import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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

const pluginId = "claim-owner";

function createBinding(
  pluginRoot: string,
  bindingId: string,
  boundAt: number,
): SessionBindingRecord {
  return {
    bindingId,
    boundAt,
    targetKind: "session",
    targetSessionKey: `plugin-binding:${pluginId}:${bindingId}`,
    conversation,
    status: "active",
    metadata: {
      pluginBindingOwner: "plugin",
      pluginId,
      pluginRoot,
    },
  };
}

async function createClaimHarness(params: { label: string; messageId: string }) {
  let phase = "first";
  const claimEffects: string[] = [];
  const harness = await createHookHarness({
    ...params,
    pluginId,
    agentIds: ["main"],
    authorizeCommands: true,
    inboundClaim: async (_event, context) => {
      claimEffects.push(`${phase}:${context.pluginBinding?.bindingId ?? "missing"}`);
      return { handled: true };
    },
  });
  return {
    ...harness,
    claimEffects,
    setPhase(next: string) {
      phase = next;
    },
  };
}

it("refuses an early none-to-plugin claim after the real runtime loader barrier", async () => {
  let current: SessionBindingRecord | null = null;
  const harness = await createClaimHarness({
    label: "plugin-claim-none-to-plugin",
    messageId: "plugin-claim-none-to-plugin",
  });
  const preparedPluginBinding = createBinding(harness.pluginRoot, "claim-prepared", 1);
  registerCurrentAdapter(() => current);

  const firstContext = await harness.buildContext();
  const firstObservation = readConversationBindingRouteFacts(firstContext);
  expect(firstObservation?.kind).toBe("none");
  expect(Object.isFrozen(firstObservation)).toBe(true);

  const entered = createDeferred();
  const release = createRouteChangeBarrier();
  const loadRuntimePlugins = runtimeLoaders.loadRuntimePlugins;
  vi.spyOn(runtimeLoaders, "loadRuntimePlugins").mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return await loadRuntimePlugins();
  });

  const first = harness.invoke(firstContext).then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  await Promise.race([
    entered.promise,
    first.then(() => {
      throw new Error("Dispatch completed before reaching the real runtime loader barrier");
    }),
  ]);
  current = preparedPluginBinding;
  release.resolve();
  const firstOutcome = await first;

  expect.soft(firstOutcome.error).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
  expect.soft(harness.claimEffects).toEqual([]);
  releaseDedupeForRetry(firstContext);

  harness.setPhase("retry");
  const retryContext = await harness.buildContext();
  const retryObservation = readConversationBindingRouteFacts(retryContext);
  expect(retryObservation).toMatchObject({ kind: "plugin", bindingId: "claim-prepared" });
  expect(Object.isFrozen(retryObservation)).toBe(true);
  await harness.invoke(retryContext);

  expect(harness.claimEffects).toEqual(["retry:claim-prepared"]);
  expect(claimInboundDedupe(retryContext).status).toBe("duplicate");
});

it("refuses a late plugin replacement after the real binding activity read", async () => {
  const harness = await createClaimHarness({
    label: "plugin-claim-plugin-replacement",
    messageId: "plugin-claim-plugin-replacement",
  });
  const preparedPluginBinding = createBinding(harness.pluginRoot, "claim-prepared", 1);
  const replacementPluginBinding = createBinding(harness.pluginRoot, "claim-replacement", 2);
  let current: SessionBindingRecord | null = preparedPluginBinding;
  let armReplacementOnTouch = false;
  let replacementArmed = false;
  registerCurrentAdapter(() => current, {
    resolveByConversationAsync: async () => {
      const captured = current;
      if (replacementArmed) {
        replacementArmed = false;
        queueMicrotask(() => {
          current = replacementPluginBinding;
        });
      }
      return captured;
    },
    touchAsync: async (bindingId) => {
      if (armReplacementOnTouch && bindingId === preparedPluginBinding.bindingId) {
        armReplacementOnTouch = false;
        replacementArmed = true;
      }
    },
  });

  const firstContext = await harness.buildContext();
  const firstObservation = readConversationBindingRouteFacts(firstContext);
  expect(firstObservation).toMatchObject({ kind: "plugin", bindingId: "claim-prepared" });
  expect(Object.isFrozen(firstObservation)).toBe(true);
  armReplacementOnTouch = true;

  const firstOutcome = await harness.invoke(firstContext).then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  expect.soft(firstOutcome.error).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
  expect.soft(harness.claimEffects).toEqual([]);
  releaseDedupeForRetry(firstContext);

  harness.setPhase("retry");
  const retryContext = await harness.buildContext();
  const retryObservation = readConversationBindingRouteFacts(retryContext);
  expect(retryObservation).toMatchObject({ kind: "plugin", bindingId: "claim-replacement" });
  expect(Object.isFrozen(retryObservation)).toBe(true);
  await harness.invoke(retryContext);

  expect(harness.claimEffects).toEqual(["retry:claim-replacement"]);
  expect(claimInboundDedupe(retryContext).status).toBe("duplicate");
});
