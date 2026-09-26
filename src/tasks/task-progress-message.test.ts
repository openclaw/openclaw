import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { ChannelStreamingConfig } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  sendOrEditTaskProgressMessage,
  type TaskProgressMessageRuntime,
  type TaskProgressMessageState,
} from "./task-progress-message.js";
import { prepareTaskProgressPreferenceReader } from "./task-registry-delivery-runtime.js";

const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
  pluginId: "telegram",
  artifactBasename: "channel-plugin-api.js",
});
const { msteamsPlugin } = await loadBundledPluginFacade<{ msteamsPlugin: ChannelPlugin }>({
  pluginId: "msteams",
  artifactBasename: "channel-plugin-api.js",
});

const { slackPlugin } = await loadBundledPluginFacade<{ slackPlugin: ChannelPlugin }>({
  pluginId: "slack",
  artifactBasename: "channel-plugin-api.js",
});
const { discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
  pluginId: "discord",
  artifactBasename: "channel-plugin-api.js",
});

describe("task progress preferences", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry(
        [slackPlugin, telegramPlugin, discordPlugin, msteamsPlugin].map((plugin) => ({
          pluginId: plugin.id,
          source: "test",
          plugin,
        })),
      ),
    );
  });
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    setActivePluginRegistry(createTestRegistry([]));
  });

  function configure(
    channel: string,
    streaming?: ChannelStreamingConfig,
    accountStreaming?: ChannelStreamingConfig,
  ) {
    const cfg: OpenClawConfig = {
      channels: {
        [channel]: {
          streaming,
          accounts: { work: accountStreaming === undefined ? {} : { streaming: accountStreaming } },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
  }

  async function isTaskProgressEnabled(channel: string | undefined, accountId: string | undefined) {
    const read = await prepareTaskProgressPreferenceReader(() => {});
    return read(channel, accountId);
  }

  it.each(["slack", "telegram", "discord"])(
    "keeps %s quiet without an explicit progress-tool opt-in",
    async (channel) => {
      for (const streaming of [undefined, { mode: "progress" as const }]) {
        configure(channel, streaming);
        expect(await isTaskProgressEnabled(channel, "work")).toBe(false);
      }
      for (const mode of ["off", "partial", "block"] as const) {
        configure(channel, { mode, progress: { toolProgress: true } });
        expect(await isTaskProgressEnabled(channel, "work")).toBe(false);
      }
      configure(channel, { mode: "progress", progress: { toolProgress: true } });
      expect(await isTaskProgressEnabled(channel, "work")).toBe(true);
      configure(channel, { mode: "progress", preview: { toolProgress: true } });
      expect(await isTaskProgressEnabled(channel, "work")).toBe(true);
    },
  );

  it.each([true, false])("preserves Slack's inherited toolProgress=%s", async (toolProgress) => {
    configure("slack", { mode: "progress", progress: { toolProgress } }, { mode: "progress" });
    expect(await isTaskProgressEnabled("slack", "work")).toBe(toolProgress);
    configure(
      "slack",
      { mode: "progress", progress: { toolProgress } },
      { progress: { label: "Working" } },
    );
    expect(await isTaskProgressEnabled("slack", "work")).toBe(toolProgress);
  });

  it.each(["slack", "telegram", "discord"])(
    "honors explicit %s account overrides and observes later opt-out",
    async (channel) => {
      configure(
        channel,
        { mode: "progress", progress: { toolProgress: false } },
        { mode: "progress", progress: { toolProgress: true } },
      );
      expect(await isTaskProgressEnabled(channel, "work")).toBe(true);
      configure(
        channel,
        { mode: "progress", progress: { toolProgress: true } },
        { mode: "progress", progress: { toolProgress: false } },
      );
      expect(await isTaskProgressEnabled(channel, "work")).toBe(false);
    },
  );

  it("preserves Teams' explicit top-level preference without assuming an account config shape", async () => {
    for (const toolProgress of [undefined, false, true]) {
      const cfg: OpenClawConfig = {
        channels: { msteams: { streaming: { mode: "progress", progress: { toolProgress } } } },
      };
      setRuntimeConfigSnapshot(cfg, cfg);
      expect(await isTaskProgressEnabled("msteams", "default")).toBe(toolProgress === true);
    }
  });

  it("does not reconstruct account overrides for metadata-only channel owners", async () => {
    const plugin = createChannelTestPluginBase({ id: "metadata-only", label: "Metadata only" });
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]));
    configure(
      plugin.id,
      { mode: "progress", progress: { toolProgress: true } },
      { progress: { toolProgress: false } },
    );
    expect(await isTaskProgressEnabled(plugin.id, "work")).toBe(false);
  });

  it.each([{}, null])(
    "does not replace an owner's explicit config projection (%j) with root settings",
    async (config) => {
      const plugin = createChannelTestPluginBase({
        id: "projected",
        label: "Projected",
        config: { resolveAccount: () => ({ config }) },
      });
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]),
      );
      const cfg: OpenClawConfig = {
        channels: {
          [plugin.id]: { streaming: { mode: "progress", progress: { toolProgress: true } } },
        },
      };
      setRuntimeConfigSnapshot(cfg, cfg);
      expect(await isTaskProgressEnabled(plugin.id, "default")).toBe(false);
    },
  );

  it("does not infer an enabled preference without a registered channel owner", async () => {
    configure("slack", { mode: "progress", progress: { toolProgress: true } });
    setActivePluginRegistry(createTestRegistry([]));
    expect(await isTaskProgressEnabled("slack", "work")).toBe(false);
    expect(await isTaskProgressEnabled(undefined, "work")).toBe(false);
    expect(await isTaskProgressEnabled("slack", undefined)).toBe(false);
  });
});

