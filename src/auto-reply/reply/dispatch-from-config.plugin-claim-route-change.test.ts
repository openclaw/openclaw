import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { readConversationBindingRouteFacts } from "../../channels/conversation-binding-route-facts.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import {
  conversation,
  createHookHarness,
  createRouteChangeBarrier,
  registerCurrentAdapter,
  releaseDedupeForRetry,
} from "./dispatch-from-config.route-change.test-support.js";
import * as runtimeLoaders from "./dispatch-from-config.runtime-loaders.js";
import { claimInboundDedupe } from "./inbound-dedupe.js";

function expectRoute(
  ctx: Parameters<typeof readConversationBindingRouteFacts>[0],
  bindingId?: string,
) {
  const observation = readConversationBindingRouteFacts(ctx);
  expect(observation).toMatchObject(bindingId ? { kind: "plugin", bindingId } : { kind: "none" });
  expect(Object.isFrozen(observation)).toBe(true);
}

it.each(["runtime loader", "binding activity read"] as const)(
  "refuses a plugin claim changed after the real %s barrier",
  async (barrier) => {
    const early = barrier === "runtime loader";
    const pluginId = "claim-owner";
    let phase = "first";
    const claimEffects: string[] = [];
    const label = early ? "plugin-claim-none-to-plugin" : "plugin-claim-plugin-replacement";
    const harness = await createHookHarness({
      label,
      messageId: label,
      pluginId,
      agentIds: ["main"],
      authorizeCommands: true,
      inboundClaim: async (_event, context) => {
        claimEffects.push(`${phase}:${context.pluginBinding?.bindingId ?? "missing"}`);
        return { handled: true };
      },
    });
    const binding = (bindingId: string, boundAt: number): SessionBindingRecord => ({
      bindingId,
      boundAt,
      targetKind: "session",
      targetSessionKey: `plugin-binding:${pluginId}:${bindingId}`,
      conversation,
      status: "active",
      metadata: { pluginBindingOwner: "plugin", pluginId, pluginRoot: harness.pluginRoot },
    });
    const prepared = binding("claim-prepared", 1);
    const replacement = binding("claim-replacement", 2);
    let current: SessionBindingRecord | null = early ? null : prepared;
    let armReplacementOnTouch = false;
    let replacementArmed = false;
    registerCurrentAdapter(
      () => current,
      early
        ? {}
        : {
            resolveByConversationAsync: async () => {
              const captured = current;
              if (replacementArmed) {
                replacementArmed = false;
                queueMicrotask(() => {
                  current = replacement;
                });
              }
              return captured;
            },
            touchAsync: async (bindingId) => {
              if (armReplacementOnTouch && bindingId === prepared.bindingId) {
                armReplacementOnTouch = false;
                replacementArmed = true;
              }
            },
          },
    );
    const firstContext = await harness.buildContext();
    expectRoute(firstContext, early ? undefined : prepared.bindingId);
    const entered = createDeferred();
    const release = createRouteChangeBarrier();
    if (early) {
      const loadRuntimePlugins = runtimeLoaders.loadRuntimePlugins;
      vi.spyOn(runtimeLoaders, "loadRuntimePlugins").mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return await loadRuntimePlugins();
      });
    } else {
      armReplacementOnTouch = true;
    }
    const first = harness.invoke(firstContext).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    if (early) {
      await awaitGateBeforeSettlement(
        entered.promise,
        first,
        "Dispatch completed before the runtime loader barrier",
      );
      current = prepared;
      release.resolve();
    }
    expect.soft((await first).error).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
    expect.soft(claimEffects).toEqual([]);
    releaseDedupeForRetry(firstContext);
    phase = "retry";
    const retryContext = await harness.buildContext();
    const retryBinding = early ? prepared : replacement;
    expectRoute(retryContext, retryBinding.bindingId);
    await harness.invoke(retryContext);
    expect(claimEffects).toEqual([`retry:${retryBinding.bindingId}`]);
    expect(claimInboundDedupe(retryContext).status).toBe("duplicate");
  },
);
