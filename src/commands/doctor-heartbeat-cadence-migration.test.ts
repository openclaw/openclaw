import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadCronJobsStore, resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import {
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
} from "../infra/device-identity.js";
import { resolveHeartbeatPhaseMs } from "../infra/heartbeat-schedule.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  collectHeartbeatCadenceMigrationFindings,
  ensureHeartbeatMonitorJobs,
  maybeMigrateHeartbeatCadenceToCron,
} from "./doctor-heartbeat-cadence-migration.js";
import { useHeartbeatMigrationRoots } from "./doctor-heartbeat-migration.test-support.js";

const makeRoot = useHeartbeatMigrationRoots("openclaw-heartbeat-cadence-");

async function createFixture(every = "15m") {
  const root = await makeRoot();
  process.env.HOME = path.join(root, "home");
  process.env.OPENCLAW_STATE_DIR = root;
  const env = process.env;
  const cfg = {
    agents: { defaults: { heartbeat: { every } }, entries: { main: {} } },
  } as OpenClawConfig;
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  const migrate = (config = cfg, shouldRepair = true) =>
    maybeMigrateHeartbeatCadenceToCron({ cfg: config, shouldRepair, env });
  const findings = (config = cfg) => collectHeartbeatCadenceMigrationFindings(config, env);
  return {
    cfg,
    env,
    storePath,
    migrate,
    findings,
    monitor: (id = "main") => loadMonitor(storePath, id),
  };
}

function heartbeatAgents(cadences: Record<string, string>): OpenClawConfig {
  return {
    agents: {
      entries: Object.fromEntries(
        Object.entries(cadences).map(([id, every]) => [id, { heartbeat: { every } }]),
      ),
    },
  };
}

async function loadMonitor(storePath: string, agentId: string) {
  const store = await loadCronJobsStore(storePath);
  return store.jobs.find((job) => job.agentId === agentId && job.payload.kind === "heartbeat");
}

it("previews without mutation, applies, updates, and reruns idempotently", async () => {
  const f = await createFixture();
  const findings = await f.findings();
  expect(findings).toEqual([
    expect.objectContaining({
      checkId: "core/doctor/heartbeat-cadence-migration",
      requirement: "heartbeat-monitor-create",
      target: "main",
    }),
  ]);
  const preview = await f.migrate(f.cfg, false);
  expect(preview).toEqual({ changes: [], warnings: [] });
  await expect(fs.access(resolveOpenClawStateSqlitePath(f.env))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await f.monitor()).toBeUndefined();
  const migrated = await f.migrate();
  expect(migrated).toEqual({
    warnings: [],
    changes: ['Create heartbeat monitor for agent "main" at 15m.'],
  });
  const created = await f.monitor();
  expect(created).toEqual(
    expect.objectContaining({
      declarationKey: "heartbeat:main",
      enabled: true,
      schedule: expect.objectContaining({ kind: "every", everyMs: 15 * 60_000 }),
      payload: { kind: "heartbeat" },
    }),
  );
  const updatedCfg = {
    ...f.cfg,
    agents: { ...f.cfg.agents, defaults: { heartbeat: { every: "45m" } } },
  } as OpenClawConfig;
  const updated = await f.migrate(updatedCfg);
  expect(updated.changes).toEqual(['Update heartbeat monitor for agent "main" at 45m.']);
  const changed = await f.monitor();
  expect(changed?.id).toBe(created?.id);
  expect(changed?.schedule).toEqual(
    expect.objectContaining({ kind: "every", everyMs: 45 * 60_000 }),
  );
  const rerun = await f.migrate(updatedCfg);
  expect(rerun).toEqual({ changes: [], warnings: [] });
  await expect(f.findings(updatedCfg)).resolves.toEqual([]);
});

it.each(["Create", "Update"])("reports %s of a disabled heartbeat monitor", async (action) => {
  const f = await createFixture("0m");
  if (action === "Update") {
    await f.migrate({
      ...f.cfg,
      agents: { ...f.cfg.agents, defaults: { heartbeat: { every: "15m" } } },
    });
  }
  const findings = await f.findings();
  const result = await f.migrate();
  expect(result.warnings).toEqual([]);
  expect(await f.monitor()).toEqual(
    expect.objectContaining({ enabled: false, payload: { kind: "heartbeat" } }),
  );
  const message = `${action} heartbeat monitor for agent "main" as disabled.`;
  expect(result.changes).toEqual([message]);
  expect(findings).toEqual([expect.objectContaining({ message })]);
});

