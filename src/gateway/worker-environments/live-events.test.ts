import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAILOVER_REASONS,
  type FailoverReason,
} from "../../../packages/gateway-protocol/src/failover-reasons.js";
import {
  type WorkerLiveEventErrorDetails as ErrorDetails,
  type WorkerLiveEventParams as Params,
  WorkerLiveEventParamsSchema,
} from "../../../packages/gateway-protocol/src/schema.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig as Config } from "../../config/types.openclaw.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
  type AgentEventRuntimePayload as Event,
} from "../../infra/agent-events.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  getAgentRunContextOwnership,
  resolveProjectedAgentRunProgressState,
  releaseAgentRunContext,
  sweepStaleRunContexts,
} from "../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { drainStoreWriterQueuesForTest } from "../../shared/store-writer-queue.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  runOpenClawAgentWorkerWrite,
  SQLITE_SESSION_WRITER_QUEUES,
} from "../../state/openclaw-agent-write-admission.js";
import { loadSqliteTrajectoryRuntimeEventRowsSync } from "../../trajectory/runtime-store.sqlite.js";
import type { WorkerConnectionIdentity as Identity } from "./connection-identity.js";
import * as liveProjection from "./live-event-projection.js";
import {
  createWorkerLiveEventReceiver,
  type WorkerLiveEventReceiver as Receiver,
} from "./live-events.js";
import * as workerRunOwner from "./worker-turn-run-owner.js";

const SID = "session-worker-live";
const KEY = "agent:main:worker-live";
const EPOCH = 7;
const RUN = "run-worker-live";
const LOCAL = { agentId: "main", sessionId: SID, sessionKey: KEY };
const ID: Identity = {
  environmentId: "environment-live",
  credentialHash: ["credential", "hash", "live"].join("-"),
  bundleHash: "b".repeat(64),
  sessionId: SID,
  runId: RUN,
  turnClaim: {
    sessionId: SID,
    claimId: "claim-worker-live",
    runId: RUN,
    placementGeneration: 4,
    owner: { kind: "worker", environmentId: "environment-live", ownerEpoch: EPOCH },
  },
  ownerEpoch: EPOCH,
  rpcSetVersion: 1,
  protocolFeatures: ["worker-live-event-v1"],
  credentialExpiresAtMs: 10_000,
};

const msg = (seq: number, delta = "hello", ack = 0, runId = RUN, epoch = EPOCH): Params => ({
  runEpoch: epoch,
  lastAckedSeq: ack,
  seq,
  runId,
  event: { kind: "assistant", payload: { text: delta, delta } },
});

function live(seq: number, event: Params["event"], runId = RUN): Params {
  return { runEpoch: EPOCH, lastAckedSeq: seq - 1, seq, runId, event };
}

const binding = ({ environmentId, ownerEpoch: runEpoch, sessionId }: Identity = ID) => ({
  environmentId,
  runEpoch,
  sessionId: sessionId ?? SID,
});

type WireEvent = Params["event"];
type Payload<K extends WireEvent["kind"]> = Extract<WireEvent, { kind: K }>["payload"];
const tool = (payload: Payload<"tool">): WireEvent => ({ kind: "tool", payload });
const approval = (payload: Payload<"approval">): WireEvent => ({ kind: "approval", payload });
const lifecycle = (payload: Payload<"lifecycle">): WireEvent => ({ kind: "lifecycle", payload });

const validateLiveProtocolEvent = (event: unknown) =>
  Value.Check(WorkerLiveEventParamsSchema, {
    runEpoch: EPOCH,
    lastAckedSeq: 0,
    seq: 1,
    runId: RUN,
    event,
  });
const fallbackEvent = (reason: FailoverReason) => ({
  kind: "lifecycle",
  payload: {
    phase: "fallback",
    selectedProvider: "p",
    selectedModel: "m",
    activeProvider: "q",
    activeModel: "n",
    reasonSummary: "x",
    attemptSummaries: ["x"],
    attempts: [{ provider: "p", model: "m", error: "x", reason }],
  },
});
const fallbackStepEvent = (reason: string) => ({
  kind: "lifecycle",
  payload: {
    phase: "fallback_step",
    fallbackStepType: "fallback_step",
    fallbackStepFromModel: "p/m",
    fallbackStepFromFailureReason: reason,
    fallbackStepFinalOutcome: "chain_exhausted",
  },
});

describe("worker live protocol conformance", () => {
  it("accepts every core failover reason in live fallback schemas", () => {
    for (const reason of FAILOVER_REASONS) {
      expect(validateLiveProtocolEvent(fallbackEvent(reason))).toBe(true);
      expect(validateLiveProtocolEvent(fallbackStepEvent(reason))).toBe(true);
    }

    expect(validateLiveProtocolEvent(fallbackStepEvent("not-a-reason"))).toBe(false);
  });
});

