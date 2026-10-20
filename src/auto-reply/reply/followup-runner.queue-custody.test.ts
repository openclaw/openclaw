import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  installSessionPlacementAdmissionProvider,
  withRequiredSessionPlacement,
} from "../../agents/session-placement-admission.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  createReplyOperation,
  markReplyOperationExecutionStarted,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
import {
  claimSessionControllerInput,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import { createFollowupRunner } from "./followup-runner.js";
import { enqueueFollowupRun, scheduleFollowupDrain, type FollowupRun } from "./queue.js";
import { createQueueTestRun, installQueueRuntimeErrorSilencer } from "./queue.test-helpers.js";
import { admitFollowupRunLifecycle } from "./queue/lifecycle.js";
import { clearFollowupQueue } from "./queue/state.js";
import type { AdmittedFollowupTurn } from "./reply-agent-turn-preparation.js";
import { createTypingController } from "./typing.js";

const state = vi.hoisted(() => ({
  admit: vi.fn<(params: { queued: FollowupRun }) => Promise<ReturnType<typeof admitted>>>(),
  execute: vi.fn(),
  config: vi.fn(async (config: unknown) => config),
}));
vi.mock("./reply-agent-turn-preparation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply-agent-turn-preparation.js")>()),
  prepareReplyAgentTurn: state.admit,
}));
vi.mock("./followup-turn-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./followup-turn-execution.js")>()),
  executeFollowupTurn: state.execute,
}));
vi.mock("./agent-runner-result-accounting.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-result-accounting.js")>()),
  accountFollowupTurn: async () => undefined,
}));
vi.mock("./followup-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./followup-delivery.js")>()),
  resolveFollowupDeliveryDecision: () => ({ kind: "suppress", reason: "silent" }),
  deliverFollowupDecision: async () => ({ kind: "completed", payloads: [] }),
}));
vi.mock("./agent-runner-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-utils.js")>()),
  resolveQueuedReplyExecutionConfig: state.config,
  resolveQueuedReplyRuntimeConfig: (config: unknown) => config,
}));
installQueueRuntimeErrorSilencer();
afterEach(() => vi.clearAllMocks());

function admitted(queued: FollowupRun, operation: ReplyOperation, runId: string) {
  const turn: AdmittedFollowupTurn = {
    runId,
    queued,
    operation,
    config: queued.run.config,
    session: { kind: "detached", current: () => undefined, publish() {} },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
  };
  return { kind: "admitted" as const, turn };
}

