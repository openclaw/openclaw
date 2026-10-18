import { afterEach, expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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

export const conversation = {
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
const pendingReleases: Array<() => void> = [];

export function createRouteChangeBarrier() {
  const deferred = createDeferred();
  pendingReleases.push(() => deferred.resolve());
  return deferred;
}
let pendingDispatch: Promise<unknown> | undefined;

afterEach(async () => {
  for (const release of pendingReleases.splice(0)) {
    release();
  }
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

export async function createHookHarness(params: {
  pluginId?: string;
  agentIds?: string[];
  authorizeCommands?: boolean;
  beforeDispatch?: BeforeDispatchHandler | readonly BeforeDispatchHandler[];
  label: string;
  messageId: string;
  replyDispatch?: ReplyDispatchHandler;
  registeredCommand?: OpenClawPluginCommandDefinition;
  inboundClaim?: InboundClaimHandler;
}) {
  const pluginId = params.pluginId ?? "hook-owner";
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
      entries: Object.fromEntries(
        (params.agentIds ?? ["main", "work"]).map((id) => [
          id,
          { workspace: testState.path(`${id}-workspace`) },
        ]),
      ),
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
    typeof params.beforeDispatch === "function"
      ? [params.beforeDispatch]
      : (params.beforeDispatch ?? []);
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
      access: {
        commands: {
          authorized: Boolean(params.registeredCommand) || params.authorizeCommands === true,
        },
      },
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

export function registerCurrentAdapter(
  readCurrent: () => SessionBindingRecord | null,
  overrides: Partial<Pick<SessionBindingAdapter, "resolveByConversationAsync" | "touchAsync">> = {},
) {
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
    ...overrides,
  };
  registerSessionBindingAdapter(adapter);
}

export function releaseDedupeForRetry(ctx: Parameters<typeof claimInboundDedupe>[0]) {
  const claim = claimInboundDedupe(ctx);
  expect.soft(claim.status).toBe("claimed");
  claim.release?.();
}
