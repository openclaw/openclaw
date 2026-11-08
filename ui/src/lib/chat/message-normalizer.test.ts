// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isToolCallContentType,
  isToolResultContentType,
} from "../../../../src/chat/tool-content.js";
import { resolveMessageDisplayMarkdown } from "./message-display.ts";
import {
  isStandaloneToolMessageForDisplay,
  isToolResultMessage,
  normalizeMessage,
  normalizeMessageFacts,
} from "./message-normalizer.ts";

const canvasPreview = { kind: "canvas", surface: "assistant_message", render: "url" };

function canvas(preview: Record<string, unknown>, rawText: string | null = null) {
  return { type: "canvas", preview: { ...canvasPreview, ...preview }, rawText };
}

function attachment(fields: Record<string, unknown>, type = "attachment") {
  return { type, attachment: fields };
}

const media = (url: string, kind: string, label: string, mimeType?: string) =>
  attachment({ url, kind, label, ...(mimeType ? { mimeType } : {}) });
const text = (value: string) => ({ type: "text", text: value });

function assistant(content: unknown, fields: Record<string, unknown> = {}) {
  return normalizeMessage({ role: "assistant", content, ...fields });
}

function user(fields: Record<string, unknown>) {
  return normalizeMessage({ role: "user", ...fields });
}

const audioSource = (source: Record<string, unknown>) => ({
  type: "audio",
  label: "clip.mp3",
  source: { media_type: "audio/mpeg", ...source },
});
const voice = {
  url: "/media/voice",
  artifactId: "audio-artifact",
  mimeType: "audio/x-caf",
  playback: "transcode",
  sizeBytes: 4096,
  durationMs: 2345,
  isVoiceNote: true,
};
const dimensions = { sizeBytes: Infinity, durationMs: Infinity, width: Infinity, height: Infinity };
const canvasFields = { url: "/canvas/one", sandbox: "scripts", boardWidgetName: "widget" };
const image = attachment({
  url: "~/Pictures/test image.png",
  kind: "image",
  label: "test image.png",
  mimeType: "image/png",
  width: 1280,
  height: 720,
});
const failures = [
  media("/media/deploy.yaml", "document", "deploy.yaml", "application/yaml"),
  ...[
    ["unsupported-format", "settings.toml", "application/toml"],
    ["delivery-failed", "bundle.7z", "application/x-7z-compressed"],
    ["file-too-large", "orders-large.zip", "application/zip"],
  ].map(([code, label, mimeType]) =>
    attachment({ code, kind: "document", label, mimeType }, "attachment_error"),
  ),
];

