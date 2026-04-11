import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalizedMsgContext } from "../templating.js";
import { buildTestCtx } from "./test-ctx.js";

const hookRunnerMock = vi.hoisted(() => ({
  hasHooks: vi.fn<(hookName?: string) => boolean>(() => false),
  runMessageReceived: vi.fn(async () => {}),
}));

const fireAndForgetMock = vi.hoisted(() => vi.fn());

const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(
    (category: string, action: string, sessionKey: string, context: unknown) => ({
      category,
      action,
      sessionKey,
      context,
    }),
  ),
  triggerInternalHook: vi.fn(async () => {}),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunnerMock,
}));

vi.mock("../../hooks/fire-and-forget.js", () => ({
  fireAndForgetHook: fireAndForgetMock,
}));

vi.mock("../../hooks/internal-hooks.js", () => internalHookMocks);

describe("emitMessageReceivedHooks", () => {
  let emitMessageReceivedHooks: typeof import("./message-received-hooks.js").emitMessageReceivedHooks;

  beforeAll(async () => {
    ({ emitMessageReceivedHooks } = await import("./message-received-hooks.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    hookRunnerMock.hasHooks.mockReturnValue(false);
  });

  function buildCtx(
    overrides: Partial<Parameters<typeof buildTestCtx>[0]> = {},
  ): FinalizedMsgContext {
    return buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      From: "telegram:12345",
      To: "telegram:67890",
      SessionKey: "agent:main:telegram:direct:12345",
      MessageSidFull: "msg-001",
      Timestamp: 1710000000000,
      Body: "hello world",
      CommandBody: "hello world",
      RawBody: "hello world",
      SenderId: "user-1",
      SenderName: "Alice",
      SenderUsername: "alice",
      ...overrides,
    });
  }

  it("fires plugin message_received hook when hooks are registered", () => {
    hookRunnerMock.hasHooks.mockReturnValue(true);
    const ctx = buildCtx();

    emitMessageReceivedHooks(ctx);

    expect(hookRunnerMock.runMessageReceived).toHaveBeenCalledTimes(1);
    const call = hookRunnerMock.runMessageReceived.mock.calls[0] as unknown[];
    expect(call[0]).toMatchObject({
      from: "telegram:12345",
      content: "hello world",
      timestamp: 1710000000000,
      metadata: expect.objectContaining({
        messageId: "msg-001",
        senderId: "user-1",
        senderName: "Alice",
        senderUsername: "alice",
      }),
    });
    expect(call[1]).toMatchObject({
      channelId: "telegram",
    });
  });

  it("fires internal message:received hook when session key is present", () => {
    const ctx = buildCtx();

    emitMessageReceivedHooks(ctx);

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "received",
      "agent:main:telegram:direct:12345",
      expect.objectContaining({
        from: "telegram:12345",
        content: "hello world",
        timestamp: 1710000000000,
      }),
    );
    expect(fireAndForgetMock).toHaveBeenCalledWith(
      expect.anything(),
      "message-received-hooks: message_received internal hook failed",
    );
  });

  it("skips plugin hook when no hooks are registered", () => {
    hookRunnerMock.hasHooks.mockReturnValue(false);
    const ctx = buildCtx();

    emitMessageReceivedHooks(ctx);

    expect(hookRunnerMock.runMessageReceived).not.toHaveBeenCalled();
  });

  it("skips internal hook when session key is absent", () => {
    const ctx = buildCtx({ SessionKey: undefined });

    emitMessageReceivedHooks(ctx);

    expect(internalHookMocks.createInternalHookEvent).not.toHaveBeenCalled();
  });

  it("uses fire-and-forget for error isolation", () => {
    hookRunnerMock.hasHooks.mockReturnValue(true);
    const ctx = buildCtx();

    emitMessageReceivedHooks(ctx);

    expect(fireAndForgetMock).toHaveBeenCalledWith(
      expect.anything(),
      "message-received-hooks: message_received plugin hook failed",
    );
  });

  it("falls back through message ID fields", () => {
    hookRunnerMock.hasHooks.mockReturnValue(true);
    const ctx = buildCtx({
      MessageSidFull: undefined,
      MessageSid: undefined,
      MessageSidFirst: "first-sid",
      MessageSidLast: "last-sid",
    });

    emitMessageReceivedHooks(ctx);

    const call = hookRunnerMock.runMessageReceived.mock.calls[0] as unknown[];
    expect(call[0]).toMatchObject({
      metadata: expect.objectContaining({
        messageId: "first-sid",
      }),
    });
  });

  it("omits timestamp when not a finite number", () => {
    const ctx = buildCtx({ Timestamp: undefined });

    emitMessageReceivedHooks(ctx);

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "received",
      expect.any(String),
      expect.objectContaining({
        timestamp: undefined,
      }),
    );
  });
});
