import { deepStrictEqual } from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDatabaseAdmissionRefusalSchema } from "../../packages/gateway-protocol/src/schema/agent-database-admission.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  findStartupMaintenanceRequiredError,
  StartupMaintenanceRequiredError,
} from "../infra/startup-maintenance-required.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import {
  AgentDatabaseAdmissionError,
  captureAgentDatabaseAdmission,
  createAgentDatabaseAdmissionErrorShape,
  createAgentDatabaseInspectionRefusal,
  evaluateAgentDatabaseAdmissions,
  preparePendingAgentDatabase,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "./agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import { readAgentDeletionJournalStatusInDatabase } from "./agent-deletion-journal.read.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  assertOpenClawDatabasesReady,
  preflightOpenClawDatabaseSchemas,
} from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  withExistingOpenClawStateDatabaseReadOnly,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs = createTempDirTracker();
afterEach(async () => {
  try {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

describe("agent database admission", () => {
  it.each([
    { errcode: 26, pending: false, recover: true },
    { errcode: 267, pending: false, recover: true },
    { errcode: 5, pending: false, recover: false },
    { errcode: 10, pending: false, recover: false },
    { errcode: 13, pending: false, recover: false },
    { errcode: 26, pending: true, recover: false },
  ])(
    "reports recovery only for completed corrupt inspections ($errcode, pending=$pending)",
    ({ errcode, pending, recover }) => {
      const native = Object.assign(new Error("native SQLite failure"), {
        code: "ERR_SQLITE_ERROR",
        errcode,
      });
      const cause = new Error("inspection failed", { cause: native });
      const refusal = createAgentDatabaseInspectionRefusal({
        agentId: "worker",
        paths: ["/synthetic/agent.sqlite"],
        reason: cause.message,
        cause,
        pending,
      });
      const output = createAgentDatabaseAdmissionErrorShape(refusal);
      expect(
        output.message.includes("doctor --session-sqlite recover --session-sqlite-agent worker"),
      ).toBe(recover);
      expect(output.retryable).toBe(pending);
    },
  );

  it("reports offline recovery for integrity findings without a transient cause", () => {
    const cause = new Error("SQLite integrity_check failed: invalid page");
    cause.name = "SqliteIntegrityError";
    const refusal = createAgentDatabaseInspectionRefusal({
      agentId: "worker",
      paths: [],
      reason: cause.message,
      cause,
    });
    expect(createAgentDatabaseAdmissionErrorShape(refusal).message).toContain(
      "doctor --session-sqlite recover --session-sqlite-agent worker",
    );
    cause.cause = Object.assign(new Error("database is locked"), { errcode: 5 });
    const transient = createAgentDatabaseInspectionRefusal({
      agentId: "worker",
      paths: [],
      reason: cause.message,
      cause,
    });
    expect(createAgentDatabaseAdmissionErrorShape(transient).message).not.toContain(
      "--session-sqlite recover",
    );
  });

  it("does not let an unavailable required agent hide a newer required database", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-admission-mixed-") };
    const config: OpenClawConfig = {
      agents: {
        entries: { openclaw: {}, worker: {} },
        defaults: { systemAgent: { agentId: "worker" } },
      },
    };
    const unavailablePath = openOpenClawAgentDatabase({ agentId: "openclaw", env }).path;
    const newerPath = openOpenClawAgentDatabase({ agentId: "worker", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    // The registered path exists but cannot be opened as a database; no schema fact is available.
    fs.unlinkSync(unavailablePath);
    fs.mkdirSync(unavailablePath);
    const database = new (requireNodeSqlite().DatabaseSync)(newerPath);
    database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
    database.close();
    await withAgentDatabaseStartupAdmission(
      async () => {
        const failure = await assertOpenClawDatabasesReady({
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
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-admission-ownerless-") };
    const config: OpenClawConfig = {
      agents: {
        entries: { main: {}, worker: {} },
        defaults: { systemAgent: { agentId: "main" } },
      },
    };
    openOpenClawAgentDatabase({ agentId: "main", env });
    const pathname = openOpenClawAgentDatabase({ agentId: "worker", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const database = new (requireNodeSqlite().DatabaseSync)(pathname);
    database.exec("UPDATE schema_meta SET agent_id = NULL WHERE meta_key = 'primary'");
    database.close();
    const before = fs.readFileSync(pathname);
    await withAgentDatabaseStartupAdmission(async (admission) => {
      await expect(
        assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config }),
      ).resolves.toBeUndefined();
      expect(readAgentDatabaseAdmissionRefusal("main", { env })).toBeUndefined();
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
        expect(readAgentDatabaseAdmissionRefusal("worker", { env })).toMatchObject({
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

  it.each([false, true])(
    "retains merged inspection causes without changing public refusals (maintenance first=%s)",
    (maintenanceFirst) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-admission-causes-") };
      const maintenance = new StartupMaintenanceRequiredError(
        "state-migrations",
        "repair required",
      );
      const failures = [new Error("storage unavailable"), maintenance];
      if (maintenanceFirst) {
        failures.reverse();
      }
      recordAgentDatabaseAdmissions(
        failures.map((cause, index) =>
          createAgentDatabaseInspectionRefusal({
            agentId: "main",
            paths: [`/synthetic/${index}.sqlite`],
            reason: cause.message,
            cause,
          }),
        ),
        { env },
      );
      const refusal = expectDefined(
        readAgentDatabaseAdmissionRefusal("main", { env }),
        "Expected the merged refusal",
      );
      const failure = new AgentDatabaseAdmissionError(refusal);
      expect(findStartupMaintenanceRequiredError(failure)).toBe(maintenance);
      expect(Value.Check(AgentDatabaseAdmissionRefusalSchema, refusal)).toBe(true);
      expect(() => captureAgentDatabaseAdmission("main", { env })()).toThrow(
        expect.objectContaining({ cause: failure.cause }),
      );
    },
  );

  it("retains its selected agent and state while observing current refusal publications", () => {
    const stateDir = tempDirs.make("openclaw-prepared-admission-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const assertAdmitted = captureAgentDatabaseAdmission("  MAIN  ", { env });
    expect(assertAdmitted).not.toThrow();
    env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-other-admission-");
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const refusal = createAgentDatabaseInspectionRefusal({
      agentId: "main",
      paths: [],
      reason: "Original admission refused",
    });
    recordAgentDatabaseAdmissions([refusal], options);
    expect(assertAdmitted).toThrow(expect.objectContaining({ refusal }));
    expect(readAgentDatabaseAdmissionRefusal("main", { env })).toBeUndefined();
    const replacement = { ...refusal, reason: "Replacement admission refused" };
    recordAgentDatabaseAdmissions([replacement], options);
    expect(assertAdmitted).toThrow(expect.objectContaining({ refusal: replacement }));
    recordAgentDatabaseAdmissions([], options);
    expect(assertAdmitted).not.toThrow();
  });

  it("uses the current preparation scope and refuses an escaped scope after preparation ends", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-prepared-admission-scope-") };
    const assertAdmitted = captureAgentDatabaseAdmission("main", { env });
    const refusal = createAgentDatabaseInspectionRefusal({
      agentId: "main",
      paths: [],
      reason: "Preparation owns pending admission",
      pending: true,
    });
    recordAgentDatabaseAdmissions([refusal], { env });
    expect(assertAdmitted).toThrow(expect.objectContaining({ refusal }));
    let inPreparation = () => {};
    await preparePendingAgentDatabase(refusal, { env, assertCurrent() {} }, async () => {
      expect(assertAdmitted).not.toThrow();
      const runInScope = AsyncLocalStorage.snapshot();
      inPreparation = () => runInScope(assertAdmitted);
    });
    expect(assertAdmitted).not.toThrow();
    expect(inPreparation).toThrow("Agent database preparation has ended: main");
  });

  it("settles deferred startup admission after its discovery snapshot closes", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-deferred-admission-snapshot-") };
    const agentId = "main";
    const pathname = openOpenClawAgentDatabase({ agentId, env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await withAgentDatabaseStartupAdmission(async (admission) => {
      const tracked = vi.spyOn(admission, "track");
      const owner = admission.adopt();
      try {
        await withOpenClawStateDatabaseReadSnapshot(
          async () => {
            const refusals = admission.defer({
              env,
              inspections: [
                {
                  target: { agentId, path: pathname },
                  result: Promise.resolve({ incompatible: [], indeterminate: [] }),
                },
              ],
              reason: "Awaiting Gateway activation",
            });
            recordAgentDatabaseAdmissions(refusals, { env, source: "startup" });
          },
          { env },
        );
        expect(readAgentDatabaseAdmissionRefusal(agentId, { env })?.code).toBe(
          "agent-database-inspection-pending",
        );
        const phases: string[] = [];
        admission.activate({
          isCurrent: () => true,
          preparationReady: Promise.resolve(),
          openAgent: async ({ assertCurrent }) => {
            assertCurrent();
            phases.push("open");
          },
          migrateAgent: async ({ assertCurrent }) => {
            assertCurrent();
            expect(
              withExistingOpenClawStateDatabaseReadOnly(
                ({ db }) => readAgentDeletionJournalStatusInDatabase(db, agentId),
                { env },
              ),
            ).toBe("absent");
            phases.push("migration");
          },
          publishAgent: async ({ assertCurrent }) => {
            assertCurrent();
            phases.push("publication");
          },
        });
        // Join the owner's work on success or refusal, never a success-only callback.
        await Promise.all(tracked.mock.calls.map(([work]) => work));
        const refusal = readAgentDatabaseAdmissionRefusal(agentId, { env });
        expect(refusal, refusal?.reason).toBeUndefined();
        expect(phases).toEqual(["open", "migration", "publication"]);
      } finally {
        await owner.stop();
        tracked.mockRestore();
      }
    });
  });

  it.each([
    { role: "secondary", agentId: "cleaner", isolate: true },
    { role: "registered secondary", agentId: "cleaner", isolate: true },
    { role: "sole", agentId: "cleaner", isolate: false },
    { role: "configured system", agentId: "cleaner", isolate: false },
    { role: "reserved system", agentId: "openclaw", isolate: false },
    { role: "reserved system", agentId: "crestodian", isolate: false },
  ] as const)(
    "$role agent ($agentId): divergent database permits startup=$isolate",
    async ({ role, agentId, isolate }) => {
      const stateDir = tempDirs.make("openclaw-divergent-admission-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const config: OpenClawConfig = {
        agents: {
          entries: {
            ...(role === "sole" ? {} : { main: {} }),
            [agentId]: {
              sandbox: { mode: "all", workspaceAccess: "none", scope: "session" },
            },
          },
          ...(role === "configured system" ? { defaults: { systemAgent: { agentId } } } : {}),
        },
      };
      const source = openOpenClawAgentDatabase({ agentId: "main", env }).path;
      if (role === "registered secondary") {
        openOpenClawAgentDatabase({ agentId, env });
      }
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const target = path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(
        source,
        target,
        role === "registered secondary" ? 0 : fs.constants.COPYFILE_EXCL,
      );
      const { DatabaseSync } = requireNodeSqlite();
      const database = new DatabaseSync(target);
      try {
        database.prepare("UPDATE schema_meta SET app_version = ?").run("divergent-fixture");
      } finally {
        database.close();
      }
      const copyBytes = fs.readFileSync(target);
      const admission = await preflightOpenClawDatabaseSchemas({
        env,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
        configuredAgentDatabaseTargets: [{ agentId, path: target }],
        agentAdmissionConfig: config,
      });
      expect(admission.agentRefusals).toContainEqual(
        expect.objectContaining({
          agentId,
          embeddedOwnerId: "main",
          code: "agent-database-ownership-mismatch",
        }),
      );
      deepStrictEqual(fs.readFileSync(target), copyBytes);
      const startup = () =>
        assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config });
      if (!isolate) {
        await expect(startup()).rejects.toMatchObject({
          name: "AgentDatabaseAdmissionError",
          message: expect.stringContaining(`belongs to agent main; requested agent ${agentId}`),
          refusal: {
            agentId,
            paths: [target],
            embeddedOwnerId: "main",
            code: "agent-database-ownership-mismatch",
          },
        });
        expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toBeUndefined();
        deepStrictEqual(fs.readFileSync(target), copyBytes);
        return;
      }
      await expect(startup()).resolves.toBeUndefined();
      const refusal = readAgentDatabaseAdmissionRefusal(agentId, { env });
      expect(refusal).toMatchObject({
        agentId,
        paths: [target],
        embeddedOwnerId: "main",
        code: "agent-database-ownership-mismatch",
        repairHint: expect.stringContaining("quarantine move"),
      });
      expect(readAgentDatabaseAdmissionRefusal("main", { env })).toBeUndefined();
      const { prepareSecretsRuntimeSnapshot } = await import("../secrets/runtime.js");
      await expect(
        prepareSecretsRuntimeSnapshot({
          config,
          env,
          includeConfigRefs: false,
          loadablePluginOrigins: new Map(),
        }),
      ).resolves.toBeDefined();
      const { resolveRequestedSessionAgentId } =
        await import("../gateway/session-request-agent.js");
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
      ).toMatchObject({
        status: "degraded",
        admissionRefusal: refusal,
      });
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
      expect(() => openOpenClawAgentDatabase({ agentId, env })).toThrow(refusal?.reason);
      await cleanupSessionStateForTest({ stateDir });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      fs.renameSync(target, `${target}.operator-backup`);
      const freshDiagnosis = await evaluateAgentDatabaseAdmissions(config, { env });
      expect(freshDiagnosis).toEqual([]);
      recordAgentDatabaseAdmissions(freshDiagnosis, { env });
      expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toBe(refusal);
      await expect(startup()).resolves.toBeUndefined();
      expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toBeUndefined();
      expect(resolveRequestedSessionAgentId(config, `agent:${agentId}:main`)).toEqual({
        ok: true,
        agentId,
      });
      expect(openOpenClawAgentDatabase({ agentId, env }).agentId).toBe(agentId);
      deepStrictEqual(fs.readFileSync(`${target}.operator-backup`), copyBytes);
    },
  );
});
