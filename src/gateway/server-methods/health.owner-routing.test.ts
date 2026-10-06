import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordStartupRecoveryStoreResult } from "../../agents/main-session-recovery/main-session-restart-recovery-diagnostics.js";
import { setPreparedModelRuntimeStartupStatus } from "../../agents/prepared-model-runtime.startup-status.js";
import { createGatewayHostLifecycle } from "../../cli/gateway-cli/host-lifecycle.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import * as childRuntime from "../../infra/child-runtime-viability.js";
import { beginLifecycleWriteCustody } from "../../infra/lifecycle-write-custody.js";
import { recordStartupMigrationWarnings } from "../../infra/state-migrations.messages.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import type { HealthSummary } from "../health/types.js";
import type { GatewayHostLifecycle } from "../server-public.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
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
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
    } as never,
    client: { connect: { role: "operator", scopes } } as never,
    isWebchatConnect: () => false,
  });
  return respond;
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
) {
  const context = {
    getHealthCache: () => snapshot,
    refreshHealthSnapshot: vi.fn(async () => snapshot),
    getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
    getEventLoopHealth,
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
  it("reports only the current host's recorded shutdown budget and resident PID", async () => {
    await withStateDirEnv("openclaw-gateway-budget-status-", async ({ stateDir }) => {
      const config = {
        agents: { entries: { main: {} } },
        session: { store: path.join(stateDir, "sessions.json") },
      };
      let current = true;
      let recorded = {
        timeoutMs: 25_000,
        reserveMs: 10_000,
        nativeStopBudget: true,
      };
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
          expect(response).toHaveBeenCalledOnce();
          expect(response.mock.calls[0]?.[0]).toBe(true);
          expect(response.mock.calls[0]?.[2]).toBeUndefined();
          expect(response.mock.calls[0]?.[1]).toMatchObject({
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
        expect(replaced.mock.calls[0]?.[1].shutdownBudget).toBeUndefined();
        const absent = await callStatus(config);
        expect(absent.mock.calls[0]?.[1].shutdownBudget).toBeUndefined();
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
        const config = {
          agents: { entries: { main: {}, second: {} } },
          session: { store: path.join(stateDir, "agents", "{agentId}", "sessions.json") },
        } satisfies OpenClawConfig;
        const degraded = {
          degraded: true,
          pendingAgents: ["second"],
          stage: "workspace plugins; agent second",
        };
        const snapshot = healthSnapshot(stateDir, { modelRuntime: degraded });
        const readHealth = createHealthReader(snapshot);
        const read = () =>
          surface === "status" ? callStatus(config) : readHealth(surface === "refreshed health");

        setPreparedModelRuntimeStartupStatus(degraded);
        const acquiring = await read();
        expect(acquiring.mock.calls[0]?.[0]).toBe(true);
        expect(acquiring.mock.calls[0]?.[1]).toMatchObject({ modelRuntime: degraded });

        const complete = { degraded: false, pendingAgents: [] };
        setPreparedModelRuntimeStartupStatus(complete);
        const recovered = await read();
        expect(recovered.mock.calls[0]?.[0]).toBe(true);
        expect(recovered.mock.calls[0]?.[1].modelRuntime).toEqual(complete);
      });
    },
  );

  it.each([
    { changeDuringRead: true, reset: false },
    { changeDuringRead: true, reset: true },
    { changeDuringRead: false, reset: true },
  ])(
    "keeps live diagnostics out of cached health ($changeDuringRead, $reset)",
    async ({ changeDuringRead, reset }) => {
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
        const read = vi.spyOn(childRuntime, "readChildRuntimeViability").mockReturnValue(removed);
        let current: HealthSummary["eventLoop"] = changeDuringRead ? initial : undefined;
        const next = reset ? undefined : { ...initial, cpuCoreRatio: 1.2 };
        const request = createHealthReader(cached, () => current)();
        current = next;
        const respond = await request;
        expect(respond).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[1].eventLoop).toBe(next);
        expect(respond.mock.calls[0]?.[3]).toEqual({ cached: true });
        expect(cached.eventLoop).toBe(initial);
        expect(read).toHaveBeenCalled();
        expect(respond.mock.calls[0]?.[1].childRuntime).toEqual(removed);
        expect(cached).not.toHaveProperty("childRuntime");
      });
    },
  );

  it("projects requested CLI facts without choosing a fleet owner or widening read scopes", async () => {
    await withStateDirEnv("openclaw-gateway-cli-status-", async ({ stateDir }) => {
      const config = {
        agents: {
          ownership: "explicit",
          entries: { alpha: { name: "Alpha" }, beta: { identity: { name: "Beta" } } },
        },
        update: { channel: "beta" },
        plugins: { slots: { memory: "none" } },
        session: { store: path.join(stateDir, "agents", "{agentId}", "sessions.json") },
      } satisfies OpenClawConfig;

      const ordinary = await callStatus(config);
      expect(ordinary.mock.calls[0]?.[1]).not.toHaveProperty("cliProjection");

      const requested = await callStatus(config, ["operator.read"], { includeCliProjection: true });
      expect(requested.mock.calls[0]?.[0]).toBe(true);
      expect(requested.mock.calls[0]?.[1]).toMatchObject({
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

  it.each(["startupRecoveryWarning", "startupMigrationWarning"] as const)(
    "restricts %s details to admins while retaining the reader's repair hint",
    async (field) => {
      await withStateDirEnv("openclaw-gateway-startup-warning-", async ({ stateDir }) => {
        const target = { agentId: "main", storePath: path.join(stateDir, "sessions.json") };
        const lifecycleGeneration = getAgentEventLifecycleGeneration();
        const config = { agents: { entries: { main: {} } }, session: { store: target.storePath } };
        const recovery = field === "startupRecoveryWarning";
        const warning = recovery
          ? "private store temporarily locked"
          : `EACCES: permission denied, open '${path.join(stateDir, "private-bindings.json")}'`;
        const hint = recovery
          ? "1 session store"
          : 'Run "openclaw doctor --fix" against the same state/config, then restart the gateway.';
        const outcome = { ok: false, error: new Error(warning) } as const;
        try {
          if (recovery) {
            recordStartupRecoveryStoreResult({ target, lifecycleGeneration, outcome });
          } else {
            recordStartupMigrationWarnings([warning]);
          }
          const reader = await callStatus(config);
          expect(reader.mock.calls[0]?.[0]).toBe(true);
          expect(reader.mock.calls[0]?.[1][field]).toContain(hint);
          expect(reader.mock.calls[0]?.[1][field]).not.toContain(stateDir);
          expect(reader.mock.calls[0]?.[1][field]).not.toContain(
            recovery ? "private store" : "EACCES",
          );
          const admin = await callStatus(config, ["operator.admin"]);
          expect(admin.mock.calls[0]?.[0]).toBe(true);
          expect(admin.mock.calls[0]?.[1][field]).toContain(warning);
          if (!recovery) {
            expect(admin.mock.calls[0]?.[1][field]).toContain(hint);
            return;
          }

          recordStartupRecoveryStoreResult({ target, lifecycleGeneration, outcome: { ok: true } });
          const healed = await callStatus(config, ["operator.admin"]);
          expect(healed.mock.calls[0]?.[1].startupRecoveryWarning).toBeUndefined();

          rotateAgentEventLifecycleGeneration();
          recordStartupRecoveryStoreResult({ target, lifecycleGeneration, outcome });
          const restarted = await callStatus(config, ["operator.admin"]);
          expect(restarted.mock.calls[0]?.[1].startupRecoveryWarning).toBeUndefined();
        } finally {
          rotateAgentEventLifecycleGeneration();
        }
      });
    },
  );

  it.each(["main", "molty", undefined])(
    "uses recorded owner %s for status and public main aliases",
    async (agentId) => {
      await withStateDirEnv("openclaw-gateway-status-owner-", async ({ stateDir }) => {
        const config = {
          agents: {
            ownership: "explicit",
            ...(agentId ? { defaults: { systemAgent: { agentId } } } : {}),
            entries: { main: {}, molty: {} },
          },
          session: { store: path.join(stateDir, "agents", "{agentId}", "sessions.json") },
        } satisfies OpenClawConfig;

        vi.spyOn(process, "memoryUsage").mockReturnValue({
          rss: 5120,
          heapUsed: 3072,
          heapTotal: 4096,
          external: 2048,
          arrayBuffers: 1024,
        });
        const respond = await callStatus(config);

        expect(respond).toHaveBeenCalledTimes(1);
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        expect(respond.mock.calls[0]?.[1]).toEqual(
          expect.objectContaining({
            processMemory: {
              rssBytes: 5120,
              heapUsedBytes: 3072,
              heapTotalBytes: 4096,
              externalBytes: 2048,
              arrayBuffersBytes: 1024,
            },
            workerPools: {
              transcriptReconciliation: {
                maxWorkers: 1,
                workers: 0,
                workersCreated: 0,
                activeTasks: 0,
                pendingTasks: 0,
              },
              modelCatalog: {
                maxWorkers: 1,
                workers: 0,
                workersCreated: 0,
                activeTasks: 0,
                pendingTasks: 0,
              },
            },
          }),
        );
        expect(respond.mock.calls[0]?.[2]).toBeUndefined();
        const selected = resolveRequestedSessionAgentId(config, "main");
        if (agentId) {
          expect(selected).toEqual({ ok: true, agentId });
        } else {
          expect(selected).toMatchObject({ ok: false });
        }
        expect(resolveRequestedSessionAgentId(config, "agent:molty:main")).toEqual({
          ok: true,
          agentId: "molty",
        });
        expect(resolveRequestedSessionAgentId(config, "agent:main:main")).toEqual({
          ok: true,
          agentId: "main",
        });
      });
    },
  );
});
