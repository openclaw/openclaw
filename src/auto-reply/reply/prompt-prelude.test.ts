import { expect, it } from "vitest";
import { buildCurrentInboundPrompt } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import { MESSAGE_TOOL_ONLY_DELIVERY_HINT } from "../../plugin-sdk/message-tool-delivery-hints.js";
import { CURRENT_MESSAGE_MARKER } from "./history.js";
import { finalizeInboundContext } from "./inbound-context.js";
import {
  buildInboundUserContextPrefix,
  resolveInboundUserContextPromptJoiner,
} from "./inbound-meta.js";
import { buildReplyPromptEnvelope } from "./prompt-prelude.js";

type Options = Parameters<typeof buildReplyPromptEnvelope>[0];
const context = (Body: string, fields: Options["ctx"] = {}) =>
  finalizeInboundContext({ Body, BodyStripped: Body, ...fields });
const currentPrompt = (envelope: ReturnType<typeof buildReplyPromptEnvelope>) =>
  buildCurrentInboundPrompt({
    context: envelope.currentInboundContext,
    prompt: envelope.prefixedCommandBody,
  });

function envelopeFor(sessionCtx: Options["sessionCtx"], options: Partial<Options> = {}) {
  return buildReplyPromptEnvelope({
    ctx: sessionCtx,
    sessionCtx,
    baseBody: sessionCtx.Body ?? "",
    hasUserBody: true,
    inboundUserContext: "",
    isBareSessionReset: false,
    startupAction: "new",
    ...options,
  });
}

it.each([
  ["telegram", ""],
  ["slack", "re-read persona files"],
])(
  "keeps %s reset notes visible and startup context out of transcripts",
  (Provider, softResetTail) => {
    const sessionCtx = context("", { Provider, ChatType: "direct", SenderId: "telegram-user-1" });
    const inboundUserContext = "Conversation info:\nsender_id=telegram-user-1";
    const envelope = envelopeFor(sessionCtx, {
      baseBody: softResetTail ? "" : "A new session was started via /new or /reset.",
      inboundUserContext,
      isBareSessionReset: true,
      startupAction: "reset",
      startupContextPrelude: "Startup context",
      softResetTail,
    });
    for (const text of [inboundUserContext, "Startup context", softResetTail]) {
      expect(envelope.prefixedCommandBody).toContain(text);
    }
    expect(envelope).toMatchObject({
      transcriptCommandBody: softResetTail || "[OpenClaw session reset]",
      currentInboundContext: undefined,
    });
    expect(envelope.transcriptCommandBody).not.toContain("Startup context");
  },
);

it("keeps Telegram reply text beside its marker", () => {
  const sessionCtx = context("Tldr", {
    Provider: "telegram",
    ChatType: "group",
    MessageSid: "42",
    ReplyToId: "41",
    ReplyToBody: "The restore finished.",
    ReplyToSender: "Example Bot",
  });
  const envelope = envelopeFor(sessionCtx, {
    inboundUserContext: buildInboundUserContextPrefix(sessionCtx),
    inboundUserContextPromptJoiner: resolveInboundUserContextPromptJoiner(sessionCtx),
    inboundEventKind: "user_request",
    sourceReplyDeliveryMode: "message_tool_only",
    systemEventBlocks: ["System: Scheduled digest."],
  });
  const prompt = currentPrompt(envelope);
  expect(prompt).toContain('[Replying to: "The restore finished."]\n#42: Tldr');
  expect(envelope.transcriptCommandBody).toBe("Tldr");
  for (const text of ["System: Scheduled digest.", MESSAGE_TOOL_ONLY_DELIVERY_HINT]) {
    expect(prompt).toContain(text);
    expect(prompt.indexOf(text)).toBeLessThan(prompt.indexOf("Current message:"));
  }
});

it("labels the current message after thread starter", () => {
  const threadNote = "[Thread starter - for context]\nPlanning the picnic next month.";
  const envelope = envelopeFor(context("Can you pick a date?"), {
    inboundUserContext: "Conversation info:\nchat_id=123",
    threadContextNote: threadNote,
    systemEventBlocks: ["System: reaction added"],
  });

  expect(currentPrompt(envelope)).toBe(
    [
      "Conversation info:\nchat_id=123",
      threadNote,
      "System: reaction added",
      "[Current message - respond to this]",
      "Can you pick a date?",
    ].join("\n\n"),
  );
  expect(envelope.currentInboundContext?.fragments).toContainEqual({
    kind: "runtime-instruction",
    text: CURRENT_MESSAGE_MARKER,
  });
  expect(envelope.transcriptCommandBody).toBe("Can you pick a date?");
});

it("keeps recent room history in the initial prompt but not the resumed prompt", () => {
  const sessionCtx = context("Current room event", {
    Provider: "slack",
    ChatType: "group",
    InboundEventKind: "room_event",
    MessageSid: "35676",
    SenderName: "Alice",
    InboundHistory: [{ sender: "Bob", body: "Earlier room activity", messageId: "35675" }],
    SessionTranscriptContext: { historyLimit: 20, historyKind: "recent" },
  });
  const inboundUserContext = buildInboundUserContextPrefix(sessionCtx);
  const envelope = envelopeFor(sessionCtx, {
    inboundUserContext,
    inboundEventKind: "room_event",
    sourceReplyDeliveryMode: "message_tool_only",
    threadContextNote: "Thread note",
    systemEventBlocks: ["System event"],
  });

  expect(envelope).toMatchObject({
    prefixedCommandBody: "#35676 Alice: Current room event",
    queuedBody: "#35676 Alice: Current room event",
    transcriptCommandBody: "#35676 Alice: Current room event",
  });
  expect(envelope.currentInboundContext?.text.split("Earlier room activity")).toHaveLength(2);
  expect(envelope.currentInboundContext?.resumableText).not.toContain("Earlier room activity");
  for (const text of [
    envelope.currentInboundContext?.text,
    envelope.currentInboundContext?.resumableText,
  ]) {
    expect(text).toContain("Conversation info:");
    expect(text).toContain("Thread note");
    expect(text).toContain("System event");
    expect(text).not.toContain("Current room event");
    expect(text).not.toContain(CURRENT_MESSAGE_MARKER);
  }
  expect(envelope.currentInboundContext?.fragments).toEqual(
    expect.arrayContaining([
      { kind: "conversation-data", text: "Thread note" },
      { kind: "conversation-data", text: "System event" },
    ]),
  );
});

