import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { readAgentDatabaseAdmissionRefusal } from "./agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import {
  compatible,
  agentConfig,
  versionRow,
  closeDatabases,
  execSql,
  trackSettlement,
} from "./database-preflight-fixtures.test-support.js";
import { openOpenClawAgentDatabase, OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db.js";
import * as schemaInspection from "./openclaw-agent-schema-inspection-worker.js";
import {
  assertOpenClawDatabasesReady,
  preflightOpenClawDatabaseSchemas,
} from "./openclaw-database-preflight.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    closeDatabases();
    cleanup();
  });
});

function createFleet() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("preflight-startup-prepared-") };
  const agentIds = ["first", "second", "third"];
  const config = agentConfig(agentIds, "first");
  const paths = agentIds.map((agentId) => openOpenClawAgentDatabase({ agentId, env }).path);
  closeDatabases();
  for (const pathname of paths) {
    execSql(pathname, "PRAGMA journal_mode=DELETE;");
  }
  const onAgentInspection = vi.fn();
  const onRegisteredAgentDatabases = vi.fn();
  return {
    config,
    env,
    paths,
    agentIds,
    onAgentInspection,
    onRegisteredAgentDatabases,
    expectInspections: (count: number) =>
      expect(onAgentInspection).toHaveBeenLastCalledWith(
        count === 0
          ? { schemaInspectionCount: 0, schemaProcessCount: 0, schemaSnapshotCount: 0 }
          : expect.objectContaining({ schemaInspectionCount: count }),
      ),
    ready: () =>
      assertOpenClawDatabasesReady({
        env,
        config,
        operation: "gateway-startup",
        onAgentInspection,
        onRegisteredAgentDatabases,
      }),
    inspect: (
      overrides: Partial<Parameters<typeof preflightOpenClawDatabaseSchemas>[0]> = {},
      purpose?: Parameters<typeof preflightOpenClawDatabaseSchemas>[1],
    ) =>
      preflightOpenClawDatabaseSchemas(
        {
          env,
          reuseStartupSchemaPreparation: true,
          onAgentInspection,
          ...overrides,
        },
        purpose,
      ),
  };
}

function withImmediateAdmission(run: Parameters<typeof withAgentDatabaseStartupAdmission>[0]) {
  return withAgentDatabaseStartupAdmission(run, { deferInspections: false });
}

it("skips an unconfigured system-agent database across startup passes while keeping Doctor strict", async () => {
  const fleet = createFleet();
  const leftover = openOpenClawAgentDatabase({ agentId: "openclaw", env: fleet.env }).path;
  closeDatabases();
  fs.writeFileSync(leftover, "not a configured database");
  const before = fs.readFileSync(leftover);
  await withImmediateAdmission(async () => {
    await expect(fleet.ready()).resolves.toBeUndefined();
    fleet.expectInspections(fleet.paths.length);
    await expect(fleet.inspect({ agentAdmissionConfig: fleet.config })).resolves.toEqual(
      compatible,
    );
    fleet.expectInspections(0);
    expect(readAgentDatabaseAdmissionRefusal("openclaw", { env: fleet.env })).toBeUndefined();
  });
  await expect(
    assertOpenClawDatabasesReady({
      env: fleet.env,
      config: fleet.config,
      operation: "doctor",
      configuredAgentDatabaseTargets: [],
    }),
  ).rejects.toThrow();
  expect(fs.readFileSync(leftover)).toEqual(before);
});

it.each(["historical", "retired shared"] as const)(
  "does not activate %s database owners",
  async (kind) => {
    const fleet = createFleet();
    const historyPath = path.join(
      fleet.env.OPENCLAW_STATE_DIR,
      "rollback-drill",
      "openclaw-agent.sqlite",
    );
    const agentId = kind === "retired shared" ? "retired" : "first";
    if (kind === "retired shared") {
      fleet.config.session = { store: historyPath };
    }
    openOpenClawAgentDatabase({ agentId, path: historyPath, env: fleet.env });
    closeDatabases();
    revokeSqliteDatabaseAdmissionsForPath(historyPath);
    execSql(historyPath, "PRAGMA journal_mode=DELETE;");
    await withImmediateAdmission(async () => {
      await fleet.ready();
      expect(readAgentDatabaseAdmissionRefusal("first", { env: fleet.env })).toBeUndefined();
      expect(readAgentDatabaseAdmissionRefusal(agentId, { env: fleet.env })).toBeUndefined();
    });
  },
);

it("isolates an unreadable configured path while inspecting healthy agents", async () => {
  const fleet = createFleet();
  fleet.config.agents!.entries = { broken: {}, ...fleet.config.agents!.entries };
  fs.writeFileSync(path.join(fleet.env.OPENCLAW_STATE_DIR, "agents", "broken"), "not a directory");
  await withImmediateAdmission(async () => {
    await fleet.ready();
    expect(readAgentDatabaseAdmissionRefusal("first", { env: fleet.env })).toBeUndefined();
    expect(readAgentDatabaseAdmissionRefusal("broken", { env: fleet.env })).toMatchObject({
      code: "agent-database-inspection-failed",
      reason: expect.stringMatching(/ENOTDIR|not a directory/i),
    });
  });
});

