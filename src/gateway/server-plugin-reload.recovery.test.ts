import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranscriptsTool } from "../agents/tools/transcripts-tool.js";
import { clearRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CronService } from "../cron/service.js";
import type { PluginHookGatewayContext } from "../plugins/hook-types.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { clearActivePluginRegistry, resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import type { OpenClawPluginApi, OpenClawPluginServiceContext } from "../plugins/types.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { withEnvAsync } from "../test-utils/env.js";
import { activeSessions } from "../transcripts/capture.js";
import type { TranscriptStartRequest } from "../transcripts/provider-types.js";
import { TranscriptsStore } from "../transcripts/store.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import { createChannelManager } from "./server-channels.js";
import { startGatewayDiscovery } from "./server-discovery-runtime.js";
import {
  verifyIndependentPostCommitActivation,
  verifyLifecycleHookSettlement,
  verifyIndependentRollbackRestoration,
  verifyPreparedSidecarRecovery,
  verifyServiceCleanupRecovery,
} from "./server-plugin-reload.activation.test-support.js";
import { verifyActiveCallDrainLease } from "./server-plugin-reload.active-call.test-support.js";
import {
  verifyGatewayCacheOwnership,
  verifySharedGatewayCacheOwnership,
} from "./server-plugin-reload.cache.test-support.js";
import {
  verifyManagedCandidateRetirement,
  verifyExpandedReplacementTargets,
  verifyCommittedRetirementOwnership,
  verifyPendingServiceCleanupRetry,
  verifyGatewayCleanupRetry,
  verifyPendingServiceCleanupRollback,
  verifyFailedRecoveryServiceOwnership,
  verifyCandidateCleanupRecovery,
} from "./server-plugin-reload.managed-candidate.test-support.js";
import { verifyGatewayMemoryReplacement } from "./server-plugin-reload.memory.test-support.js";
import {
  createRecoveryChannelManager,
  createPluginReloadRecoveryFixture,
  verifyChannelReplacementContracts,
  verifyColdAccountReplacement,
  verifyChannelCleanupFailureFence,
  verifyMalformedReloadFailureReceipt,
} from "./server-plugin-reload.recovery.test-support.js";
import {
  verifyOneWayDrainRecovery,
  verifyReversibleFenceRecovery,
} from "./server-plugin-reload.suspension.test-support.js";
import {
  registerTranscriptFixture,
  startTranscriptReloadFixtureSidecars,
} from "./server-plugin-reload.transcripts.test-support.js";

const mocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  loadPluginLookUpTable: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
}));
vi.mock("../plugins/plugin-lookup-table.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-lookup-table.js")>()),
  loadPluginLookUpTable: mocks.loadPluginLookUpTable,
}));

// These independent startup tasks do not participate in plugin replacement.
vi.mock("./server-startup-context-cache-prewarm.js", () => ({
  scheduleContextCachePrewarm: () => ({ stop() {} }),
}));
vi.mock("./server-startup-handler-prewarm.js", () => ({
  scheduleGatewayHandlerPrewarm: () => ({ stop() {} }),
}));
vi.mock("../agents/main-session-recovery/main-session-restart-recovery.js", () => ({
  scheduleRestartAbortedMainSessionRecovery: () => undefined,
}));

const cleanups: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadPluginMetadataSnapshot.mockReset();
  mocks.loadPluginLookUpTable.mockReset();
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
  mocks.loadPluginMetadataSnapshot.mockImplementation(() =>
    Object.assign(
      createPluginMetadataSnapshotFixture({ plugins: [{ id: "first" }, { id: "sibling" }] }),
      { discovery: { candidates: [], diagnostics: [] } },
    ),
  );
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
    await clearActivePluginRegistry();
  } finally {
    activeSessions.clear();
    closeOpenClawStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    resetGatewayWorkAdmission();
    clearPluginMetadataLifecycleCaches();
    cleanupTrackedTempDirs(tempDirs);
  }
});

function createRecoveryFixture(
  options: Parameters<typeof createPluginReloadRecoveryFixture>[1] = {},
) {
  return createPluginReloadRecoveryFixture({ cleanups, logMocks: mocks.log }, options);
}

