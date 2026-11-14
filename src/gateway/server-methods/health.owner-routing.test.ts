import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { setPreparedModelRuntimeStartupStatus } from "../../agents/prepared-model-runtime.startup-status.js";
import { createGatewayHostLifecycle } from "../../cli/gateway-cli/host-lifecycle.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as childRuntime from "../../infra/child-runtime-viability.js";
import { beginLifecycleWriteCustody } from "../../infra/lifecycle-write-custody.js";
import { recordStartupMigrationWarnings } from "../../infra/state-migrations.messages.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { beginAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { HealthSummary } from "../health/types.js";
import type { GatewayHostLifecycle } from "../server-public.js";
import * as processVitals from "../server/process-vitals.js";
import { healthHandlers } from "./health.js";

afterEach(() => {
  setPreparedModelRuntimeStartupStatus(undefined);
  resetConfigRuntimeState();
  vi.restoreAllMocks();
});

async function callStatus(
  config: OpenClawConfig,
  scopes = ["operator.read"],
  options: { includeCliProjection?: boolean } = {},
  hostLifecycle?: GatewayHostLifecycle,
) {
  setRuntimeConfigSnapshot(config, config);
  const respond = vi.fn();
  await healthHandlers.status!({
    req: {} as never,
    params: { includeChannelSummary: false, ...options },
    respond: respond as never,
    context: {
      hostLifecycle,
      cron: { getSuspensionBlockerCount: () => 0 },
    } as never,
    client: { connect: { role: "operator", scopes } } as never,
    isWebchatConnect: () => false,
  });
  expect(respond).toHaveBeenCalledOnce();
  const [ok, result, error] = respond.mock.calls[0]!;
  expect([ok, error]).toEqual([true, undefined]);
  return result;
}

function statusConfig(stateDir: string, agents: OpenClawConfig["agents"]): OpenClawConfig {
  return {
    agents,
    session: { store: path.join(stateDir, "agents", "{agentId}", "sessions.json") },
  };
}

function healthSnapshot(stateDir: string, overrides: Partial<HealthSummary> = {}): HealthSummary {
  return {
    ok: true,
    ts: Date.now(),
    durationMs: 1,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 0,
    agents: [],
    sessions: { path: path.join(stateDir, "sessions.json"), count: 0, recent: [] },
    ...overrides,
  };
}

function createHealthReader(
  snapshot: HealthSummary,
  getEventLoopHealth?: () => HealthSummary["eventLoop"],
  getReadiness?: import("../server/readiness.js").ReadinessChecker,
) {
  const context = {
    getHealthCache: () => snapshot,
    refreshHealthSnapshot: vi.fn(async () => snapshot),
    getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
    getEventLoopHealth,
    getReadiness,
    logHealth: { error: vi.fn() },
  };
  return async (probe = false) => {
    const respond = vi.fn();
    await healthHandlers.health!({
      req: {} as never,
      params: { probe },
      respond: respond as never,
      context: context as never,
      client: { connect: { role: "operator", scopes: ["operator.read"] } } as never,
      isWebchatConnect: () => false,
    });
    return respond;
  };
}

