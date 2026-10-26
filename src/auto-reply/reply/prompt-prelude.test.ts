import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createCliCurrentPromptRenderer } from "../../agents/cli-runner/prompt-context.js";
import { buildCurrentInboundPrompt } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import * as gitCoauthorPrompt from "../../agents/git-coauthor-prompt.js";
import { MESSAGE_TOOL_ONLY_DELIVERY_HINT } from "../../plugin-sdk/message-tool-delivery-hints.js";
import { parseSoftResetCommand } from "./commands-reset-mode.js";
import { prepareReplyRunContext, type PreparedReplyRunContext } from "./get-reply-run-context.js";
import { baseParams } from "./get-reply-run.test-support.js";
import { CURRENT_MESSAGE_MARKER } from "./history.js";
import { finalizeInboundContext } from "./inbound-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

type Options = Parameters<typeof prepareReplyRunContext>[0];
type Additions = Parameters<PreparedReplyRunContext["buildPromptBodies"]>[0];
const context = (Body: string, fields: Options["ctx"] = {}) =>
  finalizeInboundContext({ Body, BodyStripped: Body, ...fields });
const currentPrompt = (envelope: Awaited<ReturnType<typeof envelopeFor>>) =>
  buildCurrentInboundPrompt({
    context: envelope.currentInboundContext,
    prompt: envelope.prefixedCommandBody,
  });

async function envelopeFor(
  sessionCtx: Options["sessionCtx"],
  options: Partial<Options> = {},
  additions: Additions = {},
) {
  const prepared = await prepareReplyRunContext(
    baseParams({ isNewSession: false, ctx: sessionCtx, sessionCtx, ...options }),
  );
  if (prepared.kind !== "ready") {
    throw new Error("Expected prepared reply context");
  }
  return prepared.buildPromptBodies({ prefixedBody: prepared.prefixedBodyBase, ...additions });
}

async function resetEnvelope(Provider: string, soft: boolean) {
  const workspaceDir = tempDirs.make("openclaw-prompt-reset-");
  await fs.mkdir(path.join(workspaceDir, "memory"));
  await fs.writeFile(
    path.join(workspaceDir, "memory", "2026-04-11.md"),
    "Startup context sentinel",
  );
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 3, 11, 18));
  const body = soft ? "/reset soft re-read persona files" : "/reset";
  const ctx = finalizeInboundContext({
    Body: body,
    RawBody: body,
    CommandBody: body,
    CommandAuthorized: true,
    Provider,
    Surface: Provider,
    ChatType: "direct",
    SenderId: "telegram-user-1",
  });
  const sessionCtx = finalizeInboundContext({ ...ctx, Body: "", BodyStripped: "", agentText: "" });
  const params = baseParams({
    ctx,
    sessionCtx,
    cfg: {
      agents: {
        defaults: {
          userTimezone: "UTC",
          startupContext: { enabled: true, applyOn: ["reset"], dailyMemoryDays: 1 },
        },
      },
    },
    workspaceDir,
    isNewSession: !soft,
    resetTriggered: !soft,
  });
  const softReset = parseSoftResetCommand(body);
  params.command = {
    ...params.command,
    surface: Provider,
    channel: Provider,
    rawBodyNormalized: body,
    commandBodyNormalized: body,
    isAuthorizedSender: true,
    ...(softReset.matched ? { softResetTriggered: true, softResetTail: softReset.tail } : {}),
  };
  return envelopeFor(sessionCtx, params);
}

it.each([
  ["telegram", ""],
  ["slack", "re-read persona files"],
])(
  "keeps %s reset notes visible and startup context out of transcripts",
  async (Provider, softResetTail) => {
    const envelope = await resetEnvelope(Provider, Boolean(softResetTail));
    for (const text of [
      '"sender":{"id":"telegram-user-1"}',
      "Startup context sentinel",
      softResetTail,
    ]) {
      expect(envelope.prefixedCommandBody).toContain(text);
    }
    expect(envelope).toMatchObject({
      transcriptCommandBody: softResetTail || "[OpenClaw session reset]",
      currentInboundContext: undefined,
    });
    expect(envelope.transcriptCommandBody).not.toContain("Startup context");
  },
);

it("keeps Telegram reply text beside its marker", async () => {
  const sessionCtx = context("Tldr", {
    Provider: "telegram",
    ChatType: "group",
    MessageSid: "42",
    ReplyToId: "41",
    ReplyToBody: "The restore finished.",
    ReplyToSender: "Example Bot",
    InboundEventKind: "user_request",
  });
  const envelope = await envelopeFor(
    sessionCtx,
    { opts: { sourceReplyDeliveryMode: "message_tool_only" } },
    { systemEventBlocks: ["System: Scheduled digest."] },
  );
  const prompt = currentPrompt(envelope);
  expect(prompt).toContain('[Replying to: "The restore finished."]\n#42: Tldr');
  expect(envelope.transcriptCommandBody).toBe("Tldr");
  for (const text of ["System: Scheduled digest.", MESSAGE_TOOL_ONLY_DELIVERY_HINT]) {
    expect(prompt).toContain(text);
    expect(prompt.indexOf(text)).toBeLessThan(prompt.indexOf("Current message:"));
  }
});

