import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { checkDoctorStateSchemaPending } from "../flows/doctor-health-startup.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
import { resolvePendingLegacyStateDirMigrationPaths } from "../infra/state-migrations.state-dir.js";
import {
  closeDatabases,
  databaseFixture,
  supportedVersions,
} from "../state/database-preflight-fixtures.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_V26_SQL } from "../state/openclaw-agent-schema-v25.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import {
  checkDoctorAgentDeletionJournalPending,
  repairDoctorAgentDeletionJournal,
} from "./doctor-agent-deletion-journal.js";
import { prepareDoctorDatabasePreflight } from "./doctor-database-preflight.js";
import {
  checkDoctorDatabaseMigrationsPending,
  prepareDoctorMigrationBackups,
} from "./doctor-heartbeat-migration-backup.js";
import { traceDoctorMaintenancePending } from "./doctor-maintenance-pending.js";
import { withMaintenance } from "./doctor-schema-migrations.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  closeDatabases();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function capturePendingTrace() {
  vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "1");
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return () =>
    lines.filter((line) => line.includes("doctor.pending.") && line.includes("pending="));
}

/** Every entry under root with its bytes and modification time. */
function snapshotTree(root: string): Array<[string, string, bigint]> {
  const entries: Array<[string, string, bigint]> = [];
  const visit = (pathname: string) => {
    const stat = fs.lstatSync(pathname, { bigint: true });
    const bytes = stat.isFile() ? fs.readFileSync(pathname).toString("base64") : "";
    entries.push([path.relative(root, pathname), bytes, stat.mtimeNs]);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(pathname).toSorted()) {
        visit(path.join(pathname, name));
      }
    }
  };
  visit(root);
  return entries;
}

describe("Doctor maintenance pending contract", () => {
  it("treats a step without a check as work and traces the default", async () => {
    const trace = capturePendingTrace();

    await expect(traceDoctorMaintenancePending("config-flow")).resolves.toBe(true);

    expect(trace()).toEqual([
      expect.stringMatching(/doctor\.pending\.config-flow .* pending=work check=default /u),
    ]);
  });

  it.each([
    ["none", false],
    ["work", true],
    ["undecidable", true],
  ] as const)("reports an owner answer of %s as work=%s", async (answer, work) => {
    const trace = capturePendingTrace();

    await expect(traceDoctorMaintenancePending("state-schema", () => answer)).resolves.toBe(work);

    expect(trace()).toEqual([
      expect.stringMatching(new RegExp(`pending=${answer} check=owner `, "u")),
    ]);
  });

  it("counts a failing check as undecidable work", async () => {
    const trace = capturePendingTrace();

    await expect(
      traceDoctorMaintenancePending("sqlite-nocow", async () => {
        throw new Error("probe failed");
      }),
    ).resolves.toBe(true);

    expect(trace()).toEqual([expect.stringMatching(/pending=undecidable check=owner /u)]);
  });
});

