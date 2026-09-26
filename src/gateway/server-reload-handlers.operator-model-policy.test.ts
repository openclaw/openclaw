import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { bindOperatorModelExecution } from "../agents/admitted-run-context.js";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
  prepareRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import * as activeRunProjections from "../agents/embedded-agent-runner/active-run-projections.js";
import * as preparedModelRuntime from "../agents/prepared-model-runtime.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resetGatewayRestartStateForInProcessRestart,
  setGatewayRestartPolicy,
} from "../infra/restart.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createEmptyRuntimeWebToolsMetadata } from "../secrets/runtime-fast-path.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGatewayAuthPolicyGeneration } from "./auth-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createChannelManager } from "./server-channels.js";
import { createContext as createGatewayTestContext } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  createDefaultGatewayReloadState,
  createDirectConfigWriteFixture,
  createConfigWriteNotification,
  publishConfigWrite,
} from "./server-reload-handlers.config.test-support.js";
import { startManagedGatewayConfigReloader } from "./server-reload-managed.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import { createTestRuntimeSecretsActivator } from "./server-startup-config.test-support.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { disconnectDisallowedGatewayPolicyClients } from "./server/ws-origin-policy.js";

let registrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;
const registry = createEmptyPluginRegistry();
beforeEach(() => {
  registrySnapshot = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry(registry);
  resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  restoreActivePluginRegistrySnapshot(registrySnapshot);
  resetGatewayRestartStateForInProcessRestart();
  setGatewayRestartPolicy({ allowExternal: false });
  resetGatewayWorkAdmission();
});

function makePreparedSecretsSnapshot(config: OpenClawConfig) {
  return {
    sourceConfig: config,
    config,
    authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
    authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
    warnings: [],
    webTools: createEmptyRuntimeWebToolsMetadata(),
    authStores: prepareRuntimeAuthProfileStoreSnapshots([]),
  };
}

