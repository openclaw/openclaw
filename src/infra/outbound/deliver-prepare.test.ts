import { describe, expect, it, vi } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../../auto-reply/reply-payload.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.adapters.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { addTestHook } from "../../plugins/hooks.test-helpers.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { normalizeEmptyPayloadForDelivery } from "./deliver-payload.js";
import { prepareOutboundPayloadBatch } from "./deliver-prepare.js";

const cases: Array<{
  name: string;
  payload: ReplyPayload;
  expectedPayload: ReplyPayload;
  adapter?: Pick<ChannelOutboundAdapter, "preserveMarkdownDetails" | "sanitizeText">;
  messageHookContent?: string;
  messageHookChanged?: boolean;
  preparedMediaCount?: number;
}> = [
  {
    name: "ordinary text",
    payload: { text: "Ready café 世界." },
    expectedPayload: { text: "Ready café 世界." },
  },
  {
    name: "preserved details",
    payload: { text: "Ready." },
    expectedPayload: { text: "Ready." },
    adapter: { preserveMarkdownDetails: () => true },
  },
  {
    name: "flattened details",
    payload: { text: "<details><summary>More</summary>Body</details>" },
    expectedPayload: { text: "**More**\n\nBody" },
  },
  {
    name: "changed sanitized text",
    payload: { text: "Before." },
    expectedPayload: { text: "After." },
    adapter: { preserveMarkdownDetails: () => true, sanitizeText: () => "After." },
  },
  {
    name: "unchanged sanitized text",
    payload: { text: "Ready." },
    expectedPayload: { text: "Ready." },
    adapter: { preserveMarkdownDetails: () => true, sanitizeText: ({ text }) => text },
  },
  {
    name: "message hook visible-text rewrite",
    payload: { text: "Before." },
    expectedPayload: { text: "After." },
    adapter: { preserveMarkdownDetails: () => true },
    messageHookContent: "After.",
    messageHookChanged: true,
    preparedMediaCount: 0,
  },
  {
    name: "message hook spoken-text rewrite",
    payload: {
      mediaUrl: "https://example.test/voice.ogg",
      audioAsVoice: true,
      spokenText: "Before.",
    },
    expectedPayload: {
      text: "",
      mediaUrl: "https://example.test/voice.ogg",
      audioAsVoice: true,
      spokenText: "After.",
    },
    adapter: { preserveMarkdownDetails: () => true },
    messageHookContent: "After.",
    messageHookChanged: true,
    preparedMediaCount: 1,
  },
];

describe("outbound preparation metadata", () => {
  it.each(cases)(
    "preserves reply metadata through $name",
    async ({
      payload,
      expectedPayload,
      adapter,
      messageHookContent,
      messageHookChanged = false,
      preparedMediaCount = 0,
    }) => {
      const metadata = { precedingInputAnswer: true } as const;
      const input = setReplyPayloadMetadata({ ...payload }, metadata);
      const send = vi.fn(async () => {
        throw new Error("Preparation must not send to the transport");
      });
      const plugin = createOutboundTestPlugin({
        id: "metadata-test",
        outbound: { deliveryMode: "direct", sendText: send, sendMedia: send, ...adapter },
      });
      const registry = createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]);
      if (messageHookContent !== undefined) {
        addTestHook({
          registry,
          pluginId: plugin.id,
          hookName: "message_sending",
          handler: () => ({ content: messageHookContent }),
        });
      }
      const batch = await withPluginRuntimeRegistryScope(registry, () =>
        prepareOutboundPayloadBatch(
          { cfg: {}, channel: plugin.id, to: "test-recipient", payloads: [input] },
          { hookRunner: createHookRunner(registry) },
        ),
      );

      expect(batch).toEqual({
        schemaVersion: 1,
        sourcePayloadCount: 1,
        channelNormalized: true,
        entries: [
          {
            sourceIndex: 0,
            status: "accepted",
            payload: expectedPayload,
            replyHookChanged: false,
            messageHookChanged,
            preparedMediaCount,
          },
        ],
      });
      const entry = batch.entries[0];
      if (!entry || entry.status !== "accepted") {
        throw new Error("Expected one accepted payload");
      }
      expect(getReplyPayloadMetadata(entry.payload)).toEqual(metadata);
      expect(input).toEqual(payload);
      expect(getReplyPayloadMetadata(input)).toEqual(metadata);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "normalizes whitespace without losing accepted metadata (media=%s)",
    (media) => {
      const metadata = { precedingInputAnswer: true } as const;
      const input = setReplyPayloadMetadata(
        { text: " \n ", ...(media ? { mediaUrl: "https://example.test/image.png" } : {}) },
        metadata,
      );
      const result = normalizeEmptyPayloadForDelivery(input);
      if (media) {
        expect(result).toEqual({ text: "", mediaUrl: "https://example.test/image.png" });
        if (!result) {
          throw new Error("Expected accepted media payload");
        }
        expect(getReplyPayloadMetadata(result)).toEqual(metadata);
      } else {
        expect(result).toBeNull();
      }
      expect(input.text).toBe(" \n ");
      expect(getReplyPayloadMetadata(input)).toEqual(metadata);
    },
  );
});
