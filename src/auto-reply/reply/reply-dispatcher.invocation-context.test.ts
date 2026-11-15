import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { pluginInvocationContext } from "../../plugins/plugin-instance-scope.js";
import { createOwnedTestInstance } from "../../plugins/plugin-instance.test-support.js";
import { PluginInvocationScope } from "../../plugins/plugin-invocation-scope.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  attachReplyDispatchUndeliveredFallback,
  createReplyDispatcher,
} from "./reply-dispatcher.js";

describe.each(["absent", "captured"] as const)("dispatcher plugin context: %s", (context) => {
  it.for([
    ["raw", "delivered"],
    ["prepared", "delivered"],
    ["prepared", "deferred"],
    ["raw", "fallback"],
    ["prepared", "cancelled"],
    ["raw", "failed"],
  ] as const)("settles %s %s after the producer closes", async ([kind, outcome], { signal }) => {
    const channel = createOwnedTestInstance("delivery-context");
    const registry = channel.owner!.registry!;
    const captured =
      context === "captured" ? new PluginInvocationScope(registry, [channel]) : undefined;
    const producer = new PluginInvocationScope(registry, [channel]);
    const unrelated = new AsyncLocalStorage<string>();
    const entered = createDeferred();
    const release = createDeferred();
    const finalized = createDeferred<{ visibleReplySent: boolean }>();
    const observed: Array<[string, unknown, string | undefined]> = [];
    const delivered: ReplyPayload[] = [];
    const errors: unknown[] = [];
    const failure = new Error("transport failed");
    const observe = (stage: string) =>
      observed.push([stage, pluginInvocationContext.getStore(), unrelated.getStore()]);
    const deliver = channel.wrap(async (payload: ReplyPayload) => {
      observe("deliver");
      delivered.push(payload);
      if (outcome === "failed") {
        throw failure;
      }
      return outcome === "deferred" || (outcome === "fallback" && delivered.length === 1)
        ? { finalization: finalized.promise }
        : { visibleReplySent: true };
    });
    const preparedIndices: number[] = [];
    const makeDispatcher = () =>
      createReplyDispatcher({
        beforeDeliver: async (payload) => {
          entered.resolve();
          await release.promise;
          return outcome === "cancelled" ? null : payload;
        },
        deliver,
        deliverPrepared: channel.wrap(async (plan) => {
          preparedIndices.push(plan.sourceIndex);
          return await deliver(plan.payload);
        }),
        onBeforeDeliverCancelled: channel.wrap(() => void observe("cancelled")),
        onError: channel.wrap((error) => {
          observe("error");
          errors.push(error);
        }),
        onDeliverySettled: channel.wrap(() => void observe("settled")),
        onIdle: channel.wrap(() => {
          observe("idle");
          finalized.resolve({ visibleReplySent: outcome !== "fallback" });
        }),
      });
    const dispatcher = unrelated.run("constructor", () =>
      captured ? captured.run(makeDispatcher) : pluginInvocationContext.exit(makeDispatcher),
    );
    const payload = setReplyPayloadMetadata(
      { text: "queued reply" },
      { replyDispatcherNormalizationOwner: dispatcher },
    );
    const fallback = setReplyPayloadMetadata(
      { text: "known-unsent alternative" },
      { replyDispatcherNormalizationOwner: dispatcher },
    );
    if (outcome === "fallback") {
      attachReplyDispatchUndeliveredFallback(payload, fallback);
    }
    try {
      unrelated.run("producer", () =>
        producer.run(() => {
          if (kind === "prepared") {
            const [plan] = createStructuredOutboundPayloadPlan([payload]);
            expect(plan).toBeDefined();
            expect(dispatcher.sendPreparedReply("final", { ...plan!, sourceIndex: 7 })).toBe(true);
          } else {
            expect(dispatcher.sendFinalReply(payload)).toBe(true);
          }
          dispatcher.markComplete();
        }),
      );
      await withinTest(entered.promise, signal);
      producer.release();
      release.resolve();
      const receipt = await withinTest(dispatcher.waitForIdle(), signal);
      expect(receipt).toMatchObject({
        counts: {
          final: {
            delivered: outcome === "cancelled" || outcome === "failed" ? 0 : 1,
            cancelled: outcome === "cancelled" ? 1 : 0,
            failedAfterSend: outcome === "failed" ? 1 : 0,
          },
        },
      });
      expect(errors).toEqual(outcome === "failed" ? [failure] : []);
      expect(delivered.map((reply) => reply.text)).toEqual(
        outcome === "cancelled"
          ? []
          : outcome === "fallback"
            ? [payload.text, fallback.text]
            : [payload.text],
      );
      expect(preparedIndices).toEqual(kind === "prepared" && outcome !== "cancelled" ? [7] : []);
      if (kind === "raw" && delivered.length) {
        expect(delivered[0]).toBe(payload);
      }
      for (const reply of delivered) {
        expect(getReplyPayloadMetadata(reply)?.replyDispatcherNormalizationOwner).toBe(dispatcher);
      }
      expect(observed.map(([stage]) => stage)).toContain("settled");
      expect(observed.map(([stage]) => stage)).toContain("idle");
      for (const [, scope, otherStore] of observed) {
        expect(scope).toBe(captured);
        expect(otherStore).toBe("producer");
      }
      expect(pluginInvocationContext.getStore()).toBeUndefined();
      expect(unrelated.getStore()).toBeUndefined();
    } finally {
      producer.release();
      release.resolve();
      finalized.resolve({ visibleReplySent: true });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      captured?.release();
    }
  });

  it("notifies idle in the captured context when completed without queued work", () => {
    const channel = createOwnedTestInstance("idle-context");
    const registry = channel.owner!.registry!;
    const captured =
      context === "captured" ? new PluginInvocationScope(registry, [channel]) : undefined;
    const producer = new PluginInvocationScope(registry, [channel]);
    const idle = vi.fn();
    const create = () =>
      createReplyDispatcher({
        deliver: async () => {},
        onIdle: channel.wrap(() => idle(pluginInvocationContext.getStore())),
      });
    const dispatcher = captured ? captured.run(create) : pluginInvocationContext.exit(create);
    try {
      producer.run(() => {
        producer.release();
        dispatcher.markComplete();
      });
      expect(idle).toHaveBeenCalledExactlyOnceWith(captured);
    } finally {
      producer.release();
      captured?.release();
    }
  });
});

