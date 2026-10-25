import path from "node:path";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import type { InternalDeliverOutboundPayloadsParams } from "../../infra/outbound/deliver-contracts.js";
import * as queueAdmission from "../../infra/outbound/deliver-queue-admission.js";
import { runOutboundDeliveryInternal } from "../../infra/outbound/deliver-queue.js";
import * as stablePreparation from "../../infra/outbound/delivery-queue-preparation.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { ensureGlobalHookRunner, resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookHandlerMap } from "../../plugins/hook-types.js";
import { addTestHook } from "../../plugins/hooks.test-helpers.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  bindReplyReasoningVisibility,
  isReplyReasoningVisible,
  registerReplyReasoningVisibility,
} from "./reasoning-visibility-state.js";
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

  it("keeps host-bound prepared reasoning live-only with its guarded payload lane", async () => {
    const payload = { text: "private thought", isReasoning: true };
    const owner = { retainForQueue: () => {}, releaseDispatch: () => {}, close: () => {} };
    const release = registerReplyReasoningVisibility(owner, () => true);
    bindReplyReasoningVisibility(payload, owner);
    fixtures.register({
      deliveryMode: "direct",
      supportsReasoningPayloads: true,
      sendText: async () => {
        throw new Error("Guarded reasoning cannot use plain text");
      },
      sendPayload: async (ctx) => {
        expect(ctx.guardedReasoning).toBe(true);
        expect(isReplyReasoningVisible(ctx.payload)).toBe(true);
        expect(ctx.deliveryQueueId).toBeUndefined();
        visible.push(ctx.payload);
        return { channel: "matrix", messageId: "$notice" };
      },
    });
    try {
      expect(
        await routePreparedReply({
          ...destination,
          deliveryIntentId: "must-not-persist-private-reasoning",
          plan: prepare(payload),
        }),
      ).toMatchObject({ ok: true, delivered: true, messageId: "$notice" });
      expect(visible).toHaveLength(1);
    } finally {
      release();
    }
  });

  it.each(["target opt-out", "type removed", "metadata removed"])(
    "never downgrades host-bound routing after %s",
    async (change) => {
      const payload = { text: "private thought", isReasoning: true };
      const owner = { retainForQueue: () => {}, releaseDispatch: () => {}, close: () => {} };
      const release = registerReplyReasoningVisibility(owner, () => true);
      bindReplyReasoningVisibility(payload, owner);
      const send = vi.fn(async () => ({ channel: "matrix", messageId: "$must-not-send" }));
      fixtures.register(
        {
          deliveryMode: "direct",
          supportsReasoningPayloads: change !== "target opt-out",
          sendText: send,
          sendPayload: send,
          ...(change === "metadata removed"
            ? {
                normalizePayload: ({ payload: input }) => ({ text: input.text, isReasoning: true }),
              }
            : {}),
        },
        change === "type removed"
          ? {
              messaging: {
                transformReplyPayload: ({ payload: input }) => ({ ...input, isReasoning: false }),
              },
            }
          : {},
      );
      try {
        const result =
          change === "target opt-out"
            ? await routePreparedReply({ ...destination, plan: prepare(payload) })
            : await routeReply({ ...destination, payload });
        expect(result).toMatchObject({ ok: true, delivered: false, suppressed: true });
        expect(send).not.toHaveBeenCalled();
      } finally {
        release();
      }
    },
  );

  it.each<{
    name: string;
    overrides: Partial<InternalDeliverOutboundPayloadsParams>;
  }>([
    { name: "queue", overrides: {} },
    { name: "intent", overrides: { skipQueue: true, deliveryIntentId: "not-a-replayable-notice" } },
    {
      name: "retention",
      overrides: {
        skipQueue: true,
        completionRetention: { idPrefix: "notice:", maxAgeMs: 1, maxEntries: 1 },
      },
    },
    {
      name: "mirror",
      overrides: {
        skipQueue: true,
        mirror: { sessionKey: "agent:main:test", agentId: "main", text: "private thought" },
      },
    },
    {
      name: "completion",
      overrides: {
        skipQueue: true,
        deliveryCompletion: {
          kind: "pending-final",
          deliveryId: "answer",
          intentId: "answer-intent",
          sessionId: "session",
          sessionKey: "agent:main:test",
          storePath: "/must-not-be-read/sessions.json",
        },
      },
    },
  ])("rejects a bound $name contract before durable preparation", async ({ overrides }) => {
    const payload = { text: "private thought", isReasoning: true };
    const owner = { retainForQueue: () => {}, releaseDispatch: () => {}, close: () => {} };
    const release = registerReplyReasoningVisibility(owner, () => true);
    bindReplyReasoningVisibility(payload, owner);
    const prepareSpy = vi.spyOn(stablePreparation, "withStableDeliveryPreparation");
    const enqueue = vi.spyOn(queueAdmission, "stageAndEnqueueOutboundDelivery");
    try {
      await expect(
        runOutboundDeliveryInternal(
          {
            cfg: {},
            channel: "matrix",
            to: destination.to,
            payloads: [payload],
            ...overrides,
          },
          undefined,
          true,
        ),
      ).rejects.toThrow("Guarded reasoning requires live-only delivery");
      expect(visible).toEqual([]);
      expect(prepareSpy).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      prepareSpy.mockRestore();
      enqueue.mockRestore();
      release();
    }
  });

  it.each(["type", "owner"])(
    "captures the raw bound lane before a real hook loses its %s",
    async (lost) => {
      const payload = { text: "private thought", isReasoning: true };
      const owner = { retainForQueue: () => {}, releaseDispatch: () => {}, close: () => {} };
      const release = registerReplyReasoningVisibility(owner, () => true);
      bindReplyReasoningVisibility(payload, owner);
      let hooked = false;
      const send = vi.fn(async () => ({ channel: "matrix", messageId: "$must-not-send" }));
      const plugin = createOutboundTestPlugin({
        id: "matrix",
        outbound: {
          deliveryMode: "direct",
          supportsReasoningPayloads: true,
          sendText: send,
          sendPayload: send,
          ...(lost === "owner"
            ? {
                normalizePayload: ({ payload: current }) =>
                  hooked ? { text: current.text, isReasoning: true } : current,
              }
            : {}),
        },
      });
      const registry = createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]);
      const hook = vi.fn<PluginHookHandlerMap["reply_payload_sending"]>(async (event) => {
        hooked = true;
        return {
          payload: { text: event.payload.text, ...(lost === "owner" ? { isReasoning: true } : {}) },
        };
      });
      addTestHook({
        registry,
        pluginId: plugin.id,
        hookName: "reply_payload_sending",
        handler: hook,
      });
      const enqueue = vi.spyOn(queueAdmission, "stageAndEnqueueOutboundDelivery");
      const prepareSpy = vi.spyOn(stablePreparation, "withStableDeliveryPreparation");
      try {
        const results = await withPluginRuntimeRegistryScope(registry, async () => {
          ensureGlobalHookRunner();
          // No pre-filled Set: the real queue entry must capture the original source lane.
          return runOutboundDeliveryInternal(
            {
              cfg: {},
              channel: "matrix",
              to: destination.to,
              payloads: [payload],
              skipQueue: true,
              replyPayloadSendingHook: { kind: "final", context: { channelId: "matrix" } },
            },
            undefined,
            true,
          );
        });
        expect(hook).toHaveBeenCalledOnce();
        expect(results).toEqual([]);
        expect(send).not.toHaveBeenCalled();
        expect(prepareSpy).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
      } finally {
        resetGlobalHookRunner();
        prepareSpy.mockRestore();
        enqueue.mockRestore();
        release();
      }
    },
  );

  it.each([false, true])(
    "preserves the real unbound cron queue and transport with structured=%s",
    async (structured) => {
      const text = vi.fn(async () => ({ channel: "matrix", messageId: "$text" }));
      const payload = vi.fn<NonNullable<ChannelOutboundAdapter["sendPayload"]>>(async (ctx) => {
        expect(ctx.guardedReasoning).toBeUndefined();
        return { channel: "matrix", messageId: "$payload" };
      });
      const plugin = createOutboundTestPlugin({
        id: "matrix",
        outbound: {
          deliveryMode: "direct",
          supportsReasoningPayloads: true,
          sendText: text,
          sendPayload: payload,
        },
      });
      const registry = createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]);
      if (structured) {
        const hook: PluginHookHandlerMap["reply_payload_sending"] = async (event) => ({
          payload: { ...event.payload, channelData: { matrix: { legacy: true } } },
        });
        addTestHook({
          registry,
          pluginId: plugin.id,
          hookName: "reply_payload_sending",
          handler: hook,
        });
      }
      const enqueue = vi.spyOn(queueAdmission, "stageAndEnqueueOutboundDelivery");
      try {
        const results = await withPluginRuntimeRegistryScope(registry, async () => {
          ensureGlobalHookRunner();
          return runOutboundDeliveryInternal(
            {
              cfg: {},
              channel: "matrix",
              to: destination.to,
              payloads: [{ text: "explicit cron reasoning", isReasoning: true }],
              replyPayloadSendingHook: { kind: "final", context: { channelId: "matrix" } },
            },
            undefined,
            true,
          );
        });
        expect(results).toMatchObject([{ messageId: structured ? "$payload" : "$text" }]);
        expect(structured ? payload : text).toHaveBeenCalledOnce();
        expect(structured ? text : payload).not.toHaveBeenCalled();
        expect(enqueue).toHaveBeenCalledOnce();
        expect(enqueue.mock.calls[0]?.[0].reasoningPayloadIndexes).toBeUndefined();
        expect(enqueue.mock.calls[0]?.[1]).not.toHaveProperty("reasoningPayloadIndexes");
      } finally {
        resetGlobalHookRunner();
        enqueue.mockRestore();
      }
    },
  );

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
