import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";
import { getMediaDir } from "../media/store.js";
import { augmentChatHistoryWithCanvasBlocks } from "./chat-display-projection.canvas.js";
import {
  projectChatDisplayMessages,
  sanitizeChatHistoryMessages,
} from "./chat-display-projection.js";
import { CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES } from "./server-methods/chat-history-budget.js";
import { SessionHistorySseState } from "./session-history-state.js";

it("hides private yield inputs without changing canonical arguments", () => {
  const publicInput = { acknowledgment: "Waiting." };
  const args = Object.freeze({ ...publicInput, message: "PRIVATE_YIELD_CONTEXT" });
  const call = { type: "toolCall", name: "sessions_yield", arguments: args, input: args };
  const publicCall = { type: "toolCall", name: "message", arguments: { message: "Public reply" } };
  const message = { role: "assistant", content: [call, publicCall] };
  expect(projectChatDisplayMessages([message])).toEqual([
    {
      ...message,
      content: [{ ...call, arguments: publicInput, input: publicInput }, publicCall],
    },
  ]);
  expect(args.message).toBe("PRIVATE_YIELD_CONTEXT");
});

it("strips attachment capabilities even after another field changed", () => {
  const attachment = {
    artifactId: "artifact_managed_media_11111111-1111-4111-8111-111111111111",
    kind: "document",
    label: "report.csv",
    mimeType: "text/csv",
    sizeBytes: 12,
    url: "/api/chat/media/outgoing/agent%3Amain%3Amain/id/full",
  };
  expect(
    sanitizeChatHistoryMessages([
      {
        role: "assistant",
        content: [
          {
            type: "attachment",
            thinkingSignature: "private-reasoning-signature",
            attachment: {
              ...attachment,
              path: "/tmp/private-report.csv",
              url: attachment.url + "?mediaTicket=secret",
            },
          },
        ],
      },
    ]),
  ).toEqual([{ role: "assistant", content: [{ type: "attachment", attachment }] }]);
});

