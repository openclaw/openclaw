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

const pluginId = "hook-owner";
type SessionKeys = [string | undefined, string | undefined];

function createAgentBinding(agentId: string, boundAt = 1): SessionBindingRecord {
  return {
    bindingId: `${agentId}-owner`,
    boundAt,
    targetKind: "session",
    targetSessionKey: `agent:${agentId}:main`,
    conversation,
    status: "active",
    metadata: { agentId },
  };
}

it.each(["runtime-loader", "before-dispatch"] as const)(
  "revalidates ownership after %s before a claiming hook",
  async (checkpoint) => {
    const early = checkpoint === "runtime-loader";
    let phase = "first";
    const beforeEffects: SessionKeys[] = [];
    const replyEffects: [...SessionKeys, string | undefined][] = [];
    const entered = createDeferred();
    const release = createRouteChangeBarrier();
    const harness = await createHookHarness({
      label: `ordinary-hook-${checkpoint}`,
      messageId: `ordinary-hook-${checkpoint}`,
      beforeDispatch: async (event, context) => {
        beforeEffects.push([event.sessionKey, context.sessionKey]);
        if (early) {
          return { handled: true };
        }
        if (phase === "first") {
          entered.resolve();
          await release.promise;
        }
        return undefined;
      },
      replyDispatch: early
        ? undefined
        : async (event, context) => {
            replyEffects.push([event.sessionKey, event.ctx.SessionKey, event.ctx.AgentId]);
            context.recordProcessed("completed", { reason: "synthetic-ordinary-hook" });
            context.markIdle("message_completed");
            return {
              handled: true,
              queuedFinal: false,
              counts: { tool: 0, block: 0, final: 0 },
            };
          },
    });
    const mainBinding = createAgentBinding("main");
    const workBinding = createAgentBinding("work", early ? 1 : 2);
    let current: SessionBindingRecord | null = early ? null : mainBinding;
    registerCurrentAdapter(() => current);

    const firstContext = await harness.buildContext();
    expect(firstContext).toMatchObject({
      AgentId: "main",
      SessionKey: early ? "global" : "agent:main:main",
    });
    const observation = readConversationBindingRouteFacts(firstContext);
    if (early) {
      expect(observation?.kind).toBe("none");
      expect(Object.isFrozen(observation)).toBe(true);
      const loadRuntimePlugins = runtimeLoaders.loadRuntimePlugins;
      vi.spyOn(runtimeLoaders, "loadRuntimePlugins").mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return await loadRuntimePlugins();
      });
    } else {
      expect(observation).toMatchObject({ kind: "agent", bindingId: "main-owner" });
    }

    const first = harness.invoke(firstContext).then(
      () => undefined,
      (error: unknown) => error,
    );
    await awaitGateBeforeSettlement(
      entered.promise,
      first,
      `Dispatch completed before the ${checkpoint} barrier`,
    );
    current = workBinding;
    release.resolve();
    expect.soft(await first).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
    const firstEffect = ["agent:main:main", "agent:main:main"];
    expect.soft(beforeEffects).toEqual(early ? [] : [firstEffect]);
    releaseDedupeForRetry(firstContext);

    phase = "retry";
    const retryContext = await harness.buildContext();
    expect(retryContext).toMatchObject({ AgentId: "work", SessionKey: "agent:work:main" });
    expect(readConversationBindingRouteFacts(retryContext)).toMatchObject({
      kind: "agent",
      bindingId: "work-owner",
    });
    await harness.invoke(retryContext);

    const retryEffect = ["agent:work:main", "agent:work:main"];
    expect(beforeEffects).toEqual(early ? [retryEffect] : [firstEffect, retryEffect]);
    if (!early) {
      expect(replyEffects).toEqual([[...retryEffect, "work"]]);
    }
    expect(claimInboundDedupe(retryContext).status).toBe("duplicate");
  },
);

