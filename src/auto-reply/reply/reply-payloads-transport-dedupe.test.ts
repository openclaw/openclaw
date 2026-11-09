import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChannelPlugin,
  ChannelThreadingAdapter,
} from "../../channels/plugins/types.public.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery-payloads.js";

const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
  pluginId: "telegram",
  artifactBasename: "api.ts",
});

afterEach(() => resetPluginRuntimeStateForTest());

describe("Telegram topic reply dedupe", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
    );
  });

  it.each([
    { origin: "-100123", thread: 77, targetTopic: 77, count: 0 },
    { origin: "-100123", thread: " 77 ", targetTopic: 77, count: 0 },
    { origin: "-100123", thread: 77, targetTopic: 88, count: 1 },
    { origin: "-100123:topic:77", thread: 88, targetTopic: 77, count: 0 },
    { origin: "-100123:topic:77", thread: 88, targetTopic: 88, count: 1 },
  ])(
    "origin=$origin thread=$thread targetTopic=$targetTopic leaves $count replies",
    async ({ origin, thread, targetTopic, count }) => {
      const payloads = [{ text: "The completed answer." }];
      const targets = [
        {
          tool: "message",
          provider: "telegram",
          to: `-100123:topic:${targetTopic}`,
          text: "The completed answer.",
        },
      ];
      const route = {
        payloads,
        messageProvider: "telegram",
        originatingTo: origin,
        originatingThreadId: thread,
      };
      const result = await buildReplyPayloads({
        ...route,
        config: {},
        blockStreamingEnabled: false,
        blockReplyPipeline: null,
        replyToMode: "off",
        replyToChannel: "telegram",
        messagingToolSentTargets: targets,
      });
      expect(result.replyPayloads.map((payload) => payload.text)).toEqual(
        count === 0 ? [] : ["The completed answer."],
      );
      expect(
        resolveFollowupDeliveryPayloads({ ...route, cfg: {}, sentTargets: targets }).map(
          (payload) => payload.text,
        ),
      ).toEqual(count === 0 ? [] : ["The completed answer."]);
    },
  );
});

describe("reply dedupe uses the plugin's delivery destination", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "test-flat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "test-flat" }),
            threading: {
              resolveReplyTransport: ({ replyDelivery }) =>
                replyDelivery?.replyToMode === "off" ? { threadId: null, replyToId: null } : null,
            } satisfies ChannelThreadingAdapter,
          },
        },
      ]),
    );
  });

  it.each([
    { mode: "off", toolThread: undefined, count: 0 },
    { mode: "off", toolThread: "inbound-thread", count: 1 },
    { mode: "all", toolThread: undefined, count: 1 },
    { mode: "all", toolThread: "inbound-thread", count: 0 },
  ] as const)(
    "mode=$mode toolThread=$toolThread across immediate and queued replies",
    async ({ mode, toolThread, count }) => {
      const payloads = [{ text: "The completed answer." }];
      const targets = [
        {
          tool: "message",
          provider: "test-flat",
          to: "room",
          threadId: toolThread,
          text: "The completed answer.",
        },
      ];
      const result = await buildReplyPayloads({
        config: {},
        payloads,

        blockStreamingEnabled: false,
        blockReplyPipeline: null,
        replyToMode: mode,
        replyToChannel: "test-flat",
        currentMessageId: "current-message",
        messageProvider: "test-flat",
        originatingTo: "room",
        originatingThreadId: "inbound-thread",
        messagingToolSentTargets: targets,
      });
      expect(result.replyPayloads).toHaveLength(count);
      expect(
        resolveFollowupDeliveryPayloads({
          cfg: {},
          payloads,
          messageProvider: "test-flat",
          originatingTo: "room",
          originatingThreadId: "inbound-thread",
          originatingReplyToMode: mode,
          sentTargets: targets,
        }),
      ).toHaveLength(count);
    },
  );
});
