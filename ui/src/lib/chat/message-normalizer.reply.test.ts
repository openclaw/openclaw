// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeMessage } from "./message-normalizer.ts";

describe("message-normalizer reply targets", () => {
  it("uses persisted delivery facts for the current-message reply target", () => {
    const result = normalizeMessage({
      role: "assistant",
      content: "Reply body",
      openclawDelivery: { replyToCurrent: true },
    });

    expect(result.replyTarget).toEqual({ kind: "current" });
    expect(result.content).toEqual([{ type: "text", text: "Reply body" }]);
  });

  it.each([{ content: "" }, { content: [] }, { content: undefined }])(
    "keeps a fact-only reply target for $content content",
    ({ content }) => {
      const result = normalizeMessage({
        role: "assistant",
        content,
        openclawDelivery: { replyToCurrent: true },
      });

      expect(result.replyTarget).toEqual({ kind: "current" });
      expect(result.content).toStrictEqual([]);
    },
  );

  it.each([
    {
      name: "image without text",
      content: [{ type: "image", url: "/media/image.png" }],
      delivery: { replyToCurrent: true },
      target: { kind: "current" },
      types: ["image"],
    },
    {
      name: "document without text",
      content: [
        {
          type: "attachment",
          attachment: { kind: "document", url: "/media/report.pdf", label: "report.pdf" },
        },
      ],
      delivery: { replyToId: "  source-123  ", replyToCurrent: true },
      target: { kind: "id", id: "source-123" },
      types: ["attachment"],
    },
    {
      name: "audio without text",
      content: [{ type: "audio", url: "/media/voice.ogg" }],
      delivery: { replyToCurrent: true, replyToId: "  " },
      target: { kind: "current" },
      types: ["attachment"],
    },
    {
      name: "canvas without text",
      content: [
        {
          type: "canvas",
          preview: { kind: "canvas", render: "url", url: "/canvas/preview" },
        },
      ],
      delivery: { replyToId: "source-123" },
      target: { kind: "id", id: "source-123" },
      types: ["canvas"],
    },
    {
      name: "mixed image and text",
      content: [
        { type: "image", url: "/media/image.png" },
        { type: "text", text: "Caption" },
      ],
      delivery: { replyToId: "source-123", replyToCurrent: true },
      target: { kind: "id", id: "source-123" },
      types: ["image", "text"],
    },
  ])("preserves delivery reply targets for $name", ({ content, delivery, target, types }) => {
    const result = normalizeMessage({ role: "assistant", content, openclawDelivery: delivery });

    expect(result.replyTarget).toEqual(target);
    expect(result.content.map((item) => item.type)).toEqual(types);
  });

  it.each([{ replyToCurrent: true }, { replyToId: "delivery-target" }])(
    "prefers transcript reply metadata over delivery facts %j",
    (openclawDelivery) => {
      const result = normalizeMessage({
        role: "assistant",
        content: [{ type: "image", url: "/media/image.png" }],
        openclawDelivery,
        __openclaw: { replyToId: "  transcript-target  " },
      });

      expect(result.replyTarget).toEqual({ kind: "id", id: "transcript-target" });
    },
  );

  it.each(["user", "toolResult"])("ignores assistant delivery facts on %s media", (role) => {
    const result = normalizeMessage({
      role,
      content: [{ type: "image", url: "/media/image.png" }],
      openclawDelivery: { replyToId: "assistant-only" },
    });

    expect(result.replyTarget).toBeUndefined();
  });

  it("renders quoted delivery and TTS markers verbatim", () => {
    const text = "Use `[[reply_to_current]]` and `[[tts]]` literally.";
    const result = normalizeMessage({ role: "assistant", content: text });

    expect(result.replyTarget).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text }]);
  });
});
