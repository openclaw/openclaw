import { AsyncLocalStorage } from "node:async_hooks";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../config/io.js";
import { formatErrorMessage } from "../infra/errors.js";
import { retireQuestionChannelGateway } from "../infra/question-channel-runtime.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { bindLegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { closeGatewayDeviceRevocation } from "./device-revocation.js";
import { shouldUseGatewayOwnerProfile } from "./gateway-owner-profile.js";
import { createGatewayChatMetadataLifecycle } from "./server-chat-metadata-lifecycle.js";
import type { startGatewayCoreRuntime } from "./server-core-runtime.js";
import { attachInitialGatewayLifetimeSidecars } from "./server-lifetime-sidecars.js";
import { readPreparedServerMethodModelCatalogs } from "./server-methods/optional-model-catalog.js";
import type { GatewayHostLifecycle } from "./server-public.js";

type GatewayCoreRuntime = Awaited<ReturnType<typeof startGatewayCoreRuntime>>;
type GatewayLogger = ReturnType<typeof createSubsystemLogger>;

/** Prepares request bindings and the one-shot initializer shared by startup and transports. */
export async function prepareGatewayKernelRequestRuntime(params: {
  coreRuntime: GatewayCoreRuntime;
  log: GatewayLogger;
  logHealth: GatewayLogger;
  hostLifecycle?: GatewayHostLifecycle;
}) {
  const { coreRuntime: runtime, log, logHealth } = params;
  const {
    minimalTestGateway,
    runtimeState,
    bindApprovalPublicationContext,
    startupTrace,
    workerPlacementRuntime,
    githubPublicationRuntime,
    pluginGatewayContext,
    getAttachedGatewayMethodRegistry,
    gatewayInstanceRuntimeRef,
    startupState,
    shutdownRuntime,
  } = runtime;
  const [chatMetadataLifecycle, configRevisionProjector] = await Promise.all([
    startupTrace.measure("gateway.chat-metadata-lifecycle", () =>
      createGatewayChatMetadataLifecycle({
        getConfig: getRuntimeConfig,
        log,
        getPluginMetadataSnapshot: runtime.getPluginMetadataSnapshot,
      }),
    ),
    startupTrace.measure("gateway.config-revision-key", async () => {
      const { loadGatewayConfigRevisionProjector } = await import("./config-revision-token.js");
      return loadGatewayConfigRevisionProjector({ env: process.env });
    }),
  ]);
  const gatewayRequestContext = await startupTrace.measure("gateway.request-context", async () => {
    const { createGatewayRequestContext } = await import("./server-request-context.js");
    return createGatewayRequestContext({
      runtime,
      configRevisionProjector,
      chatMetadataLifecycle,
      log,
      logHealth,
    });
  });
  const projectionReady = runtime.opts.updateCanary
    ? undefined
    : startupTrace.measure("sessions.projection", async () => {
        const { createSessionRowProjection } = await import("./session-row-projection.js");
        return createSessionRowProjection({
          cfg: getRuntimeConfig(),
          getConfig: getRuntimeConfig,
          getPolicyConfig: gatewayRequestContext.getCommittedRuntimeConfig ?? getRuntimeConfig,
          getModelCatalog: () =>
            readPreparedServerMethodModelCatalogs(
              gatewayRequestContext,
              listAgentIds(getRuntimeConfig()),
            ),
          context: gatewayRequestContext,
          placementFactsReader: runtime.workerEnvironmentStartup?.placementStore,
        });
      });
  // Startup and teardown retain this work even if transport setup fails first.
  void projectionReady?.catch(() => {});
  let requestRuntimeReady: Promise<void> | undefined;
  const projectionLifetime: { closing: boolean; detach?: () => void } = { closing: false };
  runtime.registerGatewayLifetimeSidecars({
    stop: async () => {
      projectionLifetime.closing = true;
      // Received mutations and their finalizers join before lifetime sidecars stop.
      // Retire this exact context too when no request ever bound its coordinator.
      retireQuestionChannelGateway(runtime.connectionWork.signal);
      closeGatewayDeviceRevocation(gatewayRequestContext);
      await gatewayRequestContext.scopeUpgradeCoordinator?.close();
      const projection = await projectionReady?.catch(() => undefined);
      await shutdownRuntime.flushPendingSessionsChangedEvents(gatewayRequestContext);
      if (projection) {
        await shutdownRuntime.drainSessionEventPublications(projection);
      }
      projectionLifetime.detach?.();
      projection?.dispose();
    },
  });
  // An early request may initialize this while other listeners bind; keep startup ownership.
  const initializeRequestRuntime = AsyncLocalStorage.bind(async () => {
    const projection = await projectionReady;
    if (projectionLifetime.closing) {
      throw new Error("Gateway closed during session projection startup");
    }
    if (projection) {
      projectionLifetime.detach = runtime.attachSessionRowProjection(projection);
      if (
        shouldUseGatewayOwnerProfile({
          role: "operator",
          authMethod: runtime.getResolvedAuth().mode,
          rolesConfigured: Boolean(getRuntimeConfig().gateway?.roles),
        })
      ) {
        try {
          await startupTrace.measure("gateway.owner-profile", async () => {
            const [{ ensureCanonicalGatewayOwnerProfile }, { resolveHostAccountName }] =
              await Promise.all([
                import("../state/user-profile-writes.js"),
                import("../infra/host-account-name.js"),
              ]);
            // Projection owns the admitted catalog; first connect consumes its committed owner.
            await ensureCanonicalGatewayOwnerProfile(resolveHostAccountName);
          });
        } catch (error) {
          log.warn(`Gateway owner profile preparation failed: ${formatErrorMessage(error)}`);
        }
      }
      // The initial roster must be usable before reconnecting clients can issue lists.
      // Load-bearing: exact preparations outrank the bulk drain, so an un-awaited drain can
      // stay incomplete under traffic and every read re-prepares rows (#184368, reverted).
      await startupTrace.measure("sessions.materialize", () => projection.ensureMaterialized());
      if (projectionLifetime.closing) {
        throw new Error("Gateway closed during session projection startup");
      }
      // Facts are ready, but display rows remain lazy. Warm the recent page while sidecars start.
      void runtime.connectionWork
        .track(() =>
          runWithGatewayIndependentRootWorkAdmission(
            async () => {
              const { listProjectedSessions } = await import("./session-utils-list.js");
              runtime.connectionWork.signal.throwIfAborted();
              await startupTrace.measure("sessions.first-page", () =>
                listProjectedSessions({
                  projection,
                  opts: { limit: 100, archived: false, rowMode: "sidebar" },
                  acceptsSerializedJson: true,
                }),
              );
            },
            "startup:session-row-prewarm",
            runtime.connectionWork.signal,
          ),
        )
        .catch((error: unknown) => {
          if (!runtime.connectionWork.signal.aborted) {
            log.warn(`Session first-page preparation failed: ${formatErrorMessage(error)}`);
          }
        });
    }
    if (!runtime.opts.updateCanary) {
      await startupTrace.measure("gateway.lifetime-sidecars", () =>
        attachInitialGatewayLifetimeSidecars({
          scheduler: runtime.scheduler,
          chatMetadataLifecycle,
          gatewayRequestContext,
          flushPendingSessionsChangedEvents: shutdownRuntime.flushPendingSessionsChangedEvents,
          minimalTestGateway,
          logWarning: (message) => log.warn(message),
          ...(!workerPlacementRuntime && githubPublicationRuntime
            ? { reconcileGitHubPublications: githubPublicationRuntime.reconcilePublications }
            : {}),
          publishSidecars: runtimeState.gatewayLifetimeSidecars.publish,
        }),
      );
    }
  });
  const ensureRequestRuntimeReady = () => (requestRuntimeReady ??= initializeRequestRuntime());
  gatewayRequestContext.requestEntryLifetime = runtime.requestEntryLifetime;
  bindApprovalPublicationContext(gatewayRequestContext);
  pluginGatewayContext.current = gatewayRequestContext;
  gatewayRequestContext.dispatchHookAgentTurn = async (pluginId, hookParams) => {
    const transport = runtime.transportBridge.current();
    if (!transport) {
      throw new Error("Gateway listener must start before plugin hook dispatch");
    }
    return await transport.dispatchHookAgentTurn(pluginId, hookParams);
  };
  const { createGatewayInstanceRuntime } = await startupTrace.measure(
    "gateway.instance-runtime-import",
    () => import("./server-instance-runtime.js"),
  );
  const gatewayInstanceRuntime = createGatewayInstanceRuntime({
    getContext: () => gatewayRequestContext,
    getMethodRegistry: () => getAttachedGatewayMethodRegistry(),
    // Request entry fences new calls during the prelude. Retained principals
    // stay current until run shutdown records recovery and cancels execution.
    isDispatchAvailable: () => startupState.dispatchReady,
    logError: (message) => log.error(message),
    prepareRestartRecovery: runtime.channelManager.recoverAutostartSuppression,
  });
  gatewayInstanceRuntimeRef.current = gatewayInstanceRuntime;
  gatewayRequestContext.resolveGatewayContext = () =>
    gatewayInstanceRuntime.isAvailable() ? gatewayRequestContext : undefined;
  bindLegacyPluginSdkResourceHost(
    gatewayRequestContext.resolveGatewayContext,
    runtime.sdkResourceHost,
  );
  // Detached RPC replies retain this availability fence after the request ends.
  // Shutdown must still recognize them as work owned by this exact Gateway.
  bindGatewayContextResolver(
    gatewayRequestContext.resolveGatewayContext,
    runtime.resolvePluginGatewayContext,
  );
  const hostLifecycle = params.hostLifecycle;
  if (hostLifecycle) {
    gatewayRequestContext.hostLifecycle = {
      externalRestart: hostLifecycle.externalRestart,
      getShutdownBudget: () => hostLifecycle.getShutdownBudget?.(),
      request: (action, assertCaller) =>
        hostLifecycle.request(action, () => {
          // Host control creates new effects; retained reply principals can remain
          // current during recovery marking without admitting host start/stop.
          if (
            runtime.requestEntryLifetime.signal.aborted ||
            !gatewayInstanceRuntime.isAvailable()
          ) {
            throw new Error(
              "Gateway lifecycle is unavailable for this closed instance. Reconnect and retry.",
            );
          }
          assertCaller();
        }),
    };
  }
  gatewayRequestContext.approvalEvents = gatewayInstanceRuntime.approvalEvents;
  gatewayRequestContext.recoveryRuntime = gatewayInstanceRuntime.recovery;
  bindGatewayContextResolver(
    gatewayInstanceRuntime.recovery,
    gatewayRequestContext.resolveGatewayContext,
  );
  gatewayRequestContext.createAgentTurnFacade = gatewayInstanceRuntime.createAgentTurnFacade;
  return {
    ...runtime,
    chatMetadataLifecycle,
    gatewayRequestContext,
    gatewayInstanceRuntime,
    ensureRequestRuntimeReady,
  };
}

export type GatewayKernelRuntime = Awaited<ReturnType<typeof prepareGatewayKernelRequestRuntime>>;
