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

const pluginId = "hook-owner";

function createAgentBinding(params: {
  agentId: string;
  bindingId: string;
  boundAt: number;
  sessionKey: string;
}): SessionBindingRecord {
  return {
    bindingId: params.bindingId,
    boundAt: params.boundAt,
    targetKind: "session",
    targetSessionKey: params.sessionKey,
    conversation,
    status: "active",
    metadata: { agentId: params.agentId },
  };
}

it("refuses an early none-to-agent change before handled before_dispatch", async () => {
  let phase = "first";
  const effects: Array<{
    phase: string;
    eventSessionKey: string | undefined;
    contextSessionKey: string | undefined;
  }> = [];
  const harness = await createHookHarness({
    label: "ordinary-hook-none-to-agent",
    messageId: "ordinary-hook-none-to-agent",
    beforeDispatch: async (event, context) => {
      effects.push({
        phase,
        eventSessionKey: event.sessionKey,
        contextSessionKey: context.sessionKey,
      });
      return { handled: true };
    },
  });
  const workBinding = createAgentBinding({
    agentId: "work",
    bindingId: "work-owner",
    boundAt: 1,
    sessionKey: "agent:work:main",
  });
  let current: SessionBindingRecord | null = null;
  registerCurrentAdapter(() => current);

  const firstContext = await harness.buildContext();
  expect(firstContext).toMatchObject({ AgentId: "main", SessionKey: "global" });
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
  current = workBinding;
  release.resolve();
  const firstOutcome = await first;

  expect.soft(firstOutcome.error).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
  expect.soft(effects).toEqual([]);
  releaseDedupeForRetry(firstContext);

  phase = "retry";
  const retryContext = await harness.buildContext();
  expect(retryContext).toMatchObject({ AgentId: "work", SessionKey: "agent:work:main" });
  expect(readConversationBindingRouteFacts(retryContext)).toMatchObject({
    kind: "agent",
    bindingId: "work-owner",
  });
  await harness.invoke(retryContext);

  expect(effects).toEqual([
    {
      phase: "retry",
      eventSessionKey: "agent:work:main",
      contextSessionKey: "agent:work:main",
    },
  ]);
  expect(claimInboundDedupe(retryContext).status).toBe("duplicate");
});