it.for(["native", "ACP-only"] as const)(
  "keeps pending %s stores fenced without inspecting or copying them again in bootstrap",
  async (kind) => {
    const fleet = createFleet();
    if (kind === "ACP-only") {
      fleet.config.acp = { enabled: true, allowedAgents: ["codex"] };
    }
    const agentId = kind === "ACP-only" ? "codex" : "first";
    const pathname =
      kind === "ACP-only"
        ? openOpenClawAgentDatabase({ agentId, env: fleet.env }).path
        : fleet.paths[0]!;
    closeDatabases();
    execSql(pathname, "PRAGMA journal_mode=WAL;");
    const entered = createDeferred();
    const release = createDeferred();
    const createReader = schemaInspection.createAgentSchemaInspectionWorker;
    let paused = false;
    let selectedInspections = 0;
    vi.spyOn(schemaInspection, "createAgentSchemaInspectionWorker").mockImplementation(() => {
      const reader = createReader();
      const inspect = reader.inspect;
      return Object.assign(reader, {
        inspect: async (...args: Parameters<typeof inspect>) => {
          if (args[0].pathname === pathname) {
            selectedInspections += 1;
            if (!paused) {
              paused = true;
              entered.resolve();
              await release.promise;
            }
          }
          return inspect(...args);
        },
      });
    });
    const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation");
    await withAgentDatabaseStartupAdmission(async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const readiness = fleet.ready();
      const settled = trackSettlement(readiness);
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(settled()).toBe(true);
        await readiness;
        vi.useRealTimers();
        const refusal = readAgentDatabaseAdmissionRefusal(agentId, { env: fleet.env });
        expect(refusal?.code).toBe("agent-database-inspection-pending");
        expect(selectedInspections).toBe(1);

        const bootstrap = await fleet.inspect();
        expect(bootstrap.agentRefusals).toContain(refusal);
        expect(readAgentDatabaseAdmissionRefusal(agentId, { env: fleet.env })).toBe(refusal);
        expect(selectedInspections).toBe(1);
        expect(prepare.mock.calls.filter(([source]) => source === pathname)).toEqual([]);
      } finally {
        vi.useRealTimers();
        release.resolve();
        await Promise.allSettled([readiness]);
      }
    });
  },
);

it("carries fleet compatibility once into bootstrap while readiness always inspects fresh", async () => {
  const fleet = createFleet();
  await withImmediateAdmission(async () => {
    await fleet.ready();
    fleet.expectInspections(fleet.paths.length);
    // Migration admission before and under its lease must remain independent.
    await fleet.ready();
    fleet.expectInspections(fleet.paths.length);
    expect(await fleet.inspect()).toEqual(compatible);
    fleet.expectInspections(0);
    await fleet.inspect();
    fleet.expectInspections(fleet.paths.length);
  });
  await fleet.inspect();
  fleet.expectInspections(fleet.paths.length);
});

it("preserves configured ownership when reusing an unchanged inspected database", async () => {
  const fleet = createFleet();
  await withImmediateAdmission(async () => {
    await fleet.ready();
    const inspected = await fleet.inspect(
      {
        agentAdmissionConfig: agentConfig([...fleet.agentIds, "alias"], "first"),
        configuredAgentDatabaseTargets: [{ agentId: "alias", path: fleet.paths[0]! }],
      },
      "runtime",
    );
    expect(inspected).toMatchObject({ incompatible: [], indeterminate: [] });
    expect(inspected.agentRefusals).toEqual([
      expect.objectContaining({
        agentId: "alias",
        embeddedOwnerId: "first",
        code: "agent-database-ownership-mismatch",
        paths: [fleet.paths[0]],
      }),
    ]);
    fleet.expectInspections(0);
  });
});

it("reads newly registered stores without copying admitted state after startup writes", async () => {
  const fleet = createFleet();
  await withImmediateAdmission(async () => {
    await fleet.ready();
    expect(fleet.onRegisteredAgentDatabases).toHaveBeenLastCalledWith(
      fleet.paths.map((pathname, index) => ({
        agentId: ["first", "second", "third"][index],
        path: pathname,
      })),
    );
    const changedPath = openOpenClawAgentDatabase({ agentId: "newcomer", env: fleet.env }).path;
    closeDatabases();
    execSql(
      changedPath,
      `PRAGMA journal_mode=DELETE; PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`,
    );
    const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation");
    expect(await fleet.inspect()).toMatchObject({
      incompatible: [versionRow("agent", changedPath, OPENCLAW_AGENT_SCHEMA_VERSION + 1)],
      indeterminate: [],
    });
    const statePath = fs.realpathSync.native(
      path.join(fleet.env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite"),
    );
    expect(prepare.mock.calls.filter(([pathname]) => pathname === statePath)).toHaveLength(0);
    fleet.expectInspections(1);
    await fleet.ready();
    expect(fleet.onRegisteredAgentDatabases).toHaveBeenLastCalledWith(
      expect.arrayContaining([{ agentId: "newcomer", path: changedPath }]),
    );
  });
});

it("does not let prepared compatibility bypass cancellation or survive startup retirement", async () => {
  const fleet = createFleet();
  await withImmediateAdmission(async (admission) => {
    await fleet.ready();
    const controller = new AbortController();
    const cancellation = new Error("startup cancelled after fleet admission");
    controller.abort(cancellation);
    fleet.onAgentInspection.mockClear();
    await expect(fleet.inspect({ signal: controller.signal })).rejects.toBe(cancellation);
    expect(fleet.onAgentInspection).not.toHaveBeenCalled();
    await admission.stop();
    expect(await fleet.inspect()).toEqual(compatible);
    fleet.expectInspections(fleet.paths.length);
  });
});
