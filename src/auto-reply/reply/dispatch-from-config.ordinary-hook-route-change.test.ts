import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readConversationBindingRouteFacts } from "../../channels/conversation-binding-route-facts.js";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { resolveRuntimeConversationBindingRouteAsync } from "../../channels/plugins/binding-routing.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import type { OpenClawPluginCommandDefinition } from "../../plugin-sdk/channel-entry-contract.js";
import { createPluginCommandRuntime } from "../../plugin-sdk/plugin-command-runtime.js";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
  initializeGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugin-sdk/plugin-test-runtime.js";
import type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookInboundClaimResult,
  PluginHookBeforeDispatchContext,
  PluginHookBeforeDispatchEvent,
  PluginHookBeforeDispatchResult,
  PluginHookReplyDispatchContext,
  PluginHookReplyDispatchEvent,
  PluginHookReplyDispatchResult,
} from "../../plugins/hook-types.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import * as runtimeLoaders from "./dispatch-from-config.runtime-loaders.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { claimInboundDedupe, resetInboundDedupe } from "./inbound-dedupe.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

const pluginId = "hook-owner";
const conversation = {
  channel: "webchat",
  accountId: "default",
  conversationId: "room",
};

type BeforeDispatchHandler = (
  event: PluginHookBeforeDispatchEvent,
  context: PluginHookBeforeDispatchContext,
) => PluginHookBeforeDispatchResult | void | Promise<PluginHookBeforeDispatchResult | void>;
type InboundClaimHandler = (
  event: PluginHookInboundClaimEvent,
  context: PluginHookInboundClaimContext,
) => PluginHookInboundClaimResult | void | Promise<PluginHookInboundClaimResult | void>;
type ReplyDispatchHandler = (
  event: PluginHookReplyDispatchEvent,
  context: PluginHookReplyDispatchContext,
) => PluginHookReplyDispatchResult | void | Promise<PluginHookReplyDispatchResult | void>;

let state: OpenClawTestState | undefined;
let adapter: SessionBindingAdapter | undefined;
let cleanupRegistry: (() => Promise<void>) | undefined;
let releaseRuntimeLoader: (() => void) | undefined;
let releaseBeforeDispatch: (() => void) | undefined;
let pendingDispatch: Promise<unknown> | undefined;

