import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readTranscriptEventRows } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  appendAssistantMirrorMessageByIdentity,
  appendSessionTranscriptMessageByIdentity,
} from "../plugin-sdk/session-transcript-runtime.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { projectChatDisplayMessages as project } from "./chat-display-projection.js";
import { CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES } from "./server-methods/chat-history-budget.js";
import { SessionHistorySseState } from "./session-history-state.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";
import { readRecentSessionMessagesWithStatsAsync } from "./session-transcript-readers.js";

const text = (value: string) => ({ type: "text", text: value });
const phased = (value: string, phase: string, id?: string) => ({
  ...text(value),
  textSignature: JSON.stringify({ v: 1, id, phase }),
});
const answer = "The train leaves at noon.";
const reply = [text(answer)];
const image = { type: "image", url: "/media/proof.png", mimeType: "image/png" };
const tool = { type: "toolCall", id: "read-proof", name: "read", arguments: {} };
const document = { type: "attachment", attachment: { kind: "document", label: "platform.pdf" } };
const media = [{ path: "media://inbound/timetable", contentType: "image/png" }];
function assistant(fields: Record<string, unknown> = {}) {
  return { role: "assistant", content: reply, __openclaw: { id: "real-answer" }, ...fields };
}
function mirror(fields: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: reply,
    provider: "openclaw",
    model: "delivery-mirror",
    idempotencyKey: "channel-delivery-one",
    openclawDeliveryMirror: {
      kind: "channel-final",
      sourceMessageId: "channel-delivery-one",
      sourceAssistantMessageId: "real-answer",
    },
    ...fields,
  };
}
const payloadFor = (message: unknown) =>
  projectSessionMessagePayload({ sessionKey: "agent:main:main", message }).payload;

it("caps commentary captions across an intervening image as one message", () => {
  const caption = (letter: string) => phased(letter.repeat(20), "commentary", "progress-caption");
  const source = { role: "assistant", content: [caption("A"), image, caption("B")] };
  expect(project([source], { includeCommentaryFallbacks: true, maxChars: 30 })).toContainEqual(
    expect.objectContaining({
      content: [text("A".repeat(20)), image, text(`${"B".repeat(9)}\n...(truncated)...`)],
      __openclaw: expect.objectContaining({ truncated: true }),
    }),
  );
  expect(source.content[2]).toMatchObject({ text: "B".repeat(20) });
});

describe("commentary group visibility", () => {
  const progress = "Visible progress";
  const keyed = phased(progress, "commentary", "progress");
  const unkeyed = phased("Hidden thought", "commentary");
  const final = phased("Final reply", "final_answer", "final");
  const controls = "ANNOUNCE_SKIP REPLY_SKIP";
  const control = { ...keyed, text: controls };
  const inherited = { ...text(progress), textSignature: "progress" };
  const inheritedContent = [text("Hidden thought"), inherited, image, tool];
  const facts = [{ url: "/media/proof.png", contentType: "image/png" }];
  type Visibility = [string, unknown[], string[], number, number, string?, typeof facts?];
  it.each<Visibility>([
    ["visible siblings", [control, image, tool, final], [controls, "Final reply"], 1, 1],
    ["media facts", [control], [""], 0, 0, undefined, facts],
    ["unkeyed media", [text("Image caption"), image], ["Image caption"], 1, 0, "commentary"],
    ["another group's image", [unkeyed, keyed, image], [progress], 1, 0],
    ["inherited phases", inheritedContent, [progress], 1, 1, "commentary"],
  ])("keeps visibility scoped to %s", (_name, content, texts, images, tools, phase, mediaFacts) => {
    const source = assistant({
      ...(phase ? { phase } : {}),
      content,
      __openclaw: { id: "row-identity", ...(mediaFacts ? { media: mediaFacts } : {}) },
    });
    const before = structuredClone(source);
    const projected = project([source], { includeCommentaryFallbacks: true });
    const blocks = projected
      .flatMap((row) => (Array.isArray(row.content) ? row.content : []))
      .map(asOptionalRecord);
    expect(blocks.filter((block) => block?.type === "text").map((block) => block?.text)).toEqual(
      texts,
    );
    expect(blocks.filter((block) => block?.type === "image")).toHaveLength(images);
    expect(blocks.filter((block) => block?.type === "toolCall")).toHaveLength(tools);
    if (mediaFacts) {
      expect(projected).toHaveLength(1);
      expect(projected[0]).toMatchObject({ __openclaw: { media: mediaFacts } });
    }
    expect(source).toEqual(before);
  });
});

