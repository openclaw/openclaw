import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import type { AdmittedFollowupTurn, FollowupRunnerParams } from "./followup-turn-admission.js";
import {
  createFollowupTurnTestTurn,
  createFollowupTurnTestTypingController,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  scheduleFollowupDrain,
  type FollowupRun,
  type QueueSettings,
} from "./queue.js";
import { resetRecentQueuedMessageIdDedupe } from "./queue/enqueue.test-support.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import { captureQueuedReplyPresentation } from "./queued-reply-presentation.js";

const boundary = vi.hoisted(() => ({ admit: vi.fn(), deliver: vi.fn() }));

// Keep queue ownership, execution callback forwarding, and final routing real.
// Admission/accounting and the external provider/send boundary are synthetic.
vi.mock("./followup-turn-admission.js", () => ({
  admitFollowupTurn: (...args: unknown[]) => boundary.admit(...args),
  settleQueuedFollowupPresentation: async (defaults: FollowupRunnerParams) => {
    await defaults.opts?.onQueuedFollowupSettled?.();
  },
}));
vi.mock("./agent-runner-result-accounting.js", () => ({
  accountFollowupTurn: vi.fn(async ({ turn }: { turn: AdmittedFollowupTurn }) => ({
    payloadArray: [{ text: turn.queued.prompt }],
    providerUsed: "openai",
    modelUsed: "synthetic-model",
  })),
}));
vi.mock("../../agents/runtime-plan/build.js", () => ({
  buildAgentRuntimeDeliveryPlan: () => ({
    isSilentPayload: () => false,
    resolveFollowupRoute: () => undefined,
  }),
}));
vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloadsInternal: (...args: unknown[]) => boundary.deliver(...args),
}));

const { createFollowupRunner } = await import("./followup-runner.js");
const execution = getFollowupTurnTestState();
const queueKey = "agent:agent:slack:direct:synthetic-user";
const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 10 };
const threadA = "1000.000001";
const threadB = "1000.000002";

type ProgressReceipt = { source: string; threadId: string; kind: "reasoning" | "preamble" };
let progress: ProgressReceipt[];
let lifecycle: Array<{ threadId: string; kind: "admitted" | "settled" }>;

function createRun(threadId: string): FollowupRun {
  const queued = createFollowupTurnTestTurn().queued;
  return {
    ...queued,
    prompt: threadId,
    messageId: `${threadId}-message`,
    originatingChannel: "slack",
    originatingTo: "channel:D-SYNTHETIC",
    originatingThreadId: threadId,
    originatingChatType: "direct",
    media: undefined,
    run: { ...queued.run, sessionKey: queueKey },
  };
}

function createSource(threadId: string, quiet = false) {
  const typing = createFollowupTurnTestTypingController();
  const defaults: FollowupRunnerParams = {
    typing,
    typingMode: "never",
    defaultModel: "synthetic-model",
    opts: quiet
      ? undefined
      : {
          suppressDefaultToolProgressMessages: true,
          onQueuedFollowupAdmitted: async () => {
            lifecycle.push({ threadId, kind: "admitted" });
          },
          onQueuedFollowupSettled: async () => {
            lifecycle.push({ threadId, kind: "settled" });
          },
          onReasoningStream: async (payload) => {
            progress.push({ source: payload.text ?? "", threadId, kind: "reasoning" });
            return true;
          },
          onItemEvent: async (payload) => {
            progress.push({ source: payload.progressText ?? "", threadId, kind: "preamble" });
            return true;
          },
        },
  };
  return {
    typing,
    run: { ...createRun(threadId), presentation: captureQueuedReplyPresentation(defaults) },
    runner: createFollowupRunner(defaults),
  };
}

async function emitTurn(params: AgentTurnParams) {
  const runId = params.opts?.runId;
  if (!runId) {
    throw new Error("expected the admitted run ID in execution options");
  }
  const source = params.followupRun.prompt;
  await params.opts?.onReasoningStream?.({ text: source });
  await params.opts?.onItemEvent?.({ kind: "preamble", progressText: source });
  return {
    runId,
    outcome: {
      kind: "settled" as const,
      status: "ok" as const,
      result: { payloads: [{ text: source }], meta: { durationMs: 0 } },
      resolved: { provider: "openai", model: "synthetic-model" },
      fallback: { exhausted: false, attempts: [] },
      autoCompactionCount: 0,
      didLogHeartbeatStrip: false,
    },
  };
}

async function waitForDrain() {
  await vi.waitFor(() => expect(getExistingFollowupQueue(queueKey)).toBeUndefined());
}

