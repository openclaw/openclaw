import { expect, it, vi, type Mock } from "vitest";
import {
  getReplyPayloadMetadata,
  isReplyPayloadSessionWriterDeliveryAuthorized,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginHookHandlerMap } from "../../plugins/hook-types.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { addTestHook } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import type { createOutboundTestPlugin } from "../../test-utils/channel-plugins.js";
import {
  prepareOutboundPayloadBatch,
  prepareStructuredOutboundPayloadBatch,
} from "./deliver-prepare.js";
import type { deliverOutboundPayloads } from "./deliver.js";
import { createStructuredOutboundPayloadPlan } from "./payloads.js";

type PreparationFixture = {
  matrixChunkConfig: OpenClawConfig;
  matrixOutboundForTest: ChannelOutboundAdapter;
  setTestOutbound: (
    overrides: Partial<ChannelOutboundAdapter>,
    id?: Parameters<typeof createOutboundTestPlugin>[0]["id"],
  ) => void;
  hookMocks: {
    runner: {
      hasHooks: Mock<(_hookName?: string) => boolean>;
      runMessageSending: Mock<PluginHookHandlerMap["message_sending"]>;
      runReplyPayloadSending: Mock<PluginHookHandlerMap["reply_payload_sending"]>;
    };
  };
};

type DeliverOutboundArgs = Parameters<typeof deliverOutboundPayloads>[0];
type MatrixDeliveryArgs = Omit<DeliverOutboundArgs, "cfg" | "channel" | "to" | "payloads"> &
  Partial<Pick<DeliverOutboundArgs, "cfg" | "to" | "payloads">>;
type ImageProjectionFixture = PreparationFixture & {
  deliverMatrix: (params: MatrixDeliveryArgs) => ReturnType<typeof deliverOutboundPayloads>;
  requireMatrixSendCall: (sendMatrix: ReturnType<typeof vi.fn>, index?: number) => unknown[];
};

// Keep registration in deliver.test.ts so its hoisted queue/hooks and per-case registry reset apply.
export function registerOutboundPreparationMetadataTests({
  matrixChunkConfig,
  matrixOutboundForTest,
  setTestOutbound,
  hookMocks,
}: PreparationFixture) {
  it.each(["raw", "structured"] as const)(
    "keeps %s preparation metadata semantics through channel and awaited hook transforms",
    async (operation) => {
      const capture = {};
      let currentWriter = {
        activeWriterRunId: "run-original",
        lifecycleRevision: "revision-original",
        sessionId: "session-original",
      };
      const sourcePayload = setReplyPayloadMetadata(
        { text: "original", mediaUrl: "https://example.com/attachment.png" },
        {
          assistantMessageIndex: 4,
          finalDeliveryCapture: capture,
          sessionWriterDeliveryAuthority: {
            expectedWriterRunId: currentWriter.activeWriterRunId,
            expectedLifecycleRevision: currentWriter.lifecycleRevision,
            expectedSessionId: currentWriter.sessionId,
            sessionKey: "agent:main:matrix:room:prepared",
          },
        },
      );
      expect(isReplyPayloadSessionWriterDeliveryAuthorized(sourcePayload, currentWriter)).toBe(
        true,
      );
      setTestOutbound({
        ...matrixOutboundForTest,
        normalizePayload: ({ payload }) =>
          setReplyPayloadMetadata(
            {
              ...payload,
              text: payload.channelData?.normalized ? payload.text : " ",
              channelData: { normalized: true },
            },
            { assistantMessageIndex: undefined },
          ),
        normalizePayloadBatch: ({ payloads }) => payloads.map(({ payload }) => ({ ...payload })),
      });
      hookMocks.runner.hasHooks.mockImplementation((name) => name === "message_sending");
      hookMocks.runner.runMessageSending.mockImplementationOnce(async () => {
        await Promise.resolve();
        currentWriter = { ...currentWriter, activeWriterRunId: "run-replacement" };
        return { content: "after modifier" };
      });
      const params = {
        cfg: matrixChunkConfig,
        channel: "matrix" as const,
        to: "!room:example",
        payloads: [sourcePayload],
        deps: { matrix: vi.fn() },
      };
      const batch =
        operation === "structured"
          ? await prepareStructuredOutboundPayloadBatch(
              params,
              createStructuredOutboundPayloadPlan([sourcePayload]),
            )
          : await prepareOutboundPayloadBatch(params);
      const [entry] = batch.entries;
      expect(entry?.status).toBe("accepted");
      if (!entry || entry.status !== "accepted") {
        throw new Error("expected prepared payload");
      }
      expect(entry.payload.text).toBe("after modifier");
      const metadata = getReplyPayloadMetadata(entry.payload);
      expect(metadata).toHaveProperty("assistantMessageIndex", undefined);
      expect(getReplyPayloadMetadata(sourcePayload)?.assistantMessageIndex).toBe(4);
      if (operation === "structured") {
        expect(metadata?.finalDeliveryCapture).toBe(capture);
        expect(isReplyPayloadSessionWriterDeliveryAuthorized(entry.payload, currentWriter)).toBe(
          false,
        );
      } else {
        expect(metadata?.finalDeliveryCapture).toBeUndefined();
        expect(metadata?.sessionWriterDeliveryAuthority).toBeUndefined();
      }
    },
  );
}

