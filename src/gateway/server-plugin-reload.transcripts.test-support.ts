import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createHookRunner } from "../plugins/hooks.js";
import type { createPluginRegistryOwner } from "../plugins/runtime.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  TranscriptOccupancyWatchRequest,
  TranscriptSourceProvider,
  TranscriptStartRequest,
} from "../transcripts/provider-types.js";
import type { reloadGatewayPlugins } from "./server-plugin-reload.js";
import type { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";
import { startGatewayPostAttachRuntime } from "./server-startup-post-attach.js";

export async function startTranscriptReloadFixtureSidecars(
  fixture: {
    runtime: Parameters<typeof reloadGatewayPlugins>[0]["runtime"];
    getConfig: () => OpenClawConfig;
    registryOwner: ReturnType<typeof createPluginRegistryOwner>;
    owner: ReturnType<typeof createGatewayPluginRuntimeGeneration>;
  },
  workspaceDir: string,
  log: Parameters<typeof startGatewayPostAttachRuntime>[0]["logHooks"],
  cleanups: Array<() => Promise<void>>,
  waitForPostReadyWork?: () => Promise<void>,
) {
  const { runtime } = fixture;
  const startupWork = new AsyncWorkScope();
  const sidecars = runtime.runtimeState.gatewayLifetimeSidecars;
  cleanups.push(async () => {
    startupWork.beginClose();
    await sidecars.stop().catch(() => {});
    await startupWork.drain();
  });
  const config = fixture.getConfig();
  const unusedRecovery = async (): Promise<never> => {
    throw new Error("unexpected main-session recovery");
  };
  const startup = await startGatewayPostAttachRuntime(
    {
      minimalTestGateway: false,
      cfgAtStart: config,
      getConfig: fixture.getConfig,
      bindHost: "127.0.0.1",
      bindHosts: ["127.0.0.1"],
      port: 0,
      tlsEnabled: false,
      log,
      isNixMode: false,
      broadcastToConnIds: vi.fn(),
      getClientConnIds: () => new Set(),
      controlUiBasePath: "/",
      gatewayPluginConfigAtStart: config,
      activationSourceConfig: config,
      pluginManifestRecords: [],
      pluginRegistry: fixture.registryOwner.registry,
      defaultWorkspaceDir: workspaceDir,
      deps: {},
      startChannels: async () => {},
      recoveryRuntime: {
        dispatchAgent: unusedRecovery,
        waitForAgent: unusedRecovery,
        sendRecoveryNotice: unusedRecovery,
      },
      resolveGatewayContext: () => undefined,
      logHooks: log,
      logChannels: log,
      unlockStartupMethods: () => {},
      waitForPostReadyWork,
      pluginRuntimeClaim: fixture.owner.currentClaim(),
      getCurrentPluginRegistry: () => fixture.registryOwner.registry,
      getCurrentPluginServices: () => fixture.owner.currentServices() ?? null,
      onPostReadySidecars: runtime.runtimeState.postReadySidecars.publish,
      onGatewayLifetimeSidecars: sidecars.publish,
      unregisterConnectionDependentSidecar: vi.fn(),
      trackStartupWork: (run) => {
        const operation = Promise.resolve().then(() => run(startupWork.signal));
        return startupWork.track(() => operation);
      },
    },
    {
      createHookRunner,
      logGatewayStartup: () => {},
      refreshLatestUpdateRestartSentinel: async () => null,
      createGatewayUpdateCheck: () => ({
        initialize: async () => ({
          root: null,
          status: { root: null, installKind: "unknown", packageManager: "unknown" },
          installReceipt: null,
        }),
        start: () => {},
        stop: async () => {},
      }),
      startGatewaySidecars: async () => 0,
      warmSystemCa: async () => {},
      loadSubagentRegistryActivation: () => () => {},
    },
  );
  cleanups.push(async () => {
    await startup.stopGatewayUpdateCheck();
  });
  return sidecars;
}

export function registerTranscriptFixture(api: OpenClawPluginApi, owner: "first" | "sibling") {
  const watches: TranscriptOccupancyWatchRequest[] = [];
  const captures: TranscriptStartRequest[] = [];
  let nextCapture = createDeferredCore();
  const unwatch = vi.fn();
  const stop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async ({ sessionId }) => ({
    ok: true,
    sessionId,
  }));
  api.registerTranscriptSourceProvider({
    id: `${owner}-capture`,
    aliases: [`${owner}-room`, ...(owner === "first" ? ["sibling-capture"] : [])],
    name: owner,
    sourceKinds: ["live-audio"],
    watchOccupancy: async (request) => {
      watches.push(request);
      request.onOccupied();
      return { ok: true, value: { stop: unwatch } };
    },
    start: async (request) => {
      captures.push(request);
      nextCapture.resolve();
      nextCapture = createDeferredCore();
      return { ok: true, session: request.session };
    },
    stop,
  });
  return {
    watches,
    captures,
    unwatch,
    stop,
    async waitForCapture(count: number, signal: AbortSignal) {
      while (captures.length < count) {
        await racePromiseWithAbortSignal(nextCapture.promise, signal);
      }
    },
  };
}
