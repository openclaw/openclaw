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
      // Keep the real default state checks without auditing host services or plugin installs.
      const checks = actualChecks;
      return checks.filter((check) =>
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

const actualChecks = await (
  await vi.importActual<typeof import("../flows/doctor-health-contributions.js")>(
    "../flows/doctor-health-contributions.js",
  )
).resolveDoctorContributionHealthChecks();

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
  const database = new DatabaseSync(filename);
  let family: Array<{ filename: string; bytes: Buffer }>;
  try {
    database.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; ${sql}`);
    family = ["", "-wal", "-shm"].map((suffix) => ({
      filename: `${filename}${suffix}`,
      bytes: fs.readFileSync(`${filename}${suffix}`),
    }));
  } finally {
    database.close();
  }
  // Preserve a stopped writer's WAL family, including uncheckpointed schema and row changes.
  for (const artifact of family) {
    fs.writeFileSync(artifact.filename, artifact.bytes);
  }
}

it.each([
  { args: ["--lint", "--json"], exitCode: 1, customStore: false, schemaVersion: 20 },
  { args: ["--json"], exitCode: 0, customStore: true, schemaVersion: 19 },
  { args: ["--lint", "--all", "--json"], exitCode: 1, customStore: false, schemaVersion: 19 },
])(
  "doctor $args preserves schema $schemaVersion SQLite artifacts and reports pending repairs",
  async ({ args, exitCode, customStore, schemaVersion }) => {
    await withOpenClawTestState(
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
        const agentPath = openOpenClawAgentDatabase({
          agentId: "main",
          env: state.env,
          path: storePath,
        }).path;
        const sharedPath = resolveOpenClawStateSqlitePath(state.env);
        await closeOpenClawAgentDatabasesAsync();
        await closeStateDatabaseForTest();
        if (customStore) {
          const aliasDir = state.statePath("agent-alias");
          fs.symlinkSync(path.dirname(agentPath), aliasDir, "junction");
          const aliasPath = path.join(aliasDir, path.basename(agentPath));
          const normal = openOpenClawAgentDatabaseReadOnly({
            agentId: "main",
            env: state.env,
            path: aliasPath,
          });
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
          `DROP INDEX idx_meeting_transcript_sessions_source;
       DROP INDEX idx_meeting_transcript_sessions_account;
       DROP INDEX idx_meeting_transcript_sessions_agent;
       DROP INDEX idx_delivery_queue_bounded_retention;
       ALTER TABLE meeting_transcript_sessions DROP COLUMN source_account_id;
       ALTER TABLE meeting_transcript_sessions DROP COLUMN source_guild_id;
       ALTER TABLE meeting_transcript_sessions DROP COLUMN source_channel_id;
       ALTER TABLE meeting_transcript_sessions DROP COLUMN source_meeting_url;
       ALTER TABLE meeting_transcript_sessions DROP COLUMN source_thread_ts;
       ALTER TABLE meeting_transcript_sessions DROP COLUMN source_file_id;
       ALTER TABLE meeting_transcript_sessions DROP COLUMN metadata_agent_id;
       ALTER TABLE meeting_transcript_summaries DROP COLUMN overview;
       ALTER TABLE delivery_queue_entries DROP COLUMN retention_id_prefix;
       ALTER TABLE delivery_queue_entries DROP COLUMN retention_max_age_ms;
       ALTER TABLE delivery_queue_entries DROP COLUMN retention_max_entries;
       ${schemaVersion === 19 ? "ALTER TABLE cron_run_receipts DROP COLUMN delivery_attempt_state;" : ""}
       DELETE FROM agent_databases;
       PRAGMA user_version = ${schemaVersion};
       UPDATE schema_meta SET schema_version = ${schemaVersion} WHERE meta_key = 'primary';
       UPDATE config_machine_state SET value_json = '${schemaVersion}'
         WHERE state_key = 'state.schema.contentVersion';
       INSERT INTO cron_run_receipts (
         receipt_id, store_key, job_id, config_revision, agent_id, status,
         owner_pid, started_at_ms, finished_at_ms
       ) VALUES ('published-receipt', 'default', 'retained-job', '1', 'main', 'ok', 1, 1, 2);`,
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
        registerHealthCheck({
          id: "fixture/current-config",
          kind: "plugin",
          description: "Read current config through the plugin runtime accessor.",
          async detect() {
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
              const db = new DatabaseSync(snapshot.location, { readOnly: true });
              try {
                expect(db.prepare("SELECT COUNT(*) AS count FROM conversations").get()?.count).toBe(
                  1,
                );
              } finally {
                db.close();
              }
            } finally {
              expect(await snapshot.cleanupAsync()).toBe(true);
            }
            configRead = true;
            return [];
          },
        });
        for (const [name, write] of Object.entries({
          "async-agent": () =>
            withOpenClawAgentDatabaseAsync(
              { agentId: "main", env: state.env, path: storePath },
              () => {},
            ),
          shared: () => runOpenClawStateWriteTransaction(() => {}, { env: state.env }),
          agent: () =>
            openOpenClawAgentDatabase({ agentId: "main", env: state.env, path: storePath }),
        })) {
          registerHealthCheck({
            id: `fixture/forbidden-${name}-write`,
            kind: "plugin",
            description: "A detector must not open a writer.",
            async detect() {
              await write();
              return [];
            },
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
        await closeOpenClawAgentDatabasesAsync();
        await closeStateDatabaseForTest();
        expect(snapshotSqliteFiles(state.stateDir)).toEqual(before);
        const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
        expect(configRead, JSON.stringify(report)).toBe(true);
        expect(report.checksRun).toBeGreaterThanOrEqual(5);
        expect(report.findings).toEqual(
          expect.arrayContaining([
            ...["shared", "agent", "async-agent"].map((name) =>
              expect.objectContaining({
                checkId: `fixture/forbidden-${name}-write`,
                severity: "error",
                message: expect.stringContaining("Programming error:"),
              }),
            ),
            expect.objectContaining({
              checkId: "core/doctor/gateway-config",
              message: expect.stringContaining("gateway.mode is unset"),
            }),
            expect.objectContaining({
              checkId: "core/doctor/state-schema",
              message: expect.stringMatching(/migration pending/iu),
              fixHint: expect.stringContaining(
                customStore
                  ? "openclaw --profile doctor-readonly-fixture doctor --fix"
                  : "openclaw doctor --fix",
              ),
            }),
            expect.objectContaining({
              checkId: "core/doctor/telegram-general-topic-conversations",
              message: expect.stringContaining("stale Telegram General-topic"),
            }),
          ]),
        );
      },
    );
  },
);
