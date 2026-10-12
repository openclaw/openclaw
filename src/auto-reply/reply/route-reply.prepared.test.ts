import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import { createExactAssistantMessage } from "../../config/sessions/transcript-message.test-support.js";
import * as transcript from "../../config/sessions/transcript.js";
import { installDeliveryQueueTmpDirHooks } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { resolveOutboundSessionRoute } from "../../infra/outbound/outbound-session.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../shared/transcript-only-openclaw-assistant.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { routePreparedReply, routeReply } from "./route-reply.js";

describe("prepared reply routing", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let visible: ReplyPayload[];
  let beforeDelivery: (() => Promise<void>) | undefined;

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
    visible = [];
    beforeDelivery = undefined;
    const outbound: ChannelOutboundAdapter = {
      deliveryMode: "direct",
      sendText: async ({ text }) => {
        visible.push({ text });
        return { channel: "matrix", messageId: "text-sent" };
      },
      sendMedia: async ({ text, mediaUrl, audioAsVoice, replyToId, onPlatformSendDispatch }) => {
        await beforeDelivery?.();
        await onPlatformSendDispatch?.();
        visible.push({ text, mediaUrl, audioAsVoice, replyToId: replyToId ?? undefined });
        return { channel: "matrix", messageId: "media-sent" };
      },
    };
    const plugin = createOutboundTestPlugin({
      id: "matrix",
      outbound,
      messaging: {
        transformReplyPayload: ({ payload }) => ({
          ...payload,
          text: `${payload.text} transformed`,
        }),
      },
    });
    plugin.threading = {
      resolveReplyTransport: () => ({ replyToId: "routed-target", threadId: null }),
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]));
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each(["raw", "prepared"] as const)(
    "preserves the %s directive contract through channel transformation and durable delivery",
    async (operation) => {
      const payload = {
        text: "[[reply_to:literal]] [[audio_as_voice]] caption",
        mediaUrl: "https://example.invalid/clip.ogg",
      };
      const params = {
        cfg: { messages: { responsePrefix: "[prefix]" } },
        channel: "matrix" as const,
        to: "!room:example.invalid",
        replyKind: "block" as const,
        mirror: false,
      };
      const plan = createStructuredOutboundPayloadPlan([payload])[0];
      if (!plan) {
        throw new Error("Expected a renderable prepared reply");
      }
      const result =
        operation === "prepared"
          ? await routePreparedReply({ ...params, plan })
          : await routeReply({ ...params, payload });

      expect(result).toMatchObject({ ok: true, delivered: true, messageId: "media-sent" });
      expect(visible).toEqual([
        {
          text:
            operation === "prepared"
              ? "[prefix] [[reply_to:literal]] [[audio_as_voice]] caption transformed"
              : "[prefix] caption transformed",
          mediaUrl: "https://example.invalid/clip.ogg",
          audioAsVoice: operation === "raw" ? true : undefined,
          replyToId: "routed-target",
        },
      ]);
    },
  );

  it.each([
    { relation: "different", mirror: true },
    { relation: "different", mirror: false },
    { relation: "key", mirror: true },
  ] as const)(
    "records only destination-owned model history for $relation routing (mirror=$mirror)",
    async ({ relation, mirror }) => {
      const storePath = path.join(fixtures.tmpDir(), "sessions.json");
      const cfg = { session: { store: storePath, dmScope: "per-channel-peer" as const } };
      const route = await resolveOutboundSessionRoute({
        cfg,
        channel: "matrix",
        agentId: "main",
        target: "!room:example.invalid",
      });
      if (!route) {
        throw new Error("Expected a routed destination");
      }
      const sessionKey = relation === "key" ? route.sessionKey : "agent:main:producer";
      await replaceSessionEntry(
        { sessionKey, storePath },
        {
          sessionId: "producer-session",
          updatedAt: 1,
        },
      );
      await transcript.appendExactAssistantMessageToSessionTranscript({
        sessionKey,
        config: cfg,
        message: createExactAssistantMessage({ text: "Original producer answer" }),
      });

      const result = await routeReply({
        cfg,
        payload: { text: "Delivered answer" },
        channel: "matrix",
        to: "!room:example.invalid",
        sessionKey,
        replyKind: "final",
        mirror,
      });

      expect(result).toMatchObject({ ok: true, delivered: true });
      expect(visible).toEqual([{ text: "Delivered answer transformed" }]);
      const readMessages = async (key: string) => {
        const entry = loadSessionEntryReadOnly({ sessionKey: key, storePath });
        if (!entry) {
          return [];
        }
        return (
          await loadTranscriptEvents({ sessionKey: key, sessionId: entry.sessionId, storePath })
        )
          .map(readTranscriptEventMessage)
          .filter((message) => message?.role === "assistant");
      };
      const sourceMessages = await readMessages(sessionKey);
      expect(sourceMessages.filter(isTranscriptOnlyOpenClawAssistantMessage)).toHaveLength(
        mirror ? 1 : 0,
      );
      expect(
        sourceMessages.filter((message) => !isTranscriptOnlyOpenClawAssistantMessage(message)),
      ).toEqual([
        expect.objectContaining({ content: [{ type: "text", text: "Original producer answer" }] }),
      ]);
      const destinationMessages = (await readMessages(route.sessionKey)).filter(
        (message) => !isTranscriptOnlyOpenClawAssistantMessage(message),
      );
      expect(destinationMessages).toEqual(
        relation === "different"
          ? [
              expect.objectContaining({
                model: "automation-result",
                content: [{ type: "text", text: "Delivered answer transformed" }],
              }),
            ]
          : [
              expect.objectContaining({
                content: [{ type: "text", text: "Original producer answer" }],
              }),
            ],
      );
    },
  );

  it("rejects a producer retired during its final delivery preparation", async () => {
    let current = true;
    const beforeDeliver = vi.fn(async () => {
      current = false;
    });
    const result = await routeReply({
      cfg: {},
      payload: { text: "event update", mediaUrl: "https://example.invalid/clip.ogg" },
      channel: "matrix",
      to: "!room:example.invalid",
      replyKind: "final",
      mirror: false,
      beforeDeliver,
      assertCurrent: () => {
        if (!current) {
          throw new Error("event producer retired");
        }
      },
    });
    expect(beforeDeliver).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, delivered: false });
    expect(result.error).toContain("event producer retired");
    expect(visible).toEqual([]);
  });

  it("rejects a writer retired after prepared routing and awaited channel work", async () => {
    const session = {
      storePath: path.join(fixtures.tmpDir(), "sessions.json"),
      sessionKey: "agent:main:prepared-route",
    };
    await replaceSessionEntry(session, {
      sessionId: "current-session",
      activeWriterRunId: "original-writer",
      updatedAt: Date.now(),
    });
    const payload = setReplyPayloadMetadata(
      { text: "caption", mediaUrl: "https://example.invalid/clip.ogg" },
      {
        sessionWriterDeliveryAuthority: {
          ...session,
          expectedSessionId: "current-session",
          expectedWriterRunId: "original-writer",
        },
      },
    );
    const plan = createStructuredOutboundPayloadPlan([payload])[0];
    if (!plan) {
      throw new Error("Expected a renderable prepared reply");
    }
    const replaceWriter = vi.fn(async () => {
      await replaceSessionEntry(session, {
        sessionId: "current-session",
        activeWriterRunId: "replacement-writer",
        updatedAt: Date.now(),
      });
    });
    beforeDelivery = replaceWriter;

    const result = await routePreparedReply({
      cfg: { session: { store: session.storePath } },
      plan,
      channel: "matrix",
      to: "!room:example.invalid",
      replyKind: "final",
      sessionKey: session.sessionKey,
      mirror: false,
    });

    expect(result).toMatchObject({ ok: false, delivered: false });
    expect(replaceWriter).toHaveBeenCalledOnce();
    expect(result.error).toContain("Session writer changed before final reply delivery");
    expect(visible).toEqual([]);
  });
});
