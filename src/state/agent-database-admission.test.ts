import { deepStrictEqual } from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import { AgentDatabaseAdmissionRefusalSchema } from "../../packages/gateway-protocol/src/schema/agent-database-admission.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import {
  findStartupMaintenanceRequiredError,
  StartupMaintenanceRequiredError,
} from "../infra/startup-maintenance-required.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import {
  AgentDatabaseAdmissionError,
  captureAgentDatabaseAdmission as captureAdmission,
  createAgentDatabaseInspectionRefusal as inspectionRefusal,
  evaluateAgentDatabaseAdmissions,
  preparePendingAgentDatabase as preparePending,
  readAgentDatabaseAdmissionRefusal as readRefusal,
  recordAgentDatabaseAdmissions as recordAdmissions,
} from "./agent-database-admission.js";
import { withAgentDatabaseStartupAdmission as withStartupAdmission } from "./agent-database-startup.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { invalidateOpenClawAgentDatabaseIntegrityBeforeMutation } from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesAsync as closeAgentDbs,
  closeOpenClawAgentDatabasesForTest as closeAgentDbsForTest,
  openOpenClawAgentDatabase as openAgentDb,
} from "./openclaw-agent-db.js";
import {
  createNativeIntegrityGeneration as nativeGeneration,
  createNativeIntegritySource as sourceFor,
} from "./openclaw-agent-execution-native.test-support.js";
import { captureOpenClawAgentDatabaseExecution as capture } from "./openclaw-agent-execution.js";
import {
  assertOpenClawDatabasesReady as assertDatabasesReady,
  preflightOpenClawDatabaseSchemas as preflightSchemas,
} from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseForTest as closeStateDbForTest } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext as workerContext } from "./openclaw-state-worker-context.js";

const tempDirs = createTempDirTracker();
const makeEnv = () => ({ OPENCLAW_STATE_DIR: tempDirs.make("agent-admission-") });

it.each(["settled", "pending"] as const)(
  "prepares missing storage after an existing-only miss (%s)",
  async (timing) => {
    const env = makeEnv();
    const execution = capture({ agentId: "main", env });
    const source = sourceFor(() => execution.assertCurrent());
    try {
      const missing = execution.runExisting(source, async () => "unexpected");
      if (timing === "settled") {
        expect(await missing).toBeUndefined();
      }
      const preparing = execution.prepare(source);
      expect(await missing).toBeUndefined();
      await preparing;
      expect(fs.existsSync(execution.path)).toBe(true);
      expect(await execution.runExisting(source, async () => "opened")).toBe("opened");
    } finally {
      await execution.release();
    }
  },
);