describe("worker live events", () => {
  let root: string;
  let store: string;
  let cfg: Config;
  let rx: Receiver;
  let events: Event[];
  let unsubscribe: (() => void) | undefined;

  const ack = async (request: Params, ackedSeq = request.seq, id = ID) => {
    expect(await rx.apply({ identity: id, request })).toEqual({ ok: true, result: { ackedSeq } });
  };
  const fail = async (request: Params, reason: ErrorDetails["reason"], id = ID) => {
    const details: ErrorDetails =
      reason === "resync-required" ? { reason, ackedSeq: 0, expectedSeq: 1 } : { reason };
    expect(await rx.apply({ identity: id, request })).toEqual({ ok: false, details });
  };
  const start = (overrides: Partial<Parameters<typeof createWorkerLiveEventReceiver>[0]> = {}) => {
    rx?.clear();
    rx = createWorkerLiveEventReceiver({
      getConfig: () => cfg,
      startupBindings: [binding()],
      startupOwners: new Map([[ID.environmentId, EPOCH]]),
      ...overrides,
    });
    rx.start();
  };
  const target = { canonicalKey: KEY, storeKeys: [KEY] };
  const remove = () =>
    sessions.deleteSessionEntryLifecycle({
      agentId: "main",
      archiveTranscript: false,
      expectedSessionId: SID,
      storePath: store,
      target,
    });
  const create = (updatedAt = 20) =>
    sessions.upsertSessionEntryCore(
      { agentId: "main", sessionKey: KEY, storePath: store },
      { sessionId: SID, updatedAt },
    );
  const deltas = () => events.map((event) => event.data.delta);

  const holdWriter = () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const done = runOpenClawAgentWorkerWrite(
      toDatabaseOptions(resolveSqliteReadScope({ agentId: "main", storePath: store })),
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    return { entered: entered.promise, release: release.resolve, done };
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-live-"));
    store = path.join(root, "agents", "main", "sessions", "sessions.json");
    cfg = {
      agents: { list: [{ id: "main", default: true }] },
      session: {
        mainKey: "main",
        store: path.join(root, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    await create(10);
    start();
    events = [];
    unsubscribe = onAgentRuntimeEvent((event) => events.push(event));
  });

  afterEach(async () => {
    unsubscribe?.();
    rx.clear();
    await drainStoreWriterQueuesForTest(SQLITE_SESSION_WRITER_QUEUES, "live receiver test cleanup");
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("persists cloud-worker progress for sessions tail", async () => {
    const credential = ["trajectory", "credential", "secret"].join("-");
    unsubscribe?.();
    unsubscribe = onAgentRuntimeEvent((event) => {
      events.push(event);
      if (event.stream === "tool" && event.data.phase === "result") {
        event.data.result = { status: "live-consumer-mutated" };
      }
    });
    await ack(live(1, lifecycle({ phase: "start", startedAt: 100 })));
    await ack(
      live(
        2,
        tool({
          phase: "start",
          name: "write",
          toolCallId: "call-write",
          args: { path: "proof.txt", credential },
        }),
      ),
    );
    await ack(
      live(
        3,
        tool({
          phase: "result",
          name: "write",
          toolCallId: "call-write",
          isError: false,
          result: { status: "written", credential },
        }),
      ),
    );
    const terminal = live(4, lifecycle({ phase: "end", startedAt: 100, endedAt: 200 }));
    await ack(terminal);
    await ack(terminal);

    const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
      agentId: "main",
      sessionId: SID,
      storePath: store,
    });
    expect(rows.map((row) => row.event.type)).toEqual([
      "session.started",
      "tool.call",
      "tool.result",
      "model.completed",
      "session.ended",
    ]);
    expect(events.find((event) => event.data.phase === "result")?.data.result).toEqual({
      status: "live-consumer-mutated",
    });
    expect(rows[2]?.event.data).toMatchObject({
      name: "write",
      success: true,
      result: { status: "written" },
    });
    expect(rows[4]?.event.data).toMatchObject({ status: "success" });
    expect(JSON.stringify(rows)).not.toContain(credential);
  });

  const lifecycleCredential = ["lifecycle", "credential", "value"].join("-");
  it.each([
    [
      "length completions",
      lifecycle({ phase: "end", startedAt: 100, endedAt: 200, stopReason: "length" }),
      "length",
      "success",
    ],
    [
      "provider errors",
      lifecycle({
        phase: "error",
        startedAt: 100,
        endedAt: 200,
        stopReason: "error",
        error: `provider failed after Bearer ${lifecycleCredential}`,
        fallbackExhaustedFailure: true,
      }),
      "error",
      "error",
    ],
    [
      "aborted completions",
      lifecycle({
        phase: "end",
        startedAt: 100,
        endedAt: 200,
        stopReason: "aborted",
        aborted: true,
      }),
      "aborted",
      "interrupted",
    ],
  ])("persists stop reasons for %s", async (_name, terminal, stopReason, status) => {
    await ack(live(1, lifecycle({ phase: "start", startedAt: 100 })));
    await ack(live(2, terminal));

    const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
      agentId: "main",
      sessionId: SID,
      storePath: store,
    });
    expect(rows.slice(-2).map((row) => row.event)).toMatchObject([
      { type: "model.completed", data: { stopReason } },
      { type: "session.ended", data: { status, stopReason } },
    ]);
    expect(JSON.stringify(rows)).not.toContain(lifecycleCredential);
  });

  it("maps and sanitizes kinds", async () => {
    const credential = ["fixture", "credential", "value"].join("-");
    const output = (char: string, status: string) => ({
      content: [{ type: "image", bytes: 6, omitted: true }],
      details: { credential, status, aggregated: char.repeat(9000) },
    });
    const variants: WireEvent[] = [
      { kind: "assistant", payload: { text: "hello", delta: "hello" } },
      { kind: "thinking", payload: { text: "Inspecting", delta: "ing" } },
      tool({ phase: "start", name: "read", toolCallId: "call", args: { credential } }),
      tool({
        phase: "update",
        name: " BASH ",
        toolCallId: "call",
        partialResult: output("p", "running"),
      }),
      tool({
        phase: "result",
        name: "bash",
        toolCallId: "call",
        isError: false,
        result: output("r", "completed"),
      }),
      approval({ phase: "requested", kind: "exec", status: "pending", title: "Approve" }),
      approval({ phase: "resolved", kind: "exec", status: "approved", title: "Approved" }),
      lifecycle({ phase: "start", startedAt: 100 }),
      lifecycle({
        phase: "fallback_step",
        fallbackStepType: "fallback_step",
        fallbackStepFromModel: "openai/gpt-primary",
        fallbackStepFromFailureReason: "tls_certificate",
        fallbackStepFinalOutcome: "next_fallback",
      }),
    ];

    for (const [index, event] of variants.entries()) {
      await ack(live(index + 1, event, `run-map-${index}`));
    }
    expect(events.map((event) => event.stream)).toEqual(variants.map((event) => event.kind));
    const capped = (char: string) => `${char.repeat(8000)}\n...(live output truncated)...`;
    expect(events[4]?.data).toMatchObject({
      name: "exec",
      result: { content: [{ bytes: 6, omitted: true }], details: { aggregated: capped("r") } },
    });
    expect(events[8]?.data).toMatchObject({
      fallbackStepFromFailureReason: "tls_certificate",
    });
    expect(JSON.stringify(events)).not.toContain(credential);
  });

  it("settles accepted writes before returning a synchronous diagnostic failure", async () => {
    const failure = new Error("synthetic diagnostic failure");
    const diagnostic = vi
      .spyOn(workerRunOwner, "captureWorkerTurnDiagnosticRecorder")
      .mockReturnValue(() => {
        throw failure;
      });
    const writer = holdWriter();
    await writer.entered;
    let settled = false;
    const result = rx
      .apply({
        identity: ID,
        request: live(1, lifecycle({ phase: "start", startedAt: 100 })),
      })
      .then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
    try {
      await setImmediate();
      expect(events.map((event) => event.data.phase)).toEqual(["start"]);
      expect(settled).toBe(false);
      writer.release();
      await writer.done;
      expect(await result).toBe(failure);
      expect(
        loadSqliteTrajectoryRuntimeEventRowsSync({
          agentId: "main",
          sessionId: SID,
          storePath: store,
        }).map((row) => row.event.type),
      ).toEqual(["session.started"]);
    } finally {
      writer.release();
      await writer.done;
      await result;
      diagnostic.mockRestore();
    }
  });

  it("replays an unacked tail once", async () => {
    await ack(msg(2, " world"), 0);
    await ack(msg(1), 2, { ...ID });
    await ack(msg(1), 2);
    await ack(msg(2, " world"), 2);
    expect(deltas()).toEqual(["hello", " world"]);
  });

  it.each([
    ["sequence", { windowSize: 2 }, msg(3)],
    ["bytes", { maxPendingBytes: 1 }, msg(2, "buffered")],
  ])("resyncs an out-of-window %s gap", async (_name, options, request) => {
    start(options);
    await fail(request, "resync-required");
  });

  it("uses startup ACK once", async () => {
    await ack(msg(6, "before", 5));
    await remove();
    await create(30);
    await fail(msg(8, "stale", 7), "resync-required");
    await ack(msg(1, "fresh"));
  });

  it("does not seed ACK for a freshly attached startup owner", async () => {
    start({ startupBindings: [] });
    expect(rx.bindSession(binding())).toBe(true);
    await fail(msg(6, "stale", 5), "resync-required");
    await ack(msg(1));
  });

  it("rebinds unresolved startup", async () => {
    await remove();
    start();
    await fail(msg(1), "session-not-attached");
    await create();
    await fail(msg(6, "stale", 5), "resync-required");
    await ack(msg(1));
  });

  it("rotates owners", async () => {
    await ack(msg(1, "first"));
    const credentialHash = ["rotated", "credential", "hash"].join("-");
    rx.rotateCredential({
      credentialHash,
      environmentId: ID.environmentId,
      previousCredentialHash: ID.credentialHash,
      runEpoch: EPOCH,
      sessionId: SID,
    });
    const rotated = { ...ID, credentialHash };
    await ack(msg(2, "second", 1), 2, rotated);
    await fail(msg(3, "late", 2), "epoch-mismatch");
    const next = { ...rotated, ownerEpoch: EPOCH + 1 };
    rx.bindSession(binding(next));
    await fail(msg(2, "skip", 1, RUN, next.ownerEpoch), "resync-required", next);
    await ack(msg(1, "new", 0, RUN, next.ownerEpoch), 1, next);
    await fail(msg(2, "late", 1), "epoch-mismatch", rotated);
    await ack(msg(2, "current", 1, RUN, next.ownerEpoch), 2, next);
    expect(deltas()).toEqual(["first", "second", "new", "current"]);
  });

  it("retires completed process fences when a new turn reuses its durable run id", async () => {
    await ack(live(1, lifecycle({ phase: "start", startedAt: 100 })));
    await ack(live(2, lifecycle({ phase: "end", startedAt: 100, endedAt: 200 })));
    const credentialHash = ["next", "process", "credential"].join("-");

    expect(
      rx.rotateCredential({
        ackedSeq: 2,
        credentialHash,
        environmentId: ID.environmentId,
        newProcessTurn: true,
        previousCredentialHash: ID.credentialHash,
        runEpoch: EPOCH,
        sessionId: SID,
      }),
    ).toBe(true);

    const nextProcess = { ...ID, credentialHash };
    await ack(live(3, lifecycle({ phase: "start", startedAt: 300 })), 3, nextProcess);
    expect(events.map((event) => event.data.phase)).toEqual(["start", "end", "start"]);
  });

  it("rewinds cancelled preview ACKs before delivering the replacement turn terminal", async () => {
    await ack(msg(1, "cancelled preview"));
    await ack(msg(2, "another cancelled preview", 1));
    const credentialHash = "replacement-process-credential";
    const runId = "replacement-worker-run";

    expect(
      rx.rotateCredential({
        ackedSeq: 0,
        credentialHash,
        environmentId: ID.environmentId,
        newProcessTurn: true,
        previousCredentialHash: ID.credentialHash,
        runEpoch: EPOCH,
        sessionId: SID,
      }),
    ).toBe(true);

    const replacement = { ...ID, credentialHash, runId };
    await ack(live(1, lifecycle({ phase: "start", startedAt: 300 }), runId), 1, replacement);
    await ack(
      live(2, lifecycle({ phase: "finishing", startedAt: 300, endedAt: 400 }), runId),
      2,
      replacement,
    );
    expect(events.slice(-2).map((event) => event.data.phase)).toEqual(["start", "finishing"]);
  });

  it("ACKs before buffered failure", async () => {
    const first = msg(1, "first", 0, "run-prefix");
    const second = msg(2, "second", 0, "run-buffered");
    claimAgentRunContext(second.runId, { sessionKey: KEY });
    await ack(second, 0);
    await ack(first);
    await fail(second, "invalid-event");
    clearAgentRunContext(second.runId);
    await ack(second);
    expect(deltas()).toEqual(["first", "second"]);
  });

  it("retains a buffered capacity tail until the active run releases", async () => {
    start({ maxActiveRuns: 1 });
    const first = msg(1, "first", 0, "run-prefix");
    const second = msg(2, "second", 0, "run-buffered");
    const retry = msg(2, "replacement", 1, second.runId);
    const terminal = {
      ...live(3, lifecycle({ phase: "end", endedAt: 200 }), first.runId),
      lastAckedSeq: 1,
    };

    await ack(second, 0);
    await ack(first);
    expect(getAgentRunContext(first.runId)).toBeDefined();
    expect(getAgentRunContext(second.runId)).toBeUndefined();
    expect(events.map((event) => event.runId)).toEqual([first.runId]);

    await ack(retry, 1);
    expect(getAgentRunContext(first.runId)).toBeDefined();
    expect(events.map((event) => event.runId)).toEqual([first.runId]);

    await ack(terminal, 1);
    expect(getAgentRunContext(first.runId)).toBeDefined();
    expect(getAgentRunContext(second.runId)).toBeUndefined();
    expect(events.map((event) => event.runId)).toEqual([first.runId]);

    await ack(retry, 3);
    await ack(terminal, 3);
    expect(events.map((event) => [event.runId, event.stream])).toEqual([
      [first.runId, "assistant"],
      [second.runId, "assistant"],
      [first.runId, "lifecycle"],
    ]);
    expect(deltas()).toEqual(["first", "second", undefined]);
  });

  it("does not borrow capacity past another new run", async () => {
    start({ maxActiveRuns: 1 });
    const first = msg(1, "first", 0, "run-prefix");
    const second = msg(2, "second", 0, "run-buffered");
    const third = msg(3, "third", 0, "run-intervening");
    const terminal = {
      ...live(4, lifecycle({ phase: "end", endedAt: 200 }), first.runId),
      lastAckedSeq: 0,
    };

    await ack(second, 0);
    await ack(third, 0);
    await ack(terminal, 0);
    await ack(first);
    await ack(msg(2, "replacement", 1, second.runId), 1);

    expect(events.map((event) => event.runId)).toEqual([first.runId]);
    expect(getAgentRunContext(second.runId)).toBeUndefined();
    expect(getAgentRunContext(third.runId)).toBeUndefined();
  });

  it("bounds a retained capacity tail with normal resync", async () => {
    const first = msg(1, "first", 0, "run-prefix");
    const second = msg(2, "second", 0, "run-buffered");
    start({
      maxActiveRuns: 1,
      maxPendingBytes: Buffer.byteLength(JSON.stringify(second.event), "utf8"),
    });

    await ack(second, 0);
    await ack(first);
    expect(
      await rx.apply({
        identity: ID,
        request: msg(3, "overflow", 1, "run-overflow"),
      }),
    ).toEqual({
      ok: false,
      details: { reason: "resync-required", ackedSeq: 1, expectedSeq: 2 },
    });

    await fail(msg(2, "blocked", 1, second.runId), "capacity-exceeded");
    await fail(msg(2, "stale", 1, second.runId), "resync-required");
    await ack(msg(1, "fresh", 0, second.runId));
    expect(deltas()).toEqual(["first", "fresh"]);
  });

  it("clears speculative pending events on in-window resync", async () => {
    start({ windowSize: 2 });
    await ack(msg(2, "stale"), 0);
    await fail(msg(3, "gap"), "resync-required");

    await ack(msg(1, "first"));
    await ack(msg(2, "fresh", 1));

    expect(deltas()).toEqual(["first", "fresh"]);
  });

  it("resets after capacity failure", async () => {
    start({ maxActiveRuns: 1 });
    await ack(msg(1, "active", 0, "run-active"));
    await fail(msg(2, "overlap", 1, "run-overlap"), "capacity-exceeded");
    await fail(msg(2, "stale", 1, "run-overlap"), "resync-required");
    await ack(msg(1, "fresh", 0, "run-overlap"));
  });

  it("does not reserve a pending terminal for an unbuffered head", async () => {
    start({ maxActiveRuns: 1 });
    const activeRunId = "run-active";
    await ack(msg(1, "active", 0, activeRunId));
    await ack(
      {
        ...live(3, lifecycle({ phase: "end", endedAt: 200 }), activeRunId),
        lastAckedSeq: 1,
      },
      1,
    );
    await fail(msg(2, "overlap", 1, "run-overlap"), "capacity-exceeded");
    await fail(msg(2, "stale", 1, "run-overlap"), "resync-required");
    await ack(msg(1, "fresh", 0, "run-overlap"));
  });

  it.each([RUN, "run-sibling"])("resyncs after a swept context before %s", async (runId) => {
    await ack(msg(1, "before"));
    expect(getAgentRunContext(RUN)).toBeDefined();
    sweepStaleRunContexts(-1);
    expect(getAgentRunContext(RUN)).toBeUndefined();
    await fail(msg(2, "stale", 1, runId), "resync-required");
    await ack(msg(1, "fresh", 0, runId));
    expect(deltas()).toEqual(["before", "fresh"]);
  });

  it("survives config suspension", async () => {
    const valid = cfg;
    await ack(msg(1, "before"));
    await ack(msg(3, "third", 1), 1);
    cfg = {
      ...cfg,
      session: { ...cfg.session, store: path.join(root, "missing", "{agentId}", "sessions.json") },
    };
    rx.rebindAll(cfg);
    await fail(msg(2, "suspended", 1), "session-not-attached");
    cfg = valid;
    rx.rebindAll(cfg);
    await ack(msg(2, "after", 1), 3);
    expect(deltas()).toEqual(["before", "after", "third"]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("fences a committed reset", async () => {
    await ack(msg(1, "before"));
    await sessions.resetSessionEntryLifecycle({
      agentId: "main",
      buildNextEntry: () => ({ sessionId: `${SID}-replacement`, updatedAt: 20 }),
      storePath: store,
      target,
    });
    await fail(msg(2, "after", 1), "session-not-attached");
  });

  it("restarts after deletion", async () => {
    await ack(msg(1, "before"));
    await ack(msg(3, "buffered", 1), 1);
    await remove();
    await fail(msg(2, "after", 1), "session-not-attached");
    await create(30);
    await ack(msg(1, "fresh"));
    expect(deltas()).toEqual(["before", "fresh"]);
  });

  it("fences terminal runs", async () => {
    await ack(
      live(1, { kind: "lifecycle", payload: { phase: "error", endedAt: 100, error: "retryable" } }),
    );
    await ack(msg(2, "recovered", 1));
    const end = events[0];
    clearAgentRunContext(RUN, end?.lifecycleGeneration, end?.contextClaimId);
    await fail(msg(3, "released", 2), "invalid-event");

    start({ windowSize: 2 });
    await ack(live(1, { kind: "lifecycle", payload: { phase: "end", endedAt: 200 } }));
    await ack(msg(2, "other", 1, "run-other"));
    await fail(msg(3, "late", 2), "invalid-event");
  });

  it("retains a terminal fence while its run remains claimed", async () => {
    start({ windowSize: 2 });
    await ack(live(1, { kind: "lifecycle", payload: { phase: "end", endedAt: 200 } }));
    await ack(msg(2, "other-first", 1, "run-other"));
    await ack(msg(3, "other-second", 2, "run-other"));

    await fail(msg(4, "late", 3), "invalid-event");
    expect(events.filter((event) => event.runId === RUN)).toHaveLength(1);
  });

  it("clears on detach", async () => {
    await ack(msg(1, "delivered"));
    await ack(msg(3, "buffered", 1), 1);
    rx.clearEnvironment(ID.environmentId);
    expect(getAgentRunContext(RUN)).toBeUndefined();
    await fail(msg(1, "pending", 0, "run-pending"), "invalid-event");
  });

  it("adopts a compatible pre-registered gateway run context", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    claimAgentRunContext(RUN, {
      ...LOCAL,
      isControlUiVisible: false,
      lifecycleGeneration,
    });

    await ack(msg(1, "worker"));

    expect(getAgentRunContext(RUN)).toMatchObject({
      ...LOCAL,
      isControlUiVisible: false,
      lifecycleGeneration,
      projectSessionActive: true,
    });
    expect(deltas()).toEqual(["worker"]);
  });

  it.each(["terminal process turnover", "detach"])(
    "clears an ownerless Gateway run context on %s",
    async (settledBy) => {
      claimAgentRunContext(RUN, {
        ...LOCAL,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      });

      await ack(msg(1, "worker"));
      if (settledBy === "terminal process turnover") {
        await ack(live(2, lifecycle({ phase: "end", startedAt: 100, endedAt: 200 })));
        expect(
          rx.rotateCredential({
            ackedSeq: 2,
            credentialHash: "next-process-credential-hash",
            environmentId: ID.environmentId,
            newProcessTurn: true,
            previousCredentialHash: ID.credentialHash,
            runEpoch: EPOCH,
            sessionId: SID,
          }),
        ).toBe(true);
      } else {
        rx.clearEnvironment(ID.environmentId);
      }

      expect(getAgentRunContext(RUN)).toBeUndefined();
      expect(
        resolveProjectedAgentRunProgressState({ sessionKeys: [KEY], sessionId: SID }),
      ).toBeUndefined();
    },
  );

  it("joins a visible dispatch-owned run context without blocking its terminal", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    // A worker-routed turn keeps its dispatch-owned Control UI visibility. The
    // gateway claims the run context (isControlUiVisible: true for a visible
    // turn) before handing the turn to the remote worker; joining live events
    // must inherit that visibility without excluding the outer terminal.
    claimAgentRunContext(RUN, {
      ...LOCAL,
      isControlUiVisible: true,
      lifecycleGeneration,
    });

    await ack(live(1, lifecycle({ phase: "start", startedAt: 100 })));
    await ack(msg(2, "worker", 1));
    await ack(live(3, lifecycle({ phase: "finishing", startedAt: 100, endedAt: 200 })));

    expect(getAgentRunContext(RUN)).toMatchObject({
      ...LOCAL,
      isControlUiVisible: true,
      lifecycleGeneration,
      projectSessionActive: true,
    });
    expect(resolveProjectedAgentRunProgressState({ sessionKeys: [KEY], sessionId: SID })).toBe(
      "running",
    );
    expect(events.map((event) => [event.stream, event.data.phase ?? event.data.delta])).toEqual([
      ["lifecycle", "start"],
      ["assistant", "worker"],
      ["lifecycle", "finishing"],
    ]);
    expect(events.map((event) => event.controlUiVisible)).toEqual([true, true, true]);

    emitAgentEvent({
      runId: RUN,
      stream: "lifecycle",
      data: { phase: "end", startedAt: 100, endedAt: 200 },
    });

    const end = events.at(-1);
    expect(end?.data.phase).toBe("end");
    clearAgentRunContext(RUN, end?.lifecycleGeneration, end?.contextClaimId);
    expect(getAgentRunContext(RUN)).toBeUndefined();
    expect(
      resolveProjectedAgentRunProgressState({ sessionKeys: [KEY], sessionId: SID }),
    ).toBeUndefined();
  });

  it("shares a compatible non-exclusive Gateway run owner", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const gatewayClaim = claimAgentRunContext(
      RUN,
      {
        sessionId: LOCAL.sessionId,
        sessionKey: LOCAL.sessionKey,
        isControlUiVisible: false,
        lifecycleGeneration,
      },
      { ownsContext: true, trackOwner: true },
    );
    expect(gatewayClaim).toBeDefined();

    await ack(live(1, lifecycle({ phase: "start", startedAt: 100 })));

    expect(getAgentRunContext(RUN)).toMatchObject({
      ...LOCAL,
      isControlUiVisible: false,
      lifecycleGeneration,
      projectSessionActive: true,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.controlUiVisible).toBe(false);

    rx.clear();
    expect(getAgentRunContext(RUN)).toBeDefined();
    releaseAgentRunContext(RUN, gatewayClaim);
  });

  const farmIdentity = (n: number): Identity => ({
    ...ID,
    environmentId: `environment-farm-${n}`,
    sessionId: `session-farm-${n}`,
    runId: `run-farm-${n}`,
    turnClaim: {
      sessionId: `session-farm-${n}`,
      claimId: `claim-farm-${n}`,
      runId: `run-farm-${n}`,
      placementGeneration: 4,
      owner: { kind: "worker", environmentId: `environment-farm-${n}`, ownerEpoch: EPOCH },
    },
  });
  const farmSession = (n: number, updatedAt = 20) =>
    sessions.upsertSessionEntryCore(
      { agentId: "main", sessionKey: `agent:main:farm-${n}`, storePath: store },
      { sessionId: `session-farm-${n}`, updatedAt },
    );
  const farmStart = (count: number, maxSessions: number) => {
    start({
      maxSessions,
      startupBindings: Array.from({ length: count }, (_, i) => binding(farmIdentity(i + 1))),
      startupOwners: new Map(
        Array.from({ length: count }, (_, i) => [`environment-farm-${i + 1}`, EPOCH]),
      ),
    });
  };
  const farmEvent = (n: number, seq: number, event: Params["event"]): Params => ({
    runEpoch: EPOCH,
    lastAckedSeq: seq - 1,
    seq,
    runId: `run-farm-${n}`,
    event,
  });

  it("evicts the oldest quiescent window instead of rejecting new sessions at the cap", async () => {
    await Promise.all([farmSession(1), farmSession(2), farmSession(3)]);
    farmStart(3, 2);
    for (const n of [1, 2]) {
      await ack(
        farmEvent(n, 1, { kind: "assistant", payload: { text: "hi", delta: "hi" } }),
        1,
        farmIdentity(n),
      );
      // Turn completion releases the run context gateway-side; the window's
      // stale activeRuns entry lingers until the next event revalidates it.
      for (const claimId of getAgentRunContextOwnership(`run-farm-${n}`)?.claimIds ?? []) {
        releaseAgentRunContext(`run-farm-${n}`, claimId);
      }
    }
    // Both existing windows are quiescent per the run-context registry; the
    // third session evicts the oldest instead of failing with capacity-exceeded.
    await ack(
      farmEvent(3, 1, { kind: "assistant", payload: { text: "new", delta: "new" } }),
      1,
      farmIdentity(3),
    );
  });

  it("retains a quiescent window through acknowledgment validation", async () => {
    await Promise.all([farmSession(1), farmSession(2)]);
    farmStart(2, 1);
    const writes: Promise<void>[] = [];
    const record = liveProjection.recordWorkerLiveTrajectoryEvent;
    const projection = vi
      .spyOn(liveProjection, "recordWorkerLiveTrajectoryEvent")
      .mockImplementation((...params) => {
        const write = record(...params);
        if (write) {
          writes.push(write);
        }
        return write;
      });
    const writer = holdWriter();
    await writer.entered;
    const terminal = rx.apply({
      identity: farmIdentity(1),
      request: farmEvent(1, 1, lifecycle({ phase: "end", endedAt: 200 })),
    });
    let competing: ReturnType<typeof rx.apply> | undefined;
    try {
      for (const claimId of getAgentRunContextOwnership("run-farm-1")?.claimIds ?? []) {
        releaseAgentRunContext("run-farm-1", claimId);
      }
      expect(getAgentRunContext("run-farm-1")).toBeUndefined();
      const next = farmEvent(2, 1, { kind: "assistant", payload: { text: "next", delta: "next" } });
      await fail(next, "capacity-exceeded", farmIdentity(2));
      expect(events.map((event) => event.runId)).toEqual(["run-farm-1"]);

      const write = writes.at(-1);
      if (!write) {
        throw new Error("expected an accepted terminal trajectory write");
      }
      // Registered after apply's Promise.all reaction, this runs after the
      // write settles but before apply resumes ACK validation.
      competing = write.then(() => rx.apply({ identity: farmIdentity(2), request: next }));

      writer.release();
      await writer.done;
      const [terminalResult, competingResult] = await Promise.all([terminal, competing]);
      expect.soft(competingResult).toEqual({ ok: false, details: { reason: "capacity-exceeded" } });
      expect(terminalResult).toEqual({ ok: true, result: { ackedSeq: 1 } });
      await ack(next, 1, farmIdentity(2));
      expect(events.map((event) => event.runId)).toEqual(["run-farm-1", "run-farm-2"]);
    } finally {
      writer.release();
      await writer.done;
      await terminal;
      await competing;
      projection.mockRestore();
    }
  });

  it("rejects a new session only when every window has an active run", async () => {
    await Promise.all([farmSession(1), farmSession(2), farmSession(3)]);
    farmStart(3, 2);
    for (const n of [1, 2]) {
      await ack(
        farmEvent(n, 1, { kind: "assistant", payload: { text: "hi", delta: "hi" } }),
        1,
        farmIdentity(n),
      );
    }
    await fail(
      farmEvent(3, 1, { kind: "assistant", payload: { text: "new", delta: "new" } }),
      "capacity-exceeded",
      farmIdentity(3),
    );
  });

  it("rejects a compatible context held by an exclusive Gateway owner", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const gatewayClaim = claimAgentRunContext(
      RUN,
      { ...LOCAL, lifecycleGeneration },
      { exclusive: true, ownsContext: true, trackOwner: true },
    );
    expect(gatewayClaim).toBeDefined();

    await fail(msg(1, "blocked"), "invalid-event");
    expect(events).toEqual([]);

    releaseAgentRunContext(RUN, gatewayClaim);
  });

  it("rejects pre-registered gateway run contexts with mismatched identity", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const mismatches: Array<{
      context: Parameters<typeof claimAgentRunContext>[1];
      name: string;
    }> = [
      { name: "session-id", context: { ...LOCAL, sessionId: `${SID}-other` } },
      { name: "session-key", context: { ...LOCAL, sessionKey: `${KEY}-other` } },
      { name: "agent-id", context: { ...LOCAL, agentId: "other" } },
      { name: "lifecycle", context: { ...LOCAL, lifecycleGeneration: "other-lifecycle" } },
    ];

    for (const mismatch of mismatches) {
      const runId = `run-mismatch-${mismatch.name}`;
      claimAgentRunContext(runId, {
        isControlUiVisible: false,
        lifecycleGeneration,
        ...mismatch.context,
      });
      await fail(msg(1, "blocked", 0, runId), "invalid-event");
      clearAgentRunContext(runId);
    }
    expect(events).toEqual([]);
  });

  it("keeps a claimed run id exclusive against a later untracked local claim", async () => {
    const worker = "run-worker-first";
    await ack(msg(1, "worker", 0, worker));
    // A same-identity untracked claim cannot hijack a run live events already own.
    claimAgentRunContext(worker, LOCAL);
    clearAgentRunContext(worker);
    emitAgentEvent({
      runId: worker,
      stream: "assistant",
      data: { text: "local", delta: "local" },
    });
    await ack(msg(2, "again", 1, worker));
    expect(deltas()).toEqual(["worker", "again"]);
  });
});