it.for(["scope", "instance", "consumer"] as const)(
  "refuses queued delivery after its captured %s closes",
  async (closed, { signal }) => {
    const channel = createOwnedTestInstance("closed-delivery-context");
    const registry = channel.owner!.registry!;
    const scope = new PluginInvocationScope(registry, [channel]);
    const consumer = channel.retainConsumer(undefined, registry);
    const entered = createDeferred();
    const release = createDeferred();
    const delivered = vi.fn(async () => {});
    const errors: unknown[] = [];
    const dispatcher = scope.run(() =>
      createReplyDispatcher({
        beforeDeliver: async (payload) => {
          entered.resolve();
          await release.promise;
          return payload;
        },
        deliver: closed === "consumer" ? consumer.wrap(delivered) : channel.wrap(delivered),
        onError: (error) => void errors.push(error),
      }),
    );
    try {
      dispatcher.sendFinalReply({ text: "must not be sent" });
      await withinTest(entered.promise, signal);
      if (closed === "scope") {
        scope.release();
      } else if (closed === "consumer") {
        consumer.release();
      } else {
        consumer.release();
        await channel.dispose();
      }
      release.resolve();
      dispatcher.markComplete();
      const receipt = await withinTest(dispatcher.waitForIdle(), signal);
      expect(delivered).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        message:
          closed === "scope"
            ? "Plugin invocation scope is closed"
            : closed === "consumer"
              ? "Plugin closed-delivery-context consumer is closed"
              : "Plugin closed-delivery-context was reloaded or disabled; use its current tools.",
      });
      expect(receipt).toMatchObject({ counts: { final: { failedAfterSend: 1 } } });
    } finally {
      release.resolve();
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      scope.release();
      consumer.release();
    }
  },
);
