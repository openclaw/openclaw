// Lets local agent paths reuse Gateway server methods without starting a server.
import { listAgentIds } from "../agents/agent-scope-config.js";
import { loadRunReplyDispatchRuntime } from "../agents/prepared-run-reply-dispatch-runtime.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withLocalAgentCronJobsRemoved } from "../cron/local-service.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  bindLegacyPluginSdkResourceHost,
  getLegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "./agent-runtime-approval-authority.js";
import { loadGatewayConfigRevisionProjector } from "./config-revision-token.js";
import { NodeRegistry } from "./node-registry.js";
import type { ChannelRuntimeSnapshot } from "./server-channel-runtime.types.js";
import { createChatRunState } from "./server-chat-state.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";
import type { GatewayInstanceRuntime } from "./server-instance-runtime.types.js";
import { getGatewayLifecycleRuntime } from "./server-lifecycle-runtime-context.js";
import { readPreparedServerMethodModelCatalogs } from "./server-methods/optional-model-catalog.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { registerGatewayModelCatalogPrivateAccess } from "./server-model-catalog-auth.js";
import {
  loadGatewayModelCatalog,
  loadGatewayModelCatalogSnapshot,
  loadPreparedGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalog,
  readPreparedGatewayModelCatalogBatch,
  readPreparedGatewayModelCatalogOwnerSnapshot,
} from "./server-model-catalog.js";
import { resolveSessionRequestTargets } from "./session-request-targets.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import type { SessionRowProjection } from "./session-row-projection.js";

// Embedded/local agent calls need enough GatewayRequestContext to reuse server
// methods without starting the full gateway. Unsupported subsystems fail loudly
// so local command paths do not silently enqueue cron/channel work.
type LocalGatewayRequestContextParams = {
  deps: CliDeps;
  getRuntimeConfig: () => OpenClawConfig;
};

async function cronUnavailable(): Promise<never> {
  throw new Error("Cron is unavailable in local embedded agent gateway context.");
}

const unavailableCron: GatewayCronServiceContract = {
  start: cronUnavailable,
  stop: () => {},
  pauseScheduling: () => {},
  resumeScheduling: () => {},
  status: cronUnavailable,
  list: cronUnavailable,
  listPage: cronUnavailable,
  add: cronUnavailable,
  update: cronUnavailable,
  updateWithPrecondition: cronUnavailable,
  remove: cronUnavailable,
  removeStaleJobFamily: cronUnavailable,
  removeAgentJobsTransactional: cronUnavailable,
  quiesceJobs: cronUnavailable,
  run: cronUnavailable,
  enqueueRun: cronUnavailable,
  readEventSources: cronUnavailable,
  runEvent: cronUnavailable,
  waitForManualRun: cronUnavailable,
  getJob: () => undefined,
  getLoadedJobs: () => undefined,
  readJob: async () => undefined,
  readScratch: cronUnavailable,
  writeScratch: cronUnavailable,
  getDefaultAgentId: () => undefined,
  wake: async () => ({ ok: false, reason: "unwakeable-session-key" }),
};