it.each(["commit", "rollback"] as const)(
  "keeps service and lifecycle Cron getters current after %s",
  async (outcome) => {
    let serviceGetter: OpenClawPluginServiceContext["getCron"];
    let hookGetter: PluginHookGatewayContext["getCron"];
    const schedulers = ["first", "next"].map((name) => {
      const cron = new CronService({
        storePath: path.join(makeTrackedTempDir(`reload-cron-${name}`, tempDirs), "jobs.sqlite"),
        cronEnabled: false,
        log: mocks.log,
        enqueueSystemEvent: () => {},
        requestHeartbeat: () => {},
        runIsolatedAgentJob: async () => ({ status: "ok" as const }),
      });
      const list = vi.spyOn(cron, "list").mockResolvedValue([]);
      cleanups.push(async () => cron.stop());
      return { cron, list };
    });
    const [first, next] = schedulers;
    assert(first && next);
    const fixture = await createRecoveryFixture({
      abortOnCandidateStart: false,
      beforePublish: async () => {
        if (outcome === "rollback") {
          throw new Error("Cron getter rollback");
        }
      },
      register(api, owner) {
        if (owner !== "first") {
          return;
        }
        api.registerService({
          id: "cron-getter",
          start(ctx) {
            serviceGetter = ctx.getCron;
          },
        });
        api.on("gateway_start", (_event, ctx) => {
          hookGetter = ctx.getCron;
        });
      },
    });
    fixture.runtime.runtimeState.cronState.cron = first.cron;
    if (outcome === "rollback") {
      await expect(fixture.reload()).rejects.toThrow("Cron getter rollback");
    } else {
      await fixture.reload();
    }
    assert(serviceGetter && hookGetter);
    expect(hookGetter()).toBe(first.cron);
    const stale = serviceGetter();
    assert(stale);
    await stale.list();
    expect(first.list).toHaveBeenCalledOnce();

    fixture.runtime.runtimeState.cronState.cron = next.cron;
    expect(hookGetter()).toBe(next.cron);
    const current = serviceGetter();
    assert(current);
    await current.list();
    expect(next.list).toHaveBeenCalledOnce();
    const remove = vi.spyOn(first.cron, "remove");
    await expect(stale.remove("must-not-mutate")).rejects.toThrow("scheduler was replaced");
    expect(remove).not.toHaveBeenCalled();
  },
);

it("validates expanded replacement targets before draining their live owners", async () => {
  await verifyExpandedReplacementTargets(createRecoveryFixture);
});

it.each([
  "channel",
  "channel-retry",
  "hook",
  "publication",
  "notification",
  "memory",
  "sidecar",
  "hook-and-channel",
] as const)("finishes independent post-commit activation after a %s failure", (boundary) =>
  verifyIndependentPostCommitActivation(createRecoveryFixture, boundary),
);

it.each(["start", "stop"] as const)(
  "joins lifecycle %s hook completion before dependent work",
  (phase) => verifyLifecycleHookSettlement(createRecoveryFixture, phase),
);

it.each(["services", "channel"] as const)(
  "finishes independent rollback restoration after a %s failure",
  (boundary) => verifyIndependentRollbackRestoration(createRecoveryFixture, boundary),
);

it("disables and re-enables a plugin after its service cleanup fails", () =>
  verifyServiceCleanupRecovery(createRecoveryFixture));

it("preserves pending old service cleanup when candidate startup fails", () =>
  verifyPendingServiceCleanupRollback(createRecoveryFixture));

it("keeps a live Gateway's generated setup callbacks through another Gateway's reload", () =>
  verifyGatewayCacheOwnership(
    createRecoveryFixture,
    makeTrackedTempDir("gateway-setup-cache-owner", tempDirs),
    (load) => mocks.loadPluginMetadataSnapshot.mockImplementation(load),
  ));

it.each(["lookup", "replacement"] as const)(
  "keeps a shared boot setup owner through sibling %s",
  (mode) =>
    verifySharedGatewayCacheOwnership(
      createRecoveryFixture,
      makeTrackedTempDir("gateway-shared-setup-owner", tempDirs),
      (load) => mocks.loadPluginMetadataSnapshot.mockImplementation(load),
      mode,
    ),
);

it("reports call drain timeout, releases the lease, and rejects new calls to the retired instance", () =>
  verifyActiveCallDrainLease(
    createRecoveryFixture,
    makeTrackedTempDir("gateway-active-call-drain", tempDirs),
  ));

it("keeps prior retirement owned after a committed failure with shared metadata", () =>
  verifyCommittedRetirementOwnership(createRecoveryFixture));

it.each(["live", "aborted-predecessor"] as const)(
  "resumes earlier sidecars when later replacement preparation fails (%s channel)",
  (mode) => verifyPreparedSidecarRecovery(createRecoveryFixture, mode),
);

it.each(["prepare", "committed"] as const)(
  "preserves the operation receipt when a %s failure has an unreadable message",
  (boundary) => verifyMalformedReloadFailureReceipt(createRecoveryFixture, boundary),
);

it.each(["held-close", "failed-close"] as const)(
  "drains retained memory before Gateway provider replacement (%s)",
  (mode) => verifyGatewayMemoryReplacement(createRecoveryFixture, mode),
);

it.each(["retry", "shutdown"] as const)(
  "reports failed candidate startup and retires its dispatch before %s",
  (action) => verifyManagedCandidateRetirement(createRecoveryFixture, action),
);

it("replaces channel command provenance while keeping webhook ingress retryable", () =>
  verifyChannelReplacementContracts(createRecoveryFixture));