it("acquires fresh required placement for a queued successor after its predecessor releases", async () => {
  const queued = createQueueTestRun({ prompt: "queued required-placement successor" });
  const identity = {
    agentId: queued.run.agentId!,
    sessionId: queued.run.sessionId,
    sessionKey: "agent:agent:required-placement-successor",
  };
  queued.run.sessionKey = identity.sessionKey;
  queued.run.config = { cloudWorkers: { requiredProfile: "native" } };
  const options = { config: queued.run.config };
  const predecessor = createReplyOperation({ ...identity, resetTriggered: false });
  let successor: ReplyOperation | undefined;
  const releasePredecessor = createDeferred();
  let retirement: Promise<void> | undefined;
  const events: string[] = [];
  const failures: unknown[] = [];
  let admissions = 0;
  const uninstall = installSessionPlacementAdmissionProvider({
    async withRequiredSession(_identity, task) {
      const id = ++admissions;
      let active = true;
      events.push(`admit:${id}`);
      try {
        return await task(() => {
          if (!active) {
            throw new Error("required placement admission already released");
          }
        });
      } finally {
        active = false;
        events.push(`release:${id}`);
      }
    },
    assertCompactionSuccessorAllowed: () => {},
    executeLocalTurn: async (_claim, run) => await run(),
    executeTurn: async (_claim, _turn, run) => await run(),
  });
  const typing = createTypingController({});
  state.admit.mockImplementation(async () => {
    successor = createReplyOperation({
      ...identity,
      resetTriggered: false,
      mailboxClaim: queued.controllerInput!.claim!,
    });
    await admitFollowupRunLifecycle(queued);
    return admitted(queued, successor, "required-placement-successor");
  });
  state.execute.mockImplementation(async () => {
    markReplyOperationExecutionStarted(successor!);
    try {
      await withRequiredSessionPlacement(identity, options, async () => {
        events.push("effect");
        await withRequiredSessionPlacement(identity, options, async () => {
          events.push("nested effect");
        });
      });
    } catch (error) {
      failures.push(error);
      throw error;
    }
    return {
      commentaryPayloadsEnabled: false,
      execution: {
        runId: "required-placement-successor",
        outcome: {
          kind: "settled",
          status: "ok",
          result: { payloads: [], meta: { durationMs: 0 } },
        },
      },
      progress: { drain: async () => {} },
    };
  });
  try {
    setRuntimeConfigSnapshot(queued.run.config);
    await withRequiredSessionPlacement(identity, options, async () => {
      enqueueFollowupRun(identity.sessionKey, queued, { mode: "followup", debounceMs: 0 });
      scheduleFollowupDrain(
        identity.sessionKey,
        createFollowupRunner({ typing, typingMode: "never", defaultModel: "gpt-test" }),
      );
      // Settlement wakes the successor from the predecessor's retained async context.
      retirement = (async () => {
        await releasePredecessor.promise;
        predecessor.complete();
      })();
    });
    expect(events).toEqual(["admit:1", "release:1"]);
    releasePredecessor.resolve();
    await retirement;
    await queued.controllerInput!.settlement.promise;
    expect(failures).toEqual([]);
    expect(events).toEqual([
      "admit:1",
      "release:1",
      "admit:2",
      "effect",
      "nested effect",
      "release:2",
    ]);
  } finally {
    releasePredecessor.resolve();
    await retirement;
    predecessor.complete();
    successor?.complete();
    clearFollowupQueue(identity.sessionKey);
    await queued.controllerInput?.settlement.promise;
    uninstall();
    clearRuntimeConfigSnapshot();
    typing.cleanup();
  }
});

