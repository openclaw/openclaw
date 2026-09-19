import { describe, expect, it } from "vitest";
import {
  getReplyPayloadMetadata,
  isReplyPayloadSessionWriterDeliveryAuthorized,
  setReplyPayloadMetadata,
  type ReplyPayloadMetadata,
} from "../../auto-reply/reply-payload.js";
import { selectChatSendFinalReplyPayloads } from "./chat-send-command-replies.js";

const staleWriterAuthority = {
  expectedSessionId: "session-before-replacement",
  expectedWriterRunId: "run-before-replacement",
  sessionKey: "agent:main:webchat",
} as const;

const currentWriterAuthority = {
  expectedSessionId: "replacement-session",
  expectedWriterRunId: "replacement-run",
  sessionKey: "agent:main:webchat",
} as const;

const blockedTranscriptMirror = {
  expectedSessionId: "session-before-replacement",
  sessionKey: "agent:main:source",
  transcriptWriteBlocked: true,
} as const;

const currentTranscriptMirror = {
  expectedSessionId: "replacement-session",
  sessionKey: "agent:main:replacement",
} as const;

function expectStaleWriterRejected(payload: object) {
  expect(getReplyPayloadMetadata(payload)).toMatchObject({
    sessionWriterDeliveryAuthority: staleWriterAuthority,
  });
  expect(
    isReplyPayloadSessionWriterDeliveryAuthorized(payload, {
      activeWriterRunId: "replacement-run",
      sessionId: "replacement-session",
    }),
  ).toBe(false);
}

function selectDuplicateOwnerPayloads(
  blockMetadata: ReplyPayloadMetadata,
  finalMetadata: ReplyPayloadMetadata,
) {
  return selectChatSendFinalReplyPayloads({
    deliveredReplies: [
      {
        kind: "block",
        payload: setReplyPayloadMetadata(
          { text: "done", mediaUrl: "file:///tmp/result.png" },
          blockMetadata,
        ),
      },
      {
        kind: "final",
        payload: setReplyPayloadMetadata(
          { text: "done", mediaUrls: ["/tmp/result.png"] },
          finalMetadata,
        ),
      },
    ],
    foldCommandBlocks: true,
    suppressReplies: false,
  });
}

describe("selectChatSendFinalReplyPayloads", () => {
  it("keeps final replies and suppresses already-persisted media replies", () => {
    const deliveredReplies = [
      { kind: "block" as const, payload: { text: "progress" } },
      { kind: "final" as const, payload: { text: "done" } },
    ];

    expect(
      selectChatSendFinalReplyPayloads({
        deliveredReplies,
        foldCommandBlocks: false,
        suppressReplies: false,
      }),
    ).toEqual([{ text: "done" }]);
    expect(
      selectChatSendFinalReplyPayloads({
        deliveredReplies,
        foldCommandBlocks: true,
        suppressReplies: true,
      }),
    ).toEqual([]);
  });

  it("folds duplicate command media and semantics into the block reply", () => {
    const blockPayload = setReplyPayloadMetadata(
      {
        text: "done",
        mediaUrl: "file:///tmp/result.png",
        trustedLocalMedia: true,
      },
      { assistantMessageIndex: 4 },
    );
    const finalPayload = setReplyPayloadMetadata(
      {
        text: "done",
        mediaUrls: ["/tmp/result.png"],
        sensitiveMedia: true,
        replyToId: "message-1",
      },
      { sessionWriterDeliveryAuthority: staleWriterAuthority },
    );

    const result = selectChatSendFinalReplyPayloads({
      deliveredReplies: [
        {
          kind: "block",
          payload: blockPayload,
        },
        {
          kind: "final",
          payload: finalPayload,
        },
      ],
      foldCommandBlocks: true,
      suppressReplies: false,
    });

    expect(result).toEqual([
      {
        text: "done",
        mediaUrl: undefined,
        mediaUrls: ["file:///tmp/result.png"],
        trustedLocalMedia: true,
        sensitiveMedia: true,
        replyToId: "message-1",
      },
    ]);
    expect(getReplyPayloadMetadata(result[0]!)).toMatchObject({ assistantMessageIndex: 4 });
    expectStaleWriterRejected(result[0]!);
  });

  it("keeps unmatched final text while deduplicating its media", () => {
    const finalPayload = setReplyPayloadMetadata(
      {
        text: "done",
        mediaUrl: "file:///tmp/result.png",
        audioAsVoice: true,
      },
      { sessionWriterDeliveryAuthority: staleWriterAuthority },
    );
    const result = selectChatSendFinalReplyPayloads({
      deliveredReplies: [
        {
          kind: "block",
          payload: { text: "progress", mediaUrl: "/tmp/result.png" },
        },
        {
          kind: "final",
          payload: finalPayload,
        },
      ],
      foldCommandBlocks: true,
      suppressReplies: false,
    });

    expect(result).toEqual([
      {
        text: "progress",
        mediaUrl: undefined,
        mediaUrls: ["/tmp/result.png"],
        audioAsVoice: true,
      },
      {
        text: "done",
        mediaUrl: undefined,
        mediaUrls: undefined,
        audioAsVoice: true,
      },
    ]);
    expectStaleWriterRejected(result[1]!);
  });

  it.each([
    ["stale block", staleWriterAuthority, currentWriterAuthority],
    ["stale final", currentWriterAuthority, staleWriterAuthority],
  ])("keeps conflicting delivery owners separate with a %s", (_label, block, final) => {
    const result = selectDuplicateOwnerPayloads(
      { sessionWriterDeliveryAuthority: block },
      { sessionWriterDeliveryAuthority: final },
    );
    expect(result).toHaveLength(2);
    expect(getReplyPayloadMetadata(result[0]!)).toMatchObject({
      sessionWriterDeliveryAuthority: block,
    });
    expect(getReplyPayloadMetadata(result[1]!)).toMatchObject({
      sessionWriterDeliveryAuthority: final,
    });
    expect(
      result.every((payload) =>
        isReplyPayloadSessionWriterDeliveryAuthorized(payload, {
          activeWriterRunId: "replacement-run",
          sessionId: "replacement-session",
        }),
      ),
    ).toBe(false);
  });

  it.each([
    ["blocked block", blockedTranscriptMirror, currentTranscriptMirror],
    ["blocked final", currentTranscriptMirror, blockedTranscriptMirror],
  ])("keeps conflicting transcript owners separate with a %s", (_label, block, final) => {
    const result = selectDuplicateOwnerPayloads(
      { sourceReplyTranscriptMirror: block },
      { sourceReplyTranscriptMirror: final },
    );

    expect(result).toHaveLength(2);
    expect(getReplyPayloadMetadata(result[0]!)?.sourceReplyTranscriptMirror).toEqual(block);
    expect(getReplyPayloadMetadata(result[1]!)?.sourceReplyTranscriptMirror).toEqual(final);
  });

  it("folds replies when both metadata carriers have the same owners", () => {
    const result = selectDuplicateOwnerPayloads(
      {
        sessionWriterDeliveryAuthority: currentWriterAuthority,
        sourceReplyTranscriptMirror: currentTranscriptMirror,
      },
      {
        sessionWriterDeliveryAuthority: { ...currentWriterAuthority },
        sourceReplyTranscriptMirror: { ...currentTranscriptMirror },
      },
    );

    expect(result).toHaveLength(1);
    expect(getReplyPayloadMetadata(result[0]!)).toMatchObject({
      sessionWriterDeliveryAuthority: currentWriterAuthority,
      sourceReplyTranscriptMirror: currentTranscriptMirror,
    });
  });
});
