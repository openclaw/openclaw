import { afterEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "./hook-runner-global.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "./loader.test-fixtures.js";

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

afterEach(() => {
  resetPluginLoaderTestStateForTest();
  cleanupPluginLoaderFixturesForTest();
});

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

  it("loads and invokes a configured external conversation policy", async () => {
    const plugin = writePlugin({
      id: "conversation-debounce",
      filename: "conversation-debounce.cjs",
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          conversationId: { type: "string" },
          debounceMs: { type: "integer", minimum: 0 },
        },
      },
      body: `module.exports = {
        id: "conversation-debounce",
        register(api) {
          const config = api.pluginConfig;
          api.on("inbound_debounce", (event, ctx) => {
            if (ctx.channelId !== "whatsapp" || ctx.conversationId !== config.conversationId) {
              return;
            }
            return { action: "debounce", debounceMs: config.debounceMs };
          });
        },
      };`,
    });

    loadOpenClawPlugins({
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: [plugin.id],
          entries: {
            [plugin.id]: {
              enabled: true,
              config: { conversationId: "chat", debounceMs: 12_000 },
              hooks: { allowConversationAccess: true },
            },
          },
        },
      },
      cache: false,
    });

    const runner = getGlobalHookRunner();
    expect(runner?.hasHooks("inbound_debounce")).toBe(true);
    await expect(runner?.runInboundDebounce(event, context)).resolves.toEqual({
      action: "debounce",
      debounceMs: 12_000,
    });
    await expect(
      runner?.runInboundDebounce(event, { ...context, conversationId: "other" }),
    ).resolves.toBeUndefined();
  });

  it("blocks an external conversation policy without explicit access", () => {
    const plugin = writePlugin({
      id: "conversation-debounce-blocked",
      filename: "conversation-debounce-blocked.cjs",
      body: `module.exports = {
        id: "conversation-debounce-blocked",
        register(api) {
          api.on("inbound_debounce", () => ({ action: "debounce", debounceMs: 12_000 }));
        },
      };`,
    });

    const registry = loadOpenClawPlugins({
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: [plugin.id],
          entries: {
            [plugin.id]: { enabled: true },
          },
        },
      },
      cache: false,
    });

    expect(registry.typedHooks).toStrictEqual([]);
    expect(registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("hooks.allowConversationAccess=true"),
        }),
      ]),
    );
  });
});
