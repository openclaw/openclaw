import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
} from "../src/plugin-state/plugin-state-store.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

beforeEach(() => vi.resetModules());

afterEach(async () => {
  const { resetPluginRuntimeStateForTest } = await import("../src/plugins/runtime.js");
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

describe("iMessage persisted alias matching through the registered adapter", () => {
  it.each(["modern", "legacy"] as const)(
    "matches a cold SQLite current-message binding on the %s host path",
    async (host) => {
      await withOpenClawTestState({ label: `imessage-alias-${host}` }, async (state) => {
        const { createPluginStateKeyedStore, createPluginStateSyncKeyedStore } =
          await import("../src/plugin-state/plugin-state-store.js");
        const entry = {
          accountId: "work",
          messageId: "00000000-0000-4000-8000-000000000042",
          shortId: "7",
          chatId: 42,
          chatIdentifier: "person@example.test",
          timestamp: Date.now(),
        };
        // Seed the persisted upgrade contract before loading the plugin's memory cache.
        createPluginStateSyncKeyedStore("imessage", {
          namespace: "imessage.reply-cache",
          maxEntries: 2000,
          env: state.env,
        }).register(
          createHash("sha256").update(entry.messageId).digest("hex").slice(0, 32),
          entry,
          { ttlMs: 6 * 60 * 60 * 1000 },
        );
        createPluginStateSyncKeyedStore("imessage", {
          namespace: "imessage.reply-cache-counter",
          maxEntries: 1,
          env: state.env,
        }).register("short-id-counter", { counter: 7 });

        const runtime = createPluginRuntimeMock({
          state: {
            resolveStateDir: () => state.stateDir,
            openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) =>
              createPluginStateKeyedStore<T>("imessage", { ...options, env: state.env }),
            openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
              createPluginStateSyncKeyedStore<T>("imessage", { ...options, env: state.env }),
          },
        });
        const openSync = vi.spyOn(runtime.state, "openSyncKeyedStore");
        const { imessageMessageActions, setIMessageRuntime } =
          await import("../extensions/imessage/runtime-api.js");
        const { imessagePlugin } = await import("../extensions/imessage/api.js");
        setIMessageRuntime(runtime);
        const delivered = {
          content: [{ type: "text" as const, text: "reaction delivered" }],
          details: { ok: true },
        };
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
                actions: { ...imessageMessageActions, handleAction },
              },
            },
          ]),
        );
        const matchParams = {
          args: { chatId: 42, messageId: entry.messageId },
          accountId: "work",
          toolContext: {
            currentChannelProvider: "imessage" as const,
            currentChannelId: "person@example.test",
            currentMessageId: entry.shortId,
          },
        };

        if (host === "legacy") {
          const match =
            imessageMessageActions.messageActionTargetAliases?.react?.matchesCurrentConversation;
          expect(match?.(matchParams)).toBe(true);
          expect(match?.({ ...matchParams, args: { ...matchParams.args, chatId: 99 } })).toBe(
            false,
          );
          expect(openSync).toHaveBeenCalled();
          expect(handleAction).not.toHaveBeenCalled();
          return;
        }

        const { dispatchChannelMessageAction } =
          await import("../src/channels/plugins/message-action-dispatch.js");
        const context = {
          cfg: {},
          channel: "imessage" as const,
          action: "react" as const,
          params: matchParams.args,
          accountId: "work",
          requesterAccountId: "work",
          conversationReadOrigin: "delegated" as const,
          toolContext: matchParams.toolContext,
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
    },
  );
});