describe("Gateway status owner routing", () => {
  it.each([false, true])("publishes live core readiness with probe=%s", async (probe) => {
    await withStateDirEnv("health-core-readiness-", async ({ stateDir }) => {
      let coreReady = false;
      const readHealth = createHealthReader(
        healthSnapshot(stateDir, { coreReady: true }),
        undefined,
        () => ({
          ready: coreReady,
          coreReady,
          failing: coreReady ? [] : ["core-startup"],
          uptimeMs: 1,
        }),
      );
      expect((await readHealth(probe)).mock.calls[0]?.[1]).toMatchObject({ coreReady: false });
      coreReady = true;
      expect((await readHealth(probe)).mock.calls[0]?.[1]).toMatchObject({ coreReady: true });
    });
  });

  it("omits an agent deleted while the final worker-pool read is pending", async () => {
    await withOpenClawTestState({ label: "status-worker-pool-publication" }, async (state) => {
      const config: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { deleting: {}, survivor: {} } },
      };
      for (const id of ["deleting", "survivor"]) {
        replaceSessionEntrySync(
          { agentId: id, sessionKey: `agent:${id}:main` },
          { sessionId: `${id}-session`, updatedAt: 1 },
        );
      }
      const entered = createDeferred();
      const release = createDeferred();
      const readPools = processVitals.readGatewayWorkerPoolFacts;
      vi.spyOn(processVitals, "readGatewayWorkerPoolFacts").mockImplementation(async () => {
        const result = await readPools();
        entered.resolve();
        await release.promise;
        return result;
      });
      const pending = callStatus(config, ["operator.admin"]);
      try {
        await awaitGateBeforeSettlement(entered.promise, pending, "Status bypassed worker pools");
        beginAgentDeletionJournal({
          agentId: "deleting",
          operationId: "worker-pool-publication",
          agentDir: state.agentDir("deleting"),
          sessionsDir: state.sessionsDir("deleting"),
          workspaceDir: state.workspaceDir,
          deleteFiles: true,
        });
        release.resolve();
        const response = await pending;
        expect(response.sessions).toMatchObject({
          count: 1,
          byAgent: [{ agentId: "survivor", count: 1 }],
        });
      } finally {
        release.resolve();
        await pending.catch(() => {});
      }
    });
  });

  it("reports only the current host's recorded shutdown budget and resident PID", async () => {
    await withStateDirEnv("openclaw-gateway-budget-status-", async ({ stateDir }) => {
      const config = {
        agents: { entries: { main: {} } },
        session: { store: path.join(stateDir, "sessions.json") },
      };
      let current = true;
      let recorded = { timeoutMs: 25_000, reserveMs: 10_000, nativeStopBudget: true };
      const host = createGatewayHostLifecycle({
        isCurrent: () => current,
        isServing: () => true,
        acceptStop: () => {},
        processOwner: { ownsProcessLifecycle: false, supervisor: "systemd" },
        getShutdownBudget: () => recorded,
      });
      const release = beginLifecycleWriteCustody("migration");
      try {
        for (const timeoutMs of [25_000, 325_000]) {
          recorded = { timeoutMs, reserveMs: 10_000, nativeStopBudget: true };
          const response = await callStatus(config, undefined, {}, host.capability);
          expect(response).toMatchObject({
            pid: process.pid,
            shutdownBudget: {
              ...recorded,
              writeCustody: [{ phase: "migration", count: 1 }],
              activeWork: { lifecycleWrites: 1 },
            },
          });
        }
        current = false;
        const replaced = await callStatus(config, undefined, {}, host.capability);
        expect(replaced.shutdownBudget).toBeUndefined();
        const absent = await callStatus(config);
        expect(absent.shutdownBudget).toBeUndefined();
      } finally {
        release();
        await host.retire();
      }
    });
  });

  it.each(["status", "cached health", "refreshed health"] as const)(
    "reports current model acquisition and recovery through %s",
    async (surface) => {
      await withStateDirEnv("openclaw-gateway-model-status-", async ({ stateDir }) => {
        const config = statusConfig(stateDir, { entries: { main: {}, second: {} } });
        const degraded = {
          degraded: true,
          pendingAgents: ["second"],
          stage: "workspace plugins; agent second",
        };
        const snapshot = healthSnapshot(stateDir, { modelRuntime: degraded });
        const readHealth = createHealthReader(snapshot);
        const read = async () => {
          if (surface === "status") {
            return await callStatus(config);
          }
          const respond = await readHealth(surface === "refreshed health");
          expect(respond.mock.calls[0]?.[0]).toBe(true);
          return respond.mock.calls[0]?.[1];
        };

        setPreparedModelRuntimeStartupStatus(degraded);
        expect(await read()).toMatchObject({ modelRuntime: degraded });

        const complete = { degraded: false, pendingAgents: [] };
        setPreparedModelRuntimeStartupStatus(complete);
        expect((await read()).modelRuntime).toEqual(complete);
      });
    },
  );

  it.each([false, true])(
    "keeps live diagnostics out of cached health (reset=%s)",
    async (reset) => {
      await withStateDirEnv("openclaw-gateway-health-diagnostics-", async ({ stateDir }) => {
        const initial = {
          degraded: false,
          degradedSinceMs: null,
          reasons: [],
          intervalMs: 1_000,
          delayP99Ms: 20,
          delayMaxMs: 25,
          utilization: 0.2,
          cpuCoreRatio: 0.1,
        } satisfies NonNullable<HealthSummary["eventLoop"]>;
        const cached = healthSnapshot(stateDir, { eventLoop: initial });
        const removed = {
          execPath: "/opt/homebrew/Cellar/node@24/24.20.0/bin/node",
          available: false,
        };
        vi.spyOn(childRuntime, "readChildRuntimeViability").mockReturnValue(removed);
        let current: HealthSummary["eventLoop"] = initial;
        const next = reset ? undefined : { ...initial, cpuCoreRatio: 1.2 };
        const request = createHealthReader(cached, () => current)();
        current = next;
        const respond = await request;
        expect(respond).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[1].eventLoop).toBe(next);
        expect(respond.mock.calls[0]?.[3]).toEqual({ cached: true });
        expect(cached.eventLoop).toBe(initial);
        expect(respond.mock.calls[0]?.[1].childRuntime).toEqual(removed);
        expect(cached).not.toHaveProperty("childRuntime");
      });
    },
  );

  it("projects requested CLI facts without choosing a fleet owner or widening read scopes", async () => {
    await withStateDirEnv("openclaw-gateway-cli-status-", async ({ stateDir }) => {
      const config = {
        ...statusConfig(stateDir, {
          ownership: "explicit",
          entries: { alpha: { name: "Alpha" }, beta: { identity: { name: "Beta" } } },
        }),
        update: { channel: "beta" },
        plugins: { slots: { memory: "none" } },
      } satisfies OpenClawConfig;

      const ordinary = await callStatus(config);
      expect(ordinary).not.toHaveProperty("cliProjection");

      const requested = await callStatus(config, ["operator.read"], { includeCliProjection: true });
      expect(requested).toMatchObject({
        cliProjection: {
          agents: {
            defaultId: null,
            ownership: "explicit",
            selectionRequired: true,
            rows: [
              { id: "alpha", name: "Alpha" },
              { id: "beta", name: "Beta" },
            ],
          },
          updateChannel: "beta",
          memoryPlugin: { enabled: false, slot: null, reason: 'plugins.slots.memory="none"' },
        },
        sessions: {
          paths: [],
          defaults: { model: null, contextTokens: null },
          recent: [],
          byAgent: [
            { agentId: "alpha", path: "[redacted]", recent: [] },
            { agentId: "beta", path: "[redacted]", recent: [] },
          ],
        },
      });
    });
  });

  it("restricts startup migration details to admins while retaining the reader's repair hint", async () => {
    await withStateDirEnv("openclaw-gateway-startup-warning-", async ({ stateDir }) => {
      const config = statusConfig(stateDir, { entries: { main: {} } });
      const warning = `EACCES: permission denied, open '${path.join(stateDir, "private-bindings.json")}'`;
      const hint =
        'Run "openclaw doctor --fix" against the same state/config, then restart the gateway.';
      recordStartupMigrationWarnings([warning]);
      const reader = await callStatus(config);
      expect(reader.startupMigrationWarning).toContain(hint);
      expect(reader.startupMigrationWarning).not.toContain(stateDir);
      expect(reader.startupMigrationWarning).not.toContain("EACCES");
      const admin = await callStatus(config, ["operator.admin"]);
      expect(admin.startupMigrationWarning).toContain(warning);
      expect(admin.startupMigrationWarning).toContain(hint);
    });
  });

  it("reports process memory and worker pools", async () => {
    await withStateDirEnv("openclaw-gateway-status-vitals-", async ({ stateDir }) => {
      vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 5120,
        heapUsed: 3072,
        heapTotal: 4096,
        external: 2048,
        arrayBuffers: 1024,
      });
      const idlePool = {
        maxWorkers: 1,
        workers: 0,
        workersCreated: 0,
        activeTasks: 0,
        pendingTasks: 0,
      };
      expect(await callStatus(statusConfig(stateDir, { entries: { main: {} } }))).toEqual(
        expect.objectContaining({
          processMemory: {
            rssBytes: 5120,
            heapUsedBytes: 3072,
            heapTotalBytes: 4096,
            externalBytes: 2048,
            arrayBuffersBytes: 1024,
          },
          workerPools: {
            transcriptReconciliation: idlePool,
            modelCatalog: { ...idlePool, workerFailures: 0 },
          },
        }),
      );
    });
  });
});