it("preserves error-turn media after a later reply", () => {
  const user = { role: "user", content: "hello" };
  const failed = assistant({
    content: [{ type: "thinking", thinking: "Internal reasoning" }],
    stopReason: "error",
    __openclaw: { runId: "run-retry", media },
  });
  const recovered = assistant({ stopReason: "stop", __openclaw: { runId: "run-retry" } });
  expect(project([user, failed, recovered])).toEqual([user, { ...failed, content: [] }, recovered]);
});

const managedUrl = "./attachment-catalog-tiny/demo.jpg";
const delivery = { mediaUrls: [managedUrl] };
it("keeps a media-only assistant row pending for its structured rewrite", () => {
  expect(
    payloadFor(assistant({ openclawDelivery: delivery, content: [text(`MEDIA:${managedUrl}`)] }))
      ?.message,
  ).toMatchObject({ role: "assistant", content: [text("")] });
});
it.each([
  ["CR", "\r"],
  ["LF", "\n"],
  ["CRLF", "\r\n"],
])(
  "withholds only relative directives from a mixed legacy batch with %s lines",
  (_name, separator) => {
    const visibleLines = [
      "Prepared the mixed batch.",
      "MEDIA:https://cdn.example.test/legacy.jpg",
      "MEDIA:/media/legacy-audio.mp3",
    ];
    const source = assistant({
      openclawDelivery: delivery,
      content: [text([...visibleLines, `MEDIA:${managedUrl}`].join(separator))],
    });
    const before = structuredClone(source);
    const payload = payloadFor(source);
    expect(payload?.message).toMatchObject({ content: [text(visibleLines.join("\n"))] });
    expect(JSON.stringify(payload)).not.toContain("attachment-catalog-tiny");
    expect(source).toEqual(before);
  },
);

describe("correlated channel mirrors in Gateway history", () => {
  let state: OpenClawTestState;
  let scope: { agentId: string; sessionId: string; sessionKey: string; storePath: string };
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-mirror-history-", applyEnv: false });
    scope = {
      agentId: "main",
      sessionId: "mirror-history-session",
      sessionKey: "agent:main:mirror-history",
      storePath: path.join(state.root, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
  });
  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await state.cleanup();
  });
  const append = (eventId: string, message: Record<string, unknown>) =>
    appendSessionTranscriptMessageByIdentity({ ...scope, eventId, message });
  const appendAssistant = (id: string, content: unknown[], timestamp: number) =>
    append(id, { role: "assistant", content, timestamp });
  const appendMirror = (id: string) =>
    appendAssistantMirrorMessageByIdentity({
      ...scope,
      idempotencyKey: id,
      deliveryMirror: { kind: "channel-final", sourceMessageId: id },
      text: answer,
      updateMode: "none",
    });
  const storedRows = () =>
    readTranscriptEventRows(
      openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteTranscriptReadScope(scope))),
      scope.sessionId,
    );

  it("hides new correlated mirrors while preserving old bytes and distinct identical turns", async () => {
    const oldThinking = { type: "thinking", thinking: "Checking the old timetable." };
    const thinking = { type: "thinking", thinking: "Checking the current timetable." };
    await appendAssistant("old-answer", [oldThinking, ...reply], 9000);
    await append(
      "old-mirror",
      mirror({
        timestamp: 1000,
        idempotencyKey: "old-delivery",
        openclawDeliveryMirror: { kind: "channel-final", sourceMessageId: "old-delivery" },
      }),
    );
    const oldRows = storedRows();
    const progress = phased("I will check the departure.", "commentary", "commentary");
    await appendAssistant(
      "first-new-answer",
      [thinking, progress, phased(answer, "final_answer", "final")],
      8000,
    );
    await appendMirror("first-new-delivery");
    await append("second-question", {
      role: "user",
      content: "Please confirm that again.",
      timestamp: 500,
    });
    await appendAssistant("second-new-answer", reply, 400);
    await appendMirror("second-new-delivery");
    const beforeRead = storedRows();
    const history = await readRecentSessionMessagesWithStatsAsync(scope, { maxMessages: 20 });
    const displayed = project(history.messages);
    expect(history.messages).toHaveLength(7);
    expect(displayed).toMatchObject([
      { role: "assistant", __openclaw: { id: "old-answer" } },
      { model: "delivery-mirror", __openclaw: { id: "old-mirror" } },
      { role: "assistant", __openclaw: { id: "first-new-answer" } },
      { role: "user", __openclaw: { id: "second-question" } },
      { role: "assistant", __openclaw: { id: "second-new-answer" } },
    ]);
    expect(displayed[2]).toMatchObject({ content: [thinking, text(answer)] });
    expect(storedRows()).toEqual(beforeRead);
    expect(storedRows().slice(0, oldRows.length)).toEqual(oldRows);
  });
});