afterEach(async () => {
  releaseRuntimeLoader?.();
  releaseRuntimeLoader = undefined;
  releaseBeforeDispatch?.();
  releaseBeforeDispatch = undefined;
  await pendingDispatch?.catch(() => undefined);
  pendingDispatch = undefined;
  if (adapter) {
    unregisterSessionBindingAdapter({
      channel: adapter.channel,
      accountId: adapter.accountId,
      adapter,
    });
  }
  adapter = undefined;
  await cleanupRegistry?.();
  cleanupRegistry = undefined;
  await state?.cleanup();
  state = undefined;
  resetInboundDedupe();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

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

async function createHookHarness(params: {
  beforeDispatch: BeforeDispatchHandler | readonly BeforeDispatchHandler[];
  label: string;
  messageId: string;
  replyDispatch?: ReplyDispatchHandler;
  registeredCommand?: OpenClawPluginCommandDefinition;
  inboundClaim?: InboundClaimHandler;
}) {
  const testState = await createOpenClawTestState({
    label: params.label,
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  state = testState;
  const pluginRoot = params.registeredCommand
    ? testState.statePath(pluginId)
    : testState.path(pluginId);
  let pluginFile: string | undefined;
  if (params.registeredCommand) {
    const { name, description, requireAuth } = params.registeredCommand;
    pluginFile = await testState.writeText(
      `${pluginId}/index.cjs`,
      `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
        api.registerCommand({ ...${JSON.stringify({ name, description, requireAuth })},
          handler() { throw new Error("before_dispatch must handle before command execution"); }
        });
      } };`,
    );
    await testState.writeJson(`${pluginId}/openclaw.plugin.json`, {
      id: pluginId,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    });
  }
  const cfg = withFullRuntimeReplyConfig({
    agents: {
      ownership: "explicit",
      entries: {
        main: { workspace: testState.path("main-workspace") },
        work: { workspace: testState.path("work-workspace") },
      },
      defaults: {
        workspace: testState.workspaceDir,
        skipBootstrap: true,
        model: { primary: "mock-openai/gpt-5.6-luna" },
        models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
      },
    },
    plugins: {
      enabled: true,
      allow: [pluginId],
      ...(pluginFile ? { load: { paths: [pluginFile] } } : {}),
      entries: { [pluginId]: { enabled: true } },
    },
    session: { scope: "global" },
    ...(params.registeredCommand ? { commands: { text: true } } : {}),
  });
  await testState.writeConfig(cfg);

  const registryBuilder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntimeMock(),
    activateGlobalSideEffects: false,
  });
  cleanupRegistry = async () => {
    await disposePluginRegistryInstances(registryBuilder.registry);
  };
  const pluginRecord = createPluginRecord({
    id: pluginId,
    origin: "bundled",
    source: pluginFile ?? `${pluginRoot}/index.ts`,
    status: "loaded",
  });
  const pluginApi = registryBuilder.createApi(pluginRecord, { config: cfg });
  registryBuilder.registry.plugins.push(pluginRecord);
  if (params.registeredCommand) {
    pluginApi.registerCommand(params.registeredCommand);
  }
  if (params.inboundClaim) {
    pluginApi.on("inbound_claim", params.inboundClaim);
  }
  const beforeDispatchHandlers =
    typeof params.beforeDispatch === "function" ? [params.beforeDispatch] : params.beforeDispatch;
  for (const [index, handler] of beforeDispatchHandlers.entries()) {
    pluginApi.on("before_dispatch", handler, { priority: -index });
  }
  if (params.replyDispatch) {
    pluginApi.on("reply_dispatch", params.replyDispatch, { eligibleDispatchKinds: ["agent"] });
  }
  setActivePluginRegistry(registryBuilder.registry);
  initializeGlobalHookRunner(registryBuilder.registry);
  if (params.registeredCommand) {
    expect(
      createPluginCommandRuntime()
        .listNativeCandidates("webchat")
        .map((item) => item.name),
    ).toContain(params.registeredCommand.name);
  }

  const preparedCatalogs: string[][] = [];
  if (params.registeredCommand) {
    const loadAbortRuntime = runtimeLoaders.loadAbortRuntime;
    vi.spyOn(runtimeLoaders, "loadAbortRuntime").mockImplementation(async () => {
      preparedCatalogs.push(
        createPluginCommandRuntime()
          .listNativeCandidates("webchat")
          .map((item) => item.name),
      );
      return await loadAbortRuntime();
    });
  }

  const buildContext = async () => {
    const routed = await resolveRuntimeConversationBindingRouteAsync({
      route: {
        agentId: "main",
        channel: conversation.channel,
        accountId: conversation.accountId,
        sessionKey: "global",
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "session",
        matchedBy: "default",
      },
      conversation,
    });
    const text = params.registeredCommand ? `/${params.registeredCommand.name}` : "hello";
    return buildChannelInboundEventContext({
      channel: conversation.channel,
      accountId: conversation.accountId,
      messageId: params.messageId,
      from: "synthetic-user",
      sender: { id: "synthetic-user" },
      conversation: { kind: "direct", id: conversation.conversationId },
      route: {
        ...routed.route,
        routeSessionKey: routed.route.sessionKey,
      },
      reply: { to: conversation.conversationId },
      message: { rawBody: text },
      access: { commands: { authorized: Boolean(params.registeredCommand) } },
      command: params.registeredCommand
        ? { kind: "text-slash", name: params.registeredCommand.name, body: text, authorized: true }
        : undefined,
    });
  };
  const invoke = (ctx: Awaited<ReturnType<typeof buildContext>>) => {
    const run = async () => {
      const dispatcher = createReplyDispatcher({
        deliver: async () => {
          throw new Error("The handled hook must not send a provider message");
        },
      });
      try {
        return await withPluginRuntimeRegistryScope(registryBuilder.registry, () =>
          dispatchReplyFromConfig({
            ctx,
            cfg,
            dispatcher,
            replyResolver: async () => {
              throw new Error("The registered dispatch hook was not selected");
            },
          }),
        );
      } finally {
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }
    };
    const work = run();
    pendingDispatch = work;
    return work;
  };

  return { buildContext, invoke, pluginRoot, preparedCatalogs };
}

function registerCurrentAdapter(readCurrent: () => SessionBindingRecord | null) {
  adapter = {
    channel: conversation.channel,
    accountId: conversation.accountId,
    listBySession: () => {
      const current = readCurrent();
      return current ? [current] : [];
    },
    inspectByConversation: readCurrent,
    inspectByConversationAsync: async () => readCurrent(),
    resolveByConversation: readCurrent,
    resolveByConversationAsync: async () => readCurrent(),
    touchAsync: async () => undefined,
  };
  registerSessionBindingAdapter(adapter);
}

function releaseDedupeForRetry(ctx: Parameters<typeof claimInboundDedupe>[0]) {
  const claim = claimInboundDedupe(ctx);
  expect.soft(claim.status).toBe("claimed");
  claim.release?.();
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
  const release = createDeferred();
  releaseRuntimeLoader = () => release.resolve();
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
  const release = createDeferred();
  releaseBeforeDispatch = () => release.resolve();
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
    const release = createDeferred();
    releaseBeforeDispatch = () => release.resolve();
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
