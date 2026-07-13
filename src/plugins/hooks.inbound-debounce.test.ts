import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";

const event = {
  debounceKey: "default:chat:sender",
  defaultAction: "bypass" as const,
  defaultDebounceMs: 1_000,
  conversationKind: "group" as const,
  message: {
    hasMedia: true,
    hasLocation: false,
    hasQuote: false,
  },
};

const context = {
  channelId: "whatsapp",
  accountId: "default",
  conversationId: "chat",
  senderId: "sender",
};

describe("inbound_debounce hook", () => {
  it("uses the first explicit decision in priority order", async () => {
    const high = vi.fn(async () => ({ action: "debounce" as const, debounceMs: 12_000 }));
    const low = vi.fn(async () => ({ action: "bypass" as const }));
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "inbound_debounce", pluginId: "low", priority: 1, handler: low },
        { hookName: "inbound_debounce", pluginId: "high", priority: 10, handler: high },
      ]),
    );

    await expect(runner.runInboundDebounce(event, context)).resolves.toEqual({
      action: "debounce",
      debounceMs: 12_000,
    });
    expect(high).toHaveBeenCalledWith(event, context);
    expect(low).not.toHaveBeenCalled();
  });

  it("falls through when a higher-priority plugin has no rule", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "inbound_debounce",
          pluginId: "passive",
          priority: 10,
          handler: vi.fn(async () => undefined),
        },
        {
          hookName: "inbound_debounce",
          pluginId: "policy",
          priority: 1,
          handler: vi.fn(async () => ({ action: "bypass" as const })),
        },
      ]),
    );

    await expect(runner.runInboundDebounce(event, context)).resolves.toEqual({
      action: "bypass",
    });
  });
});
