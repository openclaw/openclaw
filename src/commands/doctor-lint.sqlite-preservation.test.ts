import "../test-utils/prepare-compiled-subprocesses.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { prepareAgentAuthProfileRowsRead } from "../agents/auth-profiles/sqlite-read.js";
import { inspectAuthProfileJsonCellReadOnly } from "../agents/auth-profiles/sqlite.js";
import { registerMaintenanceCommands } from "../cli/program/register.maintenance.js";
import { getRuntimeConfig } from "../config/io.runtime.js";
import { clearHealthChecksForTest, registerHealthCheck } from "../flows/health-check-registry.js";
import type { HealthCheck } from "../flows/health-checks.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { ExitError } from "../runtime.js";
import { openOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-open.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  withOpenClawAgentDatabaseAsync,
} from "../state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

vi.mock("../flows/doctor-health-contributions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../flows/doctor-health-contributions.js")>();
  return {
    ...actual,
    async resolveDoctorContributionHealthChecks() {
      return (await actual.resolveDoctorContributionHealthChecks()).filter((check) =>
        [
          "core/doctor/agent-database-admission",
          "core/doctor/gateway-config",
          "core/doctor/legacy-state",
          "core/doctor/telegram-general-topic-conversations",
        ].includes(check.id),
      );
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  clearHealthChecksForTest();
});

function snapshotSqliteFiles(stateDir: string) {
  return fs
    .readdirSync(stateDir, { recursive: true, encoding: "utf8" })
    .filter((relative) => /\.sqlite(?:-(?:wal|shm|journal))?$/u.test(relative))
    .toSorted()
    .map((relative) => {
      const filename = path.join(stateDir, relative);
      return {
        path: relative,
        sha256: createHash("sha256").update(fs.readFileSync(filename)).digest("hex"),
        mtimeNs: fs.statSync(filename, { bigint: true }).mtimeNs,
      };
    });
}

