import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  isReplyPayloadSessionWriterDeliveryAuthorized,
  setReplyPayloadMetadata,
  type ReplyPayload,
  type ReplyPayloadMetadata,
} from "../../auto-reply/reply-payload.js";
import type { ReplyDispatchOperation } from "../../auto-reply/reply/reply-dispatcher.types.js";
import { createReplyToModeFilterForChannel } from "../../auto-reply/reply/reply-threading.js";
import {
  createOutboundPayloadPlan,
  createStructuredOutboundPayloadPlan,
} from "../../infra/outbound/payloads.js";
import { collectReplyMediaEntries } from "../../infra/outbound/reply-media-entries.js";
import {
  selectChatSendFinalReplyInputs,
  readChatSendReplyPayload,
} from "./chat-send-command-replies.js";

function selectRawReplies(params: {
  deliveredReplies: readonly { kind: "block" | "final"; payload: ReplyPayload }[];
  foldCommandBlocks: boolean;
  suppressReplies: boolean;
}) {
  return selectChatSendFinalReplyInputs({
    ...params,
    deliveredReplies: params.deliveredReplies.map(({ kind, payload }) => ({
      kind,
      input: { kind: "raw", payload },
    })),
  }).map(readChatSendReplyPayload);
}

const staleWriterAuthority = {
  expectedSessionId: "session-before-replacement",
  expectedWriterRunId: "run-before-replacement",
  sessionKey: "agent:main:webchat",
} as const;