it("keeps cold accounts isolated while replacing their plugin and healthy accounts", () =>
  verifyColdAccountReplacement(createRecoveryFixture));

it.each(["rejection", "timeout"] as const)(
  "replaces channels after cleanup %s while retaining predecessor fences and warnings",
  (failure) => verifyChannelCleanupFailureFence(createRecoveryFixture, failure),
);

it("does not reopen a sibling fenced before this replacement rolls back", async () => {
  const fixture = await createRecoveryFixture();
  const first = getPluginInstance(
    fixture.previousRegistry.plugins.find((record) => record.id === "first")!,
  );
  const sibling = getPluginInstance(
    fixture.previousRegistry.plugins.find((record) => record.id === "sibling")!,
  );
  assert(first && sibling);
  sibling.quiesce();
  await expect(fixture.reload()).rejects.toMatchObject({ details: { committed: false } });
  expect(() => sibling.run(() => "stale")).toThrow("reloaded or disabled");
  expect(first.run(() => "restored")).toBe("restored");
  expect(fixture.siblingStart).toHaveBeenCalledOnce();
  expect(fixture.siblingStop).not.toHaveBeenCalled();
});

it.each(["OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_PROVIDERS"])(
  "preserves %s suppression when a candidate rolls back",
  async (flag) => {
    const channelId = "rollback-channel";
    const startAccount = vi.fn(async () => {});
    const fixture = await createRecoveryFixture({
      env: { [flag]: "1" },
      register: (api, owner) => {
        if (owner === "first") {
          api.registerChannel({
            plugin: {
              ...createChannelTestPluginBase({ id: channelId }),
              gateway: { startAccount },
            },
          });
        }
      },
    });
    const manager = createRecoveryChannelManager(fixture);
    fixture.runtime.channelManager = manager;
    cleanups.push(() => manager.stopChannel(channelId));
    await expect(fixture.reload()).rejects.toMatchObject({ details: { committed: false } });
    expect(startAccount).not.toHaveBeenCalled();
    expect(fixture.firstStart).toHaveBeenCalledTimes(2);
  },
);

it.each([false, true])(
  "reports timed-out gateway cleanup while replacement and later reload succeed (channels: %s)",
  (withChannels) => verifyGatewayCleanupRetry(createRecoveryFixture, withChannels),
);

it("publishes past pending service cleanup and keeps retired dispatch fenced across retry", () =>
  verifyPendingServiceCleanupRetry(createRecoveryFixture));

it("retains unrelated discovery after the selected service refuses cleanup", async () => {
  await withEnvAsync(
    { NODE_ENV: "development", VITEST: undefined, OPENCLAW_DISABLE_BONJOUR: undefined },
    async () => {
      const stops = { first: vi.fn(), sibling: vi.fn() };
      const starts = { first: vi.fn(), sibling: vi.fn() };
      const fixture = await createRecoveryFixture({
        initialStop: async () => {
          throw new Error("cleanup refused");
        },
        register: (api, owner) => {
          api.registerGatewayDiscoveryService({
            id: owner,
            advertise: async () => {
              starts[owner]();
              return { stop: stops[owner] };
            },
          });
        },
      });
      const discovery = await startGatewayDiscovery({
        gatewayDiscoveryServices: fixture.previousRegistry.gatewayDiscoveryServices,
        pluginRuntimeClaim: fixture.owner.currentClaim(),
        machineDisplayName: "fixture-gateway",
        port: 0,
        tailscaleMode: "off",
        logDiscovery: mocks.log,
      });
      fixture.runtime.runtimeState.discovery = discovery;
      cleanups.push(() => discovery.stop());
      try {
        await expect(fixture.reload()).rejects.toMatchObject({ details: { committed: false } });
        expect(stops.first).toHaveBeenCalledOnce();
        expect(stops.sibling).not.toHaveBeenCalled();
        expect(starts.sibling).toHaveBeenCalledOnce();
        expect(fixture.siblingStop).not.toHaveBeenCalled();
      } finally {
        await discovery.stop();
      }
      expect(stops.sibling).toHaveBeenCalledOnce();
    },
  );
});