export function registerOutboundImageProjectionTests({
  matrixChunkConfig,
  matrixOutboundForTest,
  setTestOutbound,
  hookMocks,
  deliverMatrix,
  requireMatrixSendCall,
}: ImageProjectionFixture) {
  function installRegisteredPayloadHooks(
    hooks: Pick<PluginHookHandlerMap, "reply_payload_sending" | "message_sending">,
  ) {
    const registry = createEmptyPluginRegistry();
    for (const hookName of ["reply_payload_sending", "message_sending"] as const) {
      addTestHook({ registry, pluginId: "image-presentation", hookName, handler: hooks[hookName] });
    }
    const runner = createHookRunner(registry);
    hookMocks.runner.hasHooks.mockImplementation(
      (name) =>
        (name === "reply_payload_sending" || name === "message_sending") && runner.hasHooks(name),
    );
    hookMocks.runner.runReplyPayloadSending.mockImplementation((event, context) =>
      runner.runReplyPayloadSending(event, context),
    );
    hookMocks.runner.runMessageSending.mockImplementation((event, context) =>
      runner.runMessageSending(event, context),
    );
  }

  it("keeps markdown images as text for channels that do not opt in", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-text", roomId: "!room" });

    await deliverMatrix({
      cfg: matrixChunkConfig,
      payloads: [{ text: "Tech: ![Node.js](https://img.shields.io/badge/Node.js-339933)" }],
      deps: { matrix: sendMatrix },
    });

    const sendMatrixCall = requireMatrixSendCall(sendMatrix);
    const sendMatrixOptions = sendMatrixCall[2] as { mediaUrl?: unknown } | undefined;
    expect(sendMatrixCall[0]).toBe("!room:example");
    expect(sendMatrixCall[1]).toBe("Tech: ![Node.js](https://img.shields.io/badge/Node.js-339933)");
    expect(sendMatrixOptions?.mediaUrl).toBeUndefined();
  });

  it("extracts markdown images for channels that opt in", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-media", roomId: "!room" });
    setTestOutbound({ ...matrixOutboundForTest, extractMarkdownImages: true });

    await deliverMatrix({
      cfg: matrixChunkConfig,
      payloads: [{ text: "Chart ![chart](https://example.com/chart.png) now" }],
      deps: { matrix: sendMatrix },
    });

    const sendMatrixCall = requireMatrixSendCall(sendMatrix);
    const sendMatrixOptions = sendMatrixCall[2] as { mediaUrl?: unknown } | undefined;
    expect(sendMatrixCall[0]).toBe("!room:example");
    expect(sendMatrixCall[1]).toBe("Chart now");
    expect(sendMatrixOptions?.mediaUrl).toBe("https://example.com/chart.png");
  });

  it.each([
    { operation: "raw", extractMarkdownImages: true },
    { operation: "structured", extractMarkdownImages: true },
    { operation: "raw", extractMarkdownImages: false },
    { operation: "structured", extractMarkdownImages: false },
  ] as const)(
    "projects hook-added channel images ($operation; enabled=$extractMarkdownImages)",
    async ({ operation, extractMarkdownImages }) => {
      const { telegramOutbound } = await loadBundledPluginFacade<{
        telegramOutbound: ChannelOutboundAdapter;
      }>({ pluginId: "telegram", artifactBasename: "api.js" });
      setTestOutbound({ ...telegramOutbound, extractMarkdownImages }, "telegram");
      const explicitUrl = "https://example.com/explicit.png";
      const originalUrl = "https://example.com/original.png";
      const replyUrl = "https://example.com/reply.png";
      const messageUrl = "https://example.com/message.png";
      const literalText =
        "[[reply_to:literal]] [[audio_as_voice]]\nMEDIA:https://example.com/literal.png";
      const replyText = `Reply![reply](${replyUrl}) caption.`;
      const messageText =
        `![leading](${messageUrl})    Keep  prose. Use \`a  b\`![message](${messageUrl}).  \r\n` +
        `Chart ![trailing](${messageUrl})  \r\nLeft ![adjacent](${messageUrl})caption.\r\n` +
        `  ![indented](${messageUrl})    Prefix.\r\n` +
        `Left![one](${messageUrl}) ![two](${messageUrl})right\r\n` +
        `Next\r\n${literalText}\r\nAfter  \r\n`;
      const replyHook = vi.fn<PluginHookHandlerMap["reply_payload_sending"]>(
        async ({ payload }) => ({ payload: { ...payload, text: replyText } }),
      );
      const messageHook = vi.fn<PluginHookHandlerMap["message_sending"]>(async () => ({
        content: messageText,
      }));
      installRegisteredPayloadHooks({
        reply_payload_sending: replyHook,
        message_sending: messageHook,
      });
      const payloads: ReplyPayload[] = [
        {
          text: `Original ![original](${originalUrl}) caption.`,
          mediaUrls: [explicitUrl],
          attachments: [{ url: explicitUrl, name: "explicit.png", mimeType: "image/png" }],
          replyToId: "123",
        },
      ];
      const params = {
        cfg: {},
        channel: "telegram" as const,
        to: "12345",
        payloads,
        replyPayloadSendingHook: {
          kind: "final" as const,
          channel: "telegram",
          context: { channelId: "telegram", conversationId: "12345" },
        },
      };
      const batch =
        operation === "structured"
          ? await prepareStructuredOutboundPayloadBatch(
              params,
              createStructuredOutboundPayloadPlan(payloads),
            )
          : await prepareOutboundPayloadBatch(params);

      const mediaBeforeMessage = extractMarkdownImages
        ? [explicitUrl, originalUrl, replyUrl]
        : [explicitUrl];
      expect(messageHook).toHaveBeenCalledWith(
        expect.objectContaining({
          content: extractMarkdownImages ? "Reply caption." : replyText,
          metadata: expect.objectContaining({ mediaUrls: mediaBeforeMessage }),
        }),
        expect.objectContaining({ channelId: "telegram", conversationId: "12345" }),
      );
      const entry = batch.entries[0];
      expect(batch.entries).toHaveLength(1);
      expect(entry?.status).toBe("accepted");
      if (!entry || entry.status !== "accepted") {
        throw new Error("expected accepted image payload");
      }
      const expectedMedia = extractMarkdownImages
        ? [...mediaBeforeMessage, messageUrl]
        : mediaBeforeMessage;
      expect(entry.preparedMediaCount).toBe(expectedMedia.length);
      expect(entry.payload.mediaUrls ?? [entry.payload.mediaUrl]).toEqual(expectedMedia);
      expect(entry.payload.text).toBe(
        extractMarkdownImages
          ? `Keep  prose. Use \`a  b\`.  \r\nChart  \r\nLeft caption.\r\n  Prefix.\r\nLeft right\r\nNext\r\n${literalText}\r\nAfter  \r\n`
          : messageText,
      );
      expect(entry.payload.replyToId).toBe("123");
      expect(entry.payload.audioAsVoice).toBeUndefined();
      expect(entry.payload.attachments?.[0]).toEqual({
        url: explicitUrl,
        name: "explicit.png",
        mimeType: "image/png",
      });
    },
  );

  it.each(["reply_payload_sending", "message_sending"] as const)(
    "cancels hook-added channel images at %s",
    async (cancelHook) => {
      const { telegramOutbound } = await loadBundledPluginFacade<{
        telegramOutbound: ChannelOutboundAdapter;
      }>({ pluginId: "telegram", artifactBasename: "api.js" });
      setTestOutbound(telegramOutbound, "telegram");
      const imageUrl = "https://example.com/cancelled.png";
      const replyHook = vi.fn<PluginHookHandlerMap["reply_payload_sending"]>(
        async ({ payload }) => ({
          payload: { ...payload, text: `Changed ![image](${imageUrl}) caption.` },
          cancel: cancelHook === "reply_payload_sending",
        }),
      );
      const messageHook = vi.fn<PluginHookHandlerMap["message_sending"]>(async () => ({
        cancel: true,
      }));
      installRegisteredPayloadHooks({
        reply_payload_sending: replyHook,
        message_sending: messageHook,
      });
      const payloads = [{ text: "Original caption." }];
      const batch = await prepareStructuredOutboundPayloadBatch(
        {
          cfg: {},
          channel: "telegram",
          to: "12345",
          payloads,
          replyPayloadSendingHook: {
            kind: "final",
            channel: "telegram",
            context: { channelId: "telegram", conversationId: "12345" },
          },
        },
        createStructuredOutboundPayloadPlan(payloads),
      );

      expect(batch.entries).toEqual([
        {
          sourceIndex: 0,
          status: "suppressed",
          reason: `cancelled_by_${cancelHook}_hook`,
        },
      ]);
      if (cancelHook === "reply_payload_sending") {
        expect(messageHook).not.toHaveBeenCalled();
      } else {
        expect(messageHook).toHaveBeenCalledWith(
          expect.objectContaining({
            content: "Changed caption.",
            metadata: expect.objectContaining({ mediaUrls: [imageUrl] }),
          }),
          expect.anything(),
        );
      }
    },
  );

  it.each([false, true])(
    "prepares channel images without reinterpreting prepared directive literals (images: %s)",
    async (extractMarkdownImages) => {
      setTestOutbound({ ...matrixOutboundForTest, extractMarkdownImages });
      const text =
        "[[reply_to:literal]] [[audio_as_voice]]\n" +
        "MEDIA:https://example.com/literal.png\n" +
        "Chart ![one](https://example.com/one.png) ![two](https://example.com/two.png)\nAfter  \n";
      const payloads: ReplyPayload[] = [
        { text: "" },
        {
          text,
          replyToId: undefined,
          mediaUrl: "https://example.com/primary.png",
          mediaUrls: ["https://example.com/explicit.png", "https://example.com/one.png"],
        },
      ];
      const batch = await prepareStructuredOutboundPayloadBatch(
        {
          cfg: matrixChunkConfig,
          channel: "matrix",
          to: "!room:example",
          payloads,
          deps: { matrix: vi.fn() },
        },
        createStructuredOutboundPayloadPlan(payloads),
      );

      expect(batch.entries).toEqual([
        { sourceIndex: 0, status: "suppressed", reason: "no_visible_payload" },
        expect.objectContaining({
          sourceIndex: 1,
          status: "accepted",
          preparedMediaCount: extractMarkdownImages ? 4 : 3,
          payload: {
            text: extractMarkdownImages
              ? "[[reply_to:literal]] [[audio_as_voice]]\nMEDIA:https://example.com/literal.png\nChart\nAfter  \n"
              : text,
            replyToId: undefined,
            mediaUrls: [
              "https://example.com/explicit.png",
              "https://example.com/one.png",
              "https://example.com/primary.png",
              ...(extractMarkdownImages ? ["https://example.com/two.png"] : []),
            ],
          },
        }),
      ]);
    },
  );

  it.each([
    {
      name: "MEDIA directives",
      text: "Caption\nMEDIA:https://example.com/one.png\nMEDIA:https://example.com/two.png",
      extractMarkdownImages: false,
    },
    {
      name: "Markdown images",
      text: "Caption ![one](https://example.com/one.png) ![two](https://example.com/two.png)",
      extractMarkdownImages: true,
    },
  ])("delivers explicit attachments and every extracted $name", async (testCase) => {
    const sendMedia = vi.fn<NonNullable<ChannelOutboundAdapter["sendMedia"]>>(async () => ({
      channel: "matrix",
      messageId: "sent",
    }));
    setTestOutbound({
      ...matrixOutboundForTest,
      sendMedia,
      extractMarkdownImages: testCase.extractMarkdownImages,
    });

    await deliverMatrix({
      cfg: matrixChunkConfig,
      payloads: [
        {
          text: testCase.text,
          mediaUrl: "https://example.com/primary.png",
          mediaUrls: ["https://example.com/explicit.png", "https://example.com/one.png"],
        },
      ],
    });

    expect(sendMedia.mock.calls.map(([params]) => params.mediaUrl)).toEqual([
      "https://example.com/explicit.png",
      "https://example.com/one.png",
      "https://example.com/primary.png",
      "https://example.com/two.png",
    ]);
  });
}