it("commits model-only role changes without retiring permitted models or original source work", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const profile = ensureProfileForEmail("reload-model-reader@example.test");
    const roleName = "reader.modelPolicy.allow";
    const initialConfig: OpenClawConfig = {
      agents: {
        entries: { main: {} },
        defaults: { model: { primary: "fixture/a", fallbacks: ["fixture/b"] } },
      },
      gateway: {
        roles: {
          default: roleName,
          definitions: {
            [roleName]: {
              agents: "*",
              scopes: ["operator.write"],
              sessions: { others: "none" },
              modelPolicy: {},
            },
          },
        },
      },
    };
    const candidate = structuredClone(initialConfig);
    candidate.gateway!.roles!.definitions[roleName]!.modelPolicy = { deny: ["fixture/a"] };
    setRuntimeConfigSnapshot(initialConfig);
    const fixture = createDirectConfigWriteFixture(initialConfig);
    const context = createGatewayTestContext();
    const connection = new AbortController();
    const close = vi.fn(() => connection.abort());
    const client = {
      ...createOperatorWsClient({ socket: { close }, scopes: ["operator.write"] }),
      authenticatedUserProfile: {
        profileId: profile.id,
        displayName: null,
        hasAvatar: false,
        avatarRevision: "1",
        updatedAt: 1,
      },
      authPolicyGeneration: resolveGatewayAuthPolicyGeneration(initialConfig),
      connectionSignal: connection.signal,
    };
    const entered = createDeferred();
    const releasePreparation = createDeferred();
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    let rejectCandidate = true;
    const advance = vi.spyOn(preparedModelRuntime, "advancePreparedModelRuntimeConfig");
    const invalidate = vi.spyOn(preparedModelRuntime, "markPreparedModelRuntimeSnapshotsStale");
    const rebuild = vi.spyOn(preparedModelRuntime, "refreshPreparedModelRuntimeSnapshots");
    let state = createDefaultGatewayReloadState();
    const channelManager = createChannelManager({
      getRuntimeConfig: () => initialConfig,
      getPluginRegistry: () => registry,
      channelLogs: {},
      channelRuntimeEnvs: {},
    });
    const log = createInfoWarnErrorLogger();
    const reloader = startManagedGatewayConfigReloader({
      scheduler: createTestGatewayScheduler(vi.isFakeTimers() ? "fake-timers" : undefined),
      getPluginRegistry: () => registry,
      configRevisionProjector: {
        projectRawHash: (hash) => hash,
        projectResolvedHash: (hash) => hash,
      },
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialSnapshotRawHash: null,
      initialAuthoredConfig: {},
      initialSnapshotValid: true,
      initialSnapshotIssues: [],
      initialPluginInstallRecords: {},
      watchPath: "/tmp/openclaw.json",
      promoteSnapshot: async () => true,
      deps: {},
      broadcast: vi.fn(),
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      channelManager,
      startChannel: channelManager.startChannel,
      stopChannel: channelManager.stopChannel,
      reloadPlugins: async () => {
        throw new Error("Unexpected plugin reload for model policy");
      },
      logHooks: log,
      logChannels: log,
      logCron: log,
      logReload: log,
      cronReconciliation: {
        arm: () => ({ complete: async () => {} }),
        invalidate: vi.fn(),
      },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
        current: undefined,
        required: null,
      }),
      clients: [client],
      prepareTerminalConfig: vi.fn(),
      reconcileRuntimePolicy: (config) =>
        disconnectDisallowedGatewayPolicyClients([client], config),
      commitRuntimePolicy: vi.fn(),
      acceptTerminalConfig: vi.fn(),
      readSnapshot: fixture.readSnapshot,
      subscribeToWrites: fixture.subscribeToWrites,
      resolveGatewayContext: () => context,
      activateRuntimeSecrets: createTestRuntimeSecretsActivator(async ({ config }) => {
        entered.resolve();
        await releasePreparation.promise;
        if (rejectCandidate) {
          throw new Error("candidate preparation rejected");
        }
        return makePreparedSecretsSnapshot(config);
      }),
      requestRecoveryRestart,
    });
    let original: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
    let modelA: ReturnType<typeof bindOperatorModelExecution>;
    let modelB: ReturnType<typeof bindOperatorModelExecution>;
    try {
      await reloader.ready;
      context.getRuntimeConfig = () => candidate;
      const getCommittedRuntimeConfig = reloader.getCommittedRuntimeConfig;
      assert(getCommittedRuntimeConfig);
      context.getCommittedRuntimeConfig = getCommittedRuntimeConfig;
      const dispatch = createDispatchTestHarness({
        buildRequestContext: () => context,
        extraHandlers: {
          // A classified write route exercises ordinary operator admission before capture.
          wake: async (options) => {
            original = await captureGatewayOperatorRunAuthority({
              client: options.client,
              context,
              hasCurrentClientAuthority: options.hasCurrentClientAuthority,
            });
            options.respond(true, { accepted: true });
          },
        },
      });
      await dispatch.dispatcher.dispatch(
        { type: "req", id: "model-policy", method: "wake", params: {} },
        client,
      );
      expect(dispatch.send).toHaveBeenCalledWith(
        expect.objectContaining({ id: "model-policy", ok: true, payload: { accepted: true } }),
      );
      assert(original);
      modelA = bindOperatorModelExecution(original.authority, {
        provider: "fixture",
        model: "a",
      });
      modelB = bindOperatorModelExecution(original.authority, {
        provider: "fixture",
        model: "b",
      });
      assert(modelA && modelB);
      vi.spyOn(activeRunProjections, "getActiveEmbeddedRunCount").mockReturnValue(2);
      const listener = fixture.ref.current;
      assert(listener);
      const write = (revision: number) =>
        publishConfigWrite(
          listener,
          createConfigWriteNotification(
            candidate,
            `roles-${revision}`,
            revision,
            `runtime-${revision}`,
            `source-${revision}`,
          ),
        );
      const rejected = write(1);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.race([
        entered.promise,
        rejected.then(() => {
          throw new Error("candidate settled before preparation");
        }),
      ]);
      expect(getCommittedRuntimeConfig()).toBe(initialConfig);
      expect(modelA.signal.aborted).toBe(false);
      expect(modelB.signal.aborted).toBe(false);
      expect(original.authority.assertCurrent).not.toThrow();
      expect(close).not.toHaveBeenCalled();
      releasePreparation.resolve();
      await expect(rejected).resolves.toBe("failed");
      expect(getCommittedRuntimeConfig()).toBe(initialConfig);
      expect(modelA.signal.aborted).toBe(false);
      expect(modelB.signal.aborted).toBe(false);
      expect(close).not.toHaveBeenCalled();

      rejectCandidate = false;
      const accepted = write(2);
      await vi.advanceTimersByTimeAsync(0);
      await expect(accepted).resolves.toBe("applied");
      expect(getCommittedRuntimeConfig()).toEqual(candidate);
      expect(modelA.signal.aborted).toBe(true);
      expect(modelB.signal.aborted).toBe(false);
      expect(modelA.assertCurrent).toThrow("operator role cannot use this model");
      expect(modelB.assertCurrent).not.toThrow();
      expect(original.authority.signal?.aborted).toBe(false);
      expect(original.authority.assertCurrent).not.toThrow();
      expect(close).not.toHaveBeenCalled();
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(rebuild).not.toHaveBeenCalled();
      expect(advance).toHaveBeenCalledOnce();
    } finally {
      releasePreparation.resolve();
      try {
        await reloader.stop();
      } finally {
        modelA?.release();
        modelB?.release();
        original?.release();
        vi.useRealTimers();
      }
    }
  });
});
