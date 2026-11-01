import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelThreadingAdapter } from "../../channels/plugins/types.public.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { ReplyPayload } from "../types.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery-payloads.js";

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

  it.each(
    (
      [
        { mode: "off", toolThread: undefined, count: 0 },
        { mode: "off", toolThread: "inbound-thread", count: 1 },
        { mode: "all", toolThread: undefined, count: 1 },
        { mode: "all", toolThread: "inbound-thread", count: 0 },
      ] as const
    ).flatMap((scenario) => [false, true].map((staged) => Object.assign({ staged }, scenario))),
  )(
    "mode=$mode toolThread=$toolThread staged=$staged across immediate and queued replies",
    async ({ mode, toolThread, count, staged }) => {
      const rawMedia = "/workspace/exports/answer.png";
      const payloads = [
        { text: "The completed answer.", ...(staged ? { mediaUrl: rawMedia } : {}) },
      ];
      const normalizeMediaPaths = async (payload: ReplyPayload): Promise<ReplyPayload> => ({
        ...payload,
        mediaUrl: payload.mediaUrl?.replace("/workspace/", "/managed/"),
        mediaUrls: payload.mediaUrls?.map((url) => url.replace("/workspace/", "/managed/")),
      });
      const targets = [
        {
          tool: "message",
          provider: "test-flat",
          to: "room",
          threadId: toolThread,
          text: "The completed answer.",
          ...(staged ? { mediaUrls: [rawMedia] } : {}),
        },
      ];
      const result = await buildReplyPayloads({
        config: {},
        payloads,
        normalizeMediaPaths,

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
        await resolveFollowupDeliveryPayloads({
          cfg: {},
          payloads,
          normalizePayload: normalizeMediaPaths,
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
