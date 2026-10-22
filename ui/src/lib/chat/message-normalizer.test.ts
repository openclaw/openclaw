// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isStandaloneToolMessageForDisplay,
  isToolResultMessage,
  normalizeMessage,
} from "./message-normalizer.ts";

const canvasPreview = { kind: "canvas", surface: "assistant_message", render: "url" };

function canvas(preview: Record<string, unknown>, rawText: string | null = null) {
  return { type: "canvas", preview: { ...canvasPreview, ...preview }, rawText };
}

function attachment(fields: Record<string, unknown>, type = "attachment") {
  return { type, attachment: fields };
}

function assistant(content: unknown, fields: Record<string, unknown> = {}) {
  return normalizeMessage({ role: "assistant", content, ...fields });
}

function user(fields: Record<string, unknown>) {
  return normalizeMessage({ role: "user", ...fields });
}

describe("message-normalizer", () => {
  afterEach(() => vi.useRealTimers());

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

  it("keeps Responses text after malformed content blocks", () => {
    expect(assistant([null, { type: "output_text", text: "Visible answer" }]).content).toEqual([
      { type: "text", text: "Visible answer" },
    ]);
  });

  it("normalizes mixed text, thinking, and tool content without a standalone tool envelope", () => {
    const message = {
      role: "assistant",
      content: [
        null,
        { type: "text", text: "Result" },
        { type: "tool_use", name: "bash", args: { command: "ls" } },
        { type: "thinking", thinking: "Checking." },
      ],
    };
    expect(isStandaloneToolMessageForDisplay(message)).toBe(false);
    const result = normalizeMessage(message);
    expect(result.role).toBe("toolResult");
    expect(result.content).toEqual([
      { type: "text", text: "Result", name: undefined, args: undefined },
      { type: "tool_use", text: undefined, name: "bash", args: { command: "ls" } },
      { type: "thinking", thinking: "Checking." },
    ]);
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
    expect(replacement.content).toEqual([{ type: "text", text: "finished answer" }]);
    expect(initial.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("does not cache a missing timestamp's clock fallback", () => {
    vi.useFakeTimers();
    const message = { role: "assistant", content: "answer" };
    vi.setSystemTime(100);
    const first = normalizeMessage(message);
    vi.setSystemTime(200);
    const second = normalizeMessage(message);
    expect([first.timestamp, second.timestamp]).toEqual([100, 200]);
    expect(second).not.toBe(first);
  });

  it("keeps user directives literal", () => {
    const text = "MEDIA:/tmp/example.png\n[[reply_to_current]]";
    const result = user({ text });
    expect(result.content).toEqual([{ type: "text", text }]);
    expect([result.replyTarget, result.audioAsVoice]).toEqual([undefined, undefined]);
  });

  it("accepts assistant Responses input blocks but rejects user output blocks", () => {
    expect(assistant([{ type: "input_text", text: "Answer" }]).content).toEqual([
      { type: "text", text: "Answer" },
    ]);
    expect(user({ content: [{ type: "output_text", text: "Answer" }] }).content).not.toContainEqual(
      { type: "text", text: "Answer" },
    );
  });

  it.each([
    { source: { type: "base64", data: "//uQAA==" }, url: "data:audio/mpeg;base64,//uQAA==" },
    { source: { type: "url", url: "/tmp/clip.mp3" }, url: "/tmp/clip.mp3" },
  ])("normalizes structured $source.type audio", ({ source, url }) => {
    expect(
      assistant([
        { type: "audio", label: "clip.mp3", source: { ...source, media_type: "audio/mpeg" } },
      ]).content,
    ).toEqual([attachment({ url, kind: "audio", label: "clip.mp3", mimeType: "audio/mpeg" })]);
  });

  it("preserves managed audio playback, voice, and artifact metadata", () => {
    const metadata = {
      url: "/media/voice",
      artifactId: "audio-artifact",
      mimeType: "audio/x-caf",
      playback: "transcode",
      sizeBytes: 4096,
      durationMs: 2345,
      isVoiceNote: true,
    };
    expect(assistant([{ type: "audio", fileName: "voice.caf", ...metadata }]).content).toEqual([
      attachment({ ...metadata, kind: "audio", label: "voice.caf" }),
    ]);
  });

  it("does not turn non-assistant structured audio into attachments", () => {
    expect(
      user({
        content: [
          { type: "audio", source: { type: "base64", media_type: "audio/mpeg", data: "//uQAA==" } },
        ],
      }).content,
    ).toEqual([]);
  });

  it("expands embed shortcodes into canvas previews", () => {
    expect(
      assistant('Here.\n[embed ref="cv_status" title="Status" height="320" /]').content,
    ).toEqual([
      { type: "text", text: "Here." },
      canvas({
        viewId: "cv_status",
        url: "/__openclaw__/canvas/documents/cv_status/index.html",
        title: "Status",
        preferredHeight: 320,
      }),
    ]);
  });

  it("keeps canonical canvas metadata instead of its shortcode copy", () => {
    const canonical = canvas(
      {
        url: "/__openclaw__/canvas/documents/cv_widget/index.html",
        sandbox: "scripts",
        boardWidgetName: "saved-widget",
      },
      "original tool result",
    );
    expect(
      assistant([
        { type: "text", text: 'Ready.\n[embed ref="cv_widget" title="Widget" /]' },
        canonical,
      ]).content,
    ).toEqual([{ type: "text", text: "Ready." }, canonical]);
  });

  it("extracts ordered MEDIA attachments with persisted delivery facts", () => {
    const result = assistant(
      "Intro\nMEDIA:https://example.com/image.png\nOutro\nMEDIA:https://example.com/voice.ogg",
      { openclawDelivery: { audioAsVoice: true, replyToId: "thread-123" } },
    );
    expect(result.replyTarget).toEqual({ kind: "id", id: "thread-123" });
    expect(result.audioAsVoice).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Intro" },
      attachment({
        url: "https://example.com/image.png",
        kind: "image",
        label: "image.png",
        mimeType: "image/png",
      }),
      { type: "text", text: "Outro" },
      attachment({
        url: "https://example.com/voice.ogg",
        kind: "audio",
        label: "voice.ogg",
        mimeType: "audio/ogg",
        isVoiceNote: true,
      }),
    ]);
  });

  it("omits non-finite canvas and media dimensions", () => {
    const dimensions = {
      sizeBytes: Infinity,
      durationMs: Infinity,
      width: Infinity,
      height: Infinity,
    };
    expect(
      assistant([
        canvas({ url: "/canvas/one", preferredHeight: Infinity }),
        { type: "video", url: "/media/clip", ...dimensions },
        attachment({
          kind: "document",
          url: "/media/document",
          label: "Document",
          ...dimensions,
        }),
      ]).content,
    ).toEqual([
      canvas({ url: "/canvas/one" }),
      attachment({ kind: "video", url: "/media/clip", label: "Video" }),
      attachment({ kind: "document", url: "/media/document", label: "Document" }),
    ]);
  });

  it("classifies MEDIA paths without leaking filename text", () => {
    const url = "/tmp/Shopping report.pdf";
    expect(assistant(`Before\nMEDIA:${url}\nAfter`).content).toEqual([
      { type: "text", text: "Before" },
      attachment({
        url,
        label: "Shopping report.pdf",
        kind: "document",
        mimeType: "application/pdf",
      }),
      { type: "text", text: "After" },
    ]);
  });

  it("preserves structured image attachment dimensions", () => {
    const content = [
      attachment({
        url: "~/Pictures/test image.png",
        kind: "image",
        label: "test image.png",
        mimeType: "image/png",
        width: 1280,
        height: 720,
      }),
    ];
    expect(assistant(structuredClone(content)).content).toEqual(content);
  });

  it("preserves named failures beside delivered attachments", () => {
    const content = [
      attachment({
        url: "/media/deploy.yaml",
        kind: "document",
        label: "deploy.yaml",
        mimeType: "application/yaml",
      }),
      ...[
        ["unsupported-format", "settings.toml", "application/toml"],
        ["delivery-failed", "bundle.7z", "application/x-7z-compressed"],
      ].map(([code, label, mimeType]) =>
        attachment({ code, kind: "document", label, mimeType }, "attachment_error"),
      ),
    ];
    expect(assistant(structuredClone(content)).content).toEqual(content);
  });

  it("keeps a fact-only reply target with empty content", () => {
    const result = assistant("", { openclawDelivery: { replyToCurrent: true } });
    expect(result.replyTarget).toEqual({ kind: "current" });
    expect(result.content).toStrictEqual([]);
  });

  it("keeps a media-only current reply when the explicit reply ID is blank", () => {
    const result = assistant([{ type: "audio", url: "/media/voice.ogg" }], {
      openclawDelivery: { replyToCurrent: true, replyToId: "  " },
    });
    expect(result.replyTarget).toEqual({ kind: "current" });
    expect(result.content).toEqual([
      attachment({ kind: "audio", url: "/media/voice.ogg", label: "Audio" }),
    ]);
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
    const metadata = {
      senderId: "shared-id",
      senderName: "Person",
      senderProfileAvatarUrl: "/api/users/shared-id/avatar",
    };
    const attributed = user({
      content: "hello",
      __openclaw: { ...metadata, senderIdentity: identity },
    });
    expect(attributed.senderLabel).toBe("Person");
    expect(attributed.sender).toEqual({
      id: "shared-id",
      name: "Person",
      profileAvatarUrl: metadata.senderProfileAvatarUrl,
      identity,
    });
    expect(user({ content: "hello", __openclaw: metadata }).sender).toEqual({
      id: "shared-id",
      name: "Person",
    });
  });

  it.each([
    [
      {
        sessionKey: " agent:source:main ",
        agentId: " source\t",
        label: " Daily report\t",
        extra: "discarded",
      },
      { sessionKey: "agent:source:main", agentId: "source", label: "Daily report" },
    ],
    [{ agentId: "main" }, { agentId: "main" }],
    [{ sessionKey: "agent:main:main", label: "  " }, { sessionKey: "agent:main:main" }],
    [{ sessionKey: "  ", agentId: "\t" }, undefined],
  ])("normalizes forwarded source attribution %j", (source, expected) => {
    const result = assistant("Forwarded report", { senderSession: source });
    expect(result.senderSession).toStrictEqual(expected);
    expect(result.content).toEqual([{ type: "text", text: "Forwarded report" }]);
  });
});
