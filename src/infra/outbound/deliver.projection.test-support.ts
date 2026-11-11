import assert from "node:assert/strict";
import { expect, it, vi, type Mock } from "vitest";
import {
  getReplyPayloadMetadata as metadataOf,
  isReplyPayloadSessionWriterDeliveryAuthorized as authorized,
  setReplyPayloadMetadata as withMetadata,
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

type ImageProjectionFixture = Pick<PreparationFixture, "setTestOutbound" | "hookMocks">;

function prepare(
  operation: "raw" | "structured",
  params: Parameters<typeof prepareOutboundPayloadBatch>[0],
) {
  return operation === "structured"
    ? prepareStructuredOutboundPayloadBatch(
        params,
        createStructuredOutboundPayloadPlan(params.payloads),
      )
    : prepareOutboundPayloadBatch(params);
}

function acceptedEntry(batch: Awaited<ReturnType<typeof prepareOutboundPayloadBatch>>) {
  const [entry] = batch.entries;
  assert(entry?.status === "accepted", "expected accepted payload");
  return entry;
}

// Keep registration in deliver.test.ts so its hoisted queue/hooks and per-case registry reset apply.
export function registerOutboundPreparationMetadataTests({
  matrixChunkConfig: cfg,
  matrixOutboundForTest: outbound,
  setTestOutbound: install,
  hookMocks: { runner },
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
      const sourcePayload = withMetadata(
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
      expect(authorized(sourcePayload, currentWriter)).toBe(true);
      install({
        ...outbound,
        normalizePayload: ({ payload }) =>
          withMetadata(
            {
              ...payload,
              text: payload.channelData?.normalized ? payload.text : " ",
              channelData: { normalized: true },
            },
            { assistantMessageIndex: undefined },
          ),
        normalizePayloadBatch: ({ payloads }) => payloads.map(({ payload }) => ({ ...payload })),
      });
      runner.hasHooks.mockImplementation((name) => name === "message_sending");
      runner.runMessageSending.mockImplementationOnce(async () => {
        await Promise.resolve();
        currentWriter = { ...currentWriter, activeWriterRunId: "run-replacement" };
        return { content: "after modifier" };
      });
      const params = {
        cfg,
        channel: "matrix" as const,
        to: "!room:example",
        payloads: [sourcePayload],
        deps: { matrix: vi.fn() },
      };
      const entry = acceptedEntry(await prepare(operation, params));
      expect(entry.payload.text).toBe("after modifier");
      const metadata = metadataOf(entry.payload);
      expect(metadata).toHaveProperty("assistantMessageIndex", undefined);
      expect(metadataOf(sourcePayload)?.assistantMessageIndex).toBe(4);
      if (operation === "structured") {
        expect(metadata?.finalDeliveryCapture).toBe(capture);
        expect(authorized(entry.payload, currentWriter)).toBe(false);
      } else {
        expect(metadata?.finalDeliveryCapture).toBeUndefined();
        expect(metadata?.sessionWriterDeliveryAuthority).toBeUndefined();
      }
    },
  );
}

export function registerOutboundImageProjectionTests({
  setTestOutbound: install,
  hookMocks: { runner: mocked },
}: ImageProjectionFixture) {
  async function imageFixture(
    hooks: Pick<PluginHookHandlerMap, "reply_payload_sending" | "message_sending">,
    overrides: Partial<ChannelOutboundAdapter> = {},
  ) {
    const { telegramOutbound } = await loadBundledPluginFacade<{
      telegramOutbound: ChannelOutboundAdapter;
    }>({ pluginId: "telegram", artifactBasename: "api.js" });
    install({ ...telegramOutbound, ...overrides }, "telegram");
    const registry = createEmptyPluginRegistry();
    for (const hookName of ["reply_payload_sending", "message_sending"] as const) {
      addTestHook({ registry, pluginId: "image-presentation", hookName, handler: hooks[hookName] });
    }
    const runner = createHookRunner(registry);
    mocked.hasHooks.mockImplementation(
      (name) =>
        (name === "reply_payload_sending" || name === "message_sending") && runner.hasHooks(name),
    );
    mocked.runReplyPayloadSending.mockImplementation(runner.runReplyPayloadSending.bind(runner));
    mocked.runMessageSending.mockImplementation(runner.runMessageSending.bind(runner));
    return (operation: "raw" | "structured", payloads: ReplyPayload[]) =>
      prepare(operation, {
        cfg: {},
        channel: "telegram",
        to: "12345",
        payloads,
        replyPayloadSendingHook: {
          kind: "final",
          channel: "telegram",
          context: { channelId: "telegram", conversationId: "12345" },
        },
      });
  }

  it.each(["raw", "structured"] as const)(
    "projects hook-added channel images (%s)",
    async (operation) => {
      const explicitUrl = "https://example.com/explicit.png";
      const originalUrl = "https://example.com/original.png";
      const replyUrl = "https://example.com/reply.png";
      const messageUrl = "https://example.com/message.png";
      const literalText =
        "[[reply_to:literal]] [[audio_as_voice]]\nMEDIA:https://example.com/literal.png";
      const messageText =
        `![leading](${messageUrl})    Keep  prose. Use \`a  b\`![message](${messageUrl}).  \r\n` +
        `Chart ![trailing](${messageUrl})  \r\nLeft ![adjacent](${messageUrl})caption.\r\n` +
        `  ![indented](${messageUrl})    Prefix.\r\n` +
        `Left![one](${messageUrl}) ![two](${messageUrl})right\r\n` +
        `Next\r\n${literalText}\r\nAfter  \r\n`;
      const messageHook = vi.fn<PluginHookHandlerMap["message_sending"]>(async () => ({
        content: messageText,
      }));
      const project = await imageFixture(
        {
          reply_payload_sending: async ({ payload }) => ({
            payload: { ...payload, text: `Reply![reply](${replyUrl}) caption.` },
          }),
          message_sending: messageHook,
        },
        { extractMarkdownImages: true },
      );
      const attachment = { url: explicitUrl, name: "explicit.png", mimeType: "image/png" };
      const payloads: ReplyPayload[] = [
        {
          text: `Original ![original](${originalUrl}) caption.`,
          mediaUrls: [explicitUrl],
          attachments: [attachment],
          replyToId: "123",
        },
      ];
      const batch = await project(operation, payloads);
      const mediaBeforeMessage = [explicitUrl, originalUrl, replyUrl];
      expect(messageHook).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Reply caption.",
          metadata: expect.objectContaining({ mediaUrls: mediaBeforeMessage }),
        }),
        expect.objectContaining({ channelId: "telegram", conversationId: "12345" }),
      );
      expect(batch.entries).toHaveLength(1);
      const entry = acceptedEntry(batch);
      const expectedMedia = [...mediaBeforeMessage, messageUrl];
      expect(entry.payload.mediaUrls ?? [entry.payload.mediaUrl]).toEqual(expectedMedia);
      expect(entry).toMatchObject({
        preparedMediaCount: expectedMedia.length,
        payload: {
          text: `Keep  prose. Use \`a  b\`.  \r\nChart  \r\nLeft caption.\r\n  Prefix.\r\nLeft right\r\nNext\r\n${literalText}\r\nAfter  \r\n`,
          replyToId: "123",
        },
      });
      expect(entry.payload.audioAsVoice).toBeUndefined();
      expect(entry.payload.attachments?.[0]).toEqual(attachment);
    },
  );

  it.each(["reply_payload_sending", "message_sending"] as const)(
    "cancels hook-added channel images at %s",
    async (cancelHook) => {
      const imageUrl = "https://example.com/cancelled.png";
      const messageHook = vi.fn<PluginHookHandlerMap["message_sending"]>(async () => ({
        cancel: true,
      }));
      const project = await imageFixture({
        reply_payload_sending: async ({ payload }) => ({
          payload: { ...payload, text: `Changed ![image](${imageUrl}) caption.` },
          cancel: cancelHook === "reply_payload_sending",
        }),
        message_sending: messageHook,
      });
      const batch = await project("structured", [{ text: "Original caption." }]);

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
}