describe("message-normalizer", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["assistant", "user"])(
    "omits only confirmed assistant companion blocks for %s",
    (role) => {
      const notice = {
        type: "text",
        text: "Operational status",
        openclawFallback: true,
      };
      const answer = { type: "text", text: "The work continued." };
      const ordinary = { type: "text", text: "Other status", openclawStatusNotice: true };
      const source = { role, content: [notice, answer, ordinary] };
      const normalized = normalizeMessage(source);
      expect(
        normalized.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n"),
      ).toBe([...(role === "user" ? [notice.text] : []), answer.text, ordinary.text].join("\n"));
      expect(source.content).toEqual([notice, answer, ordinary]);
    },
  );

  it("degrades missing transcript entries to an empty unknown message", () => {
    expect(normalizeMessage(undefined)).toMatchObject({ role: "unknown", content: [] });
    expect(isToolResultMessage(undefined)).toBe(false);
    expect(isStandaloneToolMessageForDisplay(undefined)).toBe(false);
  });

  it.each([
    ["TOOL_RESULT", true, true],
    [" toolResult ", false, false],
  ])("classifies role %j independently of malformed content", (role, result, standalone) => {
    const message = { role, content: [null, { text: 7 }] };
    expect(isToolResultMessage(message)).toBe(result);
    expect(isStandaloneToolMessageForDisplay(message)).toBe(standalone);
  });

  it.each([
    [
      "Responses text after malformed blocks",
      [null, { type: "output_text", text: "Visible answer" }],
      [text("Visible answer")],
    ],
    [
      "base64 audio",
      [audioSource({ type: "base64", data: "//uQAA==" })],
      [media("data:audio/mpeg;base64,//uQAA==", "audio", "clip.mp3", "audio/mpeg")],
    ],
    [
      "URL audio",
      [audioSource({ type: "url", url: "/tmp/clip.mp3" })],
      [media("/tmp/clip.mp3", "audio", "clip.mp3", "audio/mpeg")],
    ],
    [
      "managed voice metadata",
      [{ type: "audio", fileName: "voice.caf", ...voice }],
      [attachment({ ...voice, kind: "audio", label: "voice.caf" })],
    ],
    [
      "embed shortcodes",
      'Here.\n[embed ref="cv_status" title="Status" height="320" /]',
      [
        text("Here."),
        canvas({
          viewId: "cv_status",
          url: "/__openclaw__/canvas/documents/cv_status/index.html",
          title: "Status",
          preferredHeight: 320,
        }),
      ],
    ],
    [
      "finite dimensions only",
      [
        canvas({ ...canvasFields, preferredHeight: Infinity }, "raw"),
        { type: "video", url: "/media/clip", ...dimensions },
        attachment({ kind: "document", url: "/media/document", label: "Document", ...dimensions }),
      ],
      [
        canvas(canvasFields, "raw"),
        media("/media/clip", "video", "Video"),
        media("/media/document", "document", "Document"),
      ],
    ],
    [
      "MEDIA paths without filename leakage",
      "Before\nMEDIA:media://inbound/%E9%9B%AA.pdf\nAfter",
      [
        text("Before"),
        media("media://inbound/%E9%9B%AA.pdf", "document", "雪.pdf", "application/pdf"),
        text("After"),
      ],
    ],
    ["image dimensions", [image], [image]],
    ["named failures beside delivered attachments", failures, failures],
  ])("normalizes %s", (_name, input, expected) => {
    expect(assistant(structuredClone(input)).content).toEqual(expected);
  });

  it("keeps structured size failures instead of the text-only client fallback", () => {
    const failure = attachment(
      { code: "file-too-large", kind: "document", label: "orders-large.zip" },
      "attachment_error",
    );
    expect(
      assistant([text("Created the export."), failure], {
        text: "Created the export.\norders-large.zip is too large to attach.",
      }).content,
    ).toEqual([text("Created the export."), failure]);
  });

  it("normalizes mixed text, thinking, and tool content without a standalone tool envelope", () => {
    const tool = { type: "tool_use", name: "bash", args: { command: "ls" } };
    const thinking = { type: "thinking", thinking: "Checking." };
    const message = {
      role: "assistant",
      content: [null, text("Result"), tool, thinking],
    };
    expect(isStandaloneToolMessageForDisplay(message)).toBe(false);
    expect(normalizeMessage(message)).toMatchObject({
      role: "toolResult",
      content: [text("Result"), tool, thinking],
    });
  });

  it("reuses retained messages and normalizes replacement snapshots afresh", () => {
    const message = { role: "assistant", content: "answer", timestamp: 2 };
    const initial = normalizeMessage(message);
    initial.content.forEach(Object.freeze);
    Object.freeze(initial.content);
    Object.freeze(initial);
    expect(normalizeMessage(message)).toBe(initial);
    const replacement = normalizeMessage({ ...message, content: "finished answer" });
    expect(replacement).not.toBe(initial);
    expect(replacement.content).toEqual([text("finished answer")]);
    expect(initial.content).toEqual([text("answer")]);
  });

  it.each([
    {
      name: "Alice attribution and an explicit reply",
      message: {
        role: "user",
        content: "Hello",
        __openclaw: {
          senderIdentity: { type: "profile", id: "alice" },
          senderName: "Alice",
          replyToId: "earlier-message",
          replyToPreview: { text: "Earlier question", senderLabel: "Bob" },
        },
      },
      estimatedContentSize: 22,
    },
    {
      name: "current reply with ordered media and a canvas",
      message: {
        role: "assistant",
        content: [
          text("Before\nMEDIA:/media/plot.png\nAfter"),
          { type: "image", url: "/media/image.png" },
          canvas(canvasFields),
          { type: "thinking", thinking: "Internal reasoning" },
        ],
        openclawDelivery: { replyToCurrent: true },
      },
      estimatedContentSize: 224,
    },
    {
      name: "internal text spanning block boundaries",
      message: { role: "assistant", content: [text("<think>hidden"), text("</think>")] },
      estimatedContentSize: 44,
    },
    {
      name: "tool aliases without visible content",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "exec", input: { command: "pwd" } },
          { type: "toolResult", text: "done" },
        ],
      },
      estimatedContentSize: 0,
    },
    {
      name: "oversized placeholder without text",
      message: {
        role: "assistant",
        content: "",
        __openclaw: { truncated: true, reason: "oversized" },
      },
      estimatedContentSize: 0,
    },
    {
      name: "empty current reply",
      message: { role: "assistant", content: "", openclawDelivery: { replyToCurrent: true } },
      estimatedContentSize: 0,
    },
    {
      name: "catalog text keeps literal directives",
      message: {
        role: "assistant",
        content: "MEDIA:/not-an-attachment.png",
        __openclaw: { catalogSource: true },
      },
      estimatedContentSize: 22,
    },
    {
      name: "heading, blank line and fenced code height",
      message: { role: "assistant", content: "## Heading\n\n```ts\nconst n = 1;\n```\n" },
      estimatedContentSize: 102,
    },
  ])(
    "keeps compact facts equal to full normalization: $name",
    ({ message, estimatedContentSize }) => {
      const source = { ...message, timestamp: 42 };
      const facts = normalizeMessageFacts(source);
      const { content, ...metadata } = normalizeMessage(source);
      expect(facts).toEqual({
        ...metadata,
        hasContent: content.length > 0,
        hasText: content.some((item) => item.type === "text"),
        hasDisplayText: Boolean(
          resolveMessageDisplayMarkdown(source, { ...metadata, content }).trim(),
        ),
        hasNonTextContent: content.some(
          (item) =>
            item.type !== "text" &&
            item.type !== "thinking" &&
            !isToolCallContentType(item.type) &&
            !isToolResultContentType(item.type),
        ),
        canvasPreviews: content.flatMap((item) => (item.type === "canvas" ? [item.preview] : [])),
        estimatedContentSize,
      });
      const alreadyNormalized = structuredClone(source);
      normalizeMessage(alreadyNormalized);
      expect(normalizeMessageFacts(alreadyNormalized)).toEqual(facts);
    },
  );

  it("does not cache a missing timestamp's clock fallback", () => {
    vi.useFakeTimers();
    const message = { role: "assistant", content: "answer" };
    vi.setSystemTime(100);
    const first = normalizeMessage(message);
    const firstFacts = normalizeMessageFacts(message);
    vi.setSystemTime(200);
    const second = normalizeMessage(message);
    const secondFacts = normalizeMessageFacts(message);
    expect([first.timestamp, second.timestamp]).toEqual([100, 200]);
    expect([firstFacts.timestamp, secondFacts.timestamp]).toEqual([100, 200]);
    expect(second).not.toBe(first);
    expect(secondFacts).not.toBe(firstFacts);
  });

  it("keeps user directives literal", () => {
    const literal = "MEDIA:/tmp/example.png\n[[reply_to_current]]";
    const result = user({ text: literal });
    expect(result.content).toEqual([text(literal)]);
    expect([result.replyTarget, result.audioAsVoice]).toEqual([undefined, undefined]);
  });

  it.each([
    ["assistant", "input_text", "text"],
    ["assistant", "output_text", "text"],
    ["user", "input_text", "text"],
    ["user", "output_text", "output_text"],
    ["custom", "input_text", "input_text"],
    ["custom", "output_text", "output_text"],
  ])("classifies %s %s as %s", (role, type, expectedType) => {
    expect(normalizeMessage({ role, content: [{ type, text: "Answer" }] }).content).toMatchObject([
      { type: expectedType, text: "Answer" },
    ]);
  });

  it("does not turn non-assistant structured audio into attachments", () => {
    expect(user({ content: [audioSource({ type: "base64", data: "//uQAA==" })] }).content).toEqual(
      [],
    );
  });

  it("extracts ordered MEDIA attachments with persisted delivery facts", () => {
    const result = assistant(
      "Intro\nMEDIA:https://example.com/image.png\nOutro\nMEDIA:https://example.com/voice.ogg",
      { openclawDelivery: { audioAsVoice: true, replyToId: "thread-123" } },
    );
    expect(result.replyTarget).toEqual({ kind: "id", id: "thread-123" });
    expect(result.audioAsVoice).toBe(true);
    expect(result.content).toEqual([
      text("Intro"),
      media("https://example.com/image.png", "image", "image.png", "image/png"),
      text("Outro"),
      attachment({
        ...media("https://example.com/voice.ogg", "audio", "voice.ogg", "audio/ogg").attachment,
        isVoiceNote: true,
      }),
    ]);
  });

  it.each([
    ["", { replyToCurrent: true }, []],
    [
      [{ type: "audio", url: "/media/voice.ogg" }],
      { replyToCurrent: true, replyToId: "  " },
      [media("/media/voice.ogg", "audio", "Audio")],
    ],
  ])("keeps current reply facts independently of content %j", (input, delivery, content) => {
    const result = assistant(input, { openclawDelivery: delivery });
    expect(result.replyTarget).toEqual({ kind: "current" });
    expect(result.content).toStrictEqual(content);
  });

  it("prefers trimmed transcript reply metadata over delivery facts", () => {
    const result = assistant([{ type: "image", url: "/media/image.png" }], {
      openclawDelivery: { replyToId: "delivery-target", replyToCurrent: true },
      __openclaw: { replyToId: "  transcript-target  " },
    });
    expect(result.replyTarget).toEqual({ kind: "id", id: "transcript-target" });
  });

  it.each([
    [{ __openclaw: { senderId: "alice@example.com" } }, "alice", { id: "alice@example.com" }],
    [
      { senderLabel: "steipete (c3e32452-0467-47e5-aafa-233cd5dae29f)" },
      "steipete",
      { name: "steipete" },
    ],
  ])("formats sender attribution %j without inventing identity", (fields, label, sender) => {
    const result = user({ content: "Hello", ...fields });
    expect(result.senderLabel).toBe(label);
    expect(result.sender).toEqual(sender);
  });

  it("requires typed provenance for a profile avatar", () => {
    const identity = { type: "profile", id: "shared-id" };
    const sender = { id: "shared-id", name: "Person" };
    const url = "/api/users/shared-id/avatar";
    const metadata = { senderId: sender.id, senderName: sender.name, senderProfileAvatarUrl: url };
    const attributed = user({
      content: "hello",
      __openclaw: { ...metadata, senderIdentity: identity },
    });
    expect(attributed.senderLabel).toBe("Person");
    expect(attributed.sender).toEqual({ ...sender, profileAvatarUrl: url, identity });
    expect(user({ content: "hello", __openclaw: metadata }).sender).toEqual(sender);
  });

  it.each([
    [
      {
        sessionKey: " a ",
        agentId: " b\t",
        label: " c\t",
        extra: "discarded",
      },
      { sessionKey: "a", agentId: "b", label: "c" },
    ],
    [{ agentId: "main" }, { agentId: "main" }],
    [{ sessionKey: "agent:main:main", label: "  " }, { sessionKey: "agent:main:main" }],
    [{ sessionKey: "  ", agentId: "\t" }, undefined],
  ])("normalizes forwarded source attribution %j", (source, expected) => {
    const result = assistant("Forwarded report", { senderSession: source });
    expect(result.senderSession).toStrictEqual(expected);
  });
});