it.each(["commit", "rollback"])(
  "restarts pending channel preparation after command changes: %s",
  async (outcome) => {
    const preparing = createDeferredCore();
    const release = createDeferredCore();
    const starts: string[] = [];
    const channelId = "reload-probe";
    const fixture = await createRecoveryFixture({
      abortOnCandidateStart: false,
      beforePublish: async () => {
        release.resolve();
        await original;
        if (outcome === "rollback") {
          throw new Error("rollback probe");
        }
      },
      register: (api, owner) => {
        if (owner === "first") {
          api.registerCommand({
            name: "reload-probe",
            description: "Probe",
            handler: () => ({ text: "ok" }),
          });
        } else {
          api.registerChannel({
            plugin: {
              ...createChannelTestPluginBase({
                id: channelId,
                config: { listAccountIds: () => ["default", "parked"] },
              }),
              gateway: {
                startAccount: async ({ accountId, abortSignal }) => {
                  starts.push(accountId);
                  await new Promise<void>((resolve) => {
                    abortSignal.addEventListener("abort", () => resolve(), { once: true });
                  });
                },
              },
            },
          });
        }
      },
    });
    let held = false;
    const manager = createChannelManager({
      getRuntimeConfig: fixture.getConfig,
      channelLogs: {},
      channelRuntimeEnvs: {},
      getPluginRegistry: () => fixture.registryOwner.registry,
      startupTrace: {
        measure: async (name, run) => {
          const result = await run();
          if (!held && name === `channels.${channelId}.list-accounts`) {
            held = true;
            preparing.resolve();
            await release.promise;
          }
          return result;
        },
      },
    });
    fixture.runtime.channelManager = manager;
    cleanups.push(() => manager.stopChannel(channelId));
    await manager.stopChannel(channelId, "parked");
    const original = manager.startChannel(channelId).catch((error: unknown) => error);
    try {
      await preparing.promise;
      if (outcome === "rollback") {
        await expect(fixture.reload()).rejects.toThrow("rollback probe");
      } else {
        await fixture.reload();
      }
      expect(await original).toMatchObject({
        message: expect.stringContaining("plugins are reloading; retry"),
      });
      await vi.waitFor(() => expect(starts).toEqual(["default"]));
      expect(manager.isManuallyStopped(channelId, "parked")).toBe(true);
      expect(fixture.siblingStart).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await original;
    }
  },
);

it.each(["commit", "rollback", "after-commit error", "late startup"] as const)(
  "keeps discovery handles owned across plugin replacement: %s",
  async (outcome) => {
    await withEnvAsync(
      {
        NODE_ENV: "development",
        VITEST: undefined,
        OPENCLAW_DISABLE_BONJOUR: undefined,
        OPENCLAW_GATEWAY_DISCOVERY_ADVERTISE_TIMEOUT_MS: "10",
      },
      async () => {
        const releaseStartup = createDeferredCore();
        const registrations: OpenClawPluginApi[] = [];
        const handles: Array<{ api: OpenClawPluginApi; stops: number }> = [];
        const publicationFailure = new Error("publication rejected");
        const fixture = await createRecoveryFixture({
          abortOnCandidateStart: false,
          register: (api, owner) => {
            if (owner !== "first") {
              return;
            }
            registrations.push(api);
            api.registerGatewayDiscoveryService({
              id: "fixture-discovery",
              advertise: async () => {
                const handle = { api, stops: 0 };
                handles.push(handle);
                if (outcome === "late startup" && handles.length === 1) {
                  await releaseStartup.promise;
                }
                return {
                  stop: () => {
                    handle.stops += 1;
                  },
                };
              },
            });
          },
          // Settle the timed-out advertiser after quiescence, while service cleanup owns the drain.
          initialStop: async () => {
            releaseStartup.resolve();
          },
          beforePublish: async () => {
            if (outcome === "rollback") {
              throw publicationFailure;
            }
          },
          afterPublish: async () => {
            if (outcome === "after-commit error") {
              throw publicationFailure;
            }
          },
        });
        cleanups.push(async () => {
          releaseStartup.resolve();
          await fixture.runtime.runtimeState.discovery?.stop();
        });
        const discovery = await startGatewayDiscovery({
          discovery: { mdns: { mode: "minimal" } },
          gatewayDiscoveryServices: fixture.previousRegistry.gatewayDiscoveryServices,
          pluginRuntimeClaim: fixture.owner.currentClaim(),
          machineDisplayName: "fixture-gateway",
          port: 0,
          tailscaleMode: "off",
          logDiscovery: mocks.log,
        });
        fixture.runtime.runtimeState.discovery = discovery;
        try {
          expect(handles).toHaveLength(1);
          if (outcome === "rollback" || outcome === "after-commit error") {
            await expect(fixture.reload()).rejects.toMatchObject({
              details: { committed: outcome === "after-commit error" },
              cause: publicationFailure,
            });
          } else {
            await fixture.reload();
          }
          expect(
            handles.filter((handle) => handle.stops === 0).map((handle) => handle.api),
          ).toEqual([registrations[outcome === "rollback" ? 0 : 1]]);
          expect(fixture.siblingStart).toHaveBeenCalledOnce();
          expect(fixture.siblingStop).not.toHaveBeenCalled();
        } finally {
          releaseStartup.resolve();
          await discovery.stop();
        }
        expect(handles.every((handle) => handle.stops === 1)).toBe(true);
      },
    );
  },
);