describe("legacy state directory check", () => {
  it("finds a pending move from path metadata without touching either root", () => {
    const home = tempDirs.make("doctor-pending-legacy-");
    const legacy = path.join(home, ".clawdbot");
    fs.mkdirSync(path.join(legacy, "agents"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "clawdbot.json"), '{"gateway":{}}');
    const env = { HOME: home };
    const before = snapshotTree(home);

    expect(resolvePendingLegacyStateDirMigrationPaths({ env })).toEqual({
      source: legacy,
      target: path.join(home, ".openclaw"),
    });
    expect(snapshotTree(home)).toEqual(before);

    fs.mkdirSync(path.join(home, ".openclaw"));
    const moved = snapshotTree(home);
    expect(resolvePendingLegacyStateDirMigrationPaths({ env })).toBeUndefined();
    expect(snapshotTree(home)).toEqual(moved);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "cannot decide when the home cannot be inspected",
    async () => {
      const home = tempDirs.make("doctor-pending-legacy-unreadable-");
      fs.chmodSync(home, 0o000);
      try {
        const trace = capturePendingTrace();
        await expect(
          traceDoctorMaintenancePending("legacy-state-dir", () =>
            resolvePendingLegacyStateDirMigrationPaths({ env: { HOME: home } }) ? "work" : "none",
          ),
        ).resolves.toBe(true);
        expect(trace()).toEqual([expect.stringMatching(/pending=undecidable check=owner /u)]);
      } finally {
        fs.chmodSync(home, 0o700);
      }
    },
  );
});

describe("state schema check", () => {
  it("reads the prepared preflight and leaves the state database unchanged", async () => {
    const fixture = databaseFixture(tempDirs.make("doctor-pending-state-schema-"));
    fixture.state();
    closeDatabases();
    const before = snapshotTree(fixture.dir);

    expect(checkDoctorStateSchemaPending(await fixture.inspect({ scope: "state" }))).toBe("none");
    const newerRelease = await fixture.inspect({
      scope: "state",
      supportedVersions: { state: supportedVersions.state + 1, agent: supportedVersions.agent },
    });
    expect(checkDoctorStateSchemaPending(newerRelease)).toBe("work");

    expect(snapshotTree(fixture.dir)).toEqual(before);
  });
});

/** Bytes, mtime and inode of each SQLite file; the -shm index changes on every read, so only its inode. */
function snapshotStores(paths: readonly string[]) {
  return paths.flatMap((pathname) =>
    ["", "-wal", "-shm"].map((suffix) => {
      const file = `${pathname}${suffix}`;
      if (!fs.existsSync(file)) {
        return [file];
      }
      const stat = fs.statSync(file, { bigint: true });
      return suffix === "-shm"
        ? [file, stat.ino]
        : [file, fs.readFileSync(file).toString("base64"), stat.mtimeNs, stat.ino];
    }),
  );
}

/** An idle connection, as the serving Gateway holds, keeps the WAL sidecars in place. */
function holdOpen(pathname: string) {
  const database = new DatabaseSync(pathname);
  database.prepare("SELECT count(*) FROM sqlite_schema").get();
  return database;
}

describe("database migrations check", () => {
  it("reports a pending agent schema migration as work until the step migrates it", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("doctor-pending-migrations-") };
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    const statePath = openOpenClawStateDatabase({ env }).path;
    const agentPath = path.join(env.OPENCLAW_STATE_DIR, "agents/main/agent/openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    {
      // A store written by a release at agent schema v26.
      using legacy = new DatabaseSync(agentPath);
      legacy.exec(OPENCLAW_AGENT_SCHEMA_V26_SQL);
      legacy.exec("PRAGMA user_version = 26");
      legacy
        .prepare(
          "INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at) VALUES ('primary', 'agent', 26, 'main', 1, 1)",
        )
        .run();
    }
    const check = (schemas: Awaited<ReturnType<typeof prepareDoctorDatabasePreflight>>) =>
      checkDoctorDatabaseMigrationsPending({ schemas, env, automaticRepair: false });
    const preflight = await prepareDoctorDatabasePreflight();
    expect(preflight.pendingMigrations).toEqual([
      expect.objectContaining({ kind: "agent", path: agentPath }),
    ]);

    const gateway = holdOpen(agentPath);
    const pendingBefore = snapshotStores([statePath, agentPath]);
    await expect(check(preflight)).resolves.toBe("work");
    expect(snapshotStores([statePath, agentPath])).toEqual(pendingBefore);
    // The step needs the store to itself, as it has once Doctor stops the Gateway.
    gateway.close();
    await withMaintenance(() =>
      prepareDoctorMigrationBackups({
        schemas: preflight,
        env,
        check: "quick",
        verifiedSnapshots: [],
        automaticRepair: false,
        runtime: { log: () => {} },
        measure: (_name, run) => Promise.resolve(run()),
      }),
    );
    {
      using migrated = new DatabaseSync(agentPath, { readOnly: true });
      expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_AGENT_SCHEMA_VERSION,
      );
    }

    const current = await prepareDoctorDatabasePreflight();
    const restarted = holdOpen(agentPath);
    const before = snapshotStores([statePath, agentPath]);
    const files = fs.readdirSync(path.dirname(agentPath)).toSorted();
    await expect(check(current)).resolves.toBe("none");
    expect(snapshotStores([statePath, agentPath])).toEqual(before);
    expect(fs.readdirSync(path.dirname(agentPath)).toSorted()).toEqual(files);
    restarted.close();
  });
});

describe("agent deletion journal check", () => {
  it("reports unusable journal history as work until Doctor quarantines it", async () => {
    const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("doctor-pending-journal-")) };
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    const agentPath = createLegacyDatabaseFixture({
      agentId: "openclaw",
      env,
      eventsBySession: {},
    });
    // A reserved system agent id can never hold deletion authority, so the row is unusable.
    beginAgentDeletionJournal(
      {
        agentId: "openclaw",
        operationId: "unusable-deletion",
        agentDir: path.dirname(agentPath),
        workspaceDir: path.join(env.OPENCLAW_STATE_DIR, "workspace-openclaw"),
        sessionsDir: path.join(env.OPENCLAW_STATE_DIR, "agents", "openclaw", "sessions"),
        deleteFiles: false,
        databasePaths: [],
      },
      { env },
    );
    const statePath = openOpenClawStateDatabase({ env }).path;
    const cfg = { agents: { entries: { main: {} } }, plugins: { enabled: false } };
    const preflight = await prepareDoctorDatabasePreflight({ cfg });
    const before = snapshotStores([statePath]);

    expect(checkDoctorAgentDeletionJournalPending({ preflight, env })).toBe("work");
    expect(snapshotStores([statePath])).toEqual(before);

    const repaired = await repairDoctorAgentDeletionJournal({ preflight, shouldRepair: true, env });
    expect(repaired.changes.join("\n")).toContain("Quarantined unusable agent deletion journal");
    const next = await prepareDoctorDatabasePreflight({ cfg });
    const settled = snapshotStores([statePath]);
    expect(checkDoctorAgentDeletionJournalPending({ preflight: next, env })).toBe("none");
    expect(snapshotStores([statePath])).toEqual(settled);
    expect(
      (await repairDoctorAgentDeletionJournal({ preflight: next, shouldRepair: true, env }))
        .changes,
    ).toEqual([]);
  });
});
