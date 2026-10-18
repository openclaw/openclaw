import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import type { resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import type { admitFollowupTurn } from "./followup-turn-admission.js";
import {
  createFollowupTurnTestTypingController,
  createFollowupTurnTestTurn,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import {
  clearFollowupQueueForTest,
  createQueueSettings,
  createQueueTestRun,
} from "./queue.test-helpers.js";
import { scheduleFollowupDrain } from "./queue/drain.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import { FollowupRunDeferredError, type FollowupRun } from "./queue/types.js";
import { expectCallCounts, expectCalls } from "./reply-contract.test-support.js";
import type { SessionEventExecution } from "./session-event-contract.js";

const admissionState = vi.hoisted(() => ({ beforeAdmission: vi.fn<() => Promise<void>>() }));

// mock-isolation: Keep database admission outside this queue-to-execution ownership proof.
vi.mock("./followup-turn-admission.js", () => ({
  admitFollowupTurn: async ({ queued }: Parameters<typeof admitFollowupTurn>[0]) => {
    await admissionState.beforeAdmission();
    return {
      kind: "admitted",
      turn: createFollowupTurnTestTurn({ runId: `execution-${queued.prompt}`, queued }),
    };
  },
}));

// mock-isolation: No result accounting or worker initialization is needed for an aborted stub turn.
vi.mock("./agent-runner-result-accounting.js", () => ({
  accountFollowupTurn: async () => undefined,
}));

// mock-isolation: Exercise execution callbacks without loading outbound transport/plugin runtimes.
vi.mock("./followup-delivery.js", () => ({
  resolveFollowupDeliveryDecision: async ({
    opts,
  }: Parameters<typeof resolveFollowupDeliveryDecision>[0]) => {
    await opts?.resolveReplyDelivery?.(2);
    return { kind: "suppress", reason: "aborted" };
  },
  deliverFollowupDecision: async () => ({ kind: "completed", payloads: [] }),
}));

type Observers = Required<NonNullable<FollowupRun["runObservers"]>>;

const { createFollowupRunner } = await import("./followup-runner.js");
const state = getFollowupTurnTestState();
const key = "followup-turn-callback-ownership";

function createObservers() {
  return {
    onDeliberateSilentTerminalReply: vi.fn(),
    onPreparedAgentRunStart: vi.fn<Observers["onPreparedAgentRunStart"]>(),
    onAgentRunTerminalOutcome: vi.fn<Observers["onAgentRunTerminalOutcome"]>(),
    onModelSelected: vi.fn<Observers["onModelSelected"]>(),
    prepareAssistantTranscriptMessage: vi.fn<Observers["prepareAssistantTranscriptMessage"]>(
      (message) => message,
    ),
    resolveReplyDelivery: vi.fn<Observers["resolveReplyDelivery"]>(async () => "delivered"),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetFollowupTurnTestState();
  admissionState.beforeAdmission.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  clearFollowupQueueForTest(key);
  vi.useRealTimers();
});

it.for(["before drain", "enqueue during drain", "deferred restart"] as const)(
  "keeps each queued item's observers through %s",
  async (scenario, { signal }) => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const finished = [createDeferred(), createDeferred()];
    const executed: string[] = [];
    const message = makeAssistantMessageFixture();
    const originalRecorder = createUserTurnTranscriptRecorder({
      target: () => undefined,
      message: { role: "user", content: "original request", timestamp: 1 },
      updateMode: "none",
    });
    let attempts = 0;
    if (scenario === "deferred restart") {
      admissionState.beforeAdmission.mockImplementationOnce(async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
        throw new FollowupRunDeferredError("reply lane busy");
      });
    }
    state.execute.mockImplementation(async ({ opts, followupRun }: AgentTurnParams) => {
      if (++attempts === 1 && scenario !== "deferred restart") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      const item = followupRun.prompt;
      const runId = opts?.runId;
      if (!runId) {
        throw new Error("Followup execution did not bind its run ID");
      }
      executed.push(item);
      for (const [actual, expected] of [
        [opts?.userTurnTranscriptRecorder, followupRun.userTurnTranscriptRecorder],
        [opts?.internalEventExecution, followupRun.run.internalEventExecution],
        [opts?.sourceReplyDeliveryMode, followupRun.run.sourceReplyDeliveryMode],
      ]) {
        expect(actual).toBe(expected);
      }
      opts?.internalEventExecution?.onStarted(runId);
      await opts?.internalEventExecution?.onTerminal(runId, "completed");
      opts?.onDeliberateSilentTerminalReply?.();
      opts?.onPreparedAgentRunStart?.({ runId, transcriptStart: null });
      opts?.onModelSelected?.({ provider: "test", model: item, thinkLevel: undefined });
      opts?.prepareAssistantTranscriptMessage?.(message, item);
      await opts?.resolveReplyDelivery?.(1);
      opts?.onAgentRunTerminalOutcome?.("completed");
      return { runId, outcome: { kind: "aborted", reason: "user" } };
    });
    const createEventExecution = () => ({
      deliver: false as const,
      onStarted: vi.fn<SessionEventExecution["onStarted"]>(),
      onTerminal: vi.fn<SessionEventExecution["onTerminal"]>(),
    });
    const ownedEvent = createEventExecution();
    const decoyEvent = createEventExecution();
    const decoys: ReturnType<typeof createObservers>[] = [];
    const runner = () => {
      const opts = createObservers();
      decoys.push(opts);
      return createFollowupRunner({
        typing: createFollowupTurnTestTypingController(),
        typingMode: "never",
        defaultModel: "gpt-test",
        opts: {
          ...opts,
          userTurnTranscriptRecorder: originalRecorder,
          internalEventExecution: decoyEvent,
          sourceReplyDeliveryMode: "message_tool_only",
        },
      });
    };
    const activeRunner = runner();
    const settings = createQueueSettings({ mode: "followup" });
    const observers = [createObservers(), createObservers()];
    const enqueue = (item: "B" | "C", index: number) => {
      const run = createQueueTestRun({ prompt: item, messageId: item });
      run.run.sessionKey = key;
      run.runObservers = observers[index];
      if (index === 0) {
        run.run.internalEventExecution = ownedEvent;
        run.run.sourceReplyDeliveryMode = "automatic";
      }
      run.turnAdoptionLifecycle = {
        admission: "cancel-only",
        onAdopted: () => {},
        onSettled: () => finished[index]!.resolve(),
      };
      expect(enqueueFollowupRun(key, run, settings, "none", runner(), false)).toBe(true);
    };
    enqueue("B", 0);
    if (scenario !== "enqueue during drain") {
      enqueue("C", 1);
    }
    try {
      scheduleFollowupDrain(key, activeRunner);
      await withinTest(firstStarted.promise, signal);
      if (scenario === "enqueue during drain") {
        enqueue("C", 1);
      } else if (scenario === "deferred restart") {
        scheduleFollowupDrain(key, activeRunner);
      }
      releaseFirst.resolve();
      await withinTest(Promise.all(finished.map(({ promise }) => promise)), signal);
      await vi.runAllTimersAsync();

      expect(getExistingFollowupQueue(key)).toBeUndefined();
      expect(executed).toEqual(["B", "C"]);
      for (const [index, item] of ["B", "C"].entries()) {
        const own = observers[index]!;
        expect(own.onDeliberateSilentTerminalReply).toHaveBeenCalledOnce();
        expectCalls(
          [own.onPreparedAgentRunStart, [[{ runId: `execution-${item}`, transcriptStart: null }]]],
          [own.onModelSelected, [[{ provider: "test", model: item, thinkLevel: undefined }]]],
          [own.onAgentRunTerminalOutcome, [["completed"]]],
          [own.prepareAssistantTranscriptMessage, [[message, item]]],
          [own.resolveReplyDelivery, [[1], [2]]],
        );
      }
      expect(ownedEvent.onStarted).toHaveBeenCalledExactlyOnceWith("execution-B");
      expect(ownedEvent.onTerminal).toHaveBeenCalledExactlyOnceWith("execution-B", "completed");
      expectCallCounts(0, decoyEvent.onStarted, decoyEvent.onTerminal);
      for (const decoy of decoys) {
        expectCallCounts(0, ...Object.values(decoy));
      }
    } finally {
      releaseFirst.resolve();
    }
  },
);