it("labels the current message after thread starter", async () => {
  const threadNote = "[Thread starter - for context]\nPlanning the picnic next month.";
  const envelope = await envelopeFor(
    context("Can you pick a date?", {
      Provider: "discord",
      ChatType: "channel",
      OriginatingTo: "123",
    }),
    {},
    { threadContextNote: threadNote, systemEventBlocks: ["System: reaction added"] },
  );

  const prompt = currentPrompt(envelope);
  expect(prompt).toContain("PR attribution: ⟦openclaw:ctx⟧");
  expect(prompt.slice(prompt.indexOf("Conversation info:"))).toBe(
    [
      'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"chat_id":"123","is_group_chat":true}\n```',
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

it("keeps recent room history in the initial prompt but not the resumed prompt", async () => {
  const sessionCtx = context("Current room event", {
    Provider: "slack",
    ChatType: "group",
    InboundEventKind: "room_event",
    MessageSid: "35676",
    SenderName: "Alice",
    InboundHistory: [{ sender: "Bob", body: "Earlier room activity", messageId: "35675" }],
    SessionTranscriptContext: { historyLimit: 20, historyKind: "recent" },
  });
  const envelope = await envelopeFor(
    sessionCtx,
    { opts: { sourceReplyDeliveryMode: "message_tool_only" } },
    { threadContextNote: "Thread note", systemEventBlocks: ["System event"] },
  );

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

it("uses the raw current body for room-event current event text", async () => {
  const sessionCtx = context("[Chat history]\nAlice: old context\n\nBob: current note", {
    RawBody: "current note",
    CommandBody: "current note",
    Provider: "webchat",
    Surface: "webchat",
    ChatType: "group",
    InboundHistory: [{ sender: "Alice", body: "old context" }],
    InboundEventKind: "room_event",
    MessageSid: "2002",
    SenderName: "Bob",
  });

  const envelope = await envelopeFor(sessionCtx);

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

it("keeps completed audio transcripts in room-event bodies", async () => {
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
  const sessionCtx = finalizeInboundContext({ ...ctx, BodyStripped: agentText });

  const envelope = await envelopeFor(sessionCtx, { ctx });

  expect(envelope.queuedBody).toBe(`#2003 Alice: ${agentText}`);
  expect(envelope.transcriptCommandBody).toBe(envelope.queuedBody);
  expect(envelope.queuedBody).not.toContain(transportEnvelope);
});

it("keeps media-only notes in ordinary user request transcripts", async () => {
  const sessionCtx = context("", {
    Provider: "telegram",
    ChatType: "group",
    MediaPaths: ["/tmp/openclaw-photo.jpg"],
    MediaUrls: ["https://example.com/photo.jpg"],
    InboundHistory: [{ sender: "Alice", timestamp: 1_700_000_000_000, body: "context" }],
  });

  const envelope = await envelopeFor(sessionCtx);

  expect(envelope.transcriptCommandBody).toContain("[media attached");
  expect(envelope.transcriptCommandBody).toContain("https://example.com/photo.jpg");
});

it("keeps sparse inbound positions separate from appended preprojected media", async () => {
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
  const first = await envelopeFor(sessionCtx, {}, params);
  const rebuilt = await envelopeFor(
    sessionCtx,
    { ctx: { ...sessionCtx, media: [...(sessionCtx.media ?? []), { path: "/tmp/later.png" }] } },
    { ...params, systemEventBlocks: ["context changed"] },
  );

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

it("keeps requester trailers in full and resumed backend prompt projections", async () => {
  const trailer = "Co-authored-by: requester-c <9101+requester-c@users.noreply.github.com>";
  vi.spyOn(gitCoauthorPrompt, "resolveRequestGitCoauthorPrompt").mockResolvedValue(trailer);
  const envelope = await envelopeFor(
    context("Create the requested commit", {
      Provider: "discord",
      Surface: "discord",
      ChatType: "group",
      InboundEventKind: "room_event",
    }),
    { agentId: "main", sessionKey: "agent:main:main" },
  );
  // Codex consumes text, while reused CLI sessions can select resumableText.
  expect(envelope.currentInboundContext?.text).toContain(trailer);
  expect(envelope.currentInboundContext?.resumableText).toContain(trailer);
  expect(envelope.currentInboundContext?.fragments).toContainEqual({
    kind: "runtime-instruction",
    text: trailer,
  });
  const render = createCliCurrentPromptRenderer(
    { currentInboundContext: envelope.currentInboundContext },
    { mode: "reuse", sessionId: "credit-cli-session" },
  );
  expect(render(envelope.prefixedCommandBody)).toContain(trailer);
  expect(render(envelope.prefixedCommandBody, true)).toContain(trailer);
  expect(envelope.transcriptCommandBody).not.toContain(trailer);
});