/** Creates the minimal gateway context used by embedded local agent execution. */
async function createLocalGatewayRequestContext(
  params: LocalGatewayRequestContextParams,
): Promise<GatewayRequestContext> {
  const logGateway = createSubsystemLogger("gateway/local");
  // A Gateway hosting this process (BOOT.md runs local commands inside it) keeps owning dispatch
  // facts, execution lifetime and lifecycle reads; only a one-shot process supplies its own.
  const hostingGateway = getGatewayLifecycleRuntime();
  const resourceHost = getLegacyPluginSdkResourceHost();
  const cron: GatewayCronServiceContract = {
    ...unavailableCron,
    removeAgentJobsTransactional: async (agentId, commit) =>
      await withLocalAgentCronJobsRemoved(agentId, params.getRuntimeConfig, commit),
  };
  const sessionEvents = new Set<string>();
  const chatRunState = createChatRunState();
  const loadCatalogSnapshot: GatewayRequestContext["loadGatewayModelCatalogSnapshot"] = (
    loadParams,
  ) => loadGatewayModelCatalogSnapshot({ ...loadParams, getConfig: params.getRuntimeConfig });
  registerGatewayModelCatalogPrivateAccess(loadCatalogSnapshot, {
    loadDeferred: (loadParams) =>
      loadPreparedGatewayModelCatalogSnapshot({
        ...loadParams,
        getConfig: params.getRuntimeConfig,
      }),
    readPrepared: (loadParams) =>
      readPreparedGatewayModelCatalogOwnerSnapshot({
        ...loadParams,
        getConfig: params.getRuntimeConfig,
      }),
  });
  const context: GatewayRequestContext = {
    localEmbedded: true,
    ...(hostingGateway
      ? {}
      : {
          // No Gateway publishes dispatch facts here; admission prepares the target agent's run.
          loadReplyDispatchRuntime: (loadParams) =>
            loadRunReplyDispatchRuntime({ ...loadParams, config: params.getRuntimeConfig() }),
        }),
    // In a one-shot process, admitted turns (spawned children, completion continuations) outlive
    // the caller's turn. Each is root work for its own run, so the process keeps its databases
    // open until it settles; detached follow-up admits its own root. A closed caller scope still
    // refuses new execution.
    trackExecution: hostingGateway
      ? trackAsyncWork
      : (run) =>
          trackAsyncWork(() =>
            runWithGatewayIndependentRootWorkAdmission(async () => await run(), "local:agent-turn"),
          ),
    deps: params.deps,
    configRevisionProjector: await loadGatewayConfigRevisionProjector({ env: process.env }),
    cron,
    cronStorePath: "",
    getRuntimeConfig: params.getRuntimeConfig,
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    resolveSessionRequestTargets: (request) =>
      resolveSessionRequestTargets({ ...request, context }),
    // Embedded calls have no running Gateway application owner.
    isConfigReloadSettled: () => false,
    resolveTerminalLaunchPolicy: () => ({ ok: false, block: { kind: "disabled" } }),
    isTerminalEnabled: () => false,
    loadGatewayModelCatalog: (loadParams) =>
      loadGatewayModelCatalog({
        ...loadParams,
        getConfig: params.getRuntimeConfig,
      }),
    loadGatewayModelCatalogSnapshot: loadCatalogSnapshot,
    readPreparedGatewayModelCatalog: (loadParams) =>
      readPreparedGatewayModelCatalog({ ...loadParams, getConfig: params.getRuntimeConfig }),
    readPreparedGatewayModelCatalogBatch: (agentIds, options) =>
      readPreparedGatewayModelCatalogBatch(agentIds, {
        ...options,
        getConfig: params.getRuntimeConfig,
      }),
    readChatMetadata: async () => {
      throw new Error("Chat metadata is unavailable in local embedded agent gateway context.");
    },
    getHealthCache: () => null,
    refreshHealthSnapshot: async () =>
      ({}) as Awaited<ReturnType<GatewayRequestContext["refreshHealthSnapshot"]>>,
    logHealth: { error: (message) => logGateway.error(message) },
    logGateway,
    publishPresence: () => {},
    getPresenceSnapshot: () => {
      throw new Error("Presence requires a running Gateway connection.");
    },
    broadcast: () => {},
    broadcastToConnIds: () => {},
    nodeSendToSession: () => {},
    nodeSendToAllSubscribed: () => {},
    nodeSubscribe: () => {},
    nodeUnsubscribe: () => {},
    nodeUnsubscribeAll: () => {},
    hasConnectedTalkNode: async () => false,
    nodeRegistry: new NodeRegistry(),
    agentRunSeq: new Map(),
    chatRunState,
    addChatRun: chatRunState.registry.add,
    removeChatRun: chatRunState.registry.remove,
    subscribeSessionEvents: (connId) => {
      sessionEvents.add(connId);
    },
    unsubscribeSessionEvents: (connId) => {
      sessionEvents.delete(connId);
    },
    forgetConnectionAncestors: () => {},
    subscribeSessionMessageEvents: () => undefined,
    unsubscribeSessionMessageEvents: () => {},
    unsubscribeAllSessionEvents: (connId) => {
      sessionEvents.delete(connId);
    },
    getSessionEventSubscriberConnIds: () => sessionEvents,
    registerToolEventRecipient: () => {},
    dedupe: new Map(),
    wizardSessions: new Map(),
    systemAgentSessions: new Map(),
    findRunningWizard: () => null,
    purgeWizardSession: () => {},
    getRuntimeSnapshot: () => ({}) as ChannelRuntimeSnapshot,
    startChannel: async () => {
      throw new Error("Channel start is unavailable in local embedded agent gateway context.");
    },
    stopChannel: async () => {
      throw new Error("Channel stop is unavailable in local embedded agent gateway context.");
    },
    markChannelLoggedOut: () => {},
    wizardRunner: async () => {
      throw new Error("Onboarding wizard is unavailable in local embedded agent gateway context.");
    },
    channelWizardRunner: async () => {
      throw new Error(
        "Channel setup wizard is unavailable in local embedded agent gateway context.",
      );
    },
    broadcastVoiceWakeChanged: () => {},
    broadcastVoiceWakeRoutingChanged: () => {},
    unavailableGatewayMethods: new Set(),
  };
  let projection: SessionRowProjection | undefined;
  let initializing: Promise<void> | undefined;
  bindSessionRowProjection(context, () => projection);
  context.ensureSessionRowProjection = () => {
    if (!initializing) {
      const release = async () => {
        await initializing?.catch(() => {});
        projection?.dispose();
        await projection?.ensureMaterialized();
      };
      // Resident reads use the command's database maintenance scope, so it retires them
      // before closing admission. Otherwise the same host retains embedded resources used
      // by admitted work after its caller returns.
      const maintenance = getOpenClawDatabaseMaintenanceScope();
      if (maintenance) {
        maintenance.own(context, "agent-resources", release);
      } else {
        resourceHost.adopt(context, { release });
      }
      initializing = import("./session-row-projection.js").then(
        async ({ createSessionRowProjection }) => {
          projection = await createSessionRowProjection({
            cfg: params.getRuntimeConfig(),
            getConfig: params.getRuntimeConfig,
            getModelCatalog: () =>
              readPreparedServerMethodModelCatalogs(
                context,
                listAgentIds(params.getRuntimeConfig()),
              ),
            context,
          });
        },
      );
    }
    return initializing;
  };
  // The Gateway's own instance runtime serves agent turns and lifecycle reads (agent.wait,
  // chat.history) through the shared method registry. It claims no process-global state and
  // starts timers only on use, so late root work may still dispatch through it after the caller
  // returns; it is collected with this context. Loaded on first use: most one-shot turns never
  // dispatch another turn, and the runtime and method registry cost cold start.
  let instance: Promise<GatewayInstanceRuntime> | undefined;
  const loadInstance = () =>
    (instance ??= Promise.all([
      import("./server-instance-runtime.js"),
      import("./server-methods.js"),
    ]).then(([{ createGatewayInstanceRuntime }, { createRequestGatewayMethodRegistry }]) =>
      createGatewayInstanceRuntime({
        getContext: () => context,
        getMethodRegistry: () => createRequestGatewayMethodRegistry(),
        isDispatchAvailable: () => true,
      }),
    ));
  context.createAgentTurnFacade = async (principal) =>
    (await loadInstance()).createAgentTurnFacade(principal);
  context.lifecycleRuntime = hostingGateway ?? {
    dispatchSessionMethod: async (method, payload, options) =>
      await (await loadInstance()).lifecycle.dispatchSessionMethod(method, payload, options),
    dispatchAgent: async (payload, timeoutMs, options) =>
      await (await loadInstance()).lifecycle.dispatchAgent(payload, timeoutMs, options),
    waitForAgent: async (payload, timeoutMs, signal) =>
      await (await loadInstance()).lifecycle.waitForAgent(payload, timeoutMs, signal),
    sendNotice: async (payload) => await (await loadInstance()).lifecycle.sendNotice(payload),
  };
  return context;
}

/** Runs code inside a local gateway request scope unless an outer scope already exists. */
export async function withLocalGatewayRequestScope<T>(
  params: LocalGatewayRequestContextParams,
  run: () => T,
): Promise<Awaited<T>> {
  const existing = getPluginRuntimeGatewayRequestScope();
  if (existing?.context || existing?.resolveGatewayContext) {
    return await run();
  }
  const context = await createLocalGatewayRequestContext(params);
  // Session admission retains the instance binding after dropping request context.
  const resolveGatewayContext = () => context;
  context.resolveGatewayContext = resolveGatewayContext;
  bindLegacyPluginSdkResourceHost(resolveGatewayContext, getLegacyPluginSdkResourceHost());
  return await withPluginRuntimeGatewayRequestScope(
    {
      ...existing,
      context,
      resolveGatewayContext,
      isWebchatConnect: existing?.isWebchatConnect ?? (() => false),
    },
    run,
  );
}