function seedStoppedWalDatabase(filename: string, sql: string): void {
  let family: Array<{ filename: string; bytes: Buffer }>;
  {
    using database = new DatabaseSync(filename);
    database.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; ${sql}`);
    family = ["", "-wal", "-shm"].map((suffix) => ({
      filename: `${filename}${suffix}`,
      bytes: fs.readFileSync(`${filename}${suffix}`),
    }));
  }
  // Preserve a stopped writer's WAL family, including uncheckpointed schema and row changes.
  for (const artifact of family) {
    fs.writeFileSync(artifact.filename, artifact.bytes);
  }
}

const finding = (checkId: string, message: string | RegExp, extra = {}) =>
  expect.objectContaining({
    checkId,
    message:
      typeof message === "string"
        ? expect.stringContaining(message)
        : expect.stringMatching(message),
    ...extra,
  });

const dropColumns = (table: string, columns: string) =>
  columns
    .split(" ")
    .map((column) => `ALTER TABLE ${table} DROP COLUMN ${column};`)
    .join("\n");

function registerDetector(id: string, detect: HealthCheck["detect"]) {
  registerHealthCheck({ id: `fixture/${id}`, kind: "plugin", description: id, detect });
}

it.each([
  { args: ["--lint", "--json"], exitCode: 1, customStore: false, schemaVersion: 20 },
  { args: ["--json"], exitCode: 0, customStore: true, schemaVersion: 19 },
  { args: ["--lint", "--all", "--json"], exitCode: 1, customStore: false, schemaVersion: 19 },
])(
  "doctor $args preserves schema $schemaVersion SQLite artifacts and reports pending repairs",
  ({ args, exitCode, customStore, schemaVersion }) =>
    withOpenClawTestState(
      {
        label: "doctor-readonly-sqlite",
        layout: "split",
        env: { OPENCLAW_PROFILE: customStore ? "doctor-readonly-fixture" : undefined },
      },
      async (state) => {
        clearHealthChecksForTest();
        const storePath = customStore ? state.statePath("fixed.sqlite") : undefined;
        await state.writeConfig({
          ...(storePath ? { session: { store: storePath } } : {}),
          agents: { entries: { main: { workspace: state.workspaceDir } } },
          plugins: { enabled: false },
          memory: { search: { enabled: false } },
        });
        const agentOptions = { agentId: "main", env: state.env, path: storePath };
        const agentPath = openOpenClawAgentDatabase(agentOptions).path;
        const sharedPath = resolveOpenClawStateSqlitePath(state.env);
        const closeDatabases = async () => {
          await closeOpenClawAgentDatabasesAsync();
          await closeStateDatabaseForTest();
        };
        await closeDatabases();
        if (customStore) {
          const aliasDir = state.statePath("agent-alias");
          fs.symlinkSync(path.dirname(agentPath), aliasDir, "junction");
          const aliasPath = path.join(aliasDir, path.basename(agentPath));
          const normal = openOpenClawAgentDatabaseReadOnly({ ...agentOptions, path: aliasPath });
          try {
            expect(normal.found && normal.database.path).toBe(aliasPath);
          } finally {
            if (normal.found) {
              normal.database.close();
            }
            fs.rmSync(aliasDir);
          }
        }
        seedStoppedWalDatabase(
          sharedPath,
          `${["source", "account", "agent"].map((key) => `DROP INDEX idx_meeting_transcript_sessions_${key};`).join("\n")}
       DROP INDEX idx_delivery_queue_bounded_retention;
       ${dropColumns("meeting_transcript_sessions", "source_account_id source_guild_id source_channel_id source_meeting_url source_thread_ts source_file_id metadata_agent_id")}
       ${dropColumns("meeting_transcript_summaries", "overview")}
       ${dropColumns("delivery_queue_entries", "retention_id_prefix retention_max_age_ms retention_max_entries")}
       ${schemaVersion === 19 ? "ALTER TABLE cron_run_receipts DROP COLUMN delivery_attempt_state;" : ""}
       DELETE FROM agent_databases;
       PRAGMA user_version = ${schemaVersion};
       UPDATE schema_meta SET schema_version = ${schemaVersion} WHERE meta_key = 'primary';
       UPDATE config_machine_state SET value_json = '${schemaVersion}'
         WHERE state_key = 'state.schema.contentVersion';
       INSERT INTO cron_run_receipts (
         cursor_id, receipt_id, store_key, job_id, config_revision, agent_id, status,
         owner_pid, started_at_ms, finished_at_ms
       ) VALUES (1, 'published-receipt', 'default', 'retained-job', '1', 'main', 'ok', 1, 1, 2);`,
        );
        seedStoppedWalDatabase(
          agentPath,
          `INSERT INTO conversations (
         conversation_id, channel, account_id, kind, peer_id, delivery_target,
         thread_id, created_at, updated_at
       ) VALUES (
         'legacy-general-topic', 'telegram', 'default', 'group', '-1001234567890:topic:1',
         'telegram:-1001234567890:topic:1', '1', 1, 1
       );`,
        );
        if (args.includes("--all")) {
          const legacyPath = state.statePath("agent", "openclaw-agent.sqlite");
          fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
          for (const suffix of ["", "-wal", "-shm"]) {
            fs.copyFileSync(`${agentPath}${suffix}`, `${legacyPath}${suffix}`);
          }
        }
        let configRead = false;
        registerDetector("current-config", async () => {
          expect(Object.keys(getRuntimeConfig().agents?.entries ?? {})).toEqual(["main"]);
          expect(
            inspectAuthProfileJsonCellReadOnly(
              { kind: "agent", path: agentPath, env: state.env },
              "store",
            ).status,
          ).toBe("missing");
          const auth = prepareAgentAuthProfileRowsRead({
            databasePath: agentPath,
            agentId: "main",
            env: state.env,
          });
          try {
            expect((await auth.read()).store.status).toBe("missing");
          } finally {
            await auth.dispose();
          }
          const snapshot = await prepareSqliteReadOnlyLocation(agentPath);
          try {
            using db = new DatabaseSync(snapshot.location, { readOnly: true });
            const row = db.prepare("SELECT COUNT(*) AS count FROM conversations").get();
            expect(row?.count).toBe(1);
          } finally {
            expect(await snapshot.cleanupAsync()).toBe(true);
          }
          configRead = true;
          return [];
        });
        for (const [name, write] of Object.entries({
          "async-agent": () => withOpenClawAgentDatabaseAsync(agentOptions, () => {}),
          shared: () => runOpenClawStateWriteTransaction(() => {}, { env: state.env }),
          agent: () => openOpenClawAgentDatabase(agentOptions),
        })) {
          registerDetector(`forbidden-${name}-write`, async () => {
            await write();
            return [];
          });
        }
        const before = snapshotSqliteFiles(state.stateDir);
        expect(before.map((artifact) => artifact.path)).toEqual(
          expect.arrayContaining(
            [sharedPath, agentPath].flatMap((filename) =>
              ["", "-wal", "-shm"].map((suffix) =>
                path.relative(state.stateDir, `${filename}${suffix}`),
              ),
            ),
          ),
        );
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const program = new Command();
        registerMaintenanceCommands(program);
        await expect(program.parseAsync(["doctor", ...args], { from: "user" })).rejects.toEqual(
          new ExitError(exitCode),
        );
        await closeDatabases();
        expect(snapshotSqliteFiles(state.stateDir)).toEqual(before);
        const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
        expect(configRead, JSON.stringify(report)).toBe(true);
        expect(report.checksRun).toBeGreaterThanOrEqual(5);
        expect(report.findings).toEqual(
          expect.arrayContaining([
            ...["shared", "agent", "async-agent"].map((name) =>
              finding(`fixture/forbidden-${name}-write`, "Programming error:", {
                severity: "error",
              }),
            ),
            finding("core/doctor/gateway-config", "gateway.mode is unset"),
            finding("core/doctor/state-schema", /migration pending/iu, {
              fixHint: expect.stringContaining(
                customStore
                  ? "openclaw --profile doctor-readonly-fixture doctor --fix"
                  : "openclaw doctor --fix",
              ),
            }),
            finding(
              "core/doctor/telegram-general-topic-conversations",
              "stale Telegram General-topic",
            ),
          ]),
        );
      },
    ),
);
