import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { installDeliveryQueueTmpDirHooks } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
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
    { operation: "raw", revoked: false },
    { operation: "prepared", revoked: false },
    { operation: "raw", revoked: true },
    { operation: "prepared", revoked: true },
  ] as const)(
    "refreshes producer authority before $operation durable handoff (revoked=$revoked)",
    async ({ operation, revoked }) => {
      const entered = createDeferred();
      const release = createDeferred();
      let preparationComplete = false;
      let current = true;
      const payload = { text: "producer-owned reply" };
      const params = {
        cfg: {},
        channel: "matrix" as const,
        to: "!room:example.invalid",
        replyKind: "final" as const,
        mirror: false,
        beforeDeliver: async () => {
          entered.resolve();
          await release.promise;
          preparationComplete = true;
        },
        assertCurrent: () => {
          if (!preparationComplete) {
            throw new Error("Producer delivery preparation did not run");
          }
          if (!current) {
            throw new Error("Producer delivery authority was revoked");
          }
        },
      };
      const plan = createStructuredOutboundPayloadPlan([payload])[0];
      if (!plan) {
        throw new Error("Expected a renderable prepared reply");
      }
      const delivery =
        operation === "prepared"
          ? routePreparedReply({ ...params, plan })
          : routeReply({ ...params, payload });
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          delivery,
          "Producer delivery preparation did not run before handoff",
        );
        expect(visible).toEqual([]);
        current = !revoked;
        release.resolve();
        const result = await delivery;
        if (revoked) {
          expect(result).toMatchObject({ ok: false, delivered: false });
          expect(result.error).toContain("Producer delivery authority was revoked");
          expect(visible).toEqual([]);
        } else {
          expect(result).toMatchObject({ ok: true, delivered: true, messageId: "text-sent" });
          expect(visible).toEqual([{ text: "producer-owned reply transformed" }]);
        }
      } finally {
        release.resolve();
        await delivery;
      }
    },
  );

  it("rejects a writer retired after prepared routing and awaited channel work", async () => {
    const { replaceSessionEntry } = await import("../../config/sessions/session-accessor.js");
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