it.for([
  "commit",
  "rollback",
  "after-commit error",
  "stop refused",
  "deferred startup",
  "delayed stop",
  "manual stop",
] as const)(
  "keeps startup transcript capture owned across plugin replacement: %s",
  async (outcome, { signal }) => {
    const stateDir = makeTrackedTempDir("gateway-transcript-replacement-", tempDirs);
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const entry = (owner: string, channelId = "original-room") => ({
        providerId: owner === "sibling" ? "sibling-capture" : `${owner}-room`,
        guildId: "guild",
        channelId,
        whenOccupied: true,
      });
      const config: OpenClawConfig = {
        plugins: { allow: ["first", "sibling"] },
        transcripts: { autoStart: [entry("first"), entry("sibling")] },
      };
      const providers = {
        first: [] as ReturnType<typeof registerTranscriptFixture>[],
        sibling: [] as ReturnType<typeof registerTranscriptFixture>[],
      };
      const failure = new Error("fixture publication rejected");
      const reject = async () => {
        throw failure;
      };
      const fixture = await createRecoveryFixture({
        config,
        abortOnCandidateStart: false,
        register: (api, owner) => {
          providers[owner].push(registerTranscriptFixture(api, owner));
        },
        ...(outcome === "rollback" ? { beforePublish: reject } : {}),
        ...(outcome === "after-commit error" ? { afterPublish: reject } : {}),
      });
      const startupReady = outcome === "deferred startup" ? createDeferredCore() : undefined;
      const sidecars = await withPluginRuntimeRegistryScope(fixture.registryOwner.registry, () =>
        startTranscriptReloadFixtureSidecars(
          fixture,
          stateDir,
          mocks.log,
          cleanups,
          startupReady ? () => startupReady.promise : undefined,
        ),
      );
      const first = providers.first[0]!;
      const sibling = providers.sibling[0]!;
      const captured = async (
        provider: ReturnType<typeof registerTranscriptFixture>,
        count: number,
      ) => {
        // Gateway readiness precedes deferred capture startup and its session write.
        await provider.waitForCapture(count, signal);
        await vi.waitFor(() => {
          expect(provider.captures).toHaveLength(count);
          expect(activeSessions.get(provider.captures[count - 1]!.session.sessionId)?.phase).toBe(
            "active",
          );
        });
        return provider.captures[count - 1]!;
      };
      const acceptedConfig = {
        ...config,
        transcripts: { autoStart: [entry("first", "replacement-room"), entry("sibling")] },
      };
      const stopEntered = createDeferredCore();
      const stopRelease = createDeferredCore();
      let manualStop: Promise<unknown> | undefined;
      let pendingReload: Promise<unknown> | undefined;
      try {
        if (outcome === "deferred startup") {
          expect(first.watches).toHaveLength(0);
          expect(sibling.watches).toHaveLength(0);
          const receipt = await fixture.reload(acceptedConfig);
          expect(receipt).toMatchObject({ runtime: { pluginIds: ["first"] } });
          startupReady!.resolve();
          const current = providers.first[1]!;
          await captured(current, 1);
          await captured(sibling, 1);
          expect(first.watches).toHaveLength(0);
          expect(first.captures).toHaveLength(0);
          expect(current.watches[0]?.cfg).toEqual(acceptedConfig);
          expect(current.watches[0]?.source.channelId).toBe("replacement-room");
          expect(sibling.watches).toHaveLength(1);
          await sidecars.stop();
          expect(activeSessions.size).toBe(0);
          expect(sibling.unwatch).toHaveBeenCalledOnce();
          return;
        }
        const oldCapture = await captured(first, 1);
        const siblingCapture = await captured(sibling, 1);
        const oldOwner = activeSessions.get(oldCapture.session.sessionId);
        const siblingOwner = activeSessions.get(siblingCapture.session.sessionId);
        if (outcome === "stop refused") {
          first.stop.mockResolvedValue({ ok: false, error: "fixture capture still active" });
        }
        const boundedStop = outcome === "delayed stop" || outcome === "manual stop";
        let result: unknown;
        if (boundedStop) {
          vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
          first.stop.mockImplementation(async ({ sessionId }) => {
            stopEntered.resolve();
            await stopRelease.promise;
            return { ok: true, sessionId };
          });
          if (outcome === "manual stop") {
            const tool = createTranscriptsTool({
              config,
              stateDir,
              logger: mocks.log,
              caller: { kind: "operator", source: "local" },
            });
            manualStop = withPluginRuntimeRegistryScope(fixture.registryOwner.registry, () =>
              tool.execute("manual-stop-before-reload", {
                action: "stop",
                sessionId: oldCapture.session.sessionId,
              }),
            ).catch((error: unknown) => error);
            await Promise.race([
              stopEntered.promise,
              manualStop.then(() => expect(first.stop).toHaveBeenCalledOnce()),
            ]);
          }
          let reloadSettled = false;
          pendingReload = fixture
            .reload(acceptedConfig)
            .catch((error: unknown) => error)
            .then((value) => {
              reloadSettled = true;
              return value;
            });
          // An old owner may return before it attempts provider cleanup. Race that
          // result as well as provider entry so the pre-fix test cannot deadlock.
          await Promise.race([
            stopEntered.promise,
            pendingReload.then(() => expect(first.stop).toHaveBeenCalledOnce()),
          ]);
          await vi.advanceTimersByTimeAsync(5_000);
          vi.useRealTimers();
          if (outcome === "manual stop") {
            await vi.waitFor(() => expect(reloadSettled).toBe(true));
            expect(await pendingReload).toMatchObject({
              details: { phase: "drain", committed: false },
            });
          } else {
            // Acquired capture cleanup has no startup deadline; publication still waits for it.
            expect(reloadSettled).toBe(false);
          }
          expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
          expect(fixture.firstStop).not.toHaveBeenCalled();
          expect(first.stop).toHaveBeenCalledOnce();
          expect(activeSessions.get(oldCapture.session.sessionId)).toBe(oldOwner);
          expect(oldOwner?.stopping).toBe(true);
          expect(first.watches).toHaveLength(1);
          expect(providers.first[1]!.watches).toHaveLength(0);
          expect(activeSessions.get(siblingCapture.session.sessionId)).toBe(siblingOwner);
          stopRelease.resolve();
          if (manualStop) {
            expect(await manualStop).toMatchObject({
              details: { sessionId: oldCapture.session.sessionId },
            });
            // A competing manual stop must settle before a new reload can own capture cleanup.
            result = await fixture.reload(acceptedConfig);
          } else {
            result = await pendingReload;
          }
          expect(activeSessions.get(oldCapture.session.sessionId)).not.toBe(oldOwner);
        } else {
          result = await fixture.reload(acceptedConfig).catch((error: unknown) => error);
        }
        if (outcome === "stop refused") {
          expect(result).toMatchObject({ details: { phase: "drain", committed: false } });
          expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
          expect(fixture.firstStop).not.toHaveBeenCalled();
          expect(first.stop).toHaveBeenCalledOnce();
          expect(activeSessions.get(oldCapture.session.sessionId)).toBe(oldOwner);
          expect(oldOwner?.cleanupPending).toBe(true);
          expect(first.watches).toHaveLength(1);
          expect(first.captures).toHaveLength(1);
          expect(providers.first[1]!.watches).toHaveLength(0);
          expect(providers.first[1]!.captures).toHaveLength(0);
          expect(sibling.watches).toHaveLength(1);
          expect(sibling.unwatch).not.toHaveBeenCalled();
          expect(activeSessions.get(siblingCapture.session.sessionId)).toBe(siblingOwner);
          // A new operator request can publish only after this same provider
          // confirms that the previously refused capture cleanup completed.
          first.stop.mockImplementation(async ({ sessionId }) => ({ ok: true, sessionId }));
          result = await fixture.reload(acceptedConfig);
        }
        if (outcome === "commit" || outcome === "stop refused" || boundedStop) {
          expect(result).toMatchObject({ runtime: { pluginIds: ["first"] } });
        } else {
          expect(result).toMatchObject({
            details: { committed: outcome !== "rollback" },
            cause: failure,
          });
        }
        // The returned watcher handle belongs to a real PluginInstance; invoking
        // it after quiescence cannot reach this provider's stop implementation.
        expect(first.unwatch).toHaveBeenCalledOnce();
        expect(first.unwatch.mock.invocationCallOrder[0]).toBeLessThan(
          fixture.firstStop.mock.invocationCallOrder[0]!,
        );
        expect(first.stop).toHaveBeenCalledTimes(outcome === "stop refused" ? 2 : 1);
        const current = outcome === "rollback" ? first : providers.first.at(-1)!;
        const currentCapture = await captured(current, outcome === "rollback" ? 2 : 1);
        expect(current.watches.at(-1)?.source.channelId).toBe(
          outcome === "rollback" ? "original-room" : "replacement-room",
        );
        expect(current.watches.at(-1)?.cfg).toEqual(
          outcome === "rollback" ? config : acceptedConfig,
        );
        expect(sibling.watches).toHaveLength(1);
        expect(sibling.captures).toHaveLength(1);
        expect(sibling.unwatch).not.toHaveBeenCalled();
        expect(sibling.stop).not.toHaveBeenCalled();
        expect(activeSessions.get(siblingCapture.session.sessionId)).toBe(siblingOwner);
        const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        });
        const readUtteranceTexts = async (capture: TranscriptStartRequest) =>
          (await store.readUtterancesForSession(capture.session)).map(
            (utterance) => utterance.text,
          );
        await oldCapture.onUtterance({ text: "stale capture", final: true });
        await currentCapture.onUtterance({ text: "current capture", final: true });
        await siblingCapture.onUtterance({ text: "retained sibling", final: true });
        expect(await readUtteranceTexts(oldCapture)).not.toContain("stale capture");
        expect(await readUtteranceTexts(currentCapture)).toEqual(["current capture"]);
        expect(await readUtteranceTexts(siblingCapture)).toEqual(["retained sibling"]);
        if (outcome === "commit") {
          await fixture.reload({
            ...acceptedConfig,
            plugins: { ...config.plugins, entries: { first: { enabled: false } } },
          });
          expect(current.unwatch).toHaveBeenCalledOnce();
          expect(current.stop).toHaveBeenCalledOnce();
          expect(activeSessions.has(currentCapture.session.sessionId)).toBe(false);
          expect(providers.first).toHaveLength(2);
          expect(current.watches).toHaveLength(1);
          expect(sibling.watches).toHaveLength(1);
          await fixture.reload(acceptedConfig);
          const enabled = providers.first[2]!;
          await captured(enabled, 1);
          expect(enabled.watches[0]?.source.channelId).toBe("replacement-room");
          expect(sibling.watches).toHaveLength(1);
          expect(activeSessions.get(siblingCapture.session.sessionId)).toBe(siblingOwner);
        }
        await sidecars.stop();
        expect(activeSessions.size).toBe(0);
        expect(sibling.unwatch).toHaveBeenCalledOnce();
      } finally {
        stopRelease.resolve();
        startupReady?.resolve();
        vi.useRealTimers();
        await manualStop;
        await pendingReload;
        // Preserve the semantic failure on the old owner, whose stale handle can
        // reject shutdown; afterEach still closes registry and SQLite ownership.
        await sidecars.stop().catch(() => {});
      }
    });
  },
);

