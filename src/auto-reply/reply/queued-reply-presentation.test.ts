import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupRunnerParams } from "./followup-turn-admission.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  scheduleFollowupDrain,
  type FollowupRun,
  type QueueSettings,
} from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { createOverflowSummaryRetrySource } from "./queue/drain.js";
import { resetRecentQueuedMessageIdDedupe } from "./queue/enqueue.test-support.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import {
  applyQueuedReplyPresentation,
  captureQueuedReplyPresentation,
  type QueuedReplyPresentation,
} from "./queued-reply-presentation.js";
import { createMockTypingController } from "./test-helpers.js";

const queueKey = "agent:agent:presentation-carrier";

function makeDefaults(): FollowupRunnerParams {
  return {
    typing: createMockTypingController(),
    typingMode: "never",
    defaultModel: "synthetic-model",
  };
}

function makePresentation(withProgress = true): QueuedReplyPresentation {
  return captureQueuedReplyPresentation({
    ...makeDefaults(),
    opts: withProgress ? { onReasoningStream: vi.fn(async () => true) } : {},
  });
}

function makeRun(prompt: string, presentation?: QueuedReplyPresentation): FollowupRun {
  return {
    ...createQueueTestRun({
      prompt,
      originatingChannel: "slack",
      originatingTo: "channel:D-SYNTHETIC",
      originatingThreadId: "1000.000002",
      originatingChatType: "direct",
    }),
    presentation,
  };
}

async function drainRuns(runs: FollowupRun[], settings: QueueSettings) {
  const observed: FollowupRun[] = [];
  for (const run of runs) {
    expect(enqueueFollowupRun(queueKey, run, settings)).toBe(true);
  }
  scheduleFollowupDrain(queueKey, async (run) => {
    observed.push(run);
  });
  await vi.waitFor(() => expect(getExistingFollowupQueue(queueKey)).toBeUndefined());
  return observed;
}

beforeEach(() => {
  resetRecentQueuedMessageIdDedupe();
});

afterEach(() => {
  clearSessionQueues([queueKey]);
  resetRecentQueuedMessageIdDedupe();
});

describe("queued reply presentation ownership", () => {
  it("keeps a quiet source quiet while retaining refreshed runtime and delivery defaults", () => {
    const source = makeDefaults();
    const quiet = captureQueuedReplyPresentation(source);
    const fresh: FollowupRunnerParams = {
      ...makeDefaults(),
      resolveGatewayContext: vi.fn<NonNullable<FollowupRunnerParams["resolveGatewayContext"]>>(),
      sessionKey: "fresh-session",
      sessionEntry: { sessionId: "fresh-session-id", updatedAt: 2 },
      sessionStore: {},
      opts: {
        onReasoningStream: vi.fn(async () => true),
        onItemEvent: vi.fn(async () => true),
        onQueuedFollowupSettled: vi.fn(async () => {}),
        suppressDefaultToolProgressMessages: true,
        onBlockReply: vi.fn(async () => {}),
        toolsAllow: ["read"],
        disableTools: true,
      },
    };

    const applied = applyQueuedReplyPresentation(fresh, quiet);

    expect(applied.opts?.onReasoningStream).toBeUndefined();
    expect(applied.opts?.onItemEvent).toBeUndefined();
    expect(applied.opts?.onQueuedFollowupSettled).toBeUndefined();
    expect(applied.opts?.suppressDefaultToolProgressMessages).toBeUndefined();
    expect(applied.typing).toBe(source.typing);
    expect(applied.resolveGatewayContext).toBe(fresh.resolveGatewayContext);
    expect(applied.sessionKey).toBe(fresh.sessionKey);
    expect(applied.sessionEntry).toBe(fresh.sessionEntry);
    expect(applied.sessionStore).toBe(fresh.sessionStore);
    expect(applied.opts?.toolsAllow).toBe(fresh.opts?.toolsAllow);
    expect(applied.opts?.disableTools).toBe(true);
    expect(applied.opts?.onBlockReply).toBe(fresh.opts?.onBlockReply);
    expect(fresh.opts?.onReasoningStream).toBeTypeOf("function");
  });

  it("retains the refreshed dispatcher unchanged when no presentation owner exists", () => {
    const defaults = makeDefaults();
    expect(applyQueuedReplyPresentation(defaults, undefined)).toBe(defaults);
  });

  it.each(["progress", "quiet", "legacy"] as const)(
    "collects using the last source's %s presentation",
    async (kind) => {
      const first = makePresentation();
      const last = kind === "legacy" ? undefined : makePresentation(kind === "progress");
      const observed = await drainRuns([makeRun("first", first), makeRun("last", last)], {
        mode: "collect",
        debounceMs: 0,
      });

      expect(observed).toHaveLength(1);
      expect(observed[0]?.prompt).toContain("first");
      expect(observed[0]?.prompt).toContain("last");
      expect(observed[0]?.presentation).toBe(last);
    },
  );

  it.each(["progress", "quiet", "legacy"] as const)(
    "retains the last dropped source's %s presentation through elision and summary execution",
    async (kind) => {
      const lastDropped = kind === "legacy" ? undefined : makePresentation(kind === "progress");
      const retained = makePresentation();
      const observed = await drainRuns(
        [
          makeRun("first dropped", makePresentation()),
          makeRun("last dropped", lastDropped),
          makeRun("retained", retained),
        ],
        { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      );

      expect(observed).toHaveLength(2);
      // The cap retains only the latest summary text, while both source
      // identities pass through elision and the synthetic aggregate.
      expect(observed[0]?.prompt).toContain("Dropped 2 messages");
      expect(observed[0]?.prompt).toContain("last dropped");
      expect(observed[0]?.presentation).toBe(lastDropped);
      expect(observed[1]?.prompt).toBe("retained");
      expect(observed[1]?.presentation).toBe(retained);
    },
  );

  it("keeps presentation and its quiet policy in a compact overflow retry source", () => {
    const presentation = makePresentation(false);
    const source = makeRun("retry source", presentation);
    const retry = createOverflowSummaryRetrySource(source);

    expect(retry).not.toBe(source);
    expect(retry.presentation).toBe(presentation);
    expect(retry.presentation?.opts.onReasoningStream).toBeUndefined();
    expect(retry.originatingThreadId).toBe(source.originatingThreadId);
  });
});