it("revalidates an agent route after nonclaiming before_dispatch and before reply_dispatch", async () => {
  let phase = "first";
  const beforeEffects: Array<{
    phase: string;
    eventSessionKey: string | undefined;
    contextSessionKey: string | undefined;
  }> = [];
  const replyEffects: Array<{
    phase: string;
    agentId: string | undefined;
    contextSessionKey: string | undefined;
    eventSessionKey: string | undefined;
  }> = [];
  const beforeEntered = createDeferred();
  const release = createRouteChangeBarrier();
  const harness = await createHookHarness({
    label: "ordinary-hook-agent-replacement",
    messageId: "ordinary-hook-agent-replacement",
    beforeDispatch: async (event, context) => {
      beforeEffects.push({
        phase,
        eventSessionKey: event.sessionKey,
        contextSessionKey: context.sessionKey,
      });
      if (phase === "first") {
        beforeEntered.resolve();
        await release.promise;
      }
    },
    replyDispatch: async (event, context) => {
      replyEffects.push({
        phase,
        agentId: event.ctx.AgentId,
        contextSessionKey: event.ctx.SessionKey,
        eventSessionKey: event.sessionKey,
      });
      context.recordProcessed("completed", { reason: "synthetic-ordinary-hook" });
      context.markIdle("message_completed");
      return {
        handled: true,
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    },
  });
  const mainBinding = createAgentBinding({
    agentId: "main",
    bindingId: "main-owner",
    boundAt: 1,
    sessionKey: "agent:main:main",
  });
  const workBinding = createAgentBinding({
    agentId: "work",
    bindingId: "work-owner",
    boundAt: 2,
    sessionKey: "agent:work:main",
  });
  let current: SessionBindingRecord | null = mainBinding;
  registerCurrentAdapter(() => current);

  const firstContext = await harness.buildContext();
  expect(firstContext).toMatchObject({ AgentId: "main", SessionKey: "agent:main:main" });
  expect(readConversationBindingRouteFacts(firstContext)).toMatchObject({
    kind: "agent",
    bindingId: "main-owner",
  });

  const first = harness.invoke(firstContext).then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  await Promise.race([
    beforeEntered.promise,
    first.then(() => {
      throw new Error("Dispatch completed before the registered before_dispatch barrier");
    }),
  ]);
  current = workBinding;
  release.resolve();
  const firstOutcome = await first;

  expect.soft(firstOutcome.error).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
  expect.soft(beforeEffects).toEqual([
    {
      phase: "first",
      eventSessionKey: "agent:main:main",
      contextSessionKey: "agent:main:main",
    },
  ]);
  expect.soft(replyEffects).toEqual([]);
  releaseDedupeForRetry(firstContext);

  phase = "retry";
  const retryContext = await harness.buildContext();
  expect(retryContext).toMatchObject({ AgentId: "work", SessionKey: "agent:work:main" });
  expect(readConversationBindingRouteFacts(retryContext)).toMatchObject({
    kind: "agent",
    bindingId: "work-owner",
  });
  await harness.invoke(retryContext);

  expect(beforeEffects).toEqual([
    {
      phase: "first",
      eventSessionKey: "agent:main:main",
      contextSessionKey: "agent:main:main",
    },
    {
      phase: "retry",
      eventSessionKey: "agent:work:main",
      contextSessionKey: "agent:work:main",
    },
  ]);
  expect(replyEffects).toEqual([
    {
      phase: "retry",
      agentId: "work",
      contextSessionKey: "agent:work:main",
      eventSessionKey: "agent:work:main",
    },
  ]);
  expect(claimInboundDedupe(retryContext).status).toBe("duplicate");
});

it.each(["ordinary", "registered-command", "stable-plugin-command"] as const)(
  "revalidates between registered before_dispatch handlers before a later handler claims: %s",
  async (input) => {
    let phase = "first";
    const registeredCommand = input !== "ordinary";
    const stable = input === "stable-plugin-command";
    const firstSessionKey = stable ? "global" : "agent:main:main";
    const commandHandler = vi.fn(async () => {
      throw new Error("before_dispatch must handle this turn before command execution");
    });
    const inboundClaim = vi.fn(async () => ({ handled: true }));
    const preparations: Array<{ phase: string; sessionKey: string | undefined }> = [];
    const claims: Array<{
      phase: string;
      eventSessionKey: string | undefined;
      contextSessionKey: string | undefined;
    }> = [];
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
          preparations.push({ phase, sessionKey: event.sessionKey });
        },
        async (event, context) => {
          claims.push({
            phase,
            eventSessionKey: event.sessionKey,
            contextSessionKey: context.sessionKey,
          });
          return { handled: true };
        },
      ],
    });
    const mainBinding = createAgentBinding({
      agentId: "main",
      bindingId: "main-owner",
      boundAt: 1,
      sessionKey: "agent:main:main",
    });
    const workBinding = createAgentBinding({
      agentId: "work",
      bindingId: "work-owner",
      boundAt: 2,
      sessionKey: "agent:work:main",
    });
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
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    await Promise.race([
      entered.promise,
      first.then(() => {
        if (registeredCommand) {
          expect(harness.preparedCatalogs).toEqual([expect.arrayContaining(["routeproof"])]);
        }
        throw new Error("Dispatch completed before the first registered handler barrier");
      }),
    ]);
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
      expect(firstOutcome.error).toBeUndefined();
      expect(preparations).toEqual([{ phase: "first", sessionKey: firstSessionKey }]);
      expect(claims).toEqual([
        { phase: "first", eventSessionKey: firstSessionKey, contextSessionKey: firstSessionKey },
      ]);
      expect(claimInboundDedupe(firstContext).status).toBe("duplicate");
      return;
    }

    expect.soft(firstOutcome.error).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
    expect.soft(preparations).toEqual([{ phase: "first", sessionKey: "agent:main:main" }]);
    expect.soft(claims).toEqual([]);
    releaseDedupeForRetry(firstContext);

    phase = "retry";
    const retryContext = await harness.buildContext();
    expect(retryContext.MessageSid).toBe(firstContext.MessageSid);
    expect(retryContext).toMatchObject({ AgentId: "work", SessionKey: "agent:work:main" });
    await harness.invoke(retryContext);

    expect(preparations).toEqual([
      { phase: "first", sessionKey: "agent:main:main" },
      { phase: "retry", sessionKey: "agent:work:main" },
    ]);
    expect(claims).toEqual([
      {
        phase: "retry",
        eventSessionKey: "agent:work:main",
        contextSessionKey: "agent:work:main",
      },
    ]);
    expect(claimInboundDedupe(retryContext).status).toBe("duplicate");
    expect(commandHandler).not.toHaveBeenCalled();
    expect(inboundClaim).not.toHaveBeenCalled();
  },
);
