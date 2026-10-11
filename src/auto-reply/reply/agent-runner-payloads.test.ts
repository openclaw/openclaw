// Tests reply payload construction and metadata propagation from agent runs.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it } from "vitest";
import { buildEmbeddedRunPayloads } from "../../agents/embedded-agent-runner/run/payloads.js";
import type { ChannelThreadingAdapter } from "../../channels/plugins/types.public.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { selectHeartbeatToolResponse } from "../heartbeat-tool-response.js";
import {
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import type { DirectBlockDelivery } from "./reply-delivery.js";
import { createReplyToModeFilterForChannel } from "./reply-threading.js";

const baseParams = {
  isHeartbeat: false,
  didLogHeartbeatStrip: false,
  blockStreamingEnabled: false,
  blockReplyPipeline: null,
  replyToMode: "off" as const,
};

type TestReplyPayloadParams = Partial<Parameters<typeof buildReplyPayloads>[0]> &
  Pick<Parameters<typeof buildReplyPayloads>[0], "payloads">;

type ReplyRouteDedupeCase = {
  name: string;
  channel: "slack" | "discord" | "mattermost";
  text: string;
  payload?: Record<string, unknown>;
  payloads?: TestReplyPayloadParams["payloads"];
  params: Partial<TestReplyPayloadParams>;
  target: Record<string, unknown>;
  to?: string;
  sharedFirstReply?: boolean;
  expected: string[];
  expectedReplyIds?: Array<string | undefined>;
};

type DirectBlockDedupeCase = {
  name: string;
  payloads: TestReplyPayloadParams["payloads"];
  directBlockPayloads: ReplyPayload[];
  params?: Partial<TestReplyPayloadParams>;
  expected?: Record<string, unknown>;
};

function buildTestReplyPayloads(overrides: TestReplyPayloadParams) {
  return buildReplyPayloads({ ...baseParams, ...overrides });
}

describe("heartbeat reply scratch", () => {
  it.each([
    { notify: false, proposals: ["  PRIVATE_SCRATCH\n\n- keep exact spacing  \n"] },
    { notify: true, proposals: [""] },
    { notify: false, proposals: ["old proposal", "new proposal"] },
    { notify: false, proposals: ["old proposal", undefined] },
  ])(
    "preserves the latest private decision through embedded and final payloads: %j",
    async ({ notify, proposals }) => {
      const responses = proposals.map((scratch, index) => ({
        outcome: "done" as const,
        notify,
        summary: `Monitor checked ${index + 1}.`,
        ...(scratch !== undefined ? { scratch } : {}),
      }));
      const payloads = responses.flatMap((heartbeatToolResponse) =>
        buildEmbeddedRunPayloads({
          assistantTexts: [],
          lastAssistant: undefined,
          sessionKey: "agent:main:main",
          isHeartbeatTrigger: true,
          heartbeatToolResponse,
        }),
      );
      const expected = proposals.at(-1);
      const embedded = expectDefined(
        selectHeartbeatToolResponse(payloads),
        "expected the embedded heartbeat response",
      );
      expect(getReplyPayloadMetadata(embedded.payload)?.heartbeatScratchProposal).toBe(expected);
      const { replyPayloads } = await buildTestReplyPayloads({ isHeartbeat: true, payloads });

      expect(replyPayloads).toHaveLength(proposals.length);
      const selected = expectDefined(
        selectHeartbeatToolResponse(replyPayloads),
        "expected the final heartbeat response",
      );
      expect(getReplyPayloadMetadata(selected.payload)?.heartbeatScratchProposal).toBe(expected);
      expect(selected.response).toEqual({
        outcome: "done",
        notify,
        summary: `Monitor checked ${proposals.length}.`,
      });
      const serialized = JSON.stringify(replyPayloads);
      expect(serialized).not.toContain('"scratch"');
      for (const scratch of proposals) {
        if (scratch) {
          expect(serialized).not.toContain(JSON.stringify(scratch));
        }
      }
    },
  );
});

type ResolveReplyTransportParams = Parameters<
  NonNullable<ChannelThreadingAdapter["resolveReplyTransport"]>
>[0];

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

async function expectSameTargetRepliesDelivered(params: { provider: string; to: string }) {
  const { replyPayloads } = await buildTestReplyPayloads({
    payloads: [{ text: "hello world!" }],
    messageProvider: "heartbeat",
    originatingChannel: "feishu",
    originatingTo: "ou_abc123",
    messagingToolSentTexts: ["different message"],
    messagingToolSentTargets: [{ tool: "message", provider: params.provider, to: params.to }],
  });

  expect(replyPayloads).toHaveLength(1);
  expect(replyPayloads[0]?.text).toBe("hello world!");
}

describe("buildReplyPayloads media filter integration", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            threading: {
              resolveReplyTransport: ({
                threadId,
                replyToId,
                replyToIsExplicit,
                replyDelivery,
              }: ResolveReplyTransportParams) => {
                const allowedReply = replyDelivery?.replyToMode === "off" ? undefined : replyToId;
                // Slack uses the known root for inherited replies, but explicit targets win.
                const resolved =
                  replyToIsExplicit === false
                    ? (threadId ?? allowedReply)
                    : (allowedReply ?? threadId);
                return {
                  replyToId: resolved == null ? undefined : String(resolved),
                  threadId: null,
                };
              },
            },
          },
          source: "test",
        },
        {
          pluginId: "mattermost",
          plugin: {
            ...createChannelTestPluginBase({ id: "mattermost" }),
            threading: {
              resolveReplyTransport: ({
                threadId,
                replyToId,
                replyToIsExplicit,
                replyDelivery,
              }: ResolveReplyTransportParams) => {
                const ambientThreadId = threadId != null ? String(threadId) : undefined;
                const isFlatDirect =
                  replyDelivery?.chatType === "direct" && replyDelivery.replyToMode === "off";
                const resolvedThreadId = isFlatDirect
                  ? undefined
                  : replyDelivery
                    ? replyToIsExplicit
                      ? (replyToId ?? ambientThreadId)
                      : (ambientThreadId ?? replyToId ?? undefined)
                    : (ambientThreadId ?? replyToId);
                return {
                  replyToId: isFlatDirect ? null : resolvedThreadId,
                  threadId: resolvedThreadId ?? null,
                };
              },
            },
          },
          source: "test",
        },
        {
          pluginId: "telegram",
          plugin: createChannelTestPluginBase({ id: "telegram" }),
          source: "test",
        },
        {
          pluginId: "discord",
          plugin: createChannelTestPluginBase({ id: "discord" }),
          source: "test",
        },
        {
          pluginId: "feishu-plugin",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "feishu" }),
            meta: {
              id: "feishu",
              label: "Feishu",
              selectionLabel: "Feishu",
              docsPath: "/channels/feishu",
              blurb: "test stub",
              aliases: ["lark"],
            },
          },
        },
      ]),
    );
  });

  it.each<{
    name: string;
    payload: ReplyPayload;
    sentMediaUrls?: string[];
    expected?: ReplyPayload[];
  }>([
    {
      name: "unsent media after the legacy media URL was already sent",
      payload: {
        text: "already sent",
        mediaUrl: "file:///tmp/sent.ogg",
        mediaUrls: ["file:///tmp/unsent-a.ogg", "file:///tmp/unsent-b.ogg"],
        audioAsVoice: true,
      },
      sentMediaUrls: ["file:///tmp/sent.ogg"],
      expected: [
        {
          text: "already sent",
          mediaUrl: undefined,
          mediaUrls: ["file:///tmp/unsent-a.ogg", "file:///tmp/unsent-b.ogg"],
          audioAsVoice: true,
        },
      ],
    },
    {
      name: "an enabled configured delivery operation",
      payload: { text: "already sent", delivery: { pin: { enabled: true } } },
    },
  ])("preserves $name when only the reply text was sent", async (testCase) => {
    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [testCase.payload],
      messagingToolSentTexts: ["already sent"],
      messagingToolSentMediaUrls: testCase.sentMediaUrls,
    });

    const expected = testCase.expected ?? [testCase.payload];
    expect(replyPayloads).toHaveLength(expected.length);
    for (const [index, payload] of expected.entries()) {
      expect(replyPayloads[index]).toMatchObject(payload);
    }
  });

  it("shares first-reply threading across staged payload builds", async () => {
    const applyReplyToMode = createReplyToModeFilterForChannel("first", "whatsapp");
    const sharedParams = {
      ...baseParams,
      replyToMode: "first" as const,
      replyToChannel: "whatsapp" as const,
      currentMessageId: "msg",
      applyReplyToMode,
    };
    const first = await buildReplyPayloads({
      ...sharedParams,
      payloads: [{ text: "internal commentary", isCommentary: true }],
    });
    const fallback = await buildReplyPayloads({
      ...sharedParams,
      payloads: [{ text: "run failed", isError: true }],
    });

    expect(first.replyPayloads[0]?.replyToId).toBe("msg");
    expect(fallback.replyPayloads[0]?.replyToId).toBeUndefined();
  });

  it("strips legacy bracket tool blocks from heartbeat replies", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
      isHeartbeat: true,
      payloads: [
        {
          text: [
            "Before",
            '[TOOL_CALL]{tool => "exec", args => {"command":"ls"}}[/TOOL_CALL]',
            '[TOOL_RESULT]{"output":"secret result"}[/TOOL_RESULT]',
            "After",
          ].join("\n"),
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("Before\n\n\nAfter");
  });

  it("preserves internal delivery metadata through final payload normalization", async () => {
    const payload = markReplyPayloadForSourceSuppressionDelivery({
      text: "⚠️ API rate limit reached.\n[[reply_to_current]]",
    });

    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [payload],
      replyToMode: "all",
      currentMessageId: "msg-1",
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: "⚠️ API rate limit reached.",
      replyToId: "msg-1",
    });
    expectFields(
      getReplyPayloadMetadata(expectDefined(replyPayloads[0], "replyPayloads[0] test invariant")),
      {
        deliverDespiteSourceReplySuppression: true,
      },
    );
  });

  it("sanitizes source reply transcript mirror text with final payload text", async () => {
    const text = [
      "Visible",
      "<function_response>",
      'Searching for: "what skills matter most in the age of AI"',
      "...",
      "</function_response>",
      "Done",
    ].join("\n");
    const payload = setReplyPayloadMetadata(
      { text },
      {
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main",
          text,
        },
      },
    );

    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [payload],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("Visible\n\nDone");
    expect(
      getReplyPayloadMetadata(expectDefined(replyPayloads[0], "replyPayloads[0] test invariant"))
        ?.sourceReplyTranscriptMirror?.text,
    ).toBe("Visible\n\nDone");
  });

  it("redacts copied inbound context from the visible reply and its transcript mirror", async () => {
    const conversationContext = [
      "[Chat messages since your last reply - for context]",
      "Alice: private history",
      "",
      "[Current message - respond to this]",
      '<function_calls><invoke name="exec">private XML</invoke></function_calls>',
      "private inbound paragraph",
    ].join("\n");
    const text = `${conversationContext}\n\nVisible answer.`;
    const payload = setReplyPayloadMetadata(
      { text },
      { sourceReplyTranscriptMirror: { sessionKey: "agent:main", text } },
    );

    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [payload],
      conversationContext,
    });

    expect(replyPayloads[0]?.text).toBe("Visible answer.");
    expect(
      getReplyPayloadMetadata(expectDefined(replyPayloads[0], "expected prepared reply payload"))
        ?.sourceReplyTranscriptMirror?.text,
    ).toBe("Visible answer.");
  });

  it("dedupes final media only against message-tool media sent to the same route", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [{ text: "photo", mediaUrl: "file:///tmp/discord-photo.jpg" }],
      messageProvider: "slack",
      originatingTo: "channel:C1",
      messagingToolSentMediaUrls: ["file:///tmp/slack-photo.jpg", "file:///tmp/discord-photo.jpg"],
      messagingToolSentTargets: [
        {
          tool: "slack",
          provider: "slack",
          to: "channel:C1",
          mediaUrls: ["file:///tmp/slack-photo.jpg"],
        },
        {
          tool: "discord",
          provider: "discord",
          to: "channel:C2",
          mediaUrls: ["file:///tmp/discord-photo.jpg"],
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.mediaUrl).toBe("file:///tmp/discord-photo.jpg");
  });

  it("delivers distinct same-target replies when message tool target provider is generic", async () => {
    await expectSameTargetRepliesDelivered({ provider: "message", to: "ou_abc123" });
  });

  it("dedupes same-target final text already sent by a message tool", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [{ text: "hello world!" }],
      messageProvider: "telegram",
      originatingTo: "268300329",
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentTargets: [
        { tool: "telegram", provider: "telegram", to: "268300329", text: "hello world!" },
      ],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it.each<ReplyRouteDedupeCase>([
    {
      name: "dedupes against final routes when first-reply state is shared",
      channel: "slack",
      text: "result",
      payloads: [{ text: "intro" }, { text: "result" }],
      params: { replyToMode: "first", currentMessageId: "111.000" },
      target: { threadId: "111.000" },
      sharedFirstReply: true,
      expected: ["intro", "result"],
      expectedReplyIds: ["111.000", undefined],
    },
    {
      name: "dedupes an explicit Mattermost DM reply against its top-level delivery route",
      channel: "mattermost",
      text: "same reply",
      payload: { replyToId: "post-1", replyToTag: true },
      params: { replyToMode: "off", originatingChatType: "direct" },
      to: "user:U1",
      target: {},
      expected: [],
    },
    {
      name: "dedupes an implicit Mattermost send in the active thread",
      channel: "mattermost",
      text: "same reply",
      params: {
        replyToMode: "all",
        currentMessageId: "child-post",
        originatingThreadId: "root-post",
      },
      target: { threadId: "root-post", threadImplicit: true },
      expected: [],
    },
  ])("$name", async (testCase) => {
    const { channel, text, params, target } = testCase;
    const to = testCase.to ?? "channel:C1";
    const { replyPayloads } = await buildTestReplyPayloads({
      config: {},
      payloads: testCase.payloads ?? [{ text, ...testCase.payload }],
      replyToChannel: channel,
      messageProvider: channel,
      originatingTo: to,
      messagingToolSentTexts: [text],
      messagingToolSentTargets: [{ tool: channel, provider: channel, to, text, ...target }],
      ...params,
      ...(testCase.sharedFirstReply
        ? { applyReplyToMode: createReplyToModeFilterForChannel("first", channel) }
        : {}),
    });

    expect(replyPayloads.map((payload) => payload.text)).toEqual(testCase.expected);
    if (testCase.expectedReplyIds) {
      expect(replyPayloads.map((payload) => payload.replyToId)).toEqual(testCase.expectedReplyIds);
    }
  });

  it("strips media already sent by the block pipeline after normalizing both paths", async () => {
    const normalizeMediaPaths = async (payload: { mediaUrl?: string; mediaUrls?: string[] }) => {
      const rewrite = (value?: string) =>
        value === "file:///tmp/voice.ogg" ? "file:///tmp/outbound/voice.ogg" : value;
      return {
        ...payload,
        mediaUrl: rewrite(payload.mediaUrl),
        mediaUrls: payload.mediaUrls?.map((value) => rewrite(value) ?? value),
      };
    };
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => false,
      isAborted: () => false,
      hasSentPayload: () => false,
      enqueue: () => {},
      flush: async () => {},
      stop: () => {},
      hasBuffered: () => false,
      hasRetryBlockedDelivery: () => false,
      getSentMediaUrls: () => ["file:///tmp/voice.ogg"],
    };

    const { replyPayloads } = await buildTestReplyPayloads({
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      normalizeMediaPaths,
      payloads: [{ text: "caption", mediaUrl: "file:///tmp/voice.ogg" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: "caption",
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
  });

  it("suppresses already-sent text plus media before stripping block-sent media", async () => {
    const sentKey = JSON.stringify({
      text: "caption",
      mediaList: ["file:///tmp/outbound/voice.ogg"],
    });
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => false,
      isAborted: () => false,
      hasSentPayload: (payload) =>
        JSON.stringify({
          text: (payload.text ?? "").trim(),
          mediaList: [
            ...(payload.mediaUrl ? [payload.mediaUrl] : []),
            ...(payload.mediaUrls ?? []),
          ],
        }) === sentKey,
      enqueue: () => {},
      flush: async () => {},
      stop: () => {},
      hasBuffered: () => false,
      hasRetryBlockedDelivery: () => false,
      getSentMediaUrls: () => ["file:///tmp/outbound/voice.ogg"],
    };

    const { replyPayloads } = await buildTestReplyPayloads({
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      normalizeMediaPaths: async (payload) => payload,
      payloads: [{ text: "caption", mediaUrl: "file:///tmp/outbound/voice.ogg" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("preserves unsent text-only final payloads after block pipeline streamed partial content", async () => {
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => true,
      isAborted: () => false,
      hasSentPayload: () => false,
      enqueue: () => {},
      flush: async () => {},
      stop: () => {},
      hasBuffered: () => false,
      hasRetryBlockedDelivery: () => false,
      getSentMediaUrls: () => [],
    };
    // The pipeline streamed some partial content, but the final text payload was
    // never sent (hasSentPayload returns false). The old bug dropped all text-only
    // finals unconditionally; the fix preserves unsent finals.
    const { replyPayloads } = await buildTestReplyPayloads({
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "all",
      payloads: [{ text: "response", replyToId: "post-123" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("response");
  });

  it("preserves final rich content when only its text was streamed", async () => {
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => true,
      isAborted: () => false,
      hasSentPayload: () => true,
      hasSentExactPayload: () => false,
      enqueue: () => {},
      flush: async () => {},
      stop: () => {},
      hasBuffered: () => false,
      hasRetryBlockedDelivery: () => false,
      getSentMediaUrls: () => [],
    };
    const presentation = {
      blocks: [{ type: "buttons" as const, buttons: [{ label: "Open", value: "open" }] }],
    };

    const { replyPayloads } = await buildTestReplyPayloads({
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      payloads: [{ text: "response", presentation }],
    });

    expect(replyPayloads).toEqual([
      expect.objectContaining({
        text: "response",
        presentation,
      }),
    ]);
  });

  it("drops final caption and media already sent as one coalesced block payload", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
      coalescing: {
        minChars: 1,
        maxChars: 200,
        idleMs: 0,
        joiner: " ",
      },
    });
    pipeline.enqueue({ text: "Preview" });
    pipeline.enqueue({ text: "below" });
    pipeline.enqueue({ mediaUrls: ["file:///photo.png"] });
    await pipeline.flush({ force: true });

    const { replyPayloads } = await buildTestReplyPayloads({
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      payloads: [{ text: "Preview below", mediaUrls: ["file:///photo.png"] }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("preserves post-stream error payloads when block pipeline streamed successfully", async () => {
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => true,
      isAborted: () => false,
      hasSentPayload: () => false,
      enqueue: () => {},
      flush: async () => {},
      stop: () => {},
      hasBuffered: () => false,
      hasRetryBlockedDelivery: () => false,
      getSentMediaUrls: () => [],
    };

    const { replyPayloads } = await buildTestReplyPayloads({
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "all",
      payloads: [{ text: "Agent couldn't generate a response. Please try again.", isError: true }],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: "Agent couldn't generate a response. Please try again.",
      isError: true,
    });
  });

  it("keeps error payloads during silent turns", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
      silentExpected: true,
      payloads: [
        { text: "normal maintenance reply" },
        {
          text: "⚠️ write failed: Memory flush writes are restricted to memory/2026-05-05.md; use that path only.",
          isError: true,
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: "⚠️ write failed: Memory flush writes are restricted to memory/2026-05-05.md; use that path only.",
      isError: true,
    });
  });

  it("keeps voice media payloads during silent turns", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
      silentExpected: true,
      payloads: [{ text: "NO_REPLY", mediaUrl: "file:///tmp/voice.opus", audioAsVoice: true }],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: undefined,
      mediaUrl: "file:///tmp/voice.opus",
      audioAsVoice: true,
    });
  });

  it("drops empty voice markers during silent turns", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
      silentExpected: true,
      payloads: [{ audioAsVoice: true }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("preserves inline caption text when lifting markdown image replies into media", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
      extractMarkdownImages: true,
      payloads: [{ text: 'Look ![chart](https://example.com/chart.png "Quarterly chart") now' }],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: "Look now",
      mediaUrl: "https://example.com/chart.png",
      mediaUrls: ["https://example.com/chart.png"],
    });
  });

  it("keeps markdown local file images as plain text in final replies", async () => {
    const text = "Look ![chart](file:///etc/passwd) now";
    const { replyPayloads } = await buildTestReplyPayloads({
      extractMarkdownImages: true,
      payloads: [{ text }],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text,
    });
    expect(replyPayloads[0]?.mediaUrl).toBeUndefined();
    expect(replyPayloads[0]?.mediaUrls).toBeUndefined();
  });

  it.each<DirectBlockDedupeCase>([
    {
      name: "drops a final caption already sent with direct media (streaming: true)",
      directBlockPayloads: [
        setReplyPayloadMetadata(
          { text: "response", mediaUrl: "/tmp/fetched.png" },
          { assistantMessageIndex: 1 },
        ),
      ],
      payloads: [setReplyPayloadMetadata({ text: "response" }, { assistantMessageIndex: 1 })],
      params: { blockStreamingEnabled: true },
    },
    {
      name: "preserves the same caption from a different assistant message",
      directBlockPayloads: [
        setReplyPayloadMetadata(
          { text: "response", mediaUrl: "/tmp/fetched.png" },
          { assistantMessageIndex: 1 },
        ),
      ],
      payloads: [setReplyPayloadMetadata({ text: "response" }, { assistantMessageIndex: 2 })],
      expected: { text: "response" },
    },
    {
      name: "ignores direct status notices when matching final text",
      directBlockPayloads: [{ text: "Compacting", isStatusNotice: true }, { text: "response" }],
      payloads: [{ text: "response\n\nMEDIA:/tmp/generated.png" }],
      params: { blockStreamingEnabled: true },
      expected: { text: undefined, mediaUrls: ["/tmp/generated.png"] },
    },
  ])("$name", async ({ payloads, directBlockPayloads, params, expected }) => {
    const { replyPayloads } = await buildTestReplyPayloads({
      directBlockDeliveries: directBlockPayloads.map((payload): DirectBlockDelivery => ({
        payload,
        outcome: "delivered",
      })),
      payloads,
      ...params,
    });

    expect(replyPayloads).toHaveLength(expected ? 1 : 0);
    if (expected) {
      expectFields(replyPayloads[0], expected);
    }
  });

  it("preserves final text when internal whitespace changed", async () => {
    const directBlockDeliveries: DirectBlockDelivery[] = [
      {
        payload: setReplyPayloadMetadata({ text: "constx=1" }, { assistantMessageIndex: 1 }),
        outcome: "delivered",
      },
    ];
    const finalPayload = setReplyPayloadMetadata(
      { text: "const x = 1\n\nMEDIA:/tmp/generated.png" },
      { assistantMessageIndex: 1 },
    );

    const { replyPayloads } = await buildTestReplyPayloads({
      blockStreamingEnabled: true,
      directBlockDeliveries,
      payloads: [finalPayload],
    });

    expectFields(replyPayloads[0], {
      text: "const x = 1",
      mediaUrls: ["/tmp/generated.png"],
    });
  });

  it("does not suppress same-target replies when accountId differs", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [{ text: "hello world!" }],
      messageProvider: "heartbeat",
      originatingChannel: "telegram",
      originatingTo: "268300329",
      accountId: "personal",
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [
        {
          tool: "telegram",
          provider: "telegram",
          to: "268300329",
          accountId: "work",
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("hello world!");
  });
});
