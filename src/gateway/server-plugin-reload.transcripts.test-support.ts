import assert from "node:assert/strict";
import { expect, vi } from "vitest";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { activeSessions } from "../transcripts/capture-startup.js";
import type {
  TranscriptOccupancyWatchRequest,
  TranscriptSourceProvider,
  TranscriptStartRequest,
} from "../transcripts/provider-types.js";
import type { RecoveryFixtureFactory } from "./server-plugin-reload.recovery.test-support.js";
import {
  installGatewayStartupModuleMocks,
  installGatewaySubagentModuleLoad,
} from "./server-startup-module-mocks.test-support.js";
import { startGatewayPostAttachRuntime } from "./server-startup-post-attach.js";

export async function startTranscriptReloadFixtureSidecars(
  fixture: Pick<
    Awaited<ReturnType<RecoveryFixtureFactory>>,
    "runtime" | "getConfig" | "registryOwner" | "owner"
  >,
  workspaceDir: string,
  log: Parameters<typeof startGatewayPostAttachRuntime>[0]["logHooks"],
  cleanups: Array<() => Promise<void>>,
  waitForPostReadyWork?: () => Promise<void>,
) {
  const { runtime, getConfig, registryOwner, owner } = fixture;
  const idle = async () => {};
  const startupWork = new AsyncWorkScope();
  const startupModuleRestorers: Array<() => void> = [];
  const sidecars = runtime.runtimeState.gatewayLifetimeSidecars;
  cleanups.push(async () => {
    try {
      startupWork.beginClose();
      await sidecars.stop().catch(() => {});
      await runtime.runtimeState.postReadySidecars.stop().catch(() => {});
      await startupWork.drain();
    } finally {
      startupModuleRestorers.toReversed().forEach((restore) => restore());
    }
  });
  await installGatewaySubagentModuleLoad(idle, idle, startupModuleRestorers);
  const config = getConfig();
  const unusedRecovery = async (): Promise<never> => {
    throw new Error("unexpected main-session recovery");
  };
  installGatewayStartupModuleMocks(
    {
      logGatewayStartup: () => {},
      refreshLatestUpdateRestartSentinel: async () => null,
      createGatewayUpdateCheck: () => ({
        initialize: async () => ({
          root: null,
          status: { root: null, installKind: "unknown", packageManager: "unknown" },
          installReceipt: null,
        }),
        start: () => {},
        stop: idle,
      }),
      warmSystemCa: idle,
    },
    startupModuleRestorers,
  );
  const startup = await startGatewayPostAttachRuntime({
    scheduler: runtime.scheduler,
    minimalTestGateway: false,
    cfgAtStart: config,
    getConfig,
    getReadiness: () => ({ ready: true, failing: [], uptimeMs: 0 }),
    port: 0,
    log,
    isNixMode: false,
    broadcastToConnIds: vi.fn(),
    getClientConnIds: () => new Set(),
    gatewayPluginConfigAtStart: config,
    activationSourceConfig: config,
    pluginManifestRecords: [],
    pluginRegistry: registryOwner.registry,
    defaultWorkspaceDir: workspaceDir,
    deps: {},
    startChannels: idle,
    mainSessionRecoveryStartupCheckedStorePaths: new Set<string>(),
    recoveryRuntime: {
      prepareRestartRecovery: unusedRecovery,
      dispatchSessionMethod: unusedRecovery,
      dispatchAgent: unusedRecovery,
      waitForAgent: unusedRecovery,
      sendRecoveryNotice: unusedRecovery,
      resumeChatInput: unusedRecovery,
    },
    resolveGatewayContext: () => undefined,
    logHooks: log,
    logChannels: log,
    unlockStartupMethods: () => {},
    waitForPostReadyWork,
    isClosing: () => startupWork.isClosing,
    getCurrentPluginRegistry: () => registryOwner.registry,
    shouldStartPluginServices: () =>
      owner.currentServices() === null && owner.getReloadStatus() === undefined,
    onPostReadySidecars: runtime.runtimeState.postReadySidecars.publish,
    onGatewayLifetimeSidecars: sidecars.publish,
    unregisterConnectionDependentSidecar: vi.fn(),
    trackStartupWork: (run) => {
      const operation = Promise.resolve().then(() => run(startupWork.signal));
      return startupWork.track(() => operation);
    },
  });
  cleanups.push(() => startup.stopGatewayUpdateCheck());
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
  const waitForCapture = async (count: number, signal: AbortSignal) => {
    while (captures.length < count) {
      await racePromiseWithAbortSignal(nextCapture.promise, signal);
    }
  };
  return {
    watches,
    captures,
    unwatch,
    stop,
    waitForCapture,
    getActiveCaptureForChannel(source: { guildId: string; channelId: string }) {
      // Concurrent startup can deliver captures in a different order than their config entries.
      const request = captures.find(
        ({ session }) =>
          session.source.guildId === source.guildId &&
          session.source.channelId === source.channelId,
      );
      assert(request);
      const capture = activeSessions.get(request.session.sessionId);
      assert(capture);
      expect(capture.phase).toBe("active");
      return capture;
    },
    async waitForActiveCapture(count: number, signal: AbortSignal) {
      // Gateway readiness precedes deferred capture startup and its session write.
      await waitForCapture(count, signal);
      await vi.waitFor(() => {
        expect(captures).toHaveLength(count);
        expect(activeSessions.get(captures[count - 1]!.session.sessionId)?.phase).toBe("active");
      });
      return captures[count - 1]!;
    },
  };
}

export function createTranscriptFixtures() {
  const providers = {
    first: [] as ReturnType<typeof registerTranscriptFixture>[],
    sibling: [] as ReturnType<typeof registerTranscriptFixture>[],
  };
  return {
    providers,
    register: (api: OpenClawPluginApi, owner: "first" | "sibling") => {
      providers[owner].push(registerTranscriptFixture(api, owner));
    },
  };
}