describe("Gateway plugin service recovery ownership", () => {
  it.each(["prepare", "drain", "publish", "committed"] as const)(
    "preserves the committed owner when its invoker closes during %s",
    async (boundary) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const failure = new Error("plugin invoker closed");
      let invokerOpen = true;
      const pause = async () => {
        entered.resolve();
        await release.promise;
      };
      const candidateStart = vi.fn();
      const fixture = await createRecoveryFixture({
        abortOnCandidateStart: false,
        candidateStart,
        ...(boundary === "prepare" ? { prepareAttached: pause } : {}),
        ...(boundary === "drain" ? { initialStop: pause } : {}),
        ...(boundary === "publish" ? { beforePublish: pause } : {}),
        ...(boundary === "committed" ? { afterPublish: pause } : {}),
        assertInvokerOwned: () => {
          if (!invokerOpen) {
            throw failure;
          }
        },
      });
      const pending = fixture.reload().catch((error: unknown) => error);
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("plugin reload completed before its pause");
          }),
        ]);
        invokerOpen = false;
        release.resolve();
        const result = await pending;
        if (boundary === "committed") {
          expect(result).toMatchObject({
            runtime: { operationId: "service-recovery", pluginIds: ["first"] },
          });
          expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
          const previousRecord = fixture.previousRegistry.plugins.find(
            (record) => record.id === "first",
          );
          assert.ok(previousRecord);
          expect(getPluginInstance(previousRecord)?.lifecycle.signal.aborted).toBe(true);
          expect(fixture.firstStart).toHaveBeenCalledOnce();
          expect(fixture.candidateStop).not.toHaveBeenCalled();
        } else {
          expect(result).toMatchObject({
            details: { phase: boundary === "publish" ? "activate" : boundary, committed: false },
            cause: failure,
          });
          expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
          expect(fixture.firstStart).toHaveBeenCalledTimes(boundary === "prepare" ? 1 : 2);
          expect(fixture.candidateStop).toHaveBeenCalledTimes(boundary === "publish" ? 1 : 0);
        }
        expect(candidateStart).toHaveBeenCalledTimes(
          boundary === "publish" || boundary === "committed" ? 1 : 0,
        );
        expect(fixture.siblingStart).toHaveBeenCalledOnce();
        expect(fixture.siblingStop).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it("keeps retained and failed-recovery services owned after recovery startup rejects", () =>
    verifyFailedRecoveryServiceOwnership(createRecoveryFixture));

  it("restores the previous service after candidate cleanup fails and permits another attempt", () =>
    verifyCandidateCleanupRecovery(createRecoveryFixture));

  it.each(["suspension", "restart signal"] as const)(
    "restores the previous plugin runtime after failed replacement during reversible %s",
    (fence) => verifyReversibleFenceRecovery(createRecoveryFixture, fence),
  );

  it("publishes retained services before awaited cleanup when admission closes and recovery is skipped", () =>
    verifyOneWayDrainRecovery(createRecoveryFixture));
});