it.each([
  "preparation",
  "adopted preparation",
  "committed execution",
  "indeterminate execution",
] as const)("retains exact source custody across a closed %s failure", async (phase) => {
  const key = "agent:main:retry-proof:" + phase;
  const failedExecution = phase.endsWith("execution");
  const raw = createDeferred();
  const firstReturned = createDeferred();
  const operations: ReplyOperation[] = [];
  const sources: FollowupRun[] = [];
  const olderCancel = new AbortController();
  const adoptedCancellation: Array<boolean | undefined> = [];
  const attempts: object[] = [];
  let effects = 0;
  const executedPrompts: string[] = [];
  const failure = new Error("closed preparation or committed effect failure");
  const typing = createTypingController({});
  for (const prompt of phase === "adopted preparation" ? ["first", "second"] : ["first"]) {
    const source = createQueueTestRun({ prompt });
    source.run.sessionKey = key;
    source.turnAdoptionLifecycle = { onAdopted: vi.fn(), onSettled: vi.fn() };
    if (phase === "adopted preparation" && prompt === "first") {
      source.abortSignal = olderCancel.signal;
    } else if (phase === "adopted preparation") {
      source.abortSignal = new AbortController().signal;
    }
    sources.push(source);
    enqueueFollowupRun(key, source, { mode: "collect", debounceMs: 0 }, "none", undefined, false);
  }
  state.admit.mockImplementation(async ({ queued }) => {
    const claim = queued.controllerClaim ?? queued.controllerInput!.claim!;
    attempts.push(queued.controllerInput!.instance);
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId: queued.run.sessionId,
      resetTriggered: false,
      mailboxClaim: claim,
    });
    operations.push(operation);
    if (phase !== "preparation" || attempts.length > 1) {
      await admitFollowupRunLifecycle(queued);
    }
    if (!failedExecution && attempts.length === 1) {
      if (phase === "adopted preparation") {
        olderCancel.abort();
        adoptedCancellation.push(queued.abortSignal?.aborted);
      }
      const releaseExecution = operation.retainExecution();
      void raw.promise.then(releaseExecution);
      operation.complete();
      throw failure;
    }
    return admitted(queued, operation, "retry-proof");
  });
  state.execute.mockImplementation(async ({ turn }: { turn: AdmittedFollowupTurn }) => {
    if (phase !== "indeterminate execution") {
      markReplyOperationExecutionStarted(turn.operation);
    }
    effects++;
    executedPrompts.push(turn.queued.prompt);
    if (failedExecution) {
      const releaseExecution = turn.operation.retainExecution();
      void raw.promise.then(releaseExecution);
      turn.operation.complete();
      throw failure;
    }
    return {
      commentaryPayloadsEnabled: false,
      execution: { runId: turn.runId, outcome: { kind: "rejected", payload: { text: "done" } } },
      progress: { drain: async () => {} },
    };
  });
  const runner = createFollowupRunner({ typing, typingMode: "never", defaultModel: "gpt-test" });
  try {
    scheduleFollowupDrain(key, async (queued) => {
      try {
        await runner(queued);
      } finally {
        firstReturned.resolve();
      }
    });
    await firstReturned.promise;
    const claim = sources[0]!.controllerInput!.claim!;
    let settled = false;
    void sources[0]!.controllerInput!.settlement.promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect({ released: claim.released, settled }).toEqual({ released: false, settled: false });
    expect(attempts).toHaveLength(1);
    raw.resolve();
    await Promise.all(sources.map((source) => source.controllerInput!.settlement.promise));
    await sources[0]!.controllerInput!.claim!.settlement.promise;
    expect(attempts).toHaveLength(failedExecution ? 1 : 2);
    expect(effects).toBe(1);
    if (phase === "adopted preparation") {
      expect(adoptedCancellation).toEqual([false]);
      expect(executedPrompts[0]).toContain("first");
      expect(executedPrompts[0]).toContain("second");
    }
    expect(attempts.every((instance) => instance === attempts[0])).toBe(true);
    for (const source of sources) {
      expect(source.turnAdoptionLifecycle!.onAdopted).toHaveBeenCalledOnce();
      expect(source.turnAdoptionLifecycle!.onSettled).toHaveBeenCalledOnce();
    }
  } finally {
    raw.resolve();
    for (const operation of operations) {
      operation.complete();
    }
    clearFollowupQueue(key);
    await Promise.allSettled(sources.map((source) => source.controllerInput!.settlement.promise));
    typing.cleanup();
  }
});

it("keeps a drain-owned claim through the actual preparation failure boundary", async () => {
  const { prepareReplyAgentTurn } = await vi.importActual<
    typeof import("./reply-agent-turn-preparation.js")
  >("./reply-agent-turn-preparation.js");
  const queued = createQueueTestRun({ prompt: "failed configuration preparation" });
  queued.run.sessionKey = "agent:main:actual-preparation-refusal";
  const claim = await claimSessionControllerInput(queued);
  const failure = new Error("configuration unavailable before admission");
  state.config.mockRejectedValueOnce(failure);
  const typing = createTypingController({});
  try {
    await expect(
      prepareReplyAgentTurn({
        queued,
        defaults: { typing, typingMode: "never", defaultModel: "gpt-test" },
      }),
    ).rejects.toBe(failure);
    expect(claim.releaseRequested).not.toBe(true);
    expect(queued.controllerInput!.phase).toBe("claimed");
    expect(queued.controllerInput!.custody.completed).not.toBe(true);
  } finally {
    releaseSessionControllerClaim(claim);
    await claim.settlement.promise;
    typing.cleanup();
  }
});
