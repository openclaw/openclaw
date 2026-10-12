// Tests prompt prelude construction for sender, routing, and context metadata.
import { describe, expect, it } from "vitest";
import { buildCurrentInboundPrompt } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import { MESSAGE_TOOL_ONLY_DELIVERY_HINT } from "../../plugin-sdk/message-tool-delivery-hints.js";
import { finalizeInboundContext } from "./inbound-context.js";
import {
  buildInboundUserContextPrefix,
  resolveInboundUserContextPromptJoiner,
} from "./inbound-meta.js";
import { buildReplyPromptEnvelope } from "./prompt-prelude.js";

function countOccurrences(text: string | undefined, needle: string): number {
  return (text?.split(needle).length ?? 1) - 1;
}

describe("buildReplyPromptEnvelope", () => {
  it("keeps bare reset runtime context in the model prompt and out of transcript/current-turn context", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "",
      BodyStripped: "",
      Provider: "telegram",
      ChatType: "direct",
      SenderId: "telegram-user-1",
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "A new session was started via /new or /reset.",
      hasUserBody: true,
      inboundUserContext: "Conversation info:\nsender_id=telegram-user-1",
      isBareSessionReset: true,
      startupAction: "reset",
      startupContextPrelude: "Startup context",
    });

    expect(envelope.prefixedCommandBody).toContain("sender_id=telegram-user-1");
    expect(envelope.prefixedCommandBody).toContain("Startup context");
    expect(envelope.transcriptCommandBody).toBe("[OpenClaw session reset]");
    expect(envelope.currentInboundContext).toBeUndefined();
  });

  it.each([
    { systemEventBlocks: [], sourceReplyDeliveryMode: "automatic" },
    { systemEventBlocks: ["System: Scheduled digest."], sourceReplyDeliveryMode: "automatic" },
    { systemEventBlocks: [], sourceReplyDeliveryMode: "message_tool_only" },
    {
      systemEventBlocks: ["System: Scheduled digest."],
      sourceReplyDeliveryMode: "message_tool_only",
    },
  ] as const)("keeps Telegram reply text beside its marker: %j", (extra) => {
    const sessionCtx = finalizeInboundContext({
      Body: "Tldr",
      Provider: "telegram",
      ChatType: "group",
      MessageSid: "42",
      ReplyToId: "41",
      ReplyToBody: "The restore finished.",
      ReplyToSender: "Example Bot",
    });
    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "Tldr",
      hasUserBody: true,
      inboundUserContext: buildInboundUserContextPrefix(sessionCtx),
      inboundUserContextPromptJoiner: resolveInboundUserContextPromptJoiner(sessionCtx),
      isBareSessionReset: false,
      startupAction: "new",
      inboundEventKind: "user_request",
      sourceReplyDeliveryMode: extra.sourceReplyDeliveryMode,
      systemEventBlocks: [...extra.systemEventBlocks],
    });
    const prompt = buildCurrentInboundPrompt({
      context: envelope.currentInboundContext,
      prompt: envelope.prefixedCommandBody,
    });
    expect(prompt).toContain('[Replying to: "The restore finished."]\n#42: Tldr');
    expect(envelope.transcriptCommandBody).toBe("Tldr");
    for (const event of extra.systemEventBlocks) {
      expect(prompt).toContain(event);
      expect(prompt.indexOf(event)).toBeLessThan(prompt.indexOf("Current message:"));
    }
    if (extra.sourceReplyDeliveryMode === "message_tool_only") {
      expect(prompt).toContain(MESSAGE_TOOL_ONLY_DELIVERY_HINT);
      expect(prompt.indexOf(MESSAGE_TOOL_ONLY_DELIVERY_HINT)).toBeLessThan(
        prompt.indexOf("Current message:"),
      );
    }
  });

  it("adds one message-tool delivery hint to user-request runtime context only", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "@bot what changed?",
      BodyStripped: "what changed?",
      Provider: "telegram",
      ChatType: "group",
      InboundEventKind: "user_request",
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "what changed?",
      prefixedBody: "what changed?",
      hasUserBody: true,
      inboundUserContext: "Current message:\nchat_id=-100123",
      isBareSessionReset: false,
      startupAction: "new",
      inboundEventKind: "user_request",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(
      countOccurrences(envelope.currentInboundContext?.text, MESSAGE_TOOL_ONLY_DELIVERY_HINT),
    ).toBe(1);
    expect(envelope.prefixedCommandBody).toBe("what changed?");
    expect(envelope.transcriptCommandBody).toBe("what changed?");
    expect(envelope.transcriptCommandBody).not.toContain(MESSAGE_TOOL_ONLY_DELIVERY_HINT);
  });

  it.each(["pending", "recent"] as const)(
    "keeps %s room history in the initial prompt but not the resumed prompt",
    (historyKind) => {
      const sessionCtx = finalizeInboundContext({
        Body: "Current room event",
        BodyStripped: "Current room event",
        Provider: "slack",
        ChatType: "group",
        InboundEventKind: "room_event",
        MessageSid: "35676",
        SenderName: "Alice",
        InboundHistory: [{ sender: "Bob", body: "Earlier room activity", messageId: "35675" }],
        SessionTranscriptContext: { historyLimit: 20, historyKind },
      });
      const inboundUserContext = buildInboundUserContextPrefix(sessionCtx);
      const envelope = buildReplyPromptEnvelope({
        ctx: sessionCtx,
        sessionCtx,
        baseBody: "Current room event",
        hasUserBody: true,
        inboundUserContext,
        isBareSessionReset: false,
        startupAction: "new",
        inboundEventKind: "room_event",
        sourceReplyDeliveryMode: "message_tool_only",
        threadContextNote: "Thread note",
        systemEventBlocks: ["System event"],
      });

      expect(envelope.prefixedCommandBody).toBe("#35676 Alice: Current room event");
      expect(envelope.queuedBody).toBe(envelope.transcriptCommandBody);
      expect(envelope.transcriptCommandBody).toBe("#35676 Alice: Current room event");
      expect(countOccurrences(envelope.currentInboundContext?.text, "Earlier room activity")).toBe(
        1,
      );
      expect(envelope.currentInboundContext?.resumableText).not.toContain("Earlier room activity");
      for (const text of [
        envelope.currentInboundContext?.text,
        envelope.currentInboundContext?.resumableText,
      ]) {
        expect(text).toContain("Conversation info:");
        expect(text).toContain("Thread note");
        expect(text).toContain("System event");
        expect(text).not.toContain("Current room event");
      }
      expect(envelope.currentInboundContext?.fragments).toEqual(
        expect.arrayContaining([
          { kind: "conversation-data", text: "Thread note" },
          { kind: "conversation-data", text: "System event" },
        ]),
      );
    },
  );

  it("uses the raw current body for room-event current event text", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "[Chat history]\nAlice: old context\n\nBob: current note",
      BodyStripped: "[Chat history]\nAlice: old context\n\nBob: current note",
      RawBody: "current note",
      CommandBody: "current note",
      Provider: "telegram",
      ChatType: "group",
      InboundEventKind: "room_event",
      MessageSid: "2002",
      SenderName: "Bob",
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: sessionCtx.Body ?? "",
      hasUserBody: true,
      inboundUserContext: "Chat history since last reply:\nAlice: old context",
      isBareSessionReset: false,
      startupAction: "new",
      inboundEventKind: "room_event",
    });

    expect(envelope.currentInboundContext?.text).toContain("Room context:");
    expect(envelope.currentInboundContext?.text).toContain("Alice: old context");
    expect(envelope.queuedBody).toBe("#2002 Bob: current note");
    expect(envelope.currentInboundContext?.text).toContain(
      "Treat this message as observed room activity, not a request. You were not explicitly tagged or mentioned in this room event. Default: stay silent. Only respond if you have something useful, substantial, or important to add. A previous mention or reply is not an invitation to keep talking.",
    );
    expect(envelope.currentInboundContext?.text).not.toContain("message(action=send)");
    expect(envelope.currentInboundContext?.text).not.toContain(
      "your final text here stays private",
    );
    expect(envelope.queuedBody).not.toContain("[Chat history]");
  });

  it("keeps completed audio transcripts in room-event bodies", () => {
    const transcript = "turn left at the next light";
    const agentText = `[Audio]\nTranscript:\n${transcript}`;
    const transportEnvelope = "[Discord channel #ambient]\n[media attached: voice-message.ogg]";
    const ctx = finalizeInboundContext({
      Body: transportEnvelope,
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

    const envelope = buildReplyPromptEnvelope({
      ctx,
      sessionCtx,
      baseBody: sessionCtx.agentText,
      hasUserBody: true,
      inboundUserContext: "Conversation info:",
      isBareSessionReset: false,
      startupAction: "new",
      inboundEventKind: "room_event",
    });

    expect(envelope.queuedBody).toBe(`#2003 Alice: ${agentText}`);
    expect(envelope.transcriptCommandBody).toBe(envelope.queuedBody);
    expect(envelope.queuedBody).not.toContain(transportEnvelope);
  });

  it("keeps media-only notes in ordinary user request transcripts", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "",
      BodyStripped: "",
      Provider: "telegram",
      ChatType: "group",
      MediaPaths: ["/tmp/openclaw-photo.jpg"],
      MediaUrls: ["https://example.com/photo.jpg"],
      InboundHistory: [{ sender: "Alice", timestamp: 1_700_000_000_000, body: "context" }],
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "",
      hasUserBody: true,
      inboundUserContext: "Current message:\nchat_id=G1",
      isBareSessionReset: false,
      startupAction: "new",
    });

    expect(envelope.transcriptCommandBody).toContain("[media attached");
    expect(envelope.transcriptCommandBody).toContain("https://example.com/photo.jpg");
  });

  it("keeps sparse inbound positions separate from appended preprojected media", () => {
    const sharedPath = "/tmp/shared.png";
    const sessionCtx = finalizeInboundContext({
      Body: "inspect these",
      media: [
        {},
        { path: "/tmp/voice.ogg", contentType: "audio/ogg", transcribed: true },
        { path: sharedPath, contentType: "image/png" },
        { path: sharedPath, contentType: "image/png" },
      ],
    });
    const params = {
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "inspect these",
      hasUserBody: true,
      inboundUserContext: "",
      isBareSessionReset: false,
      startupAction: "new" as const,
      media: [{ path: "/tmp/preprojected.pdf", contentType: "application/pdf" }],
    };
    const first = buildReplyPromptEnvelope(params);
    const rebuilt = buildReplyPromptEnvelope({
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

  it("keeps soft reset user notes visible without leaking startup context into transcripts", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "",
      BodyStripped: "",
      Provider: "slack",
      ChatType: "direct",
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "",
      hasUserBody: true,
      inboundUserContext: 'Conversation info:\n{"sender":{"id":"U123"}}',
      isBareSessionReset: true,
      startupAction: "reset",
      startupContextPrelude: "Startup context",
      softResetTail: "re-read persona files",
    });

    expect(envelope.prefixedCommandBody).toContain("Conversation info:");
    expect(envelope.prefixedCommandBody).toContain("Startup context");
    expect(envelope.prefixedCommandBody).toContain("re-read persona files");
    expect(envelope.transcriptCommandBody).toBe("re-read persona files");
    expect(envelope.transcriptCommandBody).not.toContain("Startup context");
  });
});