beforeEach(() => {
  resetFollowupTurnTestState();
  resetRecentQueuedMessageIdDedupe();
  progress = [];
  lifecycle = [];
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        source: "test",
        plugin: createChannelTestPluginBase({
          id: "slack",
          label: "Slack",
          config: { listAccountIds: () => [], resolveAccount: () => ({}) },
        }),
      },
    ]),
  );
  boundary.admit.mockImplementation(
    async ({ queued, defaults }: { queued: FollowupRun; defaults: FollowupRunnerParams }) => {
      await defaults.opts?.onQueuedFollowupAdmitted?.();
      const turn: AdmittedFollowupTurn = createFollowupTurnTestTurn({
        runId: queued.messageId ?? "synthetic-run",
        queued,
      });
      return { kind: "admitted", turn };
    },
  );
  boundary.deliver.mockResolvedValue([{ channel: "slack", messageId: "synthetic-final" }]);
  execution.execute.mockImplementation(emitTurn);
});

afterEach(() => {
  clearSessionQueues([queueKey]);
  setActivePluginRegistry(createTestRegistry());
});

describe("queued progress origin routing", () => {
  it("uses the queued source callback when starting a fresh drain", async () => {
    const sourceB = createSource(threadB);
    expect(
      enqueueFollowupRun(queueKey, sourceB.run, settings, "message-id", sourceB.runner, false),
    ).toBe(true);
    scheduleFollowupDrain(queueKey, sourceB.runner);
    await waitForDrain();

    expect(boundary.deliver).toHaveBeenCalledWith(expect.objectContaining({ threadId: threadB }));
    expect(progress).toEqual([
      { source: threadB, threadId: threadB, kind: "reasoning" },
      { source: threadB, threadId: threadB, kind: "preamble" },
    ]);
  });

  it.each(["followup", "collect"] as const)(
    "keeps two origins queued before a fresh %s drain on their own presentation",
    async (mode) => {
      const sourceA = createSource(threadA);
      const sourceB = createSource(threadB);
      for (const source of [sourceA, sourceB]) {
        expect(
          enqueueFollowupRun(
            queueKey,
            source.run,
            { ...settings, mode },
            "message-id",
            source.runner,
            false,
          ),
        ).toBe(true);
      }
      scheduleFollowupDrain(queueKey, sourceB.runner);
      await waitForDrain();

      expect(boundary.deliver).toHaveBeenCalledTimes(2);
      expect(boundary.deliver).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ threadId: threadA }),
      );
      expect(boundary.deliver).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ threadId: threadB }),
      );
      expect(progress).toEqual([
        { source: threadA, threadId: threadA, kind: "reasoning" },
        { source: threadA, threadId: threadA, kind: "preamble" },
        { source: threadB, threadId: threadB, kind: "reasoning" },
        { source: threadB, threadId: threadB, kind: "preamble" },
      ]);
      expect(lifecycle).toEqual([
        { threadId: threadA, kind: "admitted" },
        { threadId: threadA, kind: "settled" },
        { threadId: threadB, kind: "admitted" },
        { threadId: threadB, kind: "settled" },
      ]);
    },
  );

  it.each([false, true])(
    "keeps a later queued thread's presentation with its final during an active drain (quiet=%s)",
    async (quiet) => {
      const startedA = createDeferred();
      const releaseA = createDeferred();
      execution.execute.mockImplementation(async (params: AgentTurnParams) => {
        if (params.followupRun.prompt === threadA) {
          startedA.resolve();
          await releaseA.promise;
        }
        return await emitTurn(params);
      });
      const sourceA = createSource(threadA);
      const sourceB = createSource(threadB, quiet);
      expect(
        enqueueFollowupRun(queueKey, sourceA.run, settings, "message-id", sourceA.runner, false),
      ).toBe(true);
      scheduleFollowupDrain(queueKey, sourceA.runner);
      try {
        await startedA.promise;
        expect(
          enqueueFollowupRun(queueKey, sourceB.run, settings, "message-id", sourceB.runner, false),
        ).toBe(true);
        scheduleFollowupDrain(queueKey, sourceB.runner);
      } finally {
        releaseA.resolve();
      }
      await waitForDrain();

      expect(boundary.deliver).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ threadId: threadB }),
      );
      expect(progress.filter((receipt) => receipt.source === threadB)).toEqual(
        quiet
          ? []
          : [
              { source: threadB, threadId: threadB, kind: "reasoning" },
              { source: threadB, threadId: threadB, kind: "preamble" },
            ],
      );
      expect(lifecycle).toEqual([
        { threadId: threadA, kind: "admitted" },
        { threadId: threadA, kind: "settled" },
        ...(quiet
          ? []
          : [
              { threadId: threadB, kind: "admitted" },
              { threadId: threadB, kind: "settled" },
            ]),
      ]);
      expect(sourceA.typing.markRunComplete).toHaveBeenCalledTimes(1);
      expect(sourceB.typing.markRunComplete).toHaveBeenCalledTimes(1);
      expect(sourceA.typing.markDispatchIdle).toHaveBeenCalledTimes(1);
      expect(sourceB.typing.markDispatchIdle).toHaveBeenCalledTimes(1);
    },
  );
});