describe("multimodal display privacy", () => {
  it.each([
    {
      name: "native image data",
      image: (data: string) => ({ type: "image", mimeType: "image/png", data }),
    },
    {
      name: "Anthropic image source",
      image: (data: string) => ({
        type: "image",
        source: { type: "base64", media_type: "image/png", data },
      }),
    },
  ])("keeps text while omitting $name from display history", ({ image }) => {
    const png = createNoisyPngBuffer(320, 320);
    const encoded = png.toString("base64");
    const message = {
      role: "user",
      content: [
        { type: "text", text: "keep prefix text" },
        image(encoded),
        { type: "text", text: "keep suffix text" },
      ],
    };
    const messages = projectChatDisplayMessages([message]);
    expect(messages).toMatchObject([
      {
        role: "user",
        content: [
          { type: "text", text: "keep prefix text" },
          { type: "image", omitted: true, bytes: png.length },
          { type: "text", text: "keep suffix text" },
        ],
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain(encoded);
    expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(
      CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
    );
  });

  it("keeps sanitized legacy media in projection and incremental SSE", () => {
    const data = Buffer.from("inline payload").toString("base64");
    const rawMessage = {
      role: "user",
      content: [
        { type: "text", text: "keep mixed media metadata" },
        {
          type: "image",
          mimeType: "image/png",
          path: "/tmp/private-image.png",
          url: "https://image-user@media.example/image.png?signature=image-secret#image-fragment",
          source: { type: "base64", data, blob: data, url: "media://inbound/image-claim" },
        },
        {
          type: "audio",
          mimeType: "audio/wav",
          data,
          filePath: "C:\\private-audio.wav",
          audio_url: "media://inbound/audio-claim",
          source: {
            type: "url",
            data,
            url: "https://audio-user@media.example/audio.wav?token=audio-secret#audio-fragment",
          },
        },
        {
          type: "video",
          mimeType: "video/mp4",
          blob: data,
          localPath: "\\\\server\\share\\private-video.mp4",
          openclawReasoningReplay: { private: true },
          video_url:
            "https://video-user@media.example/video.mp4?X-Amz-Signature=video-secret#video-fragment",
          source: { type: "url", blob: data, url: "media://inbound/video-claim" },
        },
      ],
    };
    const original = structuredClone(rawMessage);
    const state = SessionHistorySseState.fromSnapshot({
      target: { sessionId: "mixed-media", sessionKey: "agent:main:mixed-media" },
      snapshot: {
        history: { items: [], messages: [], hasMore: false },
        rawTranscriptSeq: 0,
        turnBoundaryPending: false,
        assistantErrorPending: false,
      },
    });
    for (const message of [
      projectChatDisplayMessages([rawMessage])[0],
      state.appendInlineMessage({ message: rawMessage, messageId: "media-message" })?.message,
    ]) {
      expect(message?.role).toBe("user");
      expect(JSON.stringify(message)).not.toContain(data);
      expect(JSON.stringify(message)).not.toMatch(
        /private-|-(?:user|secret|fragment)|openclawReasoningReplay/u,
      );
      expect(message?.content).toEqual([
        { type: "text", text: "keep mixed media metadata" },
        {
          type: "image",
          mimeType: "image/png",
          url: "https://media.example/image.png",
          source: { type: "base64", url: "media://inbound/image-claim" },
          omitted: true,
          bytes: 14,
        },
        {
          type: "audio",
          mimeType: "audio/wav",
          audio_url: "media://inbound/audio-claim",
          source: { type: "url", url: "https://media.example/audio.wav", omitted: true },
          omitted: true,
          bytes: 14,
        },
        {
          type: "video",
          mimeType: "video/mp4",
          video_url: "https://media.example/video.mp4",
          source: { type: "url", url: "media://inbound/video-claim", omitted: true },
          omitted: true,
          bytes: 14,
        },
      ]);
    }
    expect(rawMessage).toEqual(original);
  });

  it("removes private audio payloads and local references while preserving safe refs", () => {
    const privateMarker = "private-audio-reference";
    const privateFiles = Object.fromEntries(
      ["path", "file", "filePath", "localPath"].map((key) => [key, "/private/" + privateMarker]),
    );
    const safeAudio = [
      {
        type: "audio",
        url: "https://example.invalid/audio.wav",
        openUrl: "http://example.invalid/audio.wav",
        audio_url: "media://inbound/audio.wav",
        source: { type: "url", url: "/api/chat/media/outgoing/audio.wav" },
      },
      { type: "audio", url: "/media/audio.wav", openUrl: "/__openclaw__/audio/clip.wav" },
    ];
    const message = {
      role: "user",
      content: [
        {
          type: "audio",
          data: { rawSecret: privateMarker },
          url: "data:audio/wav;base64," + privateMarker,
          openUrl: "file:///tmp/" + privateMarker + ".wav",
          audio_url: "~/" + privateMarker + ".wav",
          ...privateFiles,
          source: {
            type: "opaque",
            codec: "pcm",
            data: new Uint8Array([111, 112, 113]),
            url: "/tmp/" + privateMarker + "-source.wav",
            ...privateFiles,
          },
        },
        { type: "audio", url: "C:\\a.wav", source: { url: "\\\\s\\a.wav" } },
        ...safeAudio,
      ],
    };
    const original = structuredClone(message);
    expect(projectChatDisplayMessages([message])).toEqual([
      {
        role: "user",
        content: [
          { type: "audio", omitted: true, source: { type: "opaque", codec: "pcm", omitted: true } },
          { type: "audio", omitted: true, source: { omitted: true } },
          ...safeAudio,
        ],
      },
    ]);
    expect(message).toEqual(original);
  });
});

describe("transcript display metadata", () => {
  it("keeps display identity while omitting upstream prompt metadata", () => {
    const metadata = { id: "message-1", mirrorIdentity: "turn-1:prompt", replyToId: "message-0" };
    expect(
      projectChatDisplayMessages([
        {
          role: "user",
          content: "Visible",
          __openclaw: { ...metadata, upstreamUserText: "private decorated prompt ".repeat(12_000) },
          providerReplay: {
            type: "openai-responses-compaction",
            data: "opaque-display-compaction",
          },
        },
      ]),
    ).toEqual([{ role: "user", content: "Visible", __openclaw: metadata }]);
  });

  it.each([
    {
      content: [{ type: "text", text: "block text ".repeat(20) }],
      metadata: { id: "message-9", senderId: "assistant-1" },
      expected: [{ type: "text", text: "block text block\n...(truncated)..." }],
      reason: "display-cap",
    },
    {
      content: "still long enough to cap ".repeat(4),
      metadata: { truncated: true, reason: "oversized" },
      expected: "still long enoug\n...(truncated)...",
      reason: "oversized",
    },
  ])(
    "caps text while retaining metadata and its $reason reason",
    ({ content, metadata, expected, reason }) => {
      expect(
        sanitizeChatHistoryMessages([{ role: "assistant", content, __openclaw: metadata }], 16),
      ).toEqual([
        {
          role: "assistant",
          content: expected,
          __openclaw: { ...metadata, truncated: true, reason },
        },
      ]);
    },
  );

  it("marks capped diffs on standalone and nested tool results", () => {
    const result = {
      type: "toolResult",
      toolName: "edit",
      details: { changed: true, diff: "+line\n".repeat(40) },
    };
    for (const projected of sanitizeChatHistoryMessages(
      [
        { role: "assistant", content: [result] },
        { ...result, role: "toolResult" },
      ],
      32,
    )) {
      expect(JSON.stringify(projected)).toContain("...(truncated)...");
      expect(projected).toHaveProperty("__openclaw", { truncated: true, reason: "display-cap" });
    }
  });
});

describe("managed inbound media facts", () => {
  const id = "photo---11111111-2222-3333-4444-555555555555.png";
  it.each([
    [
      path.join(getMediaDir(), "inbound", id),
      { path: "media://inbound/" + id, contentType: "image/png" },
    ],
    [path.join("/tmp", "media", "inbound", id), { contentType: "image/png" }],
    [path.join(getMediaDir(), "inbound", "%"), { contentType: "image/png" }],
  ])("projects only a valid managed inbound path: %s", (mediaPath, expected) => {
    expect(
      sanitizeChatHistoryMessages([
        {
          role: "user",
          content: "image",
          __openclaw: { media: [{ path: mediaPath, contentType: "image/png" }] },
        },
      ]),
    ).toEqual([{ role: "user", content: "image", __openclaw: { media: [expected] } }]);
  });
});

describe("current user profile display", () => {
  const resolved = (id: string, hasUploadedAvatar = true) => ({
    kind: "resolved" as const,
    profileId: id,
    avatarUrl: "/api/users/" + id + "/avatar?v=20",
    hasUploadedAvatar,
  });
  const profile = (id: string, fields: Record<string, unknown> = {}) => ({
    role: "user",
    content: id,
    __openclaw: { senderIdentity: { type: "profile", id }, senderId: id, ...fields },
  });

  it("gates alias lookup on profile provenance", () => {
    const rows = [
      { type: "profile", id: "shared-id" },
      {
        type: "observation",
        id: "shared-id",
        pluginId: "channel",
        accountId: null,
        senderKind: "unknown",
      },
      undefined,
    ].map((senderIdentity) => ({
      role: "user",
      content: "same label",
      __openclaw: { senderId: "shared-id", ...(senderIdentity ? { senderIdentity } : {}) },
    }));
    const original = structuredClone(rows);
    const resolveCurrentUserProfileDisplay = vi.fn(() => resolved("canonical-id"));
    const projected = projectChatDisplayMessages(rows, { resolveCurrentUserProfileDisplay });
    expect(resolveCurrentUserProfileDisplay).toHaveBeenCalledTimes(1);
    expect(projected[0]?.["__openclaw"]).toEqual({
      senderId: "shared-id",
      senderIdentity: { type: "profile", id: "canonical-id" },
      senderProfileAvatarUrl: "/api/users/canonical-id/avatar?v=20",
    });
    expect(projected.slice(1)).toEqual(rows.slice(1));
    expect(rows).toEqual(original);
  });

  it("caches profile lookups, refreshes stale avatars, and preserves unresolved rows", () => {
    const messages = [
      profile("ada", {
        senderName: "Historical Ada",
        senderUsername: "ada",
        senderProfileAvatarUrl: "/old/avatar",
      }),
      profile("ada", { senderName: "Earlier Ada" }),
      profile("missing", { senderProfileAvatarUrl: "/existing/avatar" }),
      { role: "user", content: "missing sender" },
      { role: "assistant", content: "hostile", __openclaw: { senderId: "hostile-assistant" } },
      {
        role: "toolResult",
        toolCallId: "hostile",
        toolName: "read",
        content: "hostile",
        __openclaw: { senderId: "hostile-tool" },
      },
    ];
    const original = structuredClone(messages);
    const resolveCurrentUserProfileDisplay = vi.fn((id: string) =>
      id === "missing" ? { kind: "unresolved" as const } : resolved(id, false),
    );
    const projected = projectChatDisplayMessages(messages, { resolveCurrentUserProfileDisplay });
    expect(resolveCurrentUserProfileDisplay.mock.calls).toEqual([["ada"], ["missing"]]);
    expect(projected).toEqual(
      messages.map((message, index) =>
        index < 2
          ? {
              ...message,
              __openclaw: {
                ...message["__openclaw"],
                senderProfileAvatarUrl: "/api/users/ada/avatar?v=20",
              },
            }
          : message,
      ),
    );
    expect(projected[0]).not.toBe(messages[0]);
    for (const index of [2, 3, 4]) {
      expect(projected[index]).toBe(messages[index]);
    }
    expect(messages).toEqual(original);
  });
});

it("matches later audio against text left by an earlier supplement", () => {
  const marker = { textSha256: createHash("sha256").update("same").digest("hex") };
  const firstAudio = { type: "audio", url: "https://example.test/first.mp3" };
  const secondAudio = { type: "audio", url: "https://example.test/second.mp3" };
  const caption = { type: "input_text", text: "caption" };
  const reply = (timestamp: number) => ({
    role: "assistant",
    content: [{ type: "text", text: "same" }],
    timestamp,
  });
  const messages = [
    reply(1),
    reply(2),
    { role: "assistant", content: [caption, firstAudio], openclawTtsSupplement: marker },
    { role: "assistant", content: [secondAudio], openclawTtsSupplement: marker },
  ];
  const original = structuredClone(messages);
  expect(projectChatDisplayMessages(messages)).toEqual([
    { ...reply(1), content: [{ type: "text", text: "same" }, secondAudio] },
    { ...reply(2), content: [{ type: "text", text: "same" }, caption, firstAudio] },
  ]);
  expect(messages).toEqual(original);
});

it.each(["next-renderable", "last-renderable", "last-assistant"] as const)(
  "preserves first-accepted previews and original messages on the %s target",
  (placement) => {
    const baseContent = [
      { type: "text", text: "Canvas results" },
      { type: "canvas", preview: { viewId: "existing", url: "/existing" } },
      { type: "canvas", preview: { viewId: "", url: "" } },
      ...(placement === "last-assistant" ? [{ type: "toolCall", name: "canvas" }] : []),
    ];
    Object.freeze(baseContent);
    const target = Object.freeze({ role: "assistant", content: baseContent, timestamp: 42 });
    const toolAssistant = { role: "assistant", content: [{ type: "toolCall", name: "canvas" }] };
    const tools = [
      ["existing", "/rejected-id-url"],
      ["first", "/rejected-id-url"],
      ["first", "/later-url"],
      ["second", "/later-url"],
      ["url-duplicate", "/existing"],
      [undefined, "/url-only"],
      [undefined, "/url-only"],
    ].map(([id, url]) => ({
      role: "toolResult",
      toolName: "canvas",
      content: JSON.stringify({ kind: "canvas", view: { ...(id ? { id } : {}), url } }),
    }));
    const detailTool = {
      role: "toolResult",
      toolName: "demo__show",
      content: "Keep the original tool result",
      details: {
        mcpAppPreview: {
          kind: "canvas",
          view: { id: "app" },
          mcpApp: { viewId: "app" },
        },
      },
    };
    const pending = [...tools, detailTool];
    const messages =
      placement === "next-renderable"
        ? [...pending, toolAssistant, target]
        : placement === "last-renderable"
          ? [target, toolAssistant, ...pending]
          : [target, ...pending];
    Object.freeze(messages);
    const original = JSON.stringify(messages);
    const targetIndex = placement === "next-renderable" ? messages.length - 1 : 0;
    const canvas = (preview: Record<string, unknown>, rawText: string | null | undefined) => ({
      type: "canvas",
      preview: { kind: "canvas", surface: "assistant_message", render: "url", ...preview },
      rawText,
    });
    const accepted = [
      { index: 1, viewId: "first", url: "/rejected-id-url" },
      { index: 3, viewId: "second", url: "/later-url" },
      { index: 5, url: "/url-only" },
    ].map(({ index, ...preview }) => canvas(preview, tools[index]?.content));
    const expectedContent = [
      ...baseContent,
      ...accepted,
      canvas({ viewId: "app", mcpApp: { viewId: "app" } }, null),
    ];

    const augmented = augmentChatHistoryWithCanvasBlocks(messages);

    expect(augmented).toEqual(
      messages.map((message, index) =>
        index === targetIndex ? { ...target, content: expectedContent } : message,
      ),
    );
    expect(augmented[targetIndex]).not.toBe(target);
    for (const [index, message] of messages.entries()) {
      if (index !== targetIndex) {
        expect(augmented[index]).toBe(message);
      }
    }
    expect(JSON.stringify(messages)).toBe(original);
  },
);

const hostTab = { targetId: "tab-1", target: "host", profile: "work" };
const nodeTab = { ...hostTab, target: "node", node: "node-1" };
it.each([
  [{ ...hostTab, url: 42, title: [], extra: "drop" }, hostTab],
  [
    {
      targetId: "x".repeat(128),
      target: "node",
      profile: "p".repeat(128),
      node: "n".repeat(256),
      url: "u".repeat(2047) + "😀",
      title: "t".repeat(511) + "😀",
      extra: "drop",
    },
    {
      targetId: "x".repeat(128),
      target: "node",
      profile: "p".repeat(128),
      node: "n".repeat(256),
      url: "u".repeat(2047),
      title: "t".repeat(511),
    },
  ],
  ...[
    { ...hostTab, target: "sandbox" },
    { ...hostTab, target: "node" },
    { ...hostTab, node: "node-1" },
    { ...nodeTab, targetId: " padded " },
    { ...nodeTab, targetId: "x".repeat(129) },
    { ...nodeTab, targetId: "" },
    { ...nodeTab, profile: "p".repeat(129) },
  ].map((invalid) => [invalid, undefined] as const),
])("preserves complete browser routes and bounded display fields (%j)", (browserTab, expected) => {
  const block = (tab: unknown) => ({
    type: "toolResult",
    toolName: "browser",
    ...(tab ? { details: { browserTab: tab } } : {}),
  });
  expect(
    sanitizeChatHistoryMessages([
      { role: "toolResult", ...block(browserTab) },
      { role: "assistant", content: [block(browserTab)] },
    ]),
  ).toEqual([
    { role: "toolResult", ...block(expected) },
    { role: "assistant", content: [block(expected)] },
  ]);
});

it("keeps authoritative write booleans and strips unrelated details", () => {
  const result = (details: Record<string, unknown>) => ({
    role: "toolResult",
    toolName: "write",
    content: [{ type: "text", text: "ok" }],
    details,
  });
  expect(
    sanitizeChatHistoryMessages([
      result({ changed: true, created: false, diff: "-1 old\n+1 new", private: "drop" }),
      result({ changed: true, created: true }),
      result({ changed: "true", created: 1 }),
    ]),
  ).toEqual([
    result({ changed: true, created: false, diff: "-1 old\n+1 new" }),
    result({ changed: true, created: true }),
    { role: "toolResult", toolName: "write", content: [{ type: "text", text: "ok" }] },
  ]);
});

it("caps nested output once, preserves literal text, and removes private media", () => {
  const text = " \n[[reply_to_current]] <tag>\r\n" + "x".repeat(20_000) + "  \n";
  const metadata = {
    id: "nested-output",
    toolOutput: { source: "execution", modelInput: "unverified" },
  };
  const result = { type: "toolResult", toolCallId: "nested-call", toolName: "exec", isError: true };
  const message = {
    role: "assistant",
    __openclaw: metadata,
    content: [
      {
        ...result,
        text,
        content: [
          { type: "text", text },
          { type: "image", data: "aW1hZ2U=", path: "/private/image.png" },
        ],
      },
    ],
  };
  const original = structuredClone(message);
  expect(sanitizeChatHistoryMessages([message], 32)).toEqual([
    {
      role: "assistant",
      __openclaw: { ...metadata, truncated: true, reason: "display-cap" },
      content: [
        {
          ...result,
          content: [
            { type: "text", text: text.slice(0, 32) },
            { type: "image", omitted: true, bytes: 5 },
          ],
        },
      ],
    },
  ]);
  expect(message).toEqual(original);
});

it("keeps tool output whitespace and UTF-16 intact without adding a sentinel", () => {
  expect(sanitizeChatHistoryMessages([{ role: "function", content: " \n😀  \n" }], 3)).toEqual([
    {
      role: "function",
      content: " \n",
      __openclaw: { truncated: true, reason: "display-cap" },
    },
  ]);
});