it("keeps ownerless multi-agent updates scoped to their declared monitors", async () => {
  const f = await createFixture();
  const initialCfg = heartbeatAgents({ alpha: "15m", beta: "20m" });
  await f.migrate(initialCfg);
  const alphaBefore = await f.monitor("alpha");
  const betaBefore = await f.monitor("beta");
  const updatedCfg = heartbeatAgents({ alpha: "45m", gamma: "30m" });
  const result = await f.migrate(updatedCfg);
  expect(result).toEqual({
    changes: [
      'Update heartbeat monitor for agent "alpha" at 45m.',
      'Create heartbeat monitor for agent "gamma" at 30m.',
      'Remove stale heartbeat monitor for agent "beta".',
    ],
    warnings: [],
  });
  const alphaAfter = await f.monitor("alpha");
  const gammaAfter = await f.monitor("gamma");
  expect(alphaAfter).toEqual(
    expect.objectContaining({
      id: alphaBefore?.id,
      declarationKey: "heartbeat:alpha",
      agentId: "alpha",
      schedule: expect.objectContaining({ kind: "every", everyMs: 45 * 60_000 }),
    }),
  );
  expect(gammaAfter).toEqual(
    expect.objectContaining({
      declarationKey: "heartbeat:gamma",
      agentId: "gamma",
      schedule: expect.objectContaining({ kind: "every", everyMs: 30 * 60_000 }),
    }),
  );
  expect(gammaAfter?.id).not.toBe(betaBefore?.id);
  expect(await f.monitor("beta")).toBeUndefined();
});

it.each(["migrate", "ensure"])(
  "%s creates heartbeat monitors without minting a primary device identity",
  async (operation) => {
    const f = await createFixture();
    const nodeIdentity = loadOrCreateDeviceIdentity({ env: f.env, identityKey: "node" });
    if (operation === "migrate") {
      expect((await f.migrate()).warnings).toEqual([]);
    } else {
      await ensureHeartbeatMonitorJobs(f.cfg, f.storePath, f.env);
    }
    expect(Boolean(loadDeviceIdentityIfPresent({ env: f.env }))).toBe(false);
    expect(loadDeviceIdentityIfPresent({ env: f.env, identityKey: "node" })).toEqual(nodeIdentity);
    const monitor = await f.monitor();
    expect(monitor).toEqual(expect.objectContaining({ payload: { kind: "heartbeat" } }));
    vi.spyOn(process, "cwd").mockReturnValue(await makeRoot());
    expect(await f.migrate()).toEqual({ changes: [], warnings: [] });
    expect((await f.monitor())?.schedule).toEqual(monitor?.schedule);
  },
);

it("uses the supplied environment's existing identity for the scheduler seed", async () => {
  const ambientRoot = await makeRoot();
  const suppliedRoot = await makeRoot();
  process.env.HOME = path.join(ambientRoot, "home");
  process.env.OPENCLAW_STATE_DIR = ambientRoot;
  const ambientEnv = { ...process.env };
  const suppliedEnv = {
    ...process.env,
    HOME: path.join(suppliedRoot, "home"),
    OPENCLAW_STATE_DIR: suppliedRoot,
  };
  const ambientIdentity = loadOrCreateDeviceIdentity({ env: ambientEnv });
  const suppliedIdentity = loadOrCreateDeviceIdentity({ env: suppliedEnv });
  const intervalMs = 15 * 60_000;
  const phase = (deviceId: string, id: string) =>
    resolveHeartbeatPhaseMs({ schedulerSeed: deviceId, agentId: id, intervalMs });
  const agentId = ["main", "ops", "alpha", "beta"].find(
    (id) => phase(ambientIdentity.deviceId, id) !== phase(suppliedIdentity.deviceId, id),
  );
  if (!agentId) {
    throw new Error("expected ambient and supplied identities to produce a distinct phase");
  }
  const cfg = {
    agents: { defaults: { heartbeat: { every: "15m" } }, entries: { [agentId]: {} } },
  } as OpenClawConfig;
  const storePath = resolveCronJobsStorePathFromConfig(cfg, suppliedEnv);
  const result = await maybeMigrateHeartbeatCadenceToCron({
    cfg,
    shouldRepair: true,
    env: suppliedEnv,
  });
  expect(result.warnings).toEqual([]);
  const monitor = await loadMonitor(storePath, agentId);
  expect(monitor?.schedule).toEqual(
    expect.objectContaining({
      kind: "every",
      everyMs: intervalMs,
      anchorMs: phase(suppliedIdentity.deviceId, agentId),
    }),
  );
});
