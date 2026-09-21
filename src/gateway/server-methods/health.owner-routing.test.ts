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
        const snapshot: HealthSummary = {
          ok: true,
          ts: Date.now(),
          durationMs: 1,
          channels: {},
          channelOrder: [],
          channelLabels: {},
          heartbeatSeconds: 0,
          agents: [],
          sessions: { path: path.join(stateDir, "sessions.json"), count: 0, recent: [] },
          modelRuntime: degraded,
        };
        const refreshHealthSnapshot = vi.fn(async () => snapshot);
        const read = async () => {
          if (surface === "status") {
            return callStatus(config);
          }
          const respond = vi.fn();
          await healthHandlers.health!({
            req: {} as never,
            params: { probe: surface === "refreshed health" },
            respond: respond as never,
            context: {
              getHealthCache: () => snapshot,
              refreshHealthSnapshot,
              getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
              logHealth: { error: vi.fn() },
            } as never,
            client: { connect: { role: "operator", scopes: ["operator.read"] } } as never,
            isWebchatConnect: () => false,
          });
          return respond;
        };

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

  it("reports current startup recovery failures with restricted details until their store heals", async () => {
    await withStateDirEnv("openclaw-gateway-recovery-warning-", async ({ stateDir }) => {
      const target = { agentId: "main", storePath: path.join(stateDir, "sessions.json") };
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const config = { agents: { entries: { main: {} } }, session: { store: target.storePath } };
      const outcome = { ok: false, error: new Error("private store temporarily locked") } as const;
      try {
        recordStartupRecoveryStoreResult({ target, lifecycleGeneration, outcome });
        const reader = await callStatus(config);
        expect(reader.mock.calls[0]?.[1].startupRecoveryWarning).toContain("1 session store");
        expect(reader.mock.calls[0]?.[1].startupRecoveryWarning).not.toContain("private store");
        const admin = await callStatus(config, ["operator.admin"]);
        expect(admin.mock.calls[0]?.[1].startupRecoveryWarning).toContain(
          "private store temporarily locked",
        );

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
  });

  it.each(["main", "molty"])(
    "uses recorded owner %s for status and public main aliases",
    async (agentId) => {
      await withStateDirEnv("openclaw-gateway-status-owner-", async ({ stateDir }) => {
        const config = {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId } },
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
        expect(resolveRequestedSessionAgentId(config, "main")).toEqual({ ok: true, agentId });
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

  it("requires selection for a public main alias without a recorded default", () => {
    expect(
      resolveRequestedSessionAgentId(
        { agents: { ownership: "explicit", entries: { main: {}, molty: {} } } },
        "main",
      ),
    ).toMatchObject({ ok: false });
  });

  it("keeps single-agent status unchanged", async () => {
    await withStateDirEnv("openclaw-gateway-status-single-", async ({ stateDir }) => {
      const respond = await callStatus({
        agents: { entries: { main: {} } },
        session: { store: path.join(stateDir, "sessions.json") },
      });

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(respond.mock.calls[0]?.[2]).toBeUndefined();
    });
  });

  it("limits startup migration details to admin status while readers retain the repair hint", async () => {
    await withStateDirEnv("openclaw-gateway-status-warning-", async ({ stateDir }) => {
      const warning = `EACCES: permission denied, open '${path.join(stateDir, "private-bindings.json")}'`;
      recordStartupMigrationWarnings([warning]);
      const config = {
        agents: { entries: { main: {} } },
        session: { store: path.join(stateDir, "sessions.json") },
      };
      const hint =
        'Run "openclaw doctor --fix" against the same state/config, then restart the gateway.';

      const reader = await callStatus(config);
      const readerPayload = reader.mock.calls[0]?.[1];
      expect(reader.mock.calls[0]?.[0]).toBe(true);
      expect(readerPayload.startupMigrationWarning).toContain(hint);
      expect(readerPayload.startupMigrationWarning).not.toContain(stateDir);
      expect(readerPayload.startupMigrationWarning).not.toContain("EACCES");

      const admin = await callStatus(config, ["operator.admin"]);
      expect(admin.mock.calls[0]?.[0]).toBe(true);
      expect(admin.mock.calls[0]?.[1].startupMigrationWarning).toContain(warning);
      expect(admin.mock.calls[0]?.[1].startupMigrationWarning).toContain(hint);
    });
  });
});
