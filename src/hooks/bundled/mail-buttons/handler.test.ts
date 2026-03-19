import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { InteractiveReply } from "../../../interactive/payload.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  registerInternalHook,
  triggerInternalHook,
} from "../../internal-hooks.js";
import type { InternalHookHandler } from "../../internal-hooks.js";

// Stub resolveHookConfig so we can control enabled/disabled + custom buttons
vi.mock("../../config.js", () => ({
  resolveHookConfig: vi.fn(),
}));

import { resolveHookConfig } from "../../config.js";
const mockedResolveHookConfig = vi.mocked(resolveHookConfig);

let handler: InternalHookHandler;

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
});

afterEach(() => {
  clearInternalHooks();
  vi.clearAllMocks();
});

function createSendingEvent(content: string, cfg?: OpenClawConfig) {
  return createInternalHookEvent("message", "sending", "agent:main:telegram:direct:123", {
    to: "123",
    content,
    channelId: "telegram",
    accountId: "default",
    cfg: cfg ?? ({} as OpenClawConfig),
  });
}

describe("mail-buttons hook", () => {
  it("should inject buttons when content contains a thread ID", async () => {
    mockedResolveHookConfig.mockReturnValue({ enabled: true });

    const event = createSendingEvent(
      "You have a new email — thread 19d05a032de0fce7 from example@test.com",
    );
    await handler(event);

    const interactive = event.context.interactive as InteractiveReply;
    expect(interactive).toBeDefined();
    expect(interactive.blocks).toHaveLength(1);
    expect(interactive.blocks[0].type).toBe("buttons");

    const block = interactive.blocks[0];
    if (block.type !== "buttons") throw new Error("unexpected block type");
    expect(block.buttons).toHaveLength(3);
    expect(block.buttons[0]).toEqual({
      label: "📥 Archive",
      value: "mb:archive:19d05a032de0fce7",
    });
    expect(block.buttons[1]).toEqual({
      label: "✏️ Reply",
      value: "mb:reply:19d05a032de0fce7",
    });
    expect(block.buttons[2]).toEqual({
      label: "🗑 Delete",
      value: "mb:delete:19d05a032de0fce7",
    });
  });

  it("should NOT inject buttons when content has no thread ID", async () => {
    mockedResolveHookConfig.mockReturnValue({ enabled: true });

    const event = createSendingEvent("Hello, this is a plain message without any thread.");
    await handler(event);

    expect(event.context.interactive).toBeUndefined();
  });

  it("should NOT inject buttons when hook is disabled", async () => {
    mockedResolveHookConfig.mockReturnValue({ enabled: false });

    const event = createSendingEvent("Thread 19d05a032de0fce7 has new mail.");
    await handler(event);

    expect(event.context.interactive).toBeUndefined();
  });

  it("should skip non-message:sending events", async () => {
    mockedResolveHookConfig.mockReturnValue({ enabled: true });

    const event = createInternalHookEvent("message", "sent", "agent:main:telegram:direct:123", {
      to: "123",
      content: "Thread 19d05a032de0fce7",
      channelId: "telegram",
      success: true,
    });
    await handler(event);

    expect(event.context.interactive).toBeUndefined();
  });

  it("should use custom buttons from config", async () => {
    mockedResolveHookConfig.mockReturnValue({
      enabled: true,
      buttons: [
        { text: "⭐ Star", action: "star" },
        { text: "🏷 Work", action: "label", label: "Work" },
      ],
    });

    const event = createSendingEvent("New mail in thread 19d032aae8dab340");
    await handler(event);

    const interactive = event.context.interactive as InteractiveReply;
    expect(interactive).toBeDefined();

    const block = interactive.blocks[0];
    if (block.type !== "buttons") throw new Error("unexpected block type");
    expect(block.buttons).toHaveLength(2);
    expect(block.buttons[0]).toEqual({
      label: "⭐ Star",
      value: "mb:star:19d032aae8dab340",
    });
    expect(block.buttons[1]).toEqual({
      label: "🏷 Work",
      value: "mb:label:Work:19d032aae8dab340",
    });
  });

  it("should use first thread ID when multiple are present", async () => {
    mockedResolveHookConfig.mockReturnValue({ enabled: true });

    const event = createSendingEvent(
      "Thread 19d05a032de0fce7 and thread 19d032aae8dab340 have updates.",
    );
    await handler(event);

    const interactive = event.context.interactive as InteractiveReply;
    expect(interactive).toBeDefined();

    const block = interactive.blocks[0];
    if (block.type !== "buttons") throw new Error("unexpected block type");
    // Should use the first thread ID
    expect(block.buttons[0].value).toBe("mb:archive:19d05a032de0fce7");
  });

  it("should not crash on handler error and leave event unchanged", async () => {
    // Force an error by making resolveHookConfig throw
    mockedResolveHookConfig.mockImplementation(() => {
      throw new Error("config read failure");
    });

    const event = createSendingEvent("Thread 19d05a032de0fce7");
    // Should not throw
    await expect(handler(event)).resolves.toBeUndefined();
    expect(event.context.interactive).toBeUndefined();
  });

  it("should work when registered and triggered via hook system", async () => {
    mockedResolveHookConfig.mockReturnValue({ enabled: true });

    registerInternalHook("message:sending", handler);

    const event = createSendingEvent("Thread 19d05a032de0fce7 from test@example.com");
    await triggerInternalHook(event);

    const interactive = event.context.interactive as InteractiveReply;
    expect(interactive).toBeDefined();
    expect(interactive.blocks[0].type).toBe("buttons");
  });
});