it("reports exhausted lock admission without recommending database repair", () => {
  const refusal = inspectionRefusal({
    agentId: "worker",
    paths: ["/synthetic/openclaw-agent.sqlite"],
    reason: "database is locked",
    cause: Object.assign(new Error("database is locked"), { errcode: 5 }),
  });
  expect(refusal).toMatchObject({
    code: "agent-database-inspection-failed",
    reason: "database locked by another process",
    repairHint: expect.stringContaining("restart the Gateway to retry admission"),
  });
  expect(refusal.repairHint).not.toContain("doctor --fix");
});
function closeDatabases() {
  closeAgentDbsForTest();
  closeStateDbForTest();
}
function mutateDatabase(pathname: string, sql: string) {
  using database = new (requireNodeSqlite().DatabaseSync)(pathname);
  database.exec(sql);
}
function agentConfig(first: string, second: string, systemAgent = first): OpenClawConfig {
  return {
    agents: {
      entries: { [first]: {}, [second]: {} },
      defaults: { systemAgent: { agentId: systemAgent } },
    },
  };
}
afterEach(async () => {
  try {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    closeDatabases();
    tempDirs.cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each([
  [21, "per-agent"],
  [OPENCLAW_AGENT_SCHEMA_VERSION + 1, "per-agent"],
  [21, "fixed"],
  [OPENCLAW_AGENT_SCHEMA_VERSION + 1, "fixed"],
] as const)(
  "isolates secondary schema %s with %s stores across restart and startup without touching retained data",
  async (version, layout) => {
    const env = makeEnv();
    const storePath = path.join(env.OPENCLAW_STATE_DIR, "shared", "sessions.json");
    const config: OpenClawConfig = {
      ...(layout === "fixed" ? { session: { store: storePath } } : {}),
      ...agentConfig("main", "worker"),
    };
    const mainPath = openAgentDb({ agentId: "main", env }).path;
    const workerPath = openAgentDb({ agentId: "worker", env }).path;
    const retainedPath = openAgentDb({
      agentId: "retained",
      env,
      ...(layout === "fixed"
        ? { path: path.join(path.dirname(storePath), "openclaw-agent.retained.sqlite") }
        : {}),
    }).path;
    await closeAgentDbs();
    closeStateDbForTest();
    for (const pathname of [workerPath, retainedPath]) {
      revokeSqliteDatabaseAdmissionsForPath(pathname);
      mutateDatabase(pathname, `PRAGMA journal_mode=DELETE; PRAGMA user_version=${version};`);
    }
    const workerBytes = fs.readFileSync(workerPath);
    const retainedBytes = fs.readFileSync(retainedPath);
    await expect(
      assertDatabasesReady({ env, config, operation: "gateway-restart" }),
    ).resolves.toBeUndefined();
    await withStartupAdmission(
      async () => {
        await expect(
          assertDatabasesReady({ env, config, operation: "gateway-startup" }),
        ).resolves.toBeUndefined();
        expect(readRefusal("main", { env })).toBeUndefined();
        expect(readRefusal("retained", { env })).toBeUndefined();
        expect(readRefusal("worker", { env })).toMatchObject({
          code: "agent-database-inspection-failed",
          paths: [workerPath],
          repairHint: expect.stringContaining("openclaw doctor --fix"),
        });
        expect(() => openAgentDb({ agentId: "worker", env })).toThrow("openclaw doctor --fix");
        expect(openAgentDb({ agentId: "main", env }).path).toBe(mainPath);
      },
      { deferInspections: false },
    );
    await expect(
      assertDatabasesReady({
        env,
        config,
        operation: "doctor",
        configuredAgentDatabaseTargets: [],
      }),
    ).rejects.toThrow();
    expect(fs.readFileSync(workerPath)).toEqual(workerBytes);
    expect(fs.readFileSync(retainedPath)).toEqual(retainedBytes);
  },
);

it("does not let an unavailable required agent hide a newer required database", async () => {
  const env = makeEnv();
  const config = agentConfig("openclaw", "worker", "worker");
  const unavailablePath = openAgentDb({ agentId: "openclaw", env }).path;
  const newerPath = openAgentDb({ agentId: "worker", env }).path;
  closeDatabases();
  // The registered path exists but cannot be opened as a database; no schema fact is available.
  fs.unlinkSync(unavailablePath);
  fs.mkdirSync(unavailablePath);
  mutateDatabase(newerPath, `PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
  await withStartupAdmission(
    async () => {
      const failure = await assertDatabasesReady({
        env,
        operation: "gateway-startup",
        config,
      }).catch((error: unknown) => error);
      expect(findStartupMaintenanceRequiredError(failure), String(failure)).toMatchObject({
        kind: "newer-schema",
      });
      expect(failure).toBeInstanceOf(AggregateError);
      expect(String(failure)).toContain(unavailablePath);
      expect(String(failure)).toContain(newerPath);
    },
    { deferInspections: false },
  );
});

it("keeps a secondary with malformed ownership isolated while required agents start", async () => {
  const env = makeEnv();
  const config = agentConfig("main", "worker");
  openAgentDb({ agentId: "main", env });
  const pathname = openAgentDb({ agentId: "worker", env }).path;
  await closeAgentDbs();
  closeStateDbForTest();
  invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(pathname);
  mutateDatabase(pathname, "UPDATE schema_meta SET agent_id = NULL WHERE meta_key = 'primary'");
  const before = fs.readFileSync(pathname);
  await withStartupAdmission(async (admission) => {
    await expect(
      assertDatabasesReady({ env, operation: "gateway-startup", config }),
    ).resolves.toBeUndefined();
    expect(readRefusal("main", { env })).toBeUndefined();
    const owner = admission.adopt();
    const prepareAgent = vi.fn(async () => {});
    try {
      admission.activate({
        isCurrent: () => true,
        preparationReady: Promise.resolve(),
        openAgent: prepareAgent,
        migrateAgent: prepareAgent,
        publishAgent: prepareAgent,
      });
      await admission.pendingPreparation;
      expect(readRefusal("worker", { env })).toMatchObject({
        code: "agent-database-inspection-failed",
        reason: expect.stringContaining("no agent owner"),
      });
      expect(prepareAgent).not.toHaveBeenCalled();
      deepStrictEqual(fs.readFileSync(pathname), before);
    } finally {
      await owner.stop();
    }
  });
});

it("retains merged inspection causes without changing public refusals", () => {
  const env = makeEnv();
  const maintenance = new StartupMaintenanceRequiredError("state-migrations", "repair required");
  const failures = [maintenance, new Error("storage unavailable")];
  recordAdmissions(
    failures.map((cause, index) =>
      inspectionRefusal({
        agentId: "main",
        paths: [`/synthetic/${index}.sqlite`],
        reason: cause.message,
        cause,
      }),
    ),
    { env },
  );
  const refusal = expectDefined(readRefusal("main", { env }), "Expected the merged refusal");
  const failure = new AgentDatabaseAdmissionError(refusal);
  expect(findStartupMaintenanceRequiredError(failure)).toBe(maintenance);
  expect(Value.Check(AgentDatabaseAdmissionRefusalSchema, refusal)).toBe(true);
  expect(() => captureAdmission("main", { env })()).toThrow(
    expect.objectContaining({ cause: failure.cause }),
  );
});

it("retains its selected agent and state while observing current refusal publications", () => {
  const env = makeEnv();
  const stateDir = env.OPENCLAW_STATE_DIR;
  const assertAdmitted = captureAdmission("  MAIN  ", { env });
  expect(assertAdmitted).not.toThrow();
  env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-other-admission-");
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const refusal = inspectionRefusal({
    agentId: "main",
    paths: [],
    reason: "Original admission refused",
  });
  recordAdmissions([refusal], options);
  expect(assertAdmitted).toThrow(expect.objectContaining({ refusal }));
  expect(readRefusal("main", { env })).toBeUndefined();
  const replacement = { ...refusal, reason: "Replacement admission refused" };
  recordAdmissions([replacement], options);
  expect(assertAdmitted).toThrow(expect.objectContaining({ refusal: replacement }));
  recordAdmissions([], options);
  expect(assertAdmitted).not.toThrow();
});

it("uses the current preparation scope and refuses an escaped scope after preparation ends", async () => {
  const env = makeEnv();
  const assertAdmitted = captureAdmission("main", { env });
  const refusal = inspectionRefusal({
    agentId: "main",
    paths: [],
    reason: "Preparation owns pending admission",
    pending: true,
  });
  recordAdmissions([refusal], { env });
  expect(assertAdmitted).toThrow(expect.objectContaining({ refusal }));
  let inPreparation = () => {};
  await preparePending(refusal, { env, assertCurrent() {} }, async () => {
    expect(assertAdmitted).not.toThrow();
    const runInScope = AsyncLocalStorage.snapshot();
    inPreparation = () => runInScope(assertAdmitted);
  });
  expect(assertAdmitted).not.toThrow();
  expect(inPreparation).toThrow("Agent database preparation has ended: main");
});

it.each([
  { role: "secondary", agentId: "cleaner", isolate: true },
  { role: "sole", agentId: "cleaner", isolate: false },
  { role: "configured system", agentId: "cleaner", isolate: false },
  { role: "reserved system", agentId: "openclaw", isolate: false },
] as const)(
  "$role agent ($agentId): divergent database permits startup=$isolate",
  async ({ role, agentId, isolate }) => {
    const env = makeEnv();
    const stateDir = env.OPENCLAW_STATE_DIR;
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const config: OpenClawConfig = {
      agents: {
        entries: {
          ...(role === "sole" ? {} : { main: {} }),
          [agentId]: { sandbox: { mode: "all", workspaceAccess: "none", scope: "session" } },
        },
        ...(role === "configured system" ? { defaults: { systemAgent: { agentId } } } : {}),
      },
    };
    const source = openAgentDb({ agentId: "main", env }).path;
    closeDatabases();
    const target = path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    mutateDatabase(target, "UPDATE schema_meta SET app_version = 'divergent-fixture'");
    const copyBytes = fs.readFileSync(target);
    const admission = await preflightSchemas({
      env,
      supportedVersions: {
        state: OPENCLAW_STATE_SCHEMA_VERSION,
        agent: OPENCLAW_AGENT_SCHEMA_VERSION,
      },
      configuredAgentDatabaseTargets: [{ agentId, path: target }],
      agentAdmissionConfig: config,
    });
    const mismatch = {
      agentId,
      embeddedOwnerId: "main",
      code: "agent-database-ownership-mismatch",
    };
    expect(admission.agentRefusals).toContainEqual(expect.objectContaining(mismatch));
    deepStrictEqual(fs.readFileSync(target), copyBytes);
    const startup = () => assertDatabasesReady({ env, operation: "gateway-startup", config });
    if (!isolate) {
      await expect(startup()).rejects.toMatchObject({
        name: "AgentDatabaseAdmissionError",
        message: expect.stringContaining(`belongs to agent main; requested agent ${agentId}`),
        refusal: { ...mismatch, paths: [target] },
      });
      expect(readRefusal(agentId, { env })).toBeUndefined();
      deepStrictEqual(fs.readFileSync(target), copyBytes);
      return;
    }
    await expect(startup()).resolves.toBeUndefined();
    const refusal = readRefusal(agentId, { env });
    expect(refusal).toMatchObject({
      ...mismatch,
      paths: [target],
      repairHint: expect.stringContaining("quarantine move"),
    });
    expect(readRefusal("main", { env })).toBeUndefined();
    const { prepareSecretsRuntimeSnapshot } = await import("../secrets/runtime.js");
    await expect(
      prepareSecretsRuntimeSnapshot({
        config,
        env,
        includeConfigRefs: false,
        loadablePluginOrigins: new Map(),
      }),
    ).resolves.toBeDefined();
    const { resolveRequestedSessionAgentId } = await import("../gateway/session-request-agent.js");
    const { listGatewayAgentsBasic } = await import("../gateway/agent-list.js");
    expect(resolveRequestedSessionAgentId(config, "agent:main:main")).toEqual({
      ok: true,
      agentId: "main",
    });
    expect(resolveRequestedSessionAgentId(config, `agent:${agentId}:main`)).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", details: refusal },
    });
    expect(
      (await listGatewayAgentsBasic(config)).agents.find((agent) => agent.id === agentId),
    ).toMatchObject({ status: "degraded", admissionRefusal: refusal });
    const { runStartupSessionMaintenanceForTest } =
      await import("../gateway/server-startup-session-migration.test-support.js");
    const { assertConfiguredWorkspaceStateReady } =
      await import("../agents/workspace-state-dirs.js");
    await assertConfiguredWorkspaceStateReady({ cfg: config, env });
    await runStartupSessionMaintenanceForTest({
      cfg: config,
      env,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    deepStrictEqual(fs.readFileSync(target), copyBytes);
    expect(() => openAgentDb({ agentId, env })).toThrow(refusal?.reason);
    await cleanupSessionStateForTest({ stateDir });
    closeDatabases();
    fs.renameSync(target, `${target}.operator-backup`);
    const freshDiagnosis = await evaluateAgentDatabaseAdmissions(config, { env });
    expect(freshDiagnosis).toEqual([]);
    recordAdmissions(freshDiagnosis, { env });
    expect(readRefusal(agentId, { env })).toBe(refusal);
    await expect(startup()).resolves.toBeUndefined();
    expect(readRefusal(agentId, { env })).toBeUndefined();
    expect(resolveRequestedSessionAgentId(config, `agent:${agentId}:main`)).toEqual({
      ok: true,
      agentId,
    });
    expect(openAgentDb({ agentId, env }).agentId).toBe(agentId);
    deepStrictEqual(fs.readFileSync(`${target}.operator-backup`), copyBytes);
  },
);

it("opens an unconfigured external store without reconstructing unknown deletion history", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-worker-missing-history-") };
  const external = tempDirs.make("agent-worker-external-history-");
  const pathname = path.join(external, "retained.sqlite");
  const retained = openAgentDb({
    agentId: "main",
    path: pathname,
    env: { OPENCLAW_STATE_DIR: tempDirs.make("agent-worker-fixture-owner-") },
  });
  retained.db.exec("INSERT INTO auth_profile_state VALUES ('preserved', '{\"ok\":true}', 1)");
  closeDatabases();
  const bytes = fs.readFileSync(pathname);
  const generation = nativeGeneration(retained, workerContext({ env }));
  try {
    expect(await generation.run(generation.source, async () => "opened")).toBe("opened");
  } finally {
    await generation.close();
  }
  expect(fs.readFileSync(pathname)).toEqual(bytes);
  expect(fs.readdirSync(external).toSorted()).toEqual(["retained.sqlite", "retained.sqlite.seal"]);
  using shared = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(env), { readOnly: true });
  expect(
    shared.prepare("SELECT name FROM sqlite_schema WHERE name = 'agent_deletion_journal'").get(),
  ).toBeUndefined();
});