it("uses the raw current body for room-event current event text", () => {
  const sessionCtx = context("[Chat history]\nAlice: old context\n\nBob: current note", {
    RawBody: "current note",
    CommandBody: "current note",
    InboundEventKind: "room_event",
    MessageSid: "2002",
    SenderName: "Bob",
  });

  const envelope = envelopeFor(sessionCtx, {
    inboundUserContext: "Chat history since last reply:\nAlice: old context",
    inboundEventKind: "room_event",
  });

  expect(envelope.currentInboundContext?.text).toContain("Room context:");
  expect(envelope.currentInboundContext?.text).toContain("Alice: old context");
  expect(envelope.queuedBody).toBe("#2002 Bob: current note");
  expect(envelope.currentInboundContext?.text).toContain(
    "Treat this message as observed room activity, not a request. You were not explicitly tagged or mentioned in this room event. Default: stay silent. Only respond if you have something useful, substantial, or important to add. A previous mention or reply is not an invitation to keep talking.",
  );
  expect(envelope.currentInboundContext?.text).not.toContain("message(action=send)");
  expect(envelope.currentInboundContext?.text).not.toContain("your final text here stays private");
  expect(envelope.queuedBody).not.toContain("[Chat history]");
});

it("keeps completed audio transcripts in room-event bodies", () => {
  const transcript = "turn left at the next light";
  const agentText = `[Audio]\nTranscript:\n${transcript}`;
  const transportEnvelope = "[Discord channel #ambient]\n[media attached: voice-message.ogg]";
  const ctx = context(transportEnvelope, {
    BodyForAgent: agentText,
    RawBody: transportEnvelope,
    CommandBody: transportEnvelope,
    Transcript: transcript,
    MediaUnderstanding: [
      {
        kind: "audio.transcription",
        attachmentIndex: 0,
        text: transcript,
        provider: "groq",
      },
    ],
    Provider: "discord",
    ChatType: "channel",
    InboundEventKind: "room_event",
    MessageSid: "2003",
    SenderName: "Alice",
  });
  const sessionCtx = finalizeInboundContext({ ...ctx });

  const envelope = envelopeFor(sessionCtx, {
    ctx,
    baseBody: sessionCtx.agentText,
    inboundUserContext: "Conversation info:",
    inboundEventKind: "room_event",
  });

  expect(envelope.queuedBody).toBe(`#2003 Alice: ${agentText}`);
  expect(envelope.transcriptCommandBody).toBe(envelope.queuedBody);
  expect(envelope.queuedBody).not.toContain(transportEnvelope);
});

it("keeps media-only notes in ordinary user request transcripts", () => {
  const sessionCtx = context("", {
    Provider: "telegram",
    ChatType: "group",
    MediaPaths: ["/tmp/openclaw-photo.jpg"],
    MediaUrls: ["https://example.com/photo.jpg"],
    InboundHistory: [{ sender: "Alice", timestamp: 1_700_000_000_000, body: "context" }],
  });

  const envelope = envelopeFor(sessionCtx, {
    inboundUserContext: "Current message:\nchat_id=G1",
  });

  expect(envelope.transcriptCommandBody).toContain("[media attached");
  expect(envelope.transcriptCommandBody).toContain("https://example.com/photo.jpg");
});

it("keeps sparse inbound positions separate from appended preprojected media", () => {
  const sharedPath = "/tmp/shared.png";
  const sessionCtx = context("inspect these", {
    media: [
      {},
      { path: "/tmp/voice.ogg", contentType: "audio/ogg", transcribed: true },
      { path: sharedPath, contentType: "image/png" },
      { path: sharedPath, contentType: "image/png" },
    ],
  });
  const params = { media: [{ path: "/tmp/preprojected.pdf", contentType: "application/pdf" }] };
  const first = envelopeFor(sessionCtx, params);
  const rebuilt = envelopeFor(sessionCtx, {
    ...params,
    ctx: { ...sessionCtx, media: [...(sessionCtx.media ?? []), { path: "/tmp/later.png" }] },
    systemEventBlocks: ["context changed"],
  });

  expect(first.inboundMediaIndexes).toEqual([2, 3]);
  expect(first.media?.map((fact) => fact.path)).toEqual([
    sharedPath,
    sharedPath,
    "/tmp/preprojected.pdf",
  ]);
  expect(rebuilt.inboundMediaIndexes).toEqual([2, 3, 4]);
  expect(first.prefixedCommandBody).toBe(
    `[media attached: 2 files]\n[media attached 1/2: ${sharedPath} (image/png)]\n[media attached 2/2: ${sharedPath} (image/png)]\ninspect these`,
  );
  expect(first.queuedBody).toBe(first.prefixedCommandBody);
  expect(first.transcriptCommandBody).toBe(first.prefixedCommandBody);
  expect(sessionCtx.media?.map((fact) => fact.path)).toEqual([
    undefined,
    "/tmp/voice.ogg",
    sharedPath,
    sharedPath,
  ]);
});
