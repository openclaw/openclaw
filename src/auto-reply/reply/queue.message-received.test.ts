import { beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import type { CanonicalInboundMessageHookContext } from "../../hooks/message-hook-mappers.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createDeferred, installQueueRuntimeErrorSilencer } from "./queue.test-helpers.js";

const mocks = vi.hoisted(() => ({
  fireAndForgetHook: vi.fn(),
  runMessageReceived: vi.fn(async () => undefined),
  hasHooks: vi.fn((hookName?: string) => hookName === "message_received"),
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async () => undefined),
}));

vi.mock("../../hooks/fire-and-forget.js", () => ({
  fireAndForgetHook: mocks.fireAndForgetHook,
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: mocks.createInternalHookEvent,
  triggerInternalHook: mocks.triggerInternalHook,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: mocks.hasHooks,
    runMessageReceived: mocks.runMessageReceived,
  }),
}));

installQueueRuntimeErrorSilencer();

function createInboundHookContext(
  overrides: Partial<CanonicalInboundMessageHookContext> = {},
): CanonicalInboundMessageHookContext {
  return {
    from: "telegram:user:42",
    to: "telegram:-100123",
    content: "queued hello",
    timestamp: 1710000000000,
    channelId: "telegram",
    accountId: "acc-1",
    conversationId: "telegram:-100123",
    messageId: "msg-1",
    senderId: "telegram:user:42",
    senderName: "Alice",
    provider: "telegram",
    surface: "telegram",
    originatingChannel: "telegram",
    originatingTo: "telegram:-100123",
    isGroup: true,
    groupId: "telegram:-100123",
    ...overrides,
  };
}

function createQueuedRun(overrides: Partial<FollowupRun> = {}): FollowupRun {
  const inboundHookContext = createInboundHookContext(
    overrides.inboundHookContext as Partial<CanonicalInboundMessageHookContext> | undefined,
  );
  return {
    prompt: "queued hello",
    messageId: inboundHookContext.messageId,
    enqueuedAt: Date.now(),
    originatingChannel: "telegram",
    originatingTo: "telegram:-100123",
    originatingAccountId: "acc-1",
    originatingThreadId: 77,
    originatingChatType: "group",
    inboundHookContext,
    run: {
      agentId: "agent",
      agentDir: "/tmp",
      sessionId: "sess",
      sessionKey: "agent:main:telegram:-100123:77",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp",
      config: {},
      provider: "openai",
      model: "gpt-test",
      timeoutMs: 10_000,
      blockReplyBreak: "text_end",
    },
    ...overrides,
  } as FollowupRun;
}

describe("followup queue message_received hooks", () => {
  let enqueueFollowupRun: typeof import("./queue.js").enqueueFollowupRun;
  let scheduleFollowupDrain: typeof import("./queue.js").scheduleFollowupDrain;
  let clearFollowupQueue: typeof import("./queue.js").clearFollowupQueue;

  beforeEach(async () => {
    const queueModule = await importFreshModule<typeof import("./queue.js")>(import.meta.url, "./queue.js");
    ({ enqueueFollowupRun, scheduleFollowupDrain, clearFollowupQueue } = queueModule);
    mocks.fireAndForgetHook.mockReset();
    mocks.runMessageReceived.mockReset().mockResolvedValue(undefined);
    mocks.hasHooks.mockReset().mockImplementation((hookName?: string) => hookName === "message_received");
    mocks.createInternalHookEvent.mockReset().mockImplementation(
      (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
        type,
        action,
        sessionKey,
        context,
      }),
    );
    mocks.triggerInternalHook.mockReset().mockResolvedValue(undefined);
  });

  it("emits plugin and internal message_received hooks when an inbound message is enqueued", () => {
    const key = `queue-hook-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

    const accepted = enqueueFollowupRun(key, createQueuedRun(), settings, "message-id", undefined, false);

    expect(accepted).toBe(true);
    expect(mocks.runMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "telegram:user:42",
        content: "queued hello",
        metadata: expect.objectContaining({
          messageId: "msg-1",
          originatingChannel: "telegram",
          originatingTo: "telegram:-100123",
        }),
      }),
      expect.objectContaining({
        channelId: "telegram",
        accountId: "acc-1",
        conversationId: "telegram:-100123",
      }),
    );
    expect(mocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "received",
      "agent:main:telegram:-100123:77",
      expect.objectContaining({
        from: "telegram:user:42",
        content: "queued hello",
        channelId: "telegram",
        conversationId: "telegram:-100123",
        messageId: "msg-1",
      }),
    );
    expect(mocks.triggerInternalHook).toHaveBeenCalledTimes(1);
    expect(mocks.fireAndForgetHook).toHaveBeenCalledTimes(2);

    clearFollowupQueue(key);
  });

  it("still emits hooks when enqueue restarts an idle drain through the cached callback", async () => {
    const key = `queue-hook-restart-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const firstProcessed = createDeferred<void>();
    const secondProcessed = createDeferred<void>();
    let processed = 0;

    const runFollowup = vi.fn(async () => {
      processed += 1;
      if (processed === 1) {
        firstProcessed.resolve();
        return;
      }
      secondProcessed.resolve();
    });

    enqueueFollowupRun(
      key,
      createQueuedRun({ messageId: "msg-first", inboundHookContext: createInboundHookContext({ messageId: "msg-first" }) }),
      settings,
      "message-id",
      undefined,
      false,
    );
    scheduleFollowupDrain(key, runFollowup);
    await firstProcessed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    enqueueFollowupRun(
      key,
      createQueuedRun({ messageId: "msg-second", inboundHookContext: createInboundHookContext({ messageId: "msg-second", content: "after idle" }) }),
      settings,
      "message-id",
      runFollowup,
      true,
    );

    await secondProcessed.promise;

    expect(mocks.runMessageReceived).toHaveBeenCalledTimes(2);
    expect(mocks.runMessageReceived).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "after idle" }),
      expect.any(Object),
    );
    expect(mocks.createInternalHookEvent).toHaveBeenCalledTimes(2);
    expect(mocks.triggerInternalHook).toHaveBeenCalledTimes(2);
  });
});
