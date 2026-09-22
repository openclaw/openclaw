// Reply payload tests cover internal reply metadata contracts.
import { describe, expect, it, vi } from "vitest";
import {
  isCommandReplyForDelivery,
  isReplyPayloadSessionWriterDeliveryAuthorized,
  isReplyPayloadTerminalContent,
  markCommandReplyForDelivery,
  readPairingQrReplyChannelData,
  readReplyPayloadSourceOccurrence,
  setReplyPayloadMetadata,
} from "./reply-payload.js";

describe("command reply delivery", () => {
  it("requires a non-empty reply whose payloads were all produced by the command owner", () => {
    expect(isCommandReplyForDelivery(undefined)).toBe(false);
    expect(isCommandReplyForDelivery([])).toBe(false);
    expect(isCommandReplyForDelivery([{ text: "unmarked" }])).toBe(false);
    expect(isCommandReplyForDelivery(markCommandReplyForDelivery({ text: "ack" }))).toBe(true);

    const marked = { text: "ack" };
    markCommandReplyForDelivery(marked);
    expect(isCommandReplyForDelivery([marked, { text: "unmarked" }])).toBe(false);
  });
});

describe("pairing QR reply channel data", () => {
  it("reads the private pairing QR payload metadata", () => {
    const channelData = {
      openclawPairingQr: {
        setupCode: "setup-code",
        expiresAtMs: 1_800_000_000_000,
      },
    };

    expect(readPairingQrReplyChannelData({ channelData })).toEqual({
      setupCode: "setup-code",
      expiresAtMs: 1_800_000_000_000,
    });
  });

  it("ignores malformed pairing QR metadata", () => {
    expect(
      readPairingQrReplyChannelData({
        channelData: {
          openclawPairingQr: {
            setupCode: "",
            expiresAtMs: 0,
          },
        },
      }),
    ).toBeUndefined();
  });
});

describe("reply payload terminal content", () => {
  it.each([
    ["text", { text: "answer" }, true],
    ["media", { mediaUrl: "file:///tmp/answer.png" }, true],
    ["reasoning", { text: "thinking", isReasoning: true }, false],
    ["commentary", { text: "working", isCommentary: true }, false],
    ["status", { text: "compacting", isStatusNotice: true }, false],
    [
      "fresh text with TTS audio",
      {
        text: "answer",
        mediaUrl: "file:///tmp/answer.mp3",
        ttsSupplement: { spokenText: "answer" },
      },
      true,
    ],
    [
      "already-delivered text with TTS audio",
      {
        text: "answer",
        mediaUrl: "file:///tmp/answer.mp3",
        ttsSupplement: { spokenText: "answer", visibleTextAlreadyDelivered: true },
      },
      false,
    ],
    [
      "audio-only TTS supplement",
      {
        mediaUrl: "file:///tmp/answer.mp3",
        ttsSupplement: { spokenText: "answer" },
      },
      false,
    ],
    [
      "TTS supplement",
      {
        mediaUrl: "file:///tmp/answer.mp3",
        ttsSupplement: { spokenText: "answer", visibleTextAlreadyDelivered: true },
      },
      false,
    ],
  ] as const)("classifies %s payloads", (_name, payload, expected) => {
    expect(isReplyPayloadTerminalContent(payload)).toBe(expected);
  });
});

describe("session writer delivery authority", () => {
  const currentEntry = {
    activeWriterRunId: "run-active",
    lifecycleRevision: "revision-active",
    sessionId: "session-active",
  };

  it("leaves payloads without a writer claim authorized", () => {
    expect(isReplyPayloadSessionWriterDeliveryAuthorized({ text: "reply" }, undefined)).toBe(true);
  });

  it("accepts only the session row that still owns the payload", () => {
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

    expect(isReplyPayloadSessionWriterDeliveryAuthorized(payload, currentEntry)).toBe(true);
    expect(
      isReplyPayloadSessionWriterDeliveryAuthorized(payload, {
        ...currentEntry,
        activeWriterRunId: "run-replacement",
      }),
    ).toBe(false);
    expect(
      isReplyPayloadSessionWriterDeliveryAuthorized(payload, {
        ...currentEntry,
        lifecycleRevision: "revision-replacement",
      }),
    ).toBe(false);
    expect(
      isReplyPayloadSessionWriterDeliveryAuthorized(payload, {
        ...currentEntry,
        sessionId: "session-replacement",
      }),
    ).toBe(false);
    expect(isReplyPayloadSessionWriterDeliveryAuthorized(payload, undefined)).toBe(false);
  });
});

describe("reply payload source occurrence", () => {
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
    ["missing message index", { ...complete, assistantMessageIndex: undefined }],
    ["negative message index", { ...complete, assistantMessageIndex: -1 }],
    ["fractional message index", { ...complete, assistantMessageIndex: 1.5 }],
    ["missing source text", { ...complete, blockSourceText: undefined }],
    ["missing source range", { ...complete, blockSourceRange: undefined }],
    ["negative source start", { ...complete, blockSourceRange: [-1, 3] as const }],
    ["reversed source range", { ...complete, blockSourceRange: [12, 8] as const }],
    ["empty source range", { ...complete, blockSourceRange: [8, 8] as const }],
    ["mismatched source length", { ...complete, blockSourceRange: [8, 13] as const }],
  ])("rejects %s", (_name, metadata) => {
    const payload = { text: "same" };
    if (metadata) {
      setReplyPayloadMetadata(payload, metadata);
    }

    expect(readReplyPayloadSourceOccurrence(payload)).toBeUndefined();
  });
});

it("retains private delivery authority across independently loaded reply module graphs", async () => {
  let open = true;
  const capability = {
    adopt: async () => open,
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
  const receipt = {
    channel: "synthetic",
    to: "original-recipient",
    messageId: "existing-card",
    text: payload.text,
    snapshot: { lines: [] },
  };
  await expect(adopt?.(receipt)).resolves.toBe(true);
  capability.close();
  await expect(adopt?.(receipt)).resolves.toBe(false);
  expect(
    reloaded.isReplyPayloadSessionWriterDeliveryAuthorized(payload, {
      sessionId: "replacement-session",
      activeWriterRunId: "replacement-run",
    }),
  ).toBe(false);
  expect(JSON.stringify(payload)).toBe(JSON.stringify({ text: "Synthetic waiting status" }));
});