const params = {
  channel: "discord",
  to: "channel:parent",
  threadId: "child-thread",
  accountId: "work",
  content: "Working",
  assertDirectAdapterHandoff: () => {},
};

function delivery() {
  return {
    channel: "discord",
    to: "channel:parent",
    via: "direct" as const,
    mediaUrl: null,
    result: {
      channel: "discord",
      messageId: "progress-message",
      target: { kind: "channel" as const, id: "child-thread" },
    },
  };
}

describe("task progress message delivery", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "telegram", source: "test", plugin: telegramPlugin },
        { pluginId: "msteams", source: "test", plugin: msteamsPlugin },
        {
          pluginId: "discord",
          source: "test",
          plugin: createChannelTestPluginBase({ id: "discord", label: "Discord" }),
        },
      ]),
    );
  });
  afterEach(() => setActivePluginRegistry(createTestRegistry()));

  it("preserves Teams conversation receipt syntax without a projection hook", async () => {
    const conversationId = "19:actual-conversation@thread.tacv2";
    const runtime = {
      sendMessage: vi.fn(async () => ({
        ...delivery(),
        channel: "msteams",
        result: {
          channel: "msteams",
          messageId: "progress-message",
          target: { kind: "conversation" as const, id: conversationId },
        },
      })),
      editTaskProgressMessage: vi.fn(async (target) => {
        expect(msteamsPlugin.messaging?.normalizeTarget?.(target.to)).toBe(
          `conversation:${conversationId}`,
        );
      }),
    } satisfies TaskProgressMessageRuntime;
    const state: TaskProgressMessageState = {};
    const teamsParams = { ...params, channel: "msteams" };
    await sendOrEditTaskProgressMessage(state, teamsParams, runtime);
    await sendOrEditTaskProgressMessage(state, { ...teamsParams, content: "Done" }, runtime);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.editTaskProgressMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "msteams",
        to: `conversation:${conversationId}`,
        accountId: "work",
        threadId: "child-thread",
        messageId: "progress-message",
      }),
    );
  });

  it.each([true, false])(
    "honors plugin-owned room projection (target available: %s)",
    async (routable) => {
      const resolveDeliveryTarget = vi.fn(() => ({
        ...(routable ? { to: "room:actual-room" } : {}),
        threadId: "actual-thread",
      }));
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "room-chat",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: "room-chat", label: "Room chat" }),
              messaging: { resolveDeliveryTarget },
            },
          },
        ]),
      );
      const runtime = {
        sendMessage: vi.fn(async () => ({
          ...delivery(),
          channel: "room-chat",
          result: {
            channel: "room-chat",
            messageId: "progress-message",
            target: { kind: "room" as const, id: "actual-room" },
          },
        })),
        editTaskProgressMessage: vi.fn(async () => {}),
      } satisfies TaskProgressMessageRuntime;
      const state: TaskProgressMessageState = {};
      const roomParams = { ...params, channel: "room-chat" };
      await sendOrEditTaskProgressMessage(state, roomParams, runtime);
      await sendOrEditTaskProgressMessage(state, { ...roomParams, content: "Done" }, runtime);
      expect(resolveDeliveryTarget).toHaveBeenCalledExactlyOnceWith({
        conversationId: "actual-room",
      });
      if (routable) {
        expect(runtime.editTaskProgressMessage).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            to: "room:actual-room",
            threadId: "actual-thread",
            accountId: "work",
          }),
        );
      } else {
        expect(runtime.editTaskProgressMessage).not.toHaveBeenCalled();
      }
      expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["123456789", "-100987654321"])(
    "round-trips Telegram receipt chat %s through its channel target contract",
    async (chatId) => {
      const telegramParams = {
        ...params,
        channel: "telegram",
        to: "@original_alias",
        threadId: "42",
      };
      const runtime = {
        sendMessage: vi.fn(async () => ({
          ...delivery(),
          channel: "telegram",
          result: {
            channel: "telegram",
            messageId: "progress-message",
            target: { kind: "chat" as const, id: chatId },
            receipt: {
              platformMessageIds: ["progress-message"],
              parts: [],
              threadId: "77",
              sentAt: 1,
            },
          },
        })),
        editTaskProgressMessage: vi.fn(async (target) => {
          target.assertCurrent();
          expect(telegramPlugin.messaging?.normalizeTarget?.(target.to)).toBe(`telegram:${chatId}`);
        }),
      } satisfies TaskProgressMessageRuntime;
      const state: TaskProgressMessageState = {};
      await sendOrEditTaskProgressMessage(state, telegramParams, runtime);
      await sendOrEditTaskProgressMessage(state, { ...telegramParams, content: "Done" }, runtime);
      expect(runtime.editTaskProgressMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          channel: "telegram",
          to: chatId,
          accountId: "work",
          threadId: "77",
          messageId: "progress-message",
          content: "Done",
        }),
      );
      await expect(
        sendOrEditTaskProgressMessage(
          state,
          {
            ...telegramParams,
            content: "Revoked",
            assertDirectAdapterHandoff: () => {
              throw new Error("owner revoked");
            },
          },
          runtime,
        ),
      ).rejects.toThrow("owner revoked");
      expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
      expect(runtime.editTaskProgressMessage).toHaveBeenCalledTimes(1);
    },
  );

  it("serializes concurrent updates onto the identified message in its actual thread", async () => {
    let release!: () => void;
    const sent = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = {
      sendMessage: vi.fn(async () => {
        await sent;
        return delivery();
      }),
      editTaskProgressMessage: vi.fn(async () => {}),
    } satisfies TaskProgressMessageRuntime;
    const state: TaskProgressMessageState = {};
    const first = sendOrEditTaskProgressMessage(state, params, runtime);
    const second = sendOrEditTaskProgressMessage(state, { ...params, content: "Done" }, runtime);
    await Promise.resolve();
    expect(runtime.editTaskProgressMessage).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    await sendOrEditTaskProgressMessage(state, { ...params, content: "Done" }, runtime);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.editTaskProgressMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:child-thread",
        accountId: "work",
        threadId: "child-thread",
        messageId: "progress-message",
        content: "Done",
      }),
    );
  });

  it.each(["ambiguous", "identityless"])("does not resend after an %s send", async (mode) => {
    const runtime = {
      sendMessage: vi.fn(async () => {
        if (mode === "ambiguous") {
          throw new Error("connection lost after dispatch");
        }
        return { ...delivery(), result: undefined };
      }),
      editTaskProgressMessage: vi.fn(async () => {}),
    } satisfies TaskProgressMessageRuntime;
    const state: TaskProgressMessageState = {};
    await sendOrEditTaskProgressMessage(state, params, runtime).catch(() => {});
    await sendOrEditTaskProgressMessage(state, { ...params, content: "Done" }, runtime);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.editTaskProgressMessage).not.toHaveBeenCalled();
  });

  it("rejects origin drift and revoked authority without editing or sending a replacement", async () => {
    const runtime = {
      sendMessage: vi.fn(async () => delivery()),
      editTaskProgressMessage: vi.fn(async () => {}),
    } satisfies TaskProgressMessageRuntime;
    const state: TaskProgressMessageState = {};
    await sendOrEditTaskProgressMessage(state, params, runtime);
    await expect(
      sendOrEditTaskProgressMessage(
        state,
        { ...params, accountId: "other", content: "Done" },
        runtime,
      ),
    ).rejects.toThrow("destination changed");
    await expect(
      sendOrEditTaskProgressMessage(
        state,
        {
          ...params,
          content: "Done",
          assertDirectAdapterHandoff: () => {
            throw new Error("owner revoked");
          },
        },
        runtime,
      ),
    ).rejects.toThrow("owner revoked");
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.editTaskProgressMessage).not.toHaveBeenCalled();
  });
});
