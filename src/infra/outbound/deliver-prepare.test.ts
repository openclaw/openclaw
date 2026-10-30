import { assert, describe, expect, it, vi } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../../auto-reply/reply-payload.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { addTestHook } from "../../plugins/hooks.test-helpers.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { normalizeEmptyPayloadForDelivery } from "./deliver-payload.js";
import { prepareOutboundPayloadBatch } from "./deliver-prepare.js";

const metadata = { precedingInputAnswer: true } as const;
const voice = { text: " \n ", mediaUrl: "https://example.test/voice.ogg", audioAsVoice: true };

describe("outbound preparation metadata", () => {
  it.each([
    ["flattened details", "<details><summary>More</summary>Body</details>", "**More**\n\nBody"],
    ["changed sanitized text", "Before.", "After."],
    ["unchanged sanitized text", "Ready café 世界.", "Ready café 世界."],
    ["message hook visible-text rewrite", "Before.", "After."],
    ["message hook spoken-text rewrite", "Before.", "After."],
  ])("preserves reply metadata through %s", async (name, before, after) => {
    const spoken = name === "message hook spoken-text rewrite";
    const hooked = name.startsWith("message hook");
    const payload: ReplyPayload = spoken ? { ...voice, spokenText: before } : { text: before };
    const expectedPayload = spoken ? { ...voice, text: "", spokenText: after } : { text: after };
    const input = setReplyPayloadMetadata({ ...payload }, metadata);
    const deliveryInput = spoken ? normalizeEmptyPayloadForDelivery(input) : input;
    assert(deliveryInput);
    if (spoken) {
      expect(deliveryInput).toEqual({ ...payload, text: "" });
    }
    const send = vi.fn(async () => {
      throw new Error("Preparation must not send to the transport");
    });
    const plugin = createOutboundTestPlugin({
      id: "metadata-test",
      outbound: {
        deliveryMode: "direct",
        sendText: send,
        sendMedia: send,
        ...(name === "flattened details" ? {} : { preserveMarkdownDetails: () => true }),
        ...(name.includes("sanitized") ? { sanitizeText: () => after } : {}),
      },
    });
    const registry = createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]);
    if (hooked) {
      addTestHook({
        registry,
        pluginId: plugin.id,
        hookName: "message_sending",
        handler: () => ({ content: after }),
      });
    }
    const batch = await withPluginRuntimeRegistryScope(registry, () =>
      prepareOutboundPayloadBatch(
        { cfg: {}, channel: plugin.id, to: "test-recipient", payloads: [deliveryInput] },
        { hookRunner: createHookRunner(registry) },
      ),
    );
    expect(batch.entries).toHaveLength(1);
    const entry = batch.entries[0];
    assert(entry?.status === "accepted", "Expected one accepted payload");
    expect(entry.payload).toEqual(expectedPayload);
    expect(getReplyPayloadMetadata(entry.payload)).toEqual(metadata);
    expect(input).toEqual(payload);
    expect(getReplyPayloadMetadata(input)).toEqual(metadata);
    expect(send).not.toHaveBeenCalled();
  });

  it("suppresses whitespace-only payloads without mutating the source", () => {
    const input = setReplyPayloadMetadata({ text: " \n " }, metadata);
    expect(normalizeEmptyPayloadForDelivery(input)).toBeNull();
    expect(input.text).toBe(" \n ");
    expect(getReplyPayloadMetadata(input)).toEqual(metadata);
  });
});