const currentWriterAuthority = {
  expectedSessionId: "replacement-session",
  expectedWriterRunId: "replacement-run",
  harnessCompletion: {
    lifecycleRevision: "revision-1",
    requesterAgentId: "main",
    requesterSessionKey: "agent:main:webchat",
    sessionId: "replacement-session",
    sourceRunId: "source-run",
    taskId: "task-1",
    taskRunId: "task-run-1",
    taskStatus: "succeeded",
  },
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
  return selectRawReplies({
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

describe("selectChatSendFinalReplyInputs", () => {
  it("keeps consumed reply policy when raw duplicate replies are folded", () => {
    const filter = createReplyToModeFilterForChannel("first", "telegram");
    filter({ text: "First", replyToId: "source" });
    const later = filter({ text: "Later", replyToId: "source", replyToCurrent: true });
    const modified = copyReplyPayloadMetadata(later, {
      ...later,
      replyToId: "later-target",
      mediaUrl: "https://example.invalid/document.txt",
    });
    const selected = selectRawReplies({
      deliveredReplies: [
        { kind: "block", payload: modified },
        { kind: "final", payload: modified },
      ],
      foldCommandBlocks: true,
      suppressReplies: false,
    });
    const plans = createOutboundPayloadPlan(selected);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.payload.replyToId).toBeUndefined();
    expect(plans[0]?.payload.replyToCurrent).toBe(false);
  });
  it.each(["raw", "prepared"] as const)(
    "keeps a sensitive prepared final from exposing matching %s block media",
    (blockKind) => {
      const blockPayload = setReplyPayloadMetadata(
        { text: "preview", mediaUrl: "/tmp/paired.png" },
        { assistantMessageIndex: 1 },
      );
      const [blockPlan, finalPlan] = createStructuredOutboundPayloadPlan([
        blockPayload,
        { text: "private", mediaUrl: "/tmp/paired.png", sensitiveMedia: true },
      ]);
      if (!blockPlan || !finalPlan) {
        throw new Error("expected both media plans");
      }
      const blockInput: ReplyDispatchOperation =
        blockKind === "raw"
          ? { kind: "raw", payload: blockPayload }
          : { kind: "prepared", plan: blockPlan };
      const inputs = selectChatSendFinalReplyInputs({
        deliveredReplies: [
          { kind: "block", input: blockInput },
          { kind: "final", input: { kind: "prepared", plan: finalPlan } },
        ],
        foldCommandBlocks: true,
        suppressReplies: false,
      });

      expect(inputs.map((input) => readChatSendReplyPayload(input).sensitiveMedia)).toEqual([
        true,
        true,
      ]);
      expect(
        getReplyPayloadMetadata(readChatSendReplyPayload(inputs[0]!))?.assistantMessageIndex,
      ).toBe(1);
      expect(blockPayload).not.toHaveProperty("sensitiveMedia");
    },
  );

  it("keeps prepared replies from distinct writers separate when visible content matches", () => {
    const plans = createStructuredOutboundPayloadPlan(
      ["first-writer", "second-writer"].map((expectedWriterRunId) =>
        setReplyPayloadMetadata(
          { text: "done" },
          {
            sessionWriterDeliveryAuthority: {
              sessionKey: "agent:main:main",
              expectedSessionId: "session-1",
              expectedWriterRunId,
            },
          },
        ),
      ),
    );
    const inputs = selectChatSendFinalReplyInputs({
      deliveredReplies: plans.map((plan, index) => ({
        kind: index === 0 ? "block" : "final",
        input: { kind: "prepared", plan },
      })),
      foldCommandBlocks: true,
      suppressReplies: false,
    });

    expect(inputs.map((input) => input.kind === "prepared" && input.plan)).toEqual(plans);
    expect(
      inputs.map(
        (input) =>
          getReplyPayloadMetadata(readChatSendReplyPayload(input))?.sessionWriterDeliveryAuthority
            ?.expectedWriterRunId,
      ),
    ).toEqual(["first-writer", "second-writer"]);
  });

  it("keeps final replies and suppresses already-persisted media replies", () => {
    const deliveredReplies = [
      { kind: "block" as const, payload: { text: "progress" } },
      { kind: "final" as const, payload: { text: "done" } },
    ];

    expect(
      selectRawReplies({
        deliveredReplies,
        foldCommandBlocks: false,
        suppressReplies: false,
      }),
    ).toEqual([{ text: "done" }]);
    expect(
      selectRawReplies({
        deliveredReplies,
        foldCommandBlocks: true,
        suppressReplies: true,
      }),
    ).toEqual([]);
  });

  it("folds duplicate command media and semantics into the block reply", () => {
    const deliveredReplies = [
      {
        kind: "block" as const,
        payload: setReplyPayloadMetadata(
          {
            text: "done",
            mediaUrl: "file:///tmp/result.png",
            trustedLocalMedia: true,
          },
          { assistantMessageIndex: 4 },
        ),
      },
      {
        kind: "final" as const,
        payload: setReplyPayloadMetadata(
          {
            text: "done",
            mediaUrls: ["/tmp/result.png"],
            sensitiveMedia: true,
            replyToId: "message-1",
            attachments: [
              { path: "/tmp/result.png", name: "Result chart.png", mimeType: "image/png" },
            ],
          },
          { sessionWriterDeliveryAuthority: staleWriterAuthority },
        ),
      },
    ];
    const originalReplies = structuredClone(deliveredReplies);
    const replies = selectRawReplies({
      deliveredReplies,
      foldCommandBlocks: true,
      suppressReplies: false,
    });

    expect(replies.map(({ attachments: _attachments, ...payload }) => payload)).toEqual([
      {
        text: "done",
        mediaUrl: undefined,
        mediaUrls: ["file:///tmp/result.png"],
        trustedLocalMedia: true,
        sensitiveMedia: true,
        replyToId: "message-1",
      },
    ]);
    expect(replies.flatMap((payload) => collectReplyMediaEntries(payload))).toMatchObject([
      {
        url: "file:///tmp/result.png",
        attachment: { name: "Result chart.png", mimeType: "image/png" },
      },
    ]);
    expect(getReplyPayloadMetadata(replies[0]!)).toMatchObject({ assistantMessageIndex: 4 });
    expectStaleWriterRejected(replies[0]!);
    expect(deliveredReplies).toEqual(originalReplies);
  });

  it("keeps unmatched final text while deduplicating its media", () => {
    const replies = selectRawReplies({
      deliveredReplies: [
        {
          kind: "block",
          payload: { text: "progress", mediaUrl: "/tmp/result.png" },
        },
        {
          kind: "final",
          payload: setReplyPayloadMetadata(
            {
              text: "done",
              mediaUrl: "file:///tmp/result.png",
              audioAsVoice: true,
            },
            { sessionWriterDeliveryAuthority: staleWriterAuthority },
          ),
        },
      ],
      foldCommandBlocks: true,
      suppressReplies: false,
    });
    expect(replies).toEqual([
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
    expectStaleWriterRejected(replies[1]!);
  });

  it.each([
    ["stale block", staleWriterAuthority, currentWriterAuthority],
    ["stale final", currentWriterAuthority, staleWriterAuthority],
  ])("keeps conflicting raw delivery owners separate with a %s", (_label, block, final) => {
    const replies = selectDuplicateOwnerPayloads(
      { sessionWriterDeliveryAuthority: block },
      { sessionWriterDeliveryAuthority: final },
    );
    expect(replies).toHaveLength(2);
    expect(getReplyPayloadMetadata(replies[0]!)).toMatchObject({
      sessionWriterDeliveryAuthority: block,
    });
    expect(getReplyPayloadMetadata(replies[1]!)).toMatchObject({
      sessionWriterDeliveryAuthority: final,
    });
    expect(
      replies.every((payload) =>
        isReplyPayloadSessionWriterDeliveryAuthorized(payload, {
          activeWriterRunId: "replacement-run",
          sessionId: "replacement-session",
        }),
      ),
    ).toBe(false);
  });

  it("keeps distinct harness completion claims separate", () => {
    const replies = selectDuplicateOwnerPayloads(
      { sessionWriterDeliveryAuthority: currentWriterAuthority },
      {
        sessionWriterDeliveryAuthority: {
          ...currentWriterAuthority,
          harnessCompletion: {
            ...currentWriterAuthority.harnessCompletion,
            taskRunId: "task-run-2",
          },
        },
      },
    );

    expect(replies).toHaveLength(2);
    expect(
      getReplyPayloadMetadata(replies[0]!)?.sessionWriterDeliveryAuthority?.harnessCompletion
        ?.taskRunId,
    ).toBe("task-run-1");
    expect(
      getReplyPayloadMetadata(replies[1]!)?.sessionWriterDeliveryAuthority?.harnessCompletion
        ?.taskRunId,
    ).toBe("task-run-2");
  });

  it.each([
    ["blocked block", blockedTranscriptMirror, currentTranscriptMirror],
    ["blocked final", currentTranscriptMirror, blockedTranscriptMirror],
  ])("keeps conflicting raw transcript owners separate with a %s", (_label, block, final) => {
    const replies = selectDuplicateOwnerPayloads(
      { sourceReplyTranscriptMirror: block },
      { sourceReplyTranscriptMirror: final },
    );
    expect(replies).toHaveLength(2);
    expect(getReplyPayloadMetadata(replies[0]!)?.sourceReplyTranscriptMirror).toEqual(block);
    expect(getReplyPayloadMetadata(replies[1]!)?.sourceReplyTranscriptMirror).toEqual(final);
  });

  it("folds raw replies when both metadata carriers have the same owners", () => {
    const replies = selectDuplicateOwnerPayloads(
      {
        sessionWriterDeliveryAuthority: currentWriterAuthority,
        sourceReplyTranscriptMirror: currentTranscriptMirror,
      },
      {
        sessionWriterDeliveryAuthority: { ...currentWriterAuthority },
        sourceReplyTranscriptMirror: { ...currentTranscriptMirror },
      },
    );
    expect(replies).toHaveLength(1);
    expect(getReplyPayloadMetadata(replies[0]!)).toMatchObject({
      sessionWriterDeliveryAuthority: currentWriterAuthority,
      sourceReplyTranscriptMirror: currentTranscriptMirror,
    });
  });

  it.each([
    { caption: "matching", blockText: "done", expectedTexts: ["done"] },
    { caption: "different", blockText: "preview", expectedTexts: ["preview", "done"] },
  ])("retains duplicate command image metadata with $caption captions", (testCase) => {
    const mediaPath = path.resolve("media", "chart-01.png");
    const mediaUrl = pathToFileURL(mediaPath).href;
    const attachment = {
      path: mediaPath,
      name: "Quarterly chart.png",
      mimeType: "image/png",
      width: 640,
    };
    const deliveredReplies = [
      {
        kind: "block" as const,
        payload: {
          text: testCase.blockText,
          mediaUrl,
          attachments: [{ path: mediaPath, height: 480 }],
        },
      },
      {
        kind: "final" as const,
        payload: { text: "done", mediaUrls: [mediaPath], attachments: [attachment] },
      },
    ];
    const originalReplies = structuredClone(deliveredReplies);

    const replies = selectRawReplies({
      deliveredReplies,
      foldCommandBlocks: true,
      suppressReplies: false,
    });

    expect(replies.map((payload) => payload.text)).toEqual(testCase.expectedTexts);
    expect(replies.flatMap((payload) => payload.mediaUrls ?? [])).toEqual([mediaUrl]);
    expect(replies[0]).toMatchObject({
      mediaUrls: [mediaUrl],
      attachments: [{ ...attachment, path: mediaUrl, height: 480 }],
    });
    expect(deliveredReplies).toEqual(originalReplies);
  });
});
