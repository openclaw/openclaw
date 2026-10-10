// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { markInboundContextLabel } from "../../../../src/auto-reply/reply/inbound-context-marker.js";
import {
  isStandaloneToolMessageForDisplay,
  isToolResultMessage,
  normalizeMessage,
} from "./message-normalizer.ts";

const imageAttachment = {
  type: "attachment",
  attachment: {
    url: "https://example.com/image.png",
    kind: "image",
    label: "image.png",
    mimeType: "image/png",
  },
};
const canvasPreview = { kind: "canvas", surface: "assistant_message", render: "url" };
const senderMetadata = `${markInboundContextLabel("Sender:")}\n\`\`\`json\n{"label":"openclaw-control-ui","id":"openclaw-control-ui"}\n\`\`\``;

function assistant(content: unknown, fields: Record<string, unknown> = {}) {
  return normalizeMessage({ role: "assistant", content, ...fields });
}

describe("message-normalizer", () => {
  it("hides the stored subagent envelope in rendered user content without changing the source", () => {
    const text =
      "[Subagent Context] You are running as a subagent (depth 1/5). Complete the current [Subagent Task]; inherited conversation is background context, not your assignment.\n\n[Subagent Task]\n\nInvestigate Side chat.\n\nBegin. Execute the assigned task to completion.";
    const message = { role: "user", content: [{ type: "text", text }] };
    expect(normalizeMessage(message).content).toEqual([
      { type: "text", text: "Investigate Side chat." },
    ]);
    expect(message.content).toEqual([{ type: "text", text }]);
    expect(assistant(text).content).toEqual([{ type: "text", text }]);
  });

  afterEach(() => vi.useRealTimers());

  it("degrades missing transcript entries to an empty unknown message", () => {
    expect(normalizeMessage(undefined)).toMatchObject({ role: "unknown", content: [] });
    expect(isToolResultMessage(undefined)).toBe(false);
    expect(isStandaloneToolMessageForDisplay(undefined)).toBe(false);
  });

  it.each(["toolCallId", "tool_call_id", "toolUseId", "tool_use_id", "toolName", "tool_name"])(
    "requires a string-valued %s tool envelope",
    (field) => {
      const message = { role: "assistant", content: "Tool output", [field]: "" };
      expect(isStandaloneToolMessageForDisplay(message)).toBe(true);
      expect(isToolResultMessage(message)).toBe(false);
      expect(normalizeMessage(message).role).toBe("toolResult");
      expect(isStandaloneToolMessageForDisplay({ ...message, [field]: 7 })).toBe(false);
    },
  );

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

  it.each([
    { type: "toolcall", name: "Bash", arguments: { command: "pwd" } },
    { type: "tool_use", name: "Bash", input: { command: "pwd" } },
  ])("normalizes provider tool arguments from $type", (block) => {
    const result = assistant([block]);
    expect(result.role).toBe("toolResult");
    expect(result.content).toEqual([
      { type: block.type, text: undefined, name: "Bash", args: { command: "pwd" } },
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
    expect(first.timestamp).toBe(100);
    expect(second.timestamp).toBe(200);
    expect(second).not.toBe(first);
  });

  it.each([
    { text: "MEDIA:/tmp/example.png\n[[reply_to_current]]" },
    { content: [{ type: "text", text: "MEDIA:/tmp/example.png\n[[reply_to_current]]" }] },
  ])("keeps user directives literal in %j", (fields) => {
    const result = normalizeMessage({ role: "user", ...fields });
    expect(result.content).toEqual([
      { type: "text", text: "MEDIA:/tmp/example.png\n[[reply_to_current]]" },
    ]);
    expect(result.replyTarget).toBeUndefined();
    expect(result.audioAsVoice).toBeUndefined();
  });

  it("normalizes persisted user Responses input text", () => {
    expect(
      normalizeMessage({ role: "user", content: [{ type: "input_text", text: "Question" }] })
        .content,
    ).toEqual([{ type: "text", text: "Question", name: undefined, args: undefined }]);
  });

  it("accepts assistant Responses input blocks but rejects user output blocks", () => {
    expect(assistant([{ type: "input_text", text: "Answer" }]).content).toEqual([
      { type: "text", text: "Answer" },
    ]);
    expect(
      normalizeMessage({ role: "user", content: [{ type: "output_text", text: "Answer" }] })
        .content,
    ).not.toContainEqual({ type: "text", text: "Answer" });
  });

  it.each([
    { source: { type: "base64", data: "//uQAA==" }, url: "data:audio/mpeg;base64,//uQAA==" },
    { source: { type: "url", url: "/tmp/clip.mp3" }, url: "/tmp/clip.mp3" },
  ])("normalizes structured $source.type audio", ({ source, url }) => {
    expect(
      assistant([
        { type: "audio", label: "clip.mp3", source: { ...source, media_type: "audio/mpeg" } },
      ]).content,
    ).toEqual([
      {
        type: "attachment",
        attachment: { url, kind: "audio", label: "clip.mp3", mimeType: "audio/mpeg" },
      },
    ]);
  });

  it("preserves managed audio playback, voice, and artifact metadata", () => {
    expect(
      assistant([
        {
          type: "audio",
          url: "/media/voice",
          fileName: "voice.caf",
          artifactId: "audio-artifact",
          mimeType: "audio/x-caf",
          playback: "transcode",
          sizeBytes: 4096,
          durationMs: 2345,
          isVoiceNote: true,
        },
      ]).content,
    ).toEqual([
      {
        type: "attachment",
        attachment: {
          url: "/media/voice",
          kind: "audio",
          label: "voice.caf",
          artifactId: "audio-artifact",
          mimeType: "audio/x-caf",
          playback: "transcode",
          sizeBytes: 4096,
          durationMs: 2345,
          isVoiceNote: true,
        },
      },
    ]);
  });

  it("does not turn non-assistant structured audio into attachments", () => {
    expect(
      normalizeMessage({
        role: "user",
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
      {
        type: "canvas",
        preview: {
          ...canvasPreview,
          viewId: "cv_status",
          url: "/__openclaw__/canvas/documents/cv_status/index.html",
          title: "Status",
          preferredHeight: 320,
        },
        rawText: null,
      },
    ]);
  });

  it.each([
    {
      viewId: "cv_widget",
      url: "/__openclaw__/canvas/documents/cv_widget/index.html",
      sandbox: "strict",
    },
    { url: "/__openclaw__/canvas/documents/cv_widget/index.html", sandbox: "scripts" },
  ])("keeps canonical canvas metadata instead of its shortcode copy: %j", (identity) => {
    const preview = { ...canvasPreview, ...identity, boardWidgetName: "saved-widget" };
    expect(
      assistant([
        { type: "text", text: 'Ready.\n[embed ref="cv_widget" title="Widget" /]' },
        { type: "canvas", preview, rawText: "original tool result" },
      ]).content,
    ).toEqual([
      { type: "text", text: "Ready." },
      { type: "canvas", preview, rawText: "original tool result" },
    ]);
  });

  it("drops invalid canvas dashboard identity", () => {
    const result = assistant([
      {
        type: "canvas",
        preview: {
          ...canvasPreview,
          url: "/canvas/widget",
          boardWidgetName: "Invalid widget name",
        },
      },
    ]);
    expect(result.content).toEqual([
      { type: "canvas", preview: { ...canvasPreview, url: "/canvas/widget" }, rawText: null },
    ]);
  });

  it.each([
    '```text\n[embed ref="cv_status" /]\n```',
    "Use `[[reply_to_current]]` and `[[tts]]` literally.",
  ])("preserves literal shortcode text %j", (text) => {
    const result = assistant(text);
    expect(result.content).toEqual([{ type: "text", text }]);
    expect(result.replyTarget).toBeUndefined();
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
      imageAttachment,
      { type: "text", text: "Outro" },
      {
        type: "attachment",
        attachment: {
          url: "https://example.com/voice.ogg",
          kind: "audio",
          label: "voice.ogg",
          mimeType: "audio/ogg",
          isVoiceNote: true,
        },
      },
    ]);
  });

  it("preserves paragraph breaks and code indentation before an attachment", () => {
    const text =
      "Here is the code.\n\n```python\ndef run():\n    if ready:\n        return True\n```\n\nThe attachment is ready.";
    expect(assistant(`${text}\nMEDIA:https://example.com/image.png`).content).toEqual([
      { type: "text", text },
      imageAttachment,
    ]);
  });

  it("preserves paragraph separators around an attachment", () => {
    expect(assistant("First\n\t\nMEDIA:https://example.com/image.png\n\t\nSecond").content).toEqual(
      [{ type: "text", text: "First\n" }, imageAttachment, { type: "text", text: "Second" }],
    );
  });

  it("preserves canonical code fences with structured delivery facts", () => {
    const text = "```python\nvalue = 'a  b'\n``` not a close\nother = 'c  d'\n```";
    expect(
      assistant(`${text}\nMEDIA:https://example.com/image.png`, {
        openclawDelivery: { audioAsVoice: true, replyToCurrent: true },
      }).content,
    ).toEqual([{ type: "text", text }, imageAttachment]);
  });

  it.each(["audioAsVoice", "replyToCurrent"])(
    "rejects a delivery record with invalid %s",
    (field) => {
      const result = assistant("Visible answer", {
        openclawDelivery: {
          audioAsVoice: true,
          replyToCurrent: true,
          replyToId: "target",
          [field]: false,
        },
      });
      expect(result.content).toEqual([{ type: "text", text: "Visible answer" }]);
      expect(result).not.toHaveProperty("audioAsVoice");
      expect(result).not.toHaveProperty("replyTarget");
    },
  );

  it("omits non-finite canvas and media dimensions", () => {
    const dimensions = {
      sizeBytes: Infinity,
      durationMs: Infinity,
      width: Infinity,
      height: Infinity,
    };
    expect(
      assistant([
        {
          type: "canvas",
          preview: { ...canvasPreview, url: "/canvas/one", preferredHeight: Infinity },
        },
        { type: "video", url: "/media/clip", ...dimensions },
        {
          type: "attachment",
          attachment: {
            kind: "document",
            url: "/media/document",
            label: "Document",
            ...dimensions,
          },
        },
      ]).content,
    ).toEqual([
      { type: "canvas", preview: { ...canvasPreview, url: "/canvas/one" }, rawText: null },
      { type: "attachment", attachment: { kind: "video", url: "/media/clip", label: "Video" } },
      {
        type: "attachment",
        attachment: { kind: "document", url: "/media/document", label: "Document" },
      },
    ]);
  });

  it.each([
    {
      url: "https://cdn.example/clip%2Emp4",
      label: "clip%2Emp4",
      kind: "video",
      mimeType: "video/mp4",
    },
    {
      url: "/__openclaw__/media/voice%2Eogg?mediaTicket=signed",
      label: "voice%2Eogg?mediaTicket=signed",
      kind: "audio",
      mimeType: "audio/ogg",
    },
    {
      url: "/tmp/Shopping report.pdf",
      label: "Shopping report.pdf",
      kind: "document",
      mimeType: "application/pdf",
    },
    { url: "render final.png", label: "render final.png", kind: "image", mimeType: "image/png" },
  ])(
    "classifies MEDIA path $url without leaking filename text",
    ({ url, label, kind, mimeType }) => {
      expect(assistant(`Before\nMEDIA:${url}\nAfter`).content).toEqual([
        { type: "text", text: "Before" },
        { type: "attachment", attachment: { url, label, kind, mimeType } },
        { type: "text", text: "After" },
      ]);
    },
  );

  it("preserves structured image attachment dimensions", () => {
    expect(
      assistant([
        {
          type: "attachment",
          attachment: {
            url: "~/Pictures/test image.png",
            kind: "image",
            label: "test image.png",
            mimeType: "image/png",
            width: 1280,
            height: 720,
          },
        },
      ]).content,
    ).toEqual([
      {
        type: "attachment",
        attachment: {
          url: "~/Pictures/test image.png",
          kind: "image",
          label: "test image.png",
          mimeType: "image/png",
          width: 1280,
          height: 720,
        },
      },
    ]);
  });

  it("preserves named failures beside delivered attachments", () => {
    expect(
      assistant([
        {
          type: "attachment",
          attachment: {
            url: "/media/deploy.yaml",
            kind: "document",
            label: "deploy.yaml",
            mimeType: "application/yaml",
          },
        },
        {
          type: "attachment_error",
          attachment: {
            code: "unsupported-format",
            kind: "document",
            label: "settings.toml",
            mimeType: "application/toml",
          },
        },
        {
          type: "attachment_error",
          attachment: {
            code: "delivery-failed",
            kind: "document",
            label: "bundle.7z",
            mimeType: "application/x-7z-compressed",
          },
        },
      ]).content,
    ).toEqual([
      {
        type: "attachment",
        attachment: {
          url: "/media/deploy.yaml",
          kind: "document",
          label: "deploy.yaml",
          mimeType: "application/yaml",
        },
      },
      {
        type: "attachment_error",
        attachment: {
          code: "unsupported-format",
          kind: "document",
          label: "settings.toml",
          mimeType: "application/toml",
        },
      },
      {
        type: "attachment_error",
        attachment: {
          code: "delivery-failed",
          kind: "document",
          label: "bundle.7z",
          mimeType: "application/x-7z-compressed",
        },
      },
    ]);
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
      {
        type: "attachment",
        attachment: { kind: "audio", url: "/media/voice.ogg", label: "Audio" },
      },
    ]);
  });

  it("prefers trimmed transcript reply metadata over delivery facts", () => {
    const result = assistant([{ type: "image", url: "/media/image.png" }], {
      openclawDelivery: { replyToId: "delivery-target", replyToCurrent: true },
      __openclaw: { replyToId: "  transcript-target  " },
    });
    expect(result.replyTarget).toEqual({ kind: "id", id: "transcript-target" });
  });

  it("ignores assistant delivery facts on user media", () => {
    expect(
      normalizeMessage({
        role: "user",
        content: [{ type: "image", url: "/media/image.png" }],
        openclawDelivery: { replyToId: "assistant-only" },
      }).replyTarget,
    ).toBeUndefined();
  });

  it.each([
    {
      role: "assistant",
      content: `${senderMetadata}\n\nVisible reply`,
      expected: [{ type: "text", text: "Visible reply" }],
    },
    { role: "system", content: senderMetadata, expected: [] },
  ])("strips stamped sender metadata from $role display", ({ role, content, expected }) => {
    expect(normalizeMessage({ role, content }).content).toStrictEqual(expected);
  });

  it("formats durable email sender attribution", () => {
    const result = normalizeMessage({
      role: "user",
      content: "Hello",
      __openclaw: { senderId: "alice@example.com" },
    });
    expect(result.senderLabel).toBe("alice");
    expect(result.sender).toEqual({ id: "alice@example.com" });
  });

  it.each([
    { senderLabel: "steipete (c3e32452-0467-47e5-aafa-233cd5dae29f)", name: "steipete" },
    { senderLabel: "Peter (+436641234567)", name: "Peter (+436641234567)" },
  ])(
    "uses legacy label $senderLabel for display without inventing identity",
    ({ senderLabel, name }) => {
      const result = normalizeMessage({ role: "user", content: "hi", senderLabel });
      expect(result.senderLabel).toBe(name);
      expect(result.sender).toEqual({ name });
    },
  );

  it("prefers durable identity over a legacy label", () => {
    const result = normalizeMessage({
      role: "user",
      content: "hi",
      senderLabel: "Legacy",
      __openclaw: { senderId: "profile", senderName: "Meta Name" },
    });
    expect(result.sender).toEqual({ id: "profile", name: "Meta Name" });
    expect(result.senderLabel).toBe("Legacy");
  });

  it("requires typed provenance for a profile avatar", () => {
    const identity = { type: "profile", id: "shared-id" };
    const metadata = {
      senderId: "shared-id",
      senderName: "Person",
      senderProfileAvatarUrl: "/api/users/shared-id/avatar",
    };
    const attributed = normalizeMessage({
      role: "user",
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
    expect(
      normalizeMessage({ role: "user", content: "hello", __openclaw: metadata }).sender,
    ).toEqual({ id: "shared-id", name: "Person" });
  });

  it.each([
    { type: "profile", id: "x".repeat(513) },
    { type: "profile", id: "profile", label: "untrusted extra field" },
    { type: "observation", id: "profile" },
  ])(
    "rejects invalid sender provenance %j without losing display attribution",
    (senderIdentity) => {
      expect(
        normalizeMessage({
          role: "user",
          content: "hello",
          __openclaw: {
            senderIdentity,
            senderId: "profile",
            senderName: "Display",
            senderProfileAvatarUrl: "/api/users/profile/avatar",
          },
        }).sender,
      ).toEqual({ id: "profile", name: "Display" });
    },
  );

  it.each([
    {
      source: {
        sessionKey: " agent:source:main ",
        agentId: " source\t",
        label: " Daily report\t",
        extra: "discarded",
      },
      expected: { sessionKey: "agent:source:main", agentId: "source", label: "Daily report" },
    },
    {
      source: { agentId: "main" },
      expected: { agentId: "main" },
    },
    {
      source: { sessionKey: "agent:main:main", label: "  " },
      expected: { sessionKey: "agent:main:main" },
    },
    { source: { sessionKey: "  ", agentId: "\t" }, expected: undefined },
  ])("normalizes forwarded source attribution %j", ({ source, expected }) => {
    const result = assistant("Forwarded report", { senderSession: source });
    expect(result.senderSession).toStrictEqual(expected);
    expect(result.content).toEqual([{ type: "text", text: "Forwarded report" }]);
  });
});
