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
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
  initializeGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugin-sdk/plugin-test-runtime.js";
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

const pluginId = "claim-owner";
const conversation = {
  channel: "webchat",
  accountId: "default",
  conversationId: "room",
};

let state: OpenClawTestState | undefined;
let adapter: SessionBindingAdapter | undefined;
let cleanupRegistry: (() => Promise<void>) | undefined;
let releaseRuntimeLoader: (() => void) | undefined;
let pendingDispatch: Promise<unknown> | undefined;

afterEach(async () => {
  releaseRuntimeLoader?.();
  releaseRuntimeLoader = undefined;
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
  const testState = await createOpenClawTestState({
    label: params.label,
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  state = testState;
  const pluginRoot = testState.path(pluginId);
  const cfg = withFullRuntimeReplyConfig({
    agents: {
      ownership: "explicit",
      entries: { main: { workspace: testState.path("main-workspace") } },
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
      entries: { [pluginId]: { enabled: true } },
    },
    session: { scope: "global" },
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
    source: `${pluginRoot}/index.ts`,
    status: "loaded",
  });
  const pluginApi = registryBuilder.createApi(pluginRecord, { config: cfg });
  registryBuilder.registry.plugins.push(pluginRecord);

  let phase = "first";
  const claimEffects: string[] = [];
  pluginApi.on("inbound_claim", async (_event, context) => {
    claimEffects.push(`${phase}:${context.pluginBinding?.bindingId ?? "missing"}`);
    return { handled: true };
  });
  setActivePluginRegistry(registryBuilder.registry);
  initializeGlobalHookRunner(registryBuilder.registry);

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
      message: { rawBody: "hello" },
      extra: { CommandAuthorized: true },
    });
  };
  const invoke = (ctx: Awaited<ReturnType<typeof buildContext>>) => {
    const run = async () => {
      const dispatcher = createReplyDispatcher({
        deliver: async () => {
          throw new Error("The claiming hook must not send a provider message");
        },
      });
      try {
        return await withPluginRuntimeRegistryScope(registryBuilder.registry, () =>
          dispatchReplyFromConfig({
            ctx,
            cfg,
            dispatcher,
            replyResolver: async () => {
              throw new Error("The registered inbound_claim hook was not selected");
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

  return {
    buildContext,
    claimEffects,
    invoke,
    pluginRoot,
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
  adapter = {
    channel: conversation.channel,
    accountId: conversation.accountId,
    listBySession: () => (current ? [current] : []),
    inspectByConversation: () => current,
    inspectByConversationAsync: async () => current,
    resolveByConversation: () => current,
    resolveByConversationAsync: async () => current,
    touchAsync: async () => undefined,
  };
  registerSessionBindingAdapter(adapter);

  const firstContext = await harness.buildContext();
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
  current = preparedPluginBinding;
  release.resolve();
  const firstOutcome = await first;

  expect.soft(firstOutcome.error).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
  expect.soft(harness.claimEffects).toEqual([]);
  const releasedClaim = claimInboundDedupe(firstContext);
  expect.soft(releasedClaim.status).toBe("claimed");
  releasedClaim.release?.();

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
  adapter = {
    channel: conversation.channel,
    accountId: conversation.accountId,
    listBySession: () => (current ? [current] : []),
    inspectByConversation: () => current,
    inspectByConversationAsync: async () => current,
    resolveByConversation: () => current,
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
  };
  registerSessionBindingAdapter(adapter);

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
  const releasedClaim = claimInboundDedupe(firstContext);
  expect.soft(releasedClaim.status).toBe("claimed");
  releasedClaim.release?.();

  harness.setPhase("retry");
  const retryContext = await harness.buildContext();
  const retryObservation = readConversationBindingRouteFacts(retryContext);
  expect(retryObservation).toMatchObject({ kind: "plugin", bindingId: "claim-replacement" });
  expect(Object.isFrozen(retryObservation)).toBe(true);
  await harness.invoke(retryContext);

  expect(harness.claimEffects).toEqual(["retry:claim-replacement"]);
  expect(claimInboundDedupe(retryContext).status).toBe("duplicate");
});