it.each(["ordinary", "registered-command", "stable-plugin-command"] as const)(
  "revalidates between before_dispatch handlers (%s)",
  async (input) => {
    let phase = "first";
    const registeredCommand = input !== "ordinary";
    const stable = input === "stable-plugin-command";
    const firstSessionKey = stable ? "global" : "agent:main:main";
    const commandHandler = vi.fn(async () => {
      throw new Error("before_dispatch must handle this turn before command execution");
    });
    const inboundClaim = vi.fn(async () => ({ handled: true }));
    const preparations: (string | undefined)[] = [];
    const claims: SessionKeys[] = [];
    const entered = createDeferred();
    const release = createRouteChangeBarrier();
    const harness = await createHookHarness({
      label: `ordinary-hook-between-handlers-${input}`,
      messageId: `ordinary-hook-between-handlers-${input}`,
      ...(registeredCommand
        ? {
            registeredCommand: {
              name: "routeproof",
              description: "Synthetic route ownership command",
              requireAuth: true,
              handler: commandHandler,
            },
            inboundClaim,
          }
        : {}),
      beforeDispatch: [
        async (event) => {
          if (phase === "first") {
            entered.resolve();
            await release.promise;
          }
          preparations.push(event.sessionKey);
        },
        async (event, context) => {
          claims.push([event.sessionKey, context.sessionKey]);
          return { handled: true };
        },
      ],
    });
    const mainBinding = createAgentBinding("main");
    const workBinding = createAgentBinding("work", 2);
    let current: SessionBindingRecord | null = stable
      ? {
          ...mainBinding,
          targetSessionKey: `plugin-binding:${pluginId}:stable`,
          metadata: { pluginBindingOwner: "plugin", pluginId, pluginRoot: harness.pluginRoot },
        }
      : mainBinding;
    registerCurrentAdapter(() => current);

    const firstContext = await harness.buildContext();
    expect(firstContext).toMatchObject({ AgentId: "main", SessionKey: firstSessionKey });
    expect(firstContext.CommandTargetSessionKey).toBeUndefined();
    if (registeredCommand) {
      expect(firstContext.CommandTurn).toMatchObject({
        kind: "text-slash",
        authorized: true,
        commandName: "routeproof",
      });
    }
    const first = harness.invoke(firstContext).then(
      () => undefined,
      (error: unknown) => error,
    );
    await awaitGateBeforeSettlement(
      entered.promise,
      first,
      "Dispatch completed before the first registered handler barrier",
    );
    expect(claims).toEqual([]);
    if (registeredCommand) {
      expect(harness.preparedCatalogs).toEqual([expect.arrayContaining(["routeproof"])]);
    }
    if (!stable) {
      current = workBinding;
    }
    release.resolve();
    const firstOutcome = await first;
    expect(commandHandler).not.toHaveBeenCalled();
    expect(inboundClaim).not.toHaveBeenCalled();
    if (stable) {
      expect(firstOutcome).toBeUndefined();
      expect(preparations).toEqual([firstSessionKey]);
      expect(claims).toEqual([[firstSessionKey, firstSessionKey]]);
      expect(claimInboundDedupe(firstContext).status).toBe("duplicate");
      return;
    }

    expect.soft(firstOutcome).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
    expect.soft(preparations).toEqual(["agent:main:main"]);
    releaseDedupeForRetry(firstContext);

    phase = "retry";
    const retryContext = await harness.buildContext();
    expect(retryContext.MessageSid).toBe(firstContext.MessageSid);
    expect(retryContext).toMatchObject({ AgentId: "work", SessionKey: "agent:work:main" });
    await harness.invoke(retryContext);

    expect(preparations).toEqual(["agent:main:main", "agent:work:main"]);
    expect(claims).toEqual([["agent:work:main", "agent:work:main"]]);
    expect(claimInboundDedupe(retryContext).status).toBe("duplicate");
    expect(commandHandler).not.toHaveBeenCalled();
    expect(inboundClaim).not.toHaveBeenCalled();
  },
);
