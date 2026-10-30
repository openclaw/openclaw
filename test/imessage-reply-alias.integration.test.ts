import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

beforeEach(() => vi.resetModules());

afterEach(async () => {
  const { resetPluginRuntimeStateForTest } = await import("../src/plugins/runtime.js");
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

it("matches a cold SQLite current-message binding through the registered iMessage adapter", async () => {
  await withOpenClawTestState({ label: "imessage-alias-worker" }, async (state) => {
    const { createPluginStateRuntimeStores, createPluginStateSyncKeyedStore } =
      await import("../src/plugin-state/plugin-state-store.js");
    const seedStore = (namespace: string, maxEntries: number) =>
      createPluginStateSyncKeyedStore("imessage", { namespace, maxEntries, env: state.env });
    const entry = {
      accountId: "work",
      messageId: "00000000-0000-4000-8000-000000000042",
      shortId: "7",
      chatId: 42,
      chatIdentifier: "person@example.test",
      timestamp: Date.now(),
    };
    // Seed the persisted upgrade contract before loading the plugin's memory cache.
    const entryKey = createHash("sha256").update(entry.messageId).digest("hex").slice(0, 32);
    seedStore("imessage.reply-cache", 2000).register(entryKey, entry, {
      ttlMs: 6 * 60 * 60 * 1000,
    });
    seedStore("imessage.reply-cache-counter", 1).register("short-id-counter", { counter: 7 });

    const runtime = createPluginRuntimeMock({
      state: {
        ...createPluginStateRuntimeStores("imessage", () => {}),
        resolveStateDir: () => state.stateDir,
      },
    });
    const openSync = vi.spyOn(runtime.state, "openSyncKeyedStore");
    const { setIMessageRuntime } = await import("../extensions/imessage/runtime-api.js");
    const { imessagePlugin } = await import("../extensions/imessage/api.js");
    setIMessageRuntime(runtime);
    const delivered = { content: [], details: { ok: true } };
    const handleAction = vi.fn(async () => delivered);
    const { setActivePluginRegistry } = await import("../src/plugins/runtime.js");
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          origin: "bundled",
          plugin: {
            ...imessagePlugin,
            actions: { ...imessagePlugin.actions, handleAction },
          },
        },
      ]),
    );
    const { dispatchChannelMessageAction } =
      await import("../src/channels/plugins/message-action-dispatch.js");
    const context = {
      cfg: {},
      channel: "imessage" as const,
      action: "react" as const,
      params: { chatId: 42, messageId: entry.messageId },
      accountId: "work",
      requesterAccountId: "work",
      conversationReadOrigin: "delegated" as const,
      toolContext: {
        currentChannelProvider: "imessage" as const,
        currentChannelId: "person@example.test",
        currentMessageId: entry.shortId,
      },
    };
    await expect(dispatchChannelMessageAction(context)).resolves.toBe(delivered);
    await expect(
      dispatchChannelMessageAction({
        ...context,
        params: { ...context.params, chatId: 99 },
      }),
    ).rejects.toThrow("exact current conversation");
    expect(handleAction).toHaveBeenCalledOnce();
    expect(openSync).not.toHaveBeenCalled();
  });
});