it("starts the first configured transcript capture after plugin reload", async ({ signal }) => {
  const stateDir = makeTrackedTempDir("gateway-transcript-first-start-", tempDirs);
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const providers: ReturnType<typeof registerTranscriptFixture>[] = [];
    const fixture = await createRecoveryFixture({
      config: { plugins: { allow: ["first", "sibling"] } },
      abortOnCandidateStart: false,
      register: (api, owner) => {
        if (owner === "first") {
          api.registerReload({ hotPrefixes: ["transcripts"] });
        } else {
          providers.push(registerTranscriptFixture(api, owner));
        }
      },
    });
    const sidecars = await withPluginRuntimeRegistryScope(fixture.registryOwner.registry, () =>
      startTranscriptReloadFixtureSidecars(fixture, stateDir, mocks.log, cleanups),
    );
    try {
      const provider = providers[0]!;
      expect(provider.watches).toHaveLength(0);
      const config: OpenClawConfig = {
        ...fixture.getConfig(),
        transcripts: {
          autoStart: [
            {
              providerId: "sibling-capture",
              guildId: "guild",
              channelId: "room",
              whenOccupied: true,
            },
          ],
        },
      };
      await fixture.reload(config);
      await vi.waitFor(() => expect(provider.watches).toHaveLength(1));
      await provider.waitForCapture(1, signal);
      expect(provider.watches[0]?.cfg).toEqual(config);
      expect(fixture.siblingStart).toHaveBeenCalledOnce();
      expect(fixture.siblingStop).not.toHaveBeenCalled();
    } finally {
      await sidecars.stop();
    }
    expect(providers[0]!.unwatch).toHaveBeenCalledOnce();
    expect(providers[0]!.stop).toHaveBeenCalledOnce();
  });
});

