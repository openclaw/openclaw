import path from "node:path";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { installRouteReplyFixture } from "./route-reply.fixture.test-support.js";
import { routePreparedReply, routeReply } from "./route-reply.js";

const destination = {
  cfg: {},
  channel: "matrix",
  to: "!room:example.invalid",
  replyKind: "final",
  mirror: false,
} as const;
function prepare(payload: ReplyPayload) {
  const plan = createStructuredOutboundPayloadPlan([payload])[0];
  assert(plan, "Expected a renderable prepared reply");
  return plan;
}

describe("prepared reply routing", () => {
  const fixtures = installRouteReplyFixture();
  let visible: ReplyPayload[];
  let beforeDelivery: (() => Promise<void>) | undefined;

  beforeEach(() => {
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
    fixtures.register(outbound, {
      messaging: {
        transformReplyPayload: ({ payload }) => ({
          ...payload,
          text: `${payload.text} transformed`,
        }),
      },
      threading: { resolveReplyTransport: () => ({ replyToId: "routed-target", threadId: null }) },
    });
  });

  it.each(["raw", "prepared"] as const)(
    "preserves the %s directive contract through channel transformation and durable delivery",
    async (operation) => {
      const payload = {
        text: "[[reply_to:literal]] [[audio_as_voice]] caption",
        mediaUrl: "https://example.invalid/clip.ogg",
      };
      const params = {
        ...destination,
        cfg: { messages: { responsePrefix: "[prefix]" } },
        replyKind: "block" as const,
      };
      const result =
        operation === "prepared"
          ? await routePreparedReply({ ...params, plan: prepare(payload) })
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

  it("delivers admitted final reasoning through the prepared transport", async () => {
    const result = await routePreparedReply({
      ...destination,
      plan: prepare({ text: "Reasoning for the report.", isReasoning: true }),
    });
    expect(result).toMatchObject({ ok: true, delivered: true, messageId: "text-sent" });
    expect(visible).toEqual([{ text: "Reasoning for the report. transformed" }]);
  });

  it.each(["raw", "prepared"] as const)(
    "rejects a reset generation after awaited %s channel preparation",
    async (operation) => {
      const { replaceSessionEntry } = await import("../../config/sessions/session-accessor.js");
      const sessionGeneration = {
        agentId: "main",
        storePath: path.join(fixtures.tmpDir(), "sessions.json"),
        sessionKey: "agent:main:route-generation",
        sessionId: "original-session",
        lifecycleRevision: "original-generation",
      };
      const entry = { sessionId: sessionGeneration.sessionId, updatedAt: 1 };
      await replaceSessionEntry(sessionGeneration, {
        ...entry,
        lifecycleRevision: sessionGeneration.lifecycleRevision,
      });
      beforeDelivery = async () => {
        await replaceSessionEntry(sessionGeneration, { ...entry, lifecycleRevision: "reset" });
      };
      const payload = { text: "old answer", mediaUrl: "https://example.invalid/clip.ogg" };
      const params = {
        ...destination,
        cfg: { session: { store: sessionGeneration.storePath } },
        sessionGeneration,
        sessionKey: sessionGeneration.sessionKey,
      };
      const result =
        operation === "prepared"
          ? await routePreparedReply({ ...params, plan: prepare(payload) })
          : await routeReply({ ...params, payload });
      expect(result).toMatchObject({ ok: false, delivered: false });
      expect(result.error).toContain("original session generation no longer accepts");
      expect(visible).toEqual([]);
    },
  );

  it("rejects a producer retired during its final delivery preparation", async () => {
    let current = true;
    const beforeDeliver = vi.fn(async () => {
      current = false;
    });
    const result = await routeReply({
      ...destination,
      payload: { text: "event update", mediaUrl: "https://example.invalid/clip.ogg" },
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
    const { replaceSessionEntry } = await import("../../config/sessions/session-accessor.js");
    const session = {
      storePath: path.join(fixtures.tmpDir(), "sessions.json"),
      sessionKey: "agent:main:prepared-route",
    };
    const setWriter = (activeWriterRunId: string) =>
      replaceSessionEntry(session, {
        sessionId: "current-session",
        activeWriterRunId,
        updatedAt: Date.now(),
      });
    await setWriter("original-writer");
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
    const plan = prepare(payload);
    const replaceWriter = vi.fn(async () => {
      await setWriter("replacement-writer");
    });
    beforeDelivery = replaceWriter;

    const result = await routePreparedReply({
      ...destination,
      cfg: { session: { store: session.storePath } },
      plan,
      sessionKey: session.sessionKey,
    });

    expect(result).toMatchObject({ ok: false, delivered: false });
    expect(result.error).toContain("Session writer changed before final reply delivery");
    expect(replaceWriter).toHaveBeenCalledOnce();
    expect(visible).toEqual([]);
  });
});
