import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerLiveEventParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import {
  emitAgentEvent,
  emitAgentEventForAdmittedRun,
  onAgentRuntimeEvent,
  type AgentEventRuntimePayload,
} from "../../infra/agent-events.js";
import {
  getAgentRunContext,
  getAgentRunContextOwnership,
  registerAgentRunContext,
  releaseAgentRunContext,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { getDiagnosticSessionActivitySnapshot } from "../../logging/diagnostic-run-activity.js";
import { tryBeginGatewayRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { loadSqliteTrajectoryRuntimeEventRowsSync } from "../../trajectory/runtime-store.sqlite.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { createWorkerLiveEventReceiver, type WorkerLiveEventReceiver } from "./live-events.js";
import { getWorkerTurnExecutionIdentityCapability } from "./placement-turn-claim-events.js";
import {
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  cleanupWorkerTurnLauncherTest,
  placements,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
} from "./worker-turn-launcher.test-support.js";
import { prepareWorkerAgentRuntimeIdentity } from "./worker-turn-payload.js";
import { createWorkerTurnRunOwner } from "./worker-turn-run-owner.js";

const RUN = "run-admitted-worker-live";
const binding = {
  environmentId: ENVIRONMENT_ID,
  runEpoch: OWNER_EPOCH,
  sessionId: SESSION_ID,
};
const session = { agentId: "main", sessionId: SESSION_ID, sessionKey: SESSION_KEY };
const started: WorkerLiveEventParams["event"] = {
  kind: "lifecycle",
  payload: { phase: "start", startedAt: 100 },
};
const toolStarted: WorkerLiveEventParams["event"] = {
  kind: "tool",
  payload: { phase: "start", name: "read", toolCallId: "worker-read", args: {} },
};
const assistant = (text: string): WorkerLiveEventParams["event"] => ({
  kind: "assistant",
  payload: { text, delta: text },
});
const request = (
  seq: number,
  event: WorkerLiveEventParams["event"],
  lastAckedSeq = 0,
): WorkerLiveEventParams => ({ runEpoch: OWNER_EPOCH, runId: RUN, seq, lastAckedSeq, event });
const acknowledged = (ackedSeq: number) => ({ ok: true, result: { ackedSeq } });
const invalid = { ok: false, details: { reason: "invalid-event" } };

let receiver: WorkerLiveEventReceiver;
let events: AgentEventRuntimePayload[];
let cleanups: Array<() => void>;

beforeEach(async () => {
  await setupWorkerTurnLauncherTest();
  vi.useFakeTimers({ toFake: ["Date"], now: 100_000 });
  seedActivePlacement();
  cleanups = [];
  events = [];
  receiver = createWorkerLiveEventReceiver({
    getConfig: () => ({ session: { store: sessionTarget.storePath } }),
    startupBindings: [binding],
    startupOwners: new Map([[ENVIRONMENT_ID, OWNER_EPOCH]]),
  });
  receiver.start();
  cleanups.push(onAgentRuntimeEvent((event) => events.push(event)));
});

afterEach(async () => {
  try {
    receiver.clear();
    for (const cleanup of cleanups.toReversed()) {
      cleanup();
    }
  } finally {
    vi.useRealTimers();
    await cleanupWorkerTurnLauncherTest();
  }
});

async function admitWorker(options: { claimId?: string; assertSourceCurrent?: () => void } = {}) {
  const input = turn(RUN);
  const prepared = options.assertSourceCurrent
    ? prepareAgentRunAdmission({
        cfg: input.config,
        operationalRunInstance: input.preparedRunAdmission.operationalRunInstance,
        facts: {
          runId: RUN,
          agentId: "main",
          ingress: { kind: "worker", boundary: "test.worker-turn", state: "present" },
        },
        assertSourceCurrent: options.assertSourceCurrent,
      })
    : input.preparedRunAdmission;
  registerAgentRunContext(RUN, { ...session, isControlUiVisible: true });
  const claim = placements.claimTurn({
    ...session,
    runId: RUN,
    claimId: options.claimId ?? "claim-admitted-worker-live",
    owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
  });
  const abort = new AbortController();
  const runtime = createWorkerTurnRunOwner({
    placements,
    claim,
    sessionKey: SESSION_KEY,
    turn: { ...input, preparedRunAdmission: prepared, abortSignal: abort.signal },
  });
  const admission = tryBeginGatewayRootWorkAdmission();
  if (!admission) {
    throw new Error("Expected Gateway work admission");
  }
  const close = () => {
    runtime.dispose();
    if (placements.validateTurnClaim(claim)) {
      placements.releaseTurn(claim);
    }
    prepared.close();
    admission.release();
  };
  cleanups.push(close);
  // Exercise the launch owner: it admits the real root and binds the durable
  // claim. No delegated authority or worker publisher is fabricated by this fixture.
  const launched = await admission.run(() =>
    prepareWorkerAgentRuntimeIdentity({
      agentId: "main",
      sessionKey: SESSION_KEY,
      runtimeInstanceId: ENVIRONMENT_ID,
      placements,
      turnClaim: claim,
      turn: { ...input, preparedRunAdmission: prepared, abortSignal: runtime.signal },
    }),
  );
  const context = await prepared.admit("worker", ENVIRONMENT_ID);
  const root = getAdmittedRunDelegatedAuthority(context);
  if (!root) {
    throw new Error("Expected the admitted launch root");
  }
  expect(launched.operationalRunInstance).toBe(context.operationalRunInstance);
  expect(root.operationalRunInstance).toBe(context.operationalRunInstance);
  expect(context.executionIdentityToken).toBeUndefined();
  expect(placements.validateTurnClaim(claim)).toBe(true);
  const identity: WorkerConnectionIdentity = {
    environmentId: ENVIRONMENT_ID,
    ownerEpoch: OWNER_EPOCH,
    sessionId: SESSION_ID,
    runId: RUN,
    turnClaim: claim,
    credentialHash: "worker-live-credential-hash",
    bundleHash: "a".repeat(64),
    rpcSetVersion: 1,
    protocolFeatures: ["worker-live-event-v1"],
    credentialExpiresAtMs: 200_000,
  };
  return { abort, claim, close, identity, prepared, root };
}

const apply = (identity: WorkerConnectionIdentity, value: WorkerLiveEventParams) =>
  receiver.apply({ identity, request: value });

async function trajectory() {
  await Promise.resolve();
  return loadSqliteTrajectoryRuntimeEventRowsSync({
    agentId: "main",
    sessionId: SESSION_ID,
    storePath: sessionTarget.storePath,
  });
}

describe("admitted worker shared-event publication", () => {
  it("stamps the actual launch root on shared start, progress, tool and approval events", async () => {
    const worker = await admitWorker();
    const inputs: WorkerLiveEventParams["event"][] = [
      started,
      assistant("working"),
      toolStarted,
      {
        kind: "approval",
        payload: { phase: "requested", kind: "exec", status: "pending", title: "Approve" },
      },
    ];
    inputs.forEach((event, index) => {
      expect(apply(worker.identity, request(index + 1, event, index))).toEqual(
        acknowledged(index + 1),
      );
    });

    expect(events.map((event) => [event.seq, event.contextClaimId])).toEqual(
      inputs.map((_, index) => [index + 1, worker.root.claimId]),
    );
    expect(events[0]).toMatchObject({
      ...session,
      lifecycleGeneration: worker.root.lifecycleGeneration,
      controlUiVisible: true,
    });
    expect(worker.root.claimId).not.toBe(worker.claim.claimId);
    expect(Object.keys(events[0]!)).not.toContain("contextClaimId");
    expect(Object.keys(events[0]!)).not.toContain("lifecycleGeneration");
    expect(getAgentRunContext(RUN)?.lifecycleStartedAt).toBe(100);
    expect((await trajectory()).map((row) => row.event.type)).toEqual([
      "session.started",
      "tool.call",
      "approval.requested",
    ]);
    expect(getDiagnosticSessionActivitySnapshot(session).activeToolCallId).toBe("worker-read");
  });

  it.each(
    (["root", "turn", "abort"] as const).flatMap((closure) =>
      [started, toolStarted].map((event) => ({ closure, event, kind: event.kind })),
    ),
  )(
    "retains the accepted prefix but rejects captured $kind after $closure closure",
    async ({ closure, event: buffered }) => {
      const worker = await admitWorker();
      expect(apply(worker.identity, request(2, buffered))).toEqual(acknowledged(0));
      const context = getAgentRunContext(RUN);
      let acceptedAt: number | undefined;
      cleanups.push(
        onAgentRuntimeEvent((event) => {
          if (event.data.delta !== "prefix") {
            return;
          }
          acceptedAt = context?.lastActiveAt;
          if (closure === "root") {
            worker.prepared.close();
          } else if (closure === "turn") {
            placements.releaseTurn(worker.claim);
          } else {
            worker.abort.abort();
          }
          vi.setSystemTime(100_001);
        }),
      );

      expect(apply(worker.identity, request(1, assistant("prefix")))).toEqual(acknowledged(1));
      expect(events.map((event) => event.data.delta)).toEqual(["prefix"]);
      expect(context?.lifecycleStartedAt).toBeUndefined();
      expect(context?.lastActiveAt).toBe(acceptedAt);
      expect(await trajectory()).toEqual([]);
      expect(getDiagnosticSessionActivitySnapshot(session).activeToolCallId).toBeUndefined();
      expect(placements.validateTurnClaim(worker.claim)).toBe(closure !== "turn");
      expect(validateAgentRunDelegatedAuthority(worker.root)).toBe(closure !== "root");

      emitAgentEvent({ runId: RUN, stream: "assistant", data: { text: "ordinary observation" } });
      expect(events.at(-1)?.seq).toBe(2);
      expect(events.at(-1)?.contextClaimId).toBeUndefined();
    },
  );

  it.each(["new claim ID", "reused claim ID"] as const)(
    "never adopts a successor publisher for a buffered same-run event with %s",
    async (replacement) => {
      const first = await admitWorker();
      expect(apply(first.identity, request(2, started))).toEqual(acknowledged(0));
      first.close();
      const second = await admitWorker({
        claimId: replacement === "new claim ID" ? "claim-worker-successor" : first.claim.claimId,
      });
      expect(second.root).not.toBe(first.root);
      expect(apply(second.identity, request(1, assistant("successor")))).toEqual(acknowledged(1));
      expect(events.map((event) => event.data.delta)).toEqual(["successor"]);
      expect(events[0]?.contextClaimId).toBe(second.root.claimId);
      expect(getAgentRunContext(RUN)?.lifecycleStartedAt).toBeUndefined();
      expect(await trajectory()).toEqual([]);

      expect(apply(second.identity, request(2, started, 1))).toEqual(acknowledged(2));
      expect(events.map((event) => event.contextClaimId)).toEqual([
        second.root.claimId,
        second.root.claimId,
      ]);
      expect(getAgentRunContext(RUN)?.lifecycleStartedAt).toBe(100);
    },
  );

  it("keeps captured buffered events through same-process credential renewal", async () => {
    const worker = await admitWorker();
    expect(apply(worker.identity, request(2, started))).toEqual(acknowledged(0));
    const renewed = { ...worker.identity, credentialHash: "worker-renewed-credential-hash" };
    expect(
      receiver.rotateCredential({
        credentialHash: renewed.credentialHash,
        previousCredentialHash: worker.identity.credentialHash,
        environmentId: ENVIRONMENT_ID,
        runEpoch: OWNER_EPOCH,
        sessionId: SESSION_ID,
      }),
    ).toBe(true);
    expect(apply(renewed, request(1, assistant("renewed")))).toEqual(acknowledged(2));
    expect(events.map((event) => [event.seq, event.contextClaimId])).toEqual([
      [1, worker.root.claimId],
      [2, worker.root.claimId],
    ]);
    expect(apply(worker.identity, request(3, toolStarted, 2))).toEqual({
      ok: false,
      details: { reason: "epoch-mismatch" },
    });
    expect(events).toHaveLength(2);
  });

  it.each(["root", "placement", "receiver window", "receiver run owner"] as const)(
    "rechecks %s after source-authority callback reentry before publishing",
    async (boundary) => {
      let reenter: (() => void) | undefined;
      const worker = await admitWorker({ assertSourceCurrent: () => reenter?.() });
      const context = getAgentRunContext(RUN);
      const lastActiveAt = context?.lastActiveAt;
      let entered = false;
      reenter = () => {
        const receiverClaim = [...(getAgentRunContextOwnership(RUN)?.claimIds ?? [])].find(
          (claimId) => claimId !== worker.root.claimId,
        );
        if (boundary === "receiver run owner" && !receiverClaim) {
          return;
        }
        reenter = undefined;
        entered = true;
        if (boundary === "root") {
          worker.prepared.close();
        } else if (boundary === "placement") {
          placements.releaseTurn(worker.claim);
        } else if (boundary === "receiver window") {
          receiver.clear();
        } else {
          releaseAgentRunContext(RUN, receiverClaim);
        }
      };
      vi.setSystemTime(100_001);

      expect(apply(worker.identity, request(1, started))).toEqual(invalid);
      expect(entered).toBe(true);
      expect(events).toEqual([]);
      expect(context?.lifecycleStartedAt).toBeUndefined();
      expect(context?.lastActiveAt).toBe(lastActiveAt);
      expect(await trajectory()).toEqual([]);
      expect(getDiagnosticSessionActivitySnapshot(session).activeToolCallId).toBeUndefined();

      emitAgentEvent({ runId: RUN, stream: "assistant", data: { text: "ordinary observation" } });
      expect(events[0]?.seq).toBe(1);
      expect(events[0]?.contextClaimId).toBeUndefined();
    },
  );

  it.each([2, 3])(
    "rejects publication when source check %s aborts the worker without closing either owner",
    async (abortOnCheck) => {
      let reenter: (() => void) | undefined;
      const worker = await admitWorker({ assertSourceCurrent: () => reenter?.() });
      const context = getAgentRunContext(RUN);
      const lastActiveAt = context?.lastActiveAt;
      let checks = 0;
      // The emitter checks first; either later bound-owner check may abort and
      // return normally while the admitted root and durable placement stay live.
      reenter = () => {
        if (++checks === abortOnCheck) {
          reenter = undefined;
          worker.abort.abort();
        }
      };
      vi.setSystemTime(100_001);

      const result = apply(worker.identity, request(1, started));
      expect(worker.abort.signal.aborted).toBe(true);
      expect(placements.validateTurnClaim(worker.claim)).toBe(true);
      expect(validateAgentRunDelegatedAuthority(worker.root)).toBe(true);
      expect(result).toEqual(invalid);
      expect(events).toEqual([]);
      expect(context?.lifecycleStartedAt).toBeUndefined();
      expect(context?.lastActiveAt).toBe(lastActiveAt);
      expect(await trajectory()).toEqual([]);
      expect(getDiagnosticSessionActivitySnapshot(session).activeToolCallId).toBeUndefined();
      expect(apply(worker.identity, request(2, assistant("still buffered")))).toEqual(
        acknowledged(0),
      );

      emitAgentEvent({ runId: RUN, stream: "assistant", data: { text: "ordinary observation" } });
      expect(events[0]?.seq).toBe(1);
      expect(events[0]?.contextClaimId).toBeUndefined();
    },
  );

  it("rejects a retained capability before its callback when the second source check aborts", async () => {
    let reenter: (() => void) | undefined;
    const worker = await admitWorker({ assertSourceCurrent: () => reenter?.() });
    const capability = getWorkerTurnExecutionIdentityCapability(placements, worker.claim);
    if (!capability) {
      throw new Error("Expected the launch-bound worker capability");
    }
    let checks = 0;
    reenter = () => {
      if (++checks === 2) {
        reenter = undefined;
        worker.abort.abort();
      }
    };
    const callback = vi.fn(() => "must not execute");

    await expect(capability.run(callback)).rejects.toThrow();
    expect(worker.abort.signal.aborted).toBe(true);
    expect(placements.validateTurnClaim(worker.claim)).toBe(true);
    expect(validateAgentRunDelegatedAuthority(worker.root)).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps the outer admitted terminal available after worker finishing and turn release", async () => {
    const worker = await admitWorker();
    expect(apply(worker.identity, request(1, started))).toEqual(acknowledged(1));
    expect(apply(worker.identity, request(2, assistant("reply"), 1))).toEqual(acknowledged(2));
    expect(
      apply(
        worker.identity,
        request(3, { kind: "lifecycle", payload: { phase: "finishing", endedAt: 200 } }, 2),
      ),
    ).toEqual(acknowledged(3));
    placements.releaseTurn(worker.claim);
    receiver.clear();
    expect(validateAgentRunDelegatedAuthority(worker.root)).toBe(true);

    expect(
      emitAgentEventForAdmittedRun(
        { runId: RUN, stream: "lifecycle", data: { phase: "end", endedAt: 200 } },
        worker.root,
      ),
    ).toBe(true);
    expect(events.map((event) => [event.seq, event.contextClaimId])).toEqual(
      [1, 2, 3, 4].map((seq) => [seq, worker.root.claimId]),
    );
    expect(events.at(-1)?.data).toMatchObject({ phase: "end", startedAt: 100, endedAt: 200 });
  });

  it.each(["unowned shared", "exclusive"] as const)(
    "preserves %s publication without manufacturing admitted-root authority",
    (mode) => {
      if (mode === "unowned shared") {
        registerAgentRunContext(RUN, session);
      }
      const identity: WorkerConnectionIdentity = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        sessionId: SESSION_ID,
        runId: RUN,
        turnClaim: null,
        credentialHash: "ordinary-worker-credential-hash",
        bundleHash: "a".repeat(64),
        rpcSetVersion: 1,
        protocolFeatures: ["worker-live-event-v1"],
        credentialExpiresAtMs: 200_000,
      };

      expect(apply(identity, request(1, started))).toEqual(acknowledged(1));
      expect(events).toHaveLength(1);
      expect(getAgentRunContext(RUN)?.delegatedAuthority).toBeUndefined();
      if (mode === "unowned shared") {
        expect(events[0]?.contextClaimId).toBeUndefined();
      } else {
        const exclusive = getAgentRunContextOwnership(RUN)?.exclusiveClaimId;
        expect(exclusive).toBeTypeOf("string");
        expect(events[0]?.contextClaimId).toBe(exclusive);
      }
    },
  );
});