it.for(["replace", "remove", "disable"] as const)(
  "drains changed transcript configuration on a retained plugin before publication: %s",
  async (change, { signal }) => {
    expect(buildGatewayReloadPlan(["transcripts.autoStart"]).restartGateway).toBe(true);
    const stateDir = makeTrackedTempDir("gateway-transcript-config-replacement-", tempDirs);
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const entry = (owner: string, channelId = "original-room") => ({
        providerId: `${owner}-capture`,
        guildId: "guild",
        channelId,
        whenOccupied: true,
      });
      const config: OpenClawConfig = {
        plugins: { allow: ["first", "sibling"] },
        transcripts: { autoStart: [entry("first"), entry("sibling")] },
      };
      const providers = {
        first: [] as ReturnType<typeof registerTranscriptFixture>[],
        sibling: [] as ReturnType<typeof registerTranscriptFixture>[],
      };
      const events: string[] = [];
      const fixture = await createRecoveryFixture({
        config,
        abortOnCandidateStart: false,
        register: (api, owner) => {
          providers[owner].push(registerTranscriptFixture(api, owner));
          if (owner === "first") {
            api.registerReload({ hotPrefixes: ["transcripts"] });
          }
        },
        beforePublish: async () => {
          events.push("publish");
        },
      });
      const nextConfig: OpenClawConfig = {
        ...config,
        transcripts:
          change === "disable"
            ? { enabled: false, autoStart: config.transcripts?.autoStart }
            : {
                autoStart: [
                  entry("first"),
                  ...(change === "replace" ? [entry("sibling", "replacement-room")] : []),
                ],
              },
      };
      expect(
        buildGatewayReloadPlan(["plugins.entries.first", "transcripts.autoStart"], {
          previousConfig: config,
          candidateConfig: nextConfig,
        }),
      ).toMatchObject({ restartGateway: false, reloadPlugins: true });
      const sidecars = await withPluginRuntimeRegistryScope(fixture.registryOwner.registry, () =>
        startTranscriptReloadFixtureSidecars(fixture, stateDir, mocks.log, cleanups),
      );
      const first = providers.first[0]!;
      const sibling = providers.sibling[0]!;
      sibling.unwatch.mockImplementation(() => {
        events.push("unwatch-sibling");
      });
      try {
        await Promise.all([first.waitForCapture(1, signal), sibling.waitForCapture(1, signal)]);
        await vi.waitFor(() =>
          expect(activeSessions.get(sibling.captures[0]!.session.sessionId)?.phase).toBe("active"),
        );
        const result = await fixture.reload(nextConfig);
        expect(result).toMatchObject({ runtime: { pluginIds: ["first"] } });
        expect(events).toEqual(["unwatch-sibling", "publish"]);
        expect(sibling.stop).toHaveBeenCalledOnce();
        expect(fixture.siblingStart).toHaveBeenCalledOnce();
        expect(fixture.siblingStop).not.toHaveBeenCalled();
        expect(providers.sibling).toHaveLength(1);
        if (change === "replace") {
          await sibling.waitForCapture(2, signal);
          expect(sibling.watches).toHaveLength(2);
          expect(sibling.watches[1]?.source.channelId).toBe("replacement-room");
          expect(sibling.watches[1]?.cfg).toEqual(nextConfig);
        } else {
          expect(sibling.watches).toHaveLength(1);
          expect(sibling.captures).toHaveLength(1);
        }
        expect(mocks.log.warn).not.toHaveBeenCalledWith(expect.stringContaining("already owns"));
      } finally {
        await sidecars.stop();
      }
    });
  },
);