describe("channel mirror display controls", () => {
  const otherSource = assistant({ __openclaw: { id: "another", mirrorIdentity: "existing" } });
  const otherText = mirror({ content: [text("The train leaves at three.")] });
  const earlierMirror = mirror({ __openclaw: { id: "real-answer" }, idempotencyKey: "earlier" });
  const canonicalTool = assistant({ openclawDisplayContent: [...reply, tool] });
  const attachedMirror = mirror({ openclawDisplayContent: [...reply, document] });
  const forwarded = {
    role: "user",
    content: answer,
    __openclaw: { id: "real-answer" },
    provenance: {
      kind: "inter_session",
      sourceTool: "sessions_send",
      sourceSessionKey: "agent:helper:main",
    },
  };
  const identity = { mirrorIdentity: "acp-run:assistant" };
  const legacy = assistant({ __openclaw: identity });
  const assistantMedia = assistant({ __openclaw: { id: "real-answer", media } });
  const mirrorMedia = mirror({ __openclaw: { media } });
  const withMedia = { __openclaw: { media } };
  const forwardedReply = { role: "assistant", senderLabel: "Forwarded from helper" };
  const fieldless = mirror({
    openclawDeliveryMirror: { kind: "channel-final", sourceMessageId: "existing-delivery" },
  });
  const visiblePair = [{ role: "assistant" }, { model: "delivery-mirror" }];
  const withTool = { content: expect.arrayContaining([tool]) };
  const withAttachment = { content: expect.arrayContaining([document]) };
  type Control = [string, unknown[], unknown[]];
  it.each<Control>([
    ["different source despite mirrorIdentity", [otherSource, mirror()], [{}, {}]],
    ["different visible text", [assistant(), otherText], [{}, {}]],
    ["another delivery mirror", [earlierMirror, mirror()], [{}, {}]],
    ["filtered user turn", [assistant(), { role: "user", content: "" }, mirror()], visiblePair],
    ["canonical tool call", [canonicalTool, mirror()], [withTool, {}]],
    ["mirror attachment", [assistant(), attachedMirror], [{}, withAttachment]],
    ["assistant media facts", [assistantMedia, mirror()], [withMedia, {}]],
    ["mirror media facts", [assistant(), mirrorMedia], [{}, withMedia]],
    ["forwarded content", [forwarded, mirror()], [forwardedReply, { model: "delivery-mirror" }]],
    ["legacy identity", [legacy, fieldless], [{ __openclaw: identity }]],
  ])("preserves the mirror boundary for %s", (_name, messages, expected) => {
    const displayed = project(messages);
    expect(displayed).toHaveLength(expected.length);
    expect(displayed).toMatchObject(expected);
  });
  it("merges a speech supplement into the retained real reply", () => {
    const audio = {
      type: "attachment",
      attachment: { kind: "audio", label: "reply.mp3", mimeType: "audio/mpeg" },
    };
    const displayed = project([
      assistant({ content: [{ type: "thinking", thinking: "Checking the timetable." }, ...reply] }),
      mirror(),
      {
        role: "assistant",
        content: [text("Audio reply"), audio],
        openclawTtsSupplement: { spokenText: answer },
      },
    ]);
    expect(displayed).toHaveLength(1);
    expect(displayed[0]).toMatchObject({
      __openclaw: { id: "real-answer" },
      content: expect.arrayContaining([audio, text(answer)]),
    });
  });
});

describe("multimodal display privacy", () => {
  it.each([
    {
      name: "native image data",
      image: (data: string) => ({ type: "image", mimeType: "image/png", data }),
    },
  ])("keeps text while omitting $name from display history", ({ image: inlineImage }) => {
    const png = createNoisyPngBuffer(320, 320);
    const encoded = png.toString("base64");
    const message = {
      role: "user",
      content: [
        { type: "text", text: "keep prefix text" },
        inlineImage(encoded),
        { type: "text", text: "keep suffix text" },
      ],
    };
    const messages = project([message]);
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

  it("keeps sanitized legacy media in projection and incremental SSE", async () => {
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
      project([rawMessage])[0],
      (await state.prepareInlineMessage({ message: rawMessage, messageId: "media-message" }))()
        ?.message,
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
    expect(project([message])).toEqual([
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
