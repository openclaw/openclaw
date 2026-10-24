import { expect, it, vi } from "vitest";
import {
  isCommandReplyForDelivery,
  isReplyPayloadSessionWriterDeliveryAuthorized,
  isReplyPayloadTerminalContent,
  markCommandReplyForDelivery,
  readPairingQrReplyChannelData,
  readReplyPayloadSourceOccurrence,
  setReplyPayloadMetadata,
} from "./reply-payload.js";

function ttsPayload(text?: string, visibleTextAlreadyDelivered?: boolean) {
  return {
    text,
    mediaUrl: "file:///tmp/answer.mp3",
    ttsSupplement: { spokenText: "answer", visibleTextAlreadyDelivered },
  };
}

it("requires a non-empty reply whose payloads were all produced by the command owner", () => {
  expect(isCommandReplyForDelivery(undefined)).toBe(false);
  expect(isCommandReplyForDelivery([])).toBe(false);
  expect(isCommandReplyForDelivery([{ text: "unmarked" }])).toBe(false);
  expect(isCommandReplyForDelivery(markCommandReplyForDelivery({ text: "ack" }))).toBe(true);

  const marked = { text: "ack" };
  markCommandReplyForDelivery(marked);
  expect(isCommandReplyForDelivery([marked, { text: "unmarked" }])).toBe(false);
});

it.each([
  ["ok", 42, { setupCode: "ok", expiresAtMs: 42 }],
  ["", 0, undefined],
] as const)("validates pairing QR metadata %s", (setupCode, expiresAtMs, expected) => {
  const channelData = { openclawPairingQr: { setupCode, expiresAtMs } };
  expect(readPairingQrReplyChannelData({ channelData })).toEqual(expected);
});

it.each([
  ["text", { text: "answer" }, true],
  ["media", { mediaUrl: "file:///tmp/answer.png" }, true],
  ["reasoning", { text: "thinking", isReasoning: true }, false],
  ["commentary", { text: "working", isCommentary: true }, false],
  ["status", { text: "compacting", isStatusNotice: true }, false],
  ["fresh text with TTS audio", ttsPayload("answer"), true],
  ["already-delivered text with TTS audio", ttsPayload("answer", true), false],
  ["audio-only TTS supplement", ttsPayload(), false],
  ["TTS supplement", ttsPayload(undefined, true), false],
] as const)("classifies %s payloads", (_name, payload, expected) => {
  expect(isReplyPayloadTerminalContent(payload)).toBe(expected);
});

const currentEntry = {
  activeWriterRunId: "run-active",
  lifecycleRevision: "revision-active",
  sessionId: "session-active",
};

it("authorizes unclaimed payloads and only the session row that owns a claimed payload", () => {
  expect(isReplyPayloadSessionWriterDeliveryAuthorized({ text: "reply" }, undefined)).toBe(true);
  const payload = setReplyPayloadMetadata(
    { text: "reply" },
    {
      sessionWriterDeliveryAuthority: {
        expectedLifecycleRevision: "revision-active",
        expectedSessionId: "session-active",
        expectedWriterRunId: "run-active",
        sessionKey: "agent:main:active",
      },
    },
  );

  const authorized = (entry: Parameters<typeof isReplyPayloadSessionWriterDeliveryAuthorized>[1]) =>
    isReplyPayloadSessionWriterDeliveryAuthorized(payload, entry);
  expect(authorized(currentEntry)).toBe(true);
  expect(authorized({ ...currentEntry, activeWriterRunId: "run-replacement" })).toBe(false);
  expect(authorized({ ...currentEntry, lifecycleRevision: "revision-replacement" })).toBe(false);
  expect(authorized({ ...currentEntry, sessionId: "session-replacement" })).toBe(false);
  expect(authorized(undefined)).toBe(false);
});

const complete = {
  assistantMessageIndex: 2,
  blockSourceText: "same",
  blockSourceRange: [8, 12] as const,
};

it("reads complete UTF-16 source identity without changing the wire payload", () => {
  const payload = setReplyPayloadMetadata({ text: "same" }, complete);
  expect(readReplyPayloadSourceOccurrence(payload)).toEqual({
    assistantMessageIndex: 2,
    sourceText: "same",
    sourceRange: [8, 12],
  });
  expect(JSON.stringify(payload)).toBe(JSON.stringify({ text: "same" }));
});

it.each([
  ["absent metadata", undefined],
  ["negative message index", { ...complete, assistantMessageIndex: -1 }],
  ["fractional message index", { ...complete, assistantMessageIndex: 1.5 }],
  ["missing source text", { ...complete, blockSourceText: undefined }],
  ["missing source range", { ...complete, blockSourceRange: undefined }],
  ["negative source start", { ...complete, blockSourceRange: [-1, 3] as const }],
  ["reversed source range", { ...complete, blockSourceRange: [12, 8] as const }],
  ["mismatched source length", { ...complete, blockSourceRange: [8, 13] as const }],
])("rejects %s", (_name, metadata) => {
  const payload = { text: "same" };
  if (metadata) {
    setReplyPayloadMetadata(payload, metadata);
  }
  expect(readReplyPayloadSourceOccurrence(payload)).toBeUndefined();
});

it("retains private delivery authority across independently loaded reply module graphs", async () => {
  let open = true;
  const capability = {
    adopt: () => open,
    close: () => {
      open = false;
    },
  };
  const payload = setReplyPayloadMetadata(
    { text: "Synthetic waiting status" },
    {
      progressContinuation: capability,
      sessionWriterDeliveryAuthority: {
        expectedSessionId: "original-session",
        expectedWriterRunId: "original-run",
        sessionKey: "agent:main:original",
      },
    },
  );
  vi.resetModules();
  const reloaded = await import("./reply-payload.js");
  const adopt = reloaded.getReplyPayloadMetadata(payload)?.progressContinuation?.adopt;
  const draft = { push: () => undefined, retire: () => undefined };
  expect(adopt?.(draft)).toBe(true);
  capability.close();
  expect(adopt?.(draft)).toBe(false);
  expect(
    reloaded.isReplyPayloadSessionWriterDeliveryAuthorized(payload, {
      sessionId: "replacement-session",
      activeWriterRunId: "replacement-run",
    }),
  ).toBe(false);
  expect(JSON.stringify(payload)).toBe(JSON.stringify({ text: "Synthetic waiting status" }));
});
