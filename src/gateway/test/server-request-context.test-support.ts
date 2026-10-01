import { vi } from "vitest";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { createChatRunState } from "../server-chat-state.js";
import type { GatewayServerLiveState } from "../server-live-state.js";
import type { createGatewayRequestContext } from "../server-request-context.js";

type GatewayRequestContextParams = Parameters<typeof createGatewayRequestContext>[0];
type TestCronState = GatewayServerLiveState["cronState"];
export type RequestRuntime = GatewayRequestContextParams["runtime"];

export function makeCronState(overrides: Partial<TestCronState> = {}): TestCronState {
  return {
    cron: { start: vi.fn(), stop: vi.fn() } as never,
    storePath: "/tmp/cron",
    cronEnabled: true,
    reconcileExitWatchers: vi.fn(async () => {}),
    reconcileStreamWatchers: vi.fn(async () => {}),
    stopStreamWatchers: vi.fn(async () => {}),
    reconcileSystemJobs: vi.fn(async () => "converged" as const),
    ...overrides,
  };
}

export function makeContextParams(
  overrides: Partial<RequestRuntime> = {},
): GatewayRequestContextParams {
  const config = {} as never;
  return {
    runtime: {
      connectionWork: { track: trackAsyncWork },
      deps: {} as never,
      runtimeState: {
        cronState: makeCronState(),
        configReloader: { isConfigReloadSettled: vi.fn(() => true) },
      },
      lifecycle: { closePreludeStarted: false },
      getAttachedGatewayMethodRegistry: vi.fn(() => ({}) as never),
      gatewayTls: { enabled: false },
      sessionCompanion: {} as never,
      sessionObserver: { removeConnection: vi.fn() } as never,
      mentionInbox: undefined,
      transportBridge: {
        getPortalService: vi.fn(() => undefined),
        getMcpAppSandboxPort: vi.fn(() => undefined),
        ensureSandboxHostPort: vi.fn(async () => 18790),
      },
      terminalLaunchPolicy: {
        resolve: vi.fn(() => ({ ok: false as const, block: { kind: "disabled" as const } })),
        isEnabled: vi.fn(() => false),
      },
      execApprovalManager: undefined,
      questionManager: undefined,
      cancelRunBoundApprovals: undefined,
      forwardPluginApprovalRequest: undefined,
      approvalWebPushDelivery: undefined,
      pluginApprovalIosPushDelivery: undefined,
      pluginApprovalManager: undefined,
      placementStandingGrants: undefined,
      systemAgentApprovalManager: undefined,
      approvalSessionEvents: { replay: undefined },
      validateAgentRuntimeApprovalAuthority: () => false,
      loadGatewayModelCatalog: vi.fn(async () => []),
      loadGatewayModelCatalogSnapshot: vi.fn(async () => ({
        agentId: "main",
        agentDir: "/tmp/model-catalog-agent",
        catalogComplete: false,
        workspaceDir: "/tmp/model-catalog-workspace",
        config,
        entries: [],
        routeVariants: [],
      })),
      readPreparedGatewayModelCatalog: undefined,
      refreshGatewayHealthSnapshotWithRuntime: vi.fn(async () => ({}) as never),
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      nodeSendToSession: vi.fn(),
      nodeSendToAllSubscribed: vi.fn(),
      nodeSubscribe: vi.fn(),
      nodeUnsubscribe: vi.fn(),
      nodeUnsubscribeAll: vi.fn(),
      hasTalkNodeConnected: vi.fn(async () => false),
      clients: new Set(),
      isConnectionActive: vi.fn(() => false),
      watchNodeHttpRuntime: {
        invalidateSessionsForDevice: vi.fn(),
        disconnectSessionsForDevice: vi.fn(),
      },
      sharedGatewaySessionGenerationState: {} as never,
      resolveSharedGatewaySessionGenerationForRuntimeSnapshot: vi.fn(() => undefined),
      nodeRegistry: { invalidateConnectionForPairingChange: vi.fn() } as never,
      nodeDesktopService: undefined,
      workerEnvironmentService: undefined,
      hostDesktopService: undefined,
      workerEnvironmentStartup: undefined,
      workerPlacementRuntime: undefined,
      workerPlacementControlAvailable: undefined,
      githubPublicationService: undefined,
      terminalSessions: undefined,
      agentRunSeq: new Map(),
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      chatRunState: createChatRunState(),
      addChatRun: vi.fn(),
      removeChatRun: vi.fn(),
      sessionEventSubscribers: {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        getAll: vi.fn(() => new Set<string>()),
      },
      subscribeSessionMessageEvents: vi.fn(),
      unsubscribeSessionMessageEvents: vi.fn(),
      sessionMessageSubscribers: { unsubscribeAll: vi.fn() },
      toolEventRecipients: { add: vi.fn() },
      dedupe: new Map(),
      wizardSessions: new Map(),
      systemAgentSessions: new Map(),
      findRunningWizard: vi.fn(() => null),
      purgeWizardSession: vi.fn(),
      getRuntimeSnapshot: vi.fn(() => ({}) as never),
      readinessEventLoopHealth: { snapshot: vi.fn(() => undefined) },
      startChannel: vi.fn(async () => new Map()),
      stopChannel: vi.fn(async () => undefined),
      markChannelLoggedOut: vi.fn(),
      wizardRunner: vi.fn(async () => undefined),
      channelWizardRunner: vi.fn(async () => undefined),
      broadcastVoiceWakeChanged: vi.fn(),
      broadcastVoiceWakeRoutingChanged: vi.fn(),
      kernel: {
        notifyPluginMetadataChanged: vi.fn(),
        getConfigReloaderHotReloadStatus: vi.fn(() => undefined),
      },
      unavailableGatewayMethods: new Set(),
      ...overrides,
    },
    chatMetadataLifecycle: {
      read: vi.fn(async () => ({ swarmEnabled: false })),
      readStartup: undefined,
    },
    logHealth: { error: vi.fn() },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
    configRevisionProjector: {
      projectRawHash: (hash) => hash,
      projectResolvedHash: (hash) => hash,
    },
  };
}
