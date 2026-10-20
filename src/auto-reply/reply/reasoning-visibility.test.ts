import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import * as sessionEntryReadRuntime from "../../config/sessions/session-entry-read-runtime.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { deferSessionControllerClaimBeforeExecution } from "../../sessions/session-controller.mailbox-claim.js";
import {
  abortSessionControllerInput,
  captureSessionControllerSourceSettlement,
  claimSessionControllerInput,
  releaseSessionControllerClaim,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { copyReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  markFollowupRunEnqueued,
  refuseCollaborativeSteering,
} from "./queue/lifecycle.js";
import {
  bindReplyReasoningVisibility,
  createReplyReasoningVisibility,
  isReplyReasoningVisible,
} from "./reasoning-visibility.js";
import { prepareSessionWriterDeliveryAuthority } from "./session-writer-delivery-authority.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const owners = new Set<Awaited<ReturnType<typeof createReplyReasoningVisibility>>>();
const releases = new Set<() => void>();
afterEach(() => {
  for (const owner of owners) {
    owner.close();
  }
  owners.clear();
  for (const release of releases) {
    release();
  }
  releases.clear();
  vi.restoreAllMocks();
});

async function createTurn(
  options: {
    stored?: "on" | "off" | "stream";
    level?: "on" | "off" | "stream";
    override?: "on" | "off" | "stream";
    authorized?: boolean;
    abortSignal?: AbortSignal;
  } = {},
) {
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:matrix:room:test",
    storePath: path.join(tempDirs.make("reasoning-visibility-"), "sessions.json"),
  };
  await sessionAccessor.replaceSessionEntry(scope, {
    sessionId: "session-1",
    updatedAt: 1,
    reasoningLevel: options.stored,
  });
  const entry = sessionAccessor.loadSessionEntryReadOnly(scope)!;
  const owner = await createReplyReasoningVisibility({
    ...scope,
    sessionEntry: entry,
    resolvedLevel: options.level ?? "on",
    override: options.override,
    authorized: options.authorized ?? true,
    abortSignal: options.abortSignal,
  });
  owners.add(owner);
  const payload = { text: "Private reasoning", isReasoning: true };
  bindReplyReasoningVisibility(payload, owner);
  return { owner, payload, scope, entry };
}

async function createQueuedTurn() {
  const turn = await createTurn();
  const queued = createQueueTestRun({ prompt: "queued reasoning owner" });
  Object.assign(queued.run, {
    agentId: turn.scope.agentId,
    sessionKey: turn.scope.sessionKey,
    sessionId: turn.entry.sessionId,
    reasoningVisibility: turn.owner,
  });
  return { ...turn, queued };
}

