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

  it.each([
    ["generation", "raw"],
    ["generation", "prepared"],
    ["writer", "prepared"],
  ] as const)("rejects a replaced %s after awaited %s channel work", async (owner, operation) => {
    const { replaceSessionEntry } = await import("../../config/sessions/session-accessor.js");
    const session = {
      agentId: "main",
      storePath: path.join(fixtures.tmpDir(), "sessions.json"),
      sessionKey: "agent:main:route-authority",
    };
    const entry = { sessionId: "original-session", updatedAt: 1 };
    const authority =
      owner === "generation"
        ? { lifecycleRevision: "original-generation" }
        : { activeWriterRunId: "original-writer" };
    await replaceSessionEntry(session, { ...entry, ...authority });
    beforeDelivery = async () => {
      await replaceSessionEntry(session, {
        ...entry,
        ...(owner === "generation"
          ? { lifecycleRevision: "reset" }
          : { activeWriterRunId: "replacement-writer" }),
      });
    };
    const payload = { text: "old answer", mediaUrl: "https://example.invalid/clip.ogg" };
    if (owner === "writer") {
      setReplyPayloadMetadata(payload, {
        sessionWriterDeliveryAuthority: {
          ...session,
          expectedSessionId: entry.sessionId,
          expectedWriterRunId: "original-writer",
        },
      });
    }
    const params = {
      ...destination,
      cfg: { session: { store: session.storePath } },
      sessionKey: session.sessionKey,
      ...(owner === "generation"
        ? {
            sessionGeneration: { ...session, ...entry, lifecycleRevision: "original-generation" },
          }
        : {}),
    };
    const result =
      operation === "prepared"
        ? await routePreparedReply({ ...params, plan: prepare(payload) })
        : await routeReply({ ...params, payload });
    expect(result).toMatchObject({ ok: false, delivered: false });
    expect(result.error).toContain(
      owner === "generation"
        ? "original session generation no longer accepts"
        : "Session writer changed before final reply delivery",
    );
    expect(visible).toEqual([]);
  });

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
    expect(result).toMatchObject({ ok: false, delivered: false });
    expect(result.error).toContain("event producer retired");
    expect(visible).toEqual([]);
  });
});
