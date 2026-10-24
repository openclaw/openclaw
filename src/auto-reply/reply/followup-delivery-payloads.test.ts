// Tests payload visibility, threading, and source-send deduplication.
import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery-payloads.js";

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
  getLoadedChannelPlugin: () => undefined,
}));

function resolve(
  payloads: Parameters<typeof resolveFollowupDeliveryPayloads>[0]["payloads"],
  options: Omit<Parameters<typeof resolveFollowupDeliveryPayloads>[0], "cfg" | "payloads"> = {},
) {
  return resolveFollowupDeliveryPayloads({ cfg: {}, payloads, ...options });
}
const answer = "The answer remains unchanged.";
const sideReply = (question: string, text: string) => `BTW\nQuestion: ${question}\n\n${text}`;

function slackTarget(text: string) {
  return { tool: "slack", provider: "slack", to: "channel:C1", threadId: "111.000", text };
}

describe("resolveFollowupDeliveryPayloads", () => {
  it("drops payloads without visible content", () => {
    expect(resolve([{ text: " \t\n " }, { text: "", mediaUrls: [" "] }])).toEqual([]);
  });

  it("keeps rich content when text is blank", () => {
    expect(resolve([{ text: " ", mediaUrl: "file:///tmp/reply.png" }])).toMatchObject([
      { mediaUrl: "file:///tmp/reply.png" },
    ]);
  });

  it("drops a durable reasoning payload when reasoningPayloadsEnabled is not set", () => {
    expect(
      resolve([{ text: "internal reasoning", isReasoning: true }, { text: "final answer" }]),
    ).toEqual([{ text: "final answer" }]);
  });

  it("drops commentary unless its delivery lane is enabled", () => {
    const payload = { text: "internal commentary", isCommentary: true };
    expect(resolve([payload])).toEqual([]);
    expect(resolve([payload], { commentaryPayloadsEnabled: true })).toMatchObject([payload]);
  });

  it("drops heartbeat ack payloads without media", () => {
    expect(resolve([{ text: "HEARTBEAT_OK" }])).toStrictEqual([]);
  });

  it("preserves transcript ownership when stripping heartbeat text", () => {
    const payload = setReplyPayloadMetadata(
      { text: "HEARTBEAT_OK still working" },
      { assistantTranscriptOwned: true },
    );

    const [resolved] = resolve([payload]);

    expect(getReplyPayloadMetadata(resolved ?? {})).toEqual({
      assistantTranscriptOwned: true,
      replyDelivery: { replyToMode: "all" },
    });
  });

  it("does not dedupe same-channel text sent to a different routed thread", () => {
    expect(
      resolve([{ text: "thread reply" }], {
        messageProvider: "slack",
        originatingTo: "channel:C1",
        originatingThreadId: "222.000",
        sentTexts: ["thread reply"],
        sentTargets: [slackTarget("thread reply")],
      }),
    ).toEqual([{ text: "thread reply" }]);
  });

  it.each([
    [answer, "What about the new case?", answer, false],
    ["323", "What is 17 * 19?", sideReply("What is 17 * 19?", "323"), true],
    [answer, "What about the second case?", sideReply("What about the first case?", answer), false],
  ] as const)(
    "dedupes side-question %s for %s against %s (duplicate=%s)",
    (text, question, sentText, duplicate) => {
      const payload = { text, btw: { question } };
      const delivered = vi.fn();
      expect(
        resolve([payload], {
          messageProvider: "slack",
          originatingTo: "channel:C1",
          originatingThreadId: "111.000",
          sentTargets: [slackTarget(sentText)],
          onDeliveredTerminalDuplicate: delivered,
        }),
      ).toEqual(duplicate ? [] : [payload]);
      expect(delivered).toHaveBeenCalledTimes(duplicate ? 1 : 0);
    },
  );

  it("delivers distinct replies when originating channel resolves the provider", () => {
    expect(
      resolve([{ text: "hello world!" }], {
        messageProvider: "heartbeat",
        originatingChannel: "telegram",
        originatingTo: "268300329",
        sentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });
});