describe("durable reasoning visibility", () => {
  it.each([
    { label: "configured on", visible: true },
    { label: "stored on", stored: "on", visible: true },
    { label: "inline on over stored off", stored: "off", override: "on", visible: true },
    {
      label: "inline off over stored on",
      stored: "on",
      override: "off",
      level: "off",
      visible: false,
    },
    { label: "stream", level: "stream", visible: false },
    { label: "unauthorized stored on", stored: "on", authorized: false, visible: false },
    { label: "unauthorized configured on", authorized: false, visible: false },
  ] as const)("honors the resolved $label turn", async ({ visible, ...options }) => {
    const { payload } = await createTurn(options);
    expect(isReplyReasoningVisible(payload)).toBe(visible);
    expect(isReplyReasoningVisible(copyReplyPayloadMetadata(payload, { ...payload }))).toBe(
      visible,
    );
  });

  it("rejects unbound, serialized, and caller-fabricated policy owners", async () => {
    const { payload } = await createTurn();
    expect(isReplyReasoningVisible({ ...payload })).toBe(false);
    expect(
      isReplyReasoningVisible(
        setReplyPayloadMetadata({ ...payload }, { reasoningVisibilityOwner: {} }),
      ),
    ).toBe(false);
    expect(isReplyReasoningVisible({ text: "Answer" })).toBe(false);
  });

  it("revokes an inline on after a same-value explicit off, but not ordinary session writes", async () => {
    const { payload, scope, entry } = await createTurn({ stored: "off", override: "on" });
    await sessionAccessor.replaceSessionEntry(scope, { ...entry, updatedAt: entry.updatedAt + 1 });
    emitSessionLifecycleEvent({ sessionKey: scope.sessionKey, agentId: "main", reason: "patch" });
    expect(isReplyReasoningVisible(payload)).toBe(true);
    emitSessionLifecycleEvent({
      sessionKey: scope.sessionKey,
      agentId: "other",
      reason: "patch",
      reasoningLevel: "off",
    });
    expect(isReplyReasoningVisible(payload)).toBe(true);
    emitSessionLifecycleEvent({
      sessionKey: scope.sessionKey,
      agentId: "main",
      reason: "patch",
      reasoningLevel: "off",
    });
    expect(isReplyReasoningVisible(payload)).toBe(false);
  });

  it("keeps the wire fence current from write receipts without synchronous session reads", async () => {
    const { payload, scope, entry } = await createTurn({ stored: "on" });
    const read = vi.spyOn(sessionAccessor, "loadSessionEntryReadOnly");
    expect(isReplyReasoningVisible(payload)).toBe(true);
    await sessionAccessor.replaceSessionEntry(scope, { ...entry, reasoningLevel: "off" });
    expect(isReplyReasoningVisible(payload)).toBe(false);
    await sessionAccessor.replaceSessionEntry(scope, {
      ...entry,
      reasoningLevel: "on",
    });
    expect(isReplyReasoningVisible(payload)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["sessionId", "lifecycleRevision"] as const)(
    "revokes the producing turn when its %s changes",
    async (field) => {
      const { payload, scope, entry } = await createTurn({ stored: "on" });
      await sessionAccessor.replaceSessionEntry(scope, {
        ...entry,
        ...(field === "sessionId"
          ? { sessionId: "replacement-session" }
          : { lifecycleRevision: `${entry.lifecycleRevision ?? ""}-next` }),
      });
      expect(isReplyReasoningVisible(payload)).toBe(false);
    },
  );

  it.each([false, true])(
    "honors the final-delivery writer authority (explicit store path: %s)",
    async (explicitStorePath) => {
      const { payload, scope, entry } = await createTurn({ stored: "on" });
      await sessionAccessor.replaceSessionEntry(scope, { ...entry, activeWriterRunId: "writer-a" });
      const prepared = await prepareSessionWriterDeliveryAuthority(
        {
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          ...(explicitStorePath ? { storePath: scope.storePath } : {}),
          expectedSessionId: entry.sessionId,
          expectedLifecycleRevision: entry.lifecycleRevision,
          expectedWriterRunId: "writer-a",
        },
        scope.storePath,
      );
      releases.add(prepared.release);
      setReplyPayloadMetadata(payload, { sessionWriterDeliveryAuthority: prepared.authority });
      expect(isReplyReasoningVisible(payload)).toBe(true);
      await sessionAccessor.replaceSessionEntry(scope, { ...entry, activeWriterRunId: "writer-b" });
      expect(isReplyReasoningVisible(payload)).toBe(false);
    },
  );

  it("fails closed on preparation failure without interrupting the answer path", async () => {
    vi.spyOn(sessionEntryReadRuntime, "withSessionEntryReadOnlyInWorker").mockRejectedValueOnce(
      new Error("store unavailable"),
    );
    const { payload } = await createTurn();
    expect(isReplyReasoningVisible(payload)).toBe(false);
  });

  it("fails closed after abort or delivery settlement", async () => {
    const abort = new AbortController();
    const { owner, payload } = await createTurn({ abortSignal: abort.signal });
    expect(isReplyReasoningVisible(payload)).toBe(true);
    abort.abort();
    expect(isReplyReasoningVisible(payload)).toBe(false);
    owner.releaseDispatch();
    expect(isReplyReasoningVisible(payload)).toBe(false);
  });

  it("retains queued policy through initial dispatch settlement and closes it after delivery", async () => {
    const initialAbort = new AbortController();
    const { owner, payload, scope, entry } = await createTurn({ abortSignal: initialAbort.signal });
    const queued = createQueueTestRun({ prompt: "queued reasoning" });
    Object.assign(queued.run, {
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      sessionId: entry.sessionId,
      reasoningVisibility: owner,
    });
    expect(markFollowupRunEnqueued(queued)).toBe(true);
    owner.releaseDispatch();
    initialAbort.abort();
    expect(isReplyReasoningVisible(payload)).toBe(true);
    completeFollowupRunLifecycle(queued);
    expect(isReplyReasoningVisible(payload)).toBe(false);
    await captureSessionControllerSourceSettlement(queued.controllerInput!);
  });

  it("observes the queue's current cancellation fence", async () => {
    const { owner, payload, scope, entry } = await createTurn();
    const abort = new AbortController();
    const queued = createQueueTestRun({ prompt: "canceled queued reasoning" });
    Object.assign(queued.run, {
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      sessionId: entry.sessionId,
      reasoningVisibility: owner,
    });
    queued.queueAbortSignal = abort.signal;
    expect(markFollowupRunEnqueued(queued)).toBe(true);
    expect(isReplyReasoningVisible(payload)).toBe(true);
    abort.abort();
    expect(isReplyReasoningVisible(payload)).toBe(false);
    completeFollowupRunLifecycle(queued);
    await captureSessionControllerSourceSettlement(queued.controllerInput!);
  });

  it("closes reasoning when a captured source refuses collaborative steering", async () => {
    const { owner, payload, queued } = await createQueuedTurn();
    expect(markFollowupRunEnqueued(queued)).toBe(true);
    owner.releaseDispatch();
    const input = queued.controllerInput!;
    const source = {
      controllerInput: input,
      operatorAuthority: queued.operatorAuthority,
      turnAdoptionLifecycle: queued.turnAdoptionLifecycle,
      userTurnTranscriptRecorder: queued.userTurnTranscriptRecorder,
    };
    const close = vi.spyOn(owner, "close");
    try {
      await refuseCollaborativeSteering(source, undefined);
      expect(isReplyReasoningVisible(payload)).toBe(false);
      expect(close).toHaveBeenCalledOnce();
      expect(input.custody.failure).toBeUndefined();
      await expect(captureSessionControllerSourceSettlement(input)).resolves.toBeUndefined();
      completeFollowupRunLifecycle(source);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      retireSessionControllerInput(input);
      await captureSessionControllerSourceSettlement(input).catch(() => {});
    }
  });

  it.each(["controller-cancel", "restart-clear"] as const)(
    "revokes only the completed source and joins pending adoption (%s)",
    async (route) => {
      resetGatewayWorkAdmission();
      const { owner, payload, queued } = await createQueuedTurn();
      const unrelated = await createTurn();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const onSettled = vi.fn();
      queued.turnAdoptionLifecycle = {
        onAdopted: async () => {
          entered.resolve();
          await release.promise;
        },
        onSettled,
      };
      expect(markFollowupRunEnqueued(queued)).toBe(true);
      owner.releaseDispatch();
      const input = queued.controllerInput!;
      const settlement = captureSessionControllerSourceSettlement(input);
      let settled = false;
      void settlement.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const close = vi.spyOn(owner, "close");
      const admission = admitFollowupRunLifecycle(queued);
      try {
        await entered.promise;
        if (route === "controller-cancel") {
          expect(abortSessionControllerInput(input, new Error("source cancelled"))).toBe(true);
        } else {
          markGatewayRestartDraining();
        }
        expect(isReplyReasoningVisible(payload)).toBe(false);
        expect(close).toHaveBeenCalledOnce();
        expect(isReplyReasoningVisible(unrelated.payload)).toBe(true);
        expect(onSettled).not.toHaveBeenCalled();
        expect(settled).toBe(false);
        release.resolve();
        await admission;
        await settlement;
        expect(onSettled).toHaveBeenCalledOnce();
        completeFollowupRunLifecycle(queued);
        retireSessionControllerInput(input);
        expect(close).toHaveBeenCalledOnce();
        expect(isReplyReasoningVisible(unrelated.payload)).toBe(true);
      } finally {
        release.resolve();
        await admission.catch(() => {});
        retireSessionControllerInput(input);
        await settlement.catch(() => {});
        resetGatewayWorkAdmission();
      }
    },
  );

  it("retains reasoning across a pre-execution claim retry and closes only the final source", async () => {
    const { owner, payload, queued } = await createQueuedTurn();
    const unrelated = await createTurn();
    expect(markFollowupRunEnqueued(queued)).toBe(true);
    owner.releaseDispatch();
    const input = queued.controllerInput!;
    const close = vi.spyOn(owner, "close");
    try {
      const first = await claimSessionControllerInput(queued);
      expect(deferSessionControllerClaimBeforeExecution(first)).toBe(true);
      releaseSessionControllerClaim(first);
      await first.settlement.promise;
      expect(input.phase).toBe("waiting");
      expect(close).not.toHaveBeenCalled();
      expect(isReplyReasoningVisible(payload)).toBe(true);
      const retried = await claimSessionControllerInput(queued);
      expect(retried).not.toBe(first);
      expect(retried.inputs).toContain(input);
      releaseSessionControllerClaim(retried);
      await retried.settlement.promise;
      await captureSessionControllerSourceSettlement(input);
      expect(close).toHaveBeenCalledOnce();
      expect(isReplyReasoningVisible(payload)).toBe(false);
      expect(isReplyReasoningVisible(unrelated.payload)).toBe(true);
    } finally {
      const remaining = input.mailbox.claim;
      if (remaining) {
        releaseSessionControllerClaim(remaining);
        await remaining.settlement.promise.catch(() => {});
      }
      retireSessionControllerInput(input);
      await captureSessionControllerSourceSettlement(input).catch(() => {});
    }
  });

  it("does not authorize an old payload when a newer turn enables reasoning", async () => {
    const oldTurn = await createTurn({ level: "off" });
    const newTurn = await createTurn({ level: "on" });
    expect(isReplyReasoningVisible(newTurn.payload)).toBe(true);
    expect(isReplyReasoningVisible(oldTurn.payload)).toBe(false);
    newTurn.owner.close();
    expect(isReplyReasoningVisible(newTurn.payload)).toBe(false);
  });
});
