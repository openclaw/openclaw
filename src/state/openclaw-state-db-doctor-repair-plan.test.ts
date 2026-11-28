import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OLDER_OPERATOR_APPROVAL_SCHEMA_SQL } from "../gateway/operator-approval-store.older-reader.test-support.js";
import { resolveClientCredentialStorePath } from "../infra/client-credential-paths.js";
import { corruptSqliteIndexKey } from "../infra/sqlite-index-corruption.test-support.js";
import * as snapshotStaging from "../infra/sqlite-snapshot-staging.js";
import {
  original as historicalOriginal,
  preparation as historicalPreparation,
} from "./openclaw-historical-imports.test-support.js";
import { seedOpenClawDatabaseQuarantine } from "./openclaw-quarantine-store.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { createDanglingSkillWorkshopReviewIndex } from "./openclaw-state-db-corruption.test-support.js";
import { planOpenClawStateDatabaseDoctorRepair } from "./openclaw-state-db-doctor-repair-plan.js";
import { repairStateSchemaAsync } from "./openclaw-state-db-repair.js";
import { ensureRepositoryGitHubPublicationSchema } from "./openclaw-state-db-schema-additive.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  prepareOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { resolveQuarantineStorePath } from "./openclaw-state-db.paths.js";

// Records every write-mode SQLite open made in this process; the opens still happen.
const writableOpens = vi.hoisted(() => [] as string[]);
vi.mock("../infra/node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/node-sqlite.js")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (...args: Parameters<typeof actual.openNodeSqliteDatabase>) => {
      if (args[1]?.readOnly !== true) {
        writableOpens.push(args[0]);
      }
      return actual.openNodeSqliteDatabase(...args);
    },
  };
});

/** Write-mode opens of the shared, quarantine or credential store since `since`. */
function storeWritesSince(env: NodeJS.ProcessEnv, since: number) {
  return writableOpens
    .slice(since)
    .filter((location) => location.includes(env.OPENCLAW_STATE_DIR!))
    .map((location) => path.basename(location.replace(/\?.*$/u, "")));
}

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.restoreAllMocks();
    cleanup();
  }),
);

const handles: DatabaseSync[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) {
    if (handle.isOpen) {
      handle.close();
    }
  }
});

/** Holds the store open as the serving Gateway does, so its WAL sidecars exist. */
function holdOpen(databasePath: string): DatabaseSync {
  const gateway = new DatabaseSync(databasePath);
  gateway.prepare("SELECT count(*) FROM sqlite_schema").get();
  handles.push(gateway);
  return gateway;
}

/** A current store after one Doctor repair (a fresh store first records its ACP accounting). */
async function healthyStore() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("state-schema-plan-") };
  const databasePath = openOpenClawStateDatabase({ env }).path;
  await closeOpenClawStateDatabaseAsync();
  await prepareOpenClawStateDatabaseSchema({ env }, "doctor");
  await closeOpenClawStateDatabaseAsync();
  return { env, databasePath, gateway: holdOpen(databasePath) };
}

/** Names, bytes, modes and inodes of every file in the state directories but the -shm index. */
function snapshotStores(env: NodeJS.ProcessEnv) {
  const roots = [
    path.join(env.OPENCLAW_STATE_DIR!, "state"),
    path.join(env.OPENCLAW_STATE_DIR!, "client"),
  ];
  return roots.flatMap((root) =>
    fs.existsSync(root)
      ? fs
          .readdirSync(root)
          .toSorted()
          .map((name) => {
            const file = path.join(root, name);
            const stat = fs.statSync(file, { bigint: true });
            return [
              file,
              stat.mode,
              stat.ino,
              name.endsWith("-shm") || stat.isDirectory()
                ? ""
                : fs.readFileSync(file).toString("base64"),
              name.endsWith("-shm") ? 0n : stat.mtimeNs,
            ];
          })
      : [],
  );
}

/** Every catalog entry and row, for comparing what a repair changed. */
function dumpContent(databasePath: string) {
  using db = new DatabaseSync(databasePath, { readOnly: true });
  const schema = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
    .all();
  const rows = Object.fromEntries(
    schema
      .filter((entry) => entry.type === "table" && !String(entry.name).startsWith("sqlite_"))
      .map((entry) => [
        entry.name,
        db.prepare(`SELECT * FROM "${String(entry.name)}" ORDER BY 1`).all(),
      ]),
  );
  return {
    userVersion: db.prepare("PRAGMA user_version").get()?.user_version,
    schema,
    rows,
  };
}

function plan(env: NodeJS.ProcessEnv, integrityCheck: "quick" | "full" = "quick") {
  return planOpenClawStateDatabaseDoctorRepair({ env, integrityCheck });
}

async function expectAllNone(env: NodeJS.ProcessEnv, integrityCheck: "quick" | "full" = "quick") {
  const result = await plan(env, integrityCheck);
  expect(Object.entries(result.conditions).filter(([, answer]) => answer !== "none")).toEqual([]);
  expect(result.decision).toBe("none");
}

/**
 * One condition, really created: the plan reports work for it without touching a store,
 * Doctor's schema preparation still runs the repair, and the repair either fixes it (the plan
 * then answers none) or refuses with a warning (the plan keeps answering work).
 */
async function expectConditionDrivesRepair(params: {
  condition: string;
  create: (fixture: Awaited<ReturnType<typeof healthyStore>>) => unknown;
  refusal?: boolean;
  integrityCheck?: "quick" | "full";
  verify?: (fixture: Awaited<ReturnType<typeof healthyStore>>) => void;
}) {
  const fixture = await healthyStore();
  await params.create(fixture);
  const integrityCheck = params.integrityCheck ?? "quick";
  const before = snapshotStores(fixture.env);

  const planOpens = writableOpens.length;
  const planned = await plan(fixture.env, integrityCheck);
  expect(storeWritesSince(fixture.env, planOpens)).toEqual([]);
  expect(planned.conditions[params.condition]).toBe("work");
  expect(planned.decision).toBe("work");
  expect(snapshotStores(fixture.env)).toEqual(before);

  const opens = writableOpens.length;
  const repaired = await prepareOpenClawStateDatabaseSchema(
    { env: fixture.env, integrityCheck },
    "doctor",
  );
  // The repair ran as before: it opened the shared store for writing.
  expect(storeWritesSince(fixture.env, opens)).toContain("openclaw.sqlite");
  await closeOpenClawStateDatabaseAsync();
  if (params.refusal) {
    expect(repaired.warnings).not.toEqual([]);
    expect((await plan(fixture.env, integrityCheck)).conditions[params.condition]).toBe("work");
  } else {
    expect(repaired.warnings).toEqual([]);
    expect(snapshotStores(fixture.env)).not.toEqual(before);
    await expectAllNone(fixture.env, integrityCheck);
  }
  params.verify?.(fixture);
}

describe("planOpenClawStateDatabaseDoctorRepair", () => {
  it("answers none on a healthy store, and Doctor then leaves every store untouched", async () => {
    const { env } = await healthyStore();
    const copies = [
      vi.spyOn(snapshotStaging, "createSqliteSnapshotStagingDirectory"),
      vi.spyOn(snapshotStaging, "createSqliteSnapshotStagingDirectorySync"),
    ];
    const before = snapshotStores(env);

    await expectAllNone(env);
    await expectAllNone(env, "full");
    expect(snapshotStores(env)).toEqual(before);
    for (const copy of copies) {
      expect(copy).not.toHaveBeenCalled();
    }

    // No write-mode open of any store, and no file changes.
    const opens = writableOpens.length;
    expect(await prepareOpenClawStateDatabaseSchema({ env }, "doctor")).toEqual({
      changes: [],
      warnings: [],
    });
    expect(storeWritesSince(env, opens)).toEqual([]);
    expect(snapshotStores(env)).toEqual(before);
  });

  it("answers none only where the repair, forced to run, changes no catalog entry or row", async () => {
    const { env, databasePath } = await healthyStore();
    await expectAllNone(env);
    const content = dumpContent(databasePath);

    const forced = await repairStateSchemaAsync(databasePath, env, "doctor");

    expect(forced).toEqual({ changes: [], warnings: [] });
    expect(dumpContent(databasePath)).toEqual(content);
  });

  it("cannot decide a store nobody holds open, so Doctor repairs it as before", async () => {
    const { env, databasePath, gateway } = await healthyStore();
    gateway.exec("CREATE TABLE node_pairing_pending (id TEXT)");
    gateway.close();
    const files = fs.readdirSync(path.dirname(databasePath)).toSorted();

    expect((await plan(env)).decision).toBe("undecidable");
    expect(fs.readdirSync(path.dirname(databasePath)).toSorted()).toEqual(files);

    await prepareOpenClawStateDatabaseSchema({ env }, "doctor");
    expect(dumpContent(databasePath).schema.map(({ name }) => name)).not.toContain(
      "node_pairing_pending",
    );
  });

  it("cannot decide an unreadable credential store, so Doctor repairs and reports it", async () => {
    const { env } = await healthyStore();
    fs.writeFileSync(resolveClientCredentialStorePath(env), "not a database", { mode: 0o600 });

    expect((await plan(env)).decision).toBe("undecidable");

    const opens = writableOpens.length;
    const repaired = await prepareOpenClawStateDatabaseSchema({ env }, "doctor");
    expect(storeWritesSince(env, opens)).toContain("openclaw.sqlite");
    expect(repaired.warnings).not.toEqual([]);
  });

  it("answers none for a missing store, which the repair also leaves alone", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("state-schema-plan-missing-") };
    expect(await plan(env)).toEqual({ decision: "none", conditions: {} });
  });
});

describe("each condition the doctor repair acts on", () => {
  it.skipIf(process.platform === "win32")("permissions: a broadened file mode", () =>
    expectConditionDrivesRepair({
      condition: "permissions",
      create: ({ databasePath }) => fs.chmodSync(databasePath, 0o644),
      verify: ({ databasePath }) => expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600),
    }),
  );

  it("recorded-damage: a persisted quarantine verdict", () =>
    expectConditionDrivesRepair({
      condition: "recorded-damage",
      create: ({ env, databasePath }) =>
        seedOpenClawDatabaseQuarantine({
          env,
          kind: "state",
          path: databasePath,
          reason: "seeded integrity failure",
        }),
    }));

  it("quarantine-store: a schema-1 quarantine store its writer migrates", () =>
    expectConditionDrivesRepair({
      condition: "quarantine-store",
      create: ({ env, databasePath }) => {
        // A record for another database creates the store without quarantining this one.
        seedOpenClawDatabaseQuarantine({
          env,
          kind: "state",
          path: `${databasePath}.other`,
          reason: "seeded for another store",
        });
        using store = new DatabaseSync(resolveQuarantineStorePath(env));
        store.exec(
          "ALTER TABLE quarantined_databases DROP COLUMN verified_generation; PRAGMA user_version = 1",
        );
      },
    }));

  it("quarantine-store: a quarantine store whose clear fails, which the repair reports", () =>
    expectConditionDrivesRepair({
      condition: "quarantine-store",
      refusal: true,
      create: ({ env, databasePath }) => {
        seedOpenClawDatabaseQuarantine({
          env,
          kind: "state",
          path: `${databasePath}.other`,
          reason: "seeded for another store",
        });
        using store = new DatabaseSync(resolveQuarantineStorePath(env));
        store.exec("DROP TABLE quarantined_databases");
      },
    }));

  it("catalog-readability: the dangling Skill Workshop review index", () =>
    expectConditionDrivesRepair({
      condition: "catalog-readability",
      create: ({ databasePath }) => {
        createDanglingSkillWorkshopReviewIndex(databasePath);
      },
    }));

  it("registry-key: a noncanonical agent database registry key", () =>
    expectConditionDrivesRepair({
      condition: "registry-key",
      refusal: true,
      create: ({ gateway }) =>
        gateway.exec(
          "DROP TABLE agent_databases; CREATE TABLE agent_databases (agent_id TEXT PRIMARY KEY, path TEXT NOT NULL, schema_version INTEGER, last_seen_at INTEGER, size_bytes INTEGER) STRICT;",
        ),
    }));

  it("schema-version: owner metadata behind the published version", () =>
    expectConditionDrivesRepair({
      condition: "schema-version",
      create: ({ gateway }) =>
        gateway
          .prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'")
          .run(OPENCLAW_STATE_SCHEMA_VERSION - 1),
      verify: ({ databasePath }) =>
        expect(dumpContent(databasePath).rows.schema_meta).toContainEqual(
          expect.objectContaining({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION }),
        ),
    }));

  it("integrity: an index key the full check finds damaged", () =>
    expectConditionDrivesRepair({
      condition: "integrity",
      integrityCheck: "full",
      create: ({ databasePath, gateway }) => {
        gateway
          .prepare(
            "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at) VALUES ('planprobe', 'ns', 'key', '{}', 1)",
          )
          .run();
        gateway.close();
        corruptSqliteIndexKey(databasePath, "idx_plugin_state_listing", "planprobe", "planprobf");
        holdOpen(databasePath);
      },
    }));

  it("orphan-task-delivery: a delivery row without its task", () =>
    expectConditionDrivesRepair({
      condition: "orphan-task-delivery",
      create: ({ gateway }) => {
        gateway.exec("PRAGMA foreign_keys = OFF");
        gateway
          .prepare(
            "INSERT INTO task_delivery_state (task_id, requester_origin_json, last_notified_event_at) VALUES ('orphan', '{}', 1)",
          )
          .run();
      },
    }));

  it("client-credentials: a local receipt left in the copied phase", () =>
    expectConditionDrivesRepair({
      condition: "client-credentials",
      create: ({ env }) => {
        using store = new DatabaseSync(resolveClientCredentialStorePath(env));
        store.exec("UPDATE client_credential_migration SET phase = 'copied'");
      },
      verify: ({ env }) => {
        using store = new DatabaseSync(resolveClientCredentialStorePath(env), { readOnly: true });
        expect(store.prepare("SELECT phase FROM client_credential_migration").get()).toEqual({
          phase: "complete",
        });
      },
    }));

  it("required-tables: a missing required table", () =>
    expectConditionDrivesRepair({
      condition: "required-tables",
      refusal: true,
      create: ({ gateway }) => gateway.exec("DROP TABLE subagent_runs"),
    }));

  it("legacy-tables: a retired node pairing table", () =>
    expectConditionDrivesRepair({
      condition: "legacy-tables",
      create: ({ gateway }) => gateway.exec("CREATE TABLE node_pairing_pending (id TEXT)"),
      verify: ({ databasePath }) =>
        expect(dumpContent(databasePath).schema.map(({ name }) => name)).not.toContain(
          "node_pairing_pending",
        ),
    }));

  it("session-watch: a legacy ambient-watch sentinel row", () =>
    expectConditionDrivesRepair({
      condition: "session-watch",
      create: ({ gateway }) =>
        gateway
          .prepare(
            "INSERT INTO session_watch_cursors (watcher_session_key, target_session_key, updated_at) VALUES (?, 'agent:main:target', 1)",
          )
          .run(`ambient-group-watch:${Buffer.from("agent:main:watcher").toString("hex")}`),
      verify: ({ databasePath }) =>
        expect(dumpContent(databasePath).rows.session_watch_cursors).toEqual([]),
    }));

  it("additive-schema: the retired diagnostic event index", () =>
    expectConditionDrivesRepair({
      condition: "additive-schema",
      create: ({ gateway }) =>
        gateway.exec(
          "CREATE INDEX idx_diagnostic_events_scope_created ON diagnostic_events(scope, created_at)",
        ),
    }));

  it("acp-replay-accounting: the recount's completion record is missing", () =>
    expectConditionDrivesRepair({
      condition: "acp-replay-accounting",
      create: ({ gateway }) =>
        gateway.exec(
          "DELETE FROM config_machine_state WHERE state_key = 'state.repair.acpReplayUtf8Accounting'",
        ),
    }));

  it("cron-job-projection: a job whose query projection lags its definition", () =>
    expectConditionDrivesRepair({
      condition: "cron-job-projection",
      create: ({ gateway }) =>
        gateway
          .prepare(
            "INSERT INTO cron_jobs (store_key, job_id, name, enabled, payload_kind, job_json, updated_at) VALUES ('default', 'job-1', '', 1, 'message', ?, 5)",
          )
          .run(
            JSON.stringify({
              name: "nightly",
              schedule: { kind: "cron", expr: "0 3 * * *" },
              payload: { kind: "agentTurn", message: "summarize" },
            }),
          ),
      verify: ({ databasePath }) =>
        expect(dumpContent(databasePath).rows.cron_jobs).toEqual([
          expect.objectContaining({ name: "nightly", payload_kind: "agentTurn" }),
        ]),
    }));

  it("delivery-queue: a pending row whose retry count lags its entry", () =>
    expectConditionDrivesRepair({
      condition: "delivery-queue",
      create: ({ gateway }) =>
        gateway
          .prepare(
            "INSERT INTO delivery_queue_entries (queue_name, id, status, retry_count, entry_json, enqueued_at, updated_at) VALUES ('outbound', 'entry-1', 'pending', 0, ?, 1, 1)",
          )
          .run(JSON.stringify({ id: "entry-1", retryCount: 2, channel: "telegram" })),
      verify: ({ databasePath }) =>
        expect(dumpContent(databasePath).rows.delivery_queue_entries).toEqual([
          expect.objectContaining({ retry_count: 2, channel: "telegram" }),
        ]),
    }));

  it("delivery-queue: a completed receipt past its retention", () =>
    expectConditionDrivesRepair({
      condition: "delivery-queue",
      create: ({ gateway }) =>
        gateway
          .prepare(
            "INSERT INTO delivery_queue_entries (queue_name, id, status, entry_json, enqueued_at, updated_at) VALUES ('outbound', 'old', 'completed', '{}', 1, 1)",
          )
          .run(),
      verify: ({ databasePath }) =>
        expect(dumpContent(databasePath).rows.delivery_queue_entries).toEqual([]),
    }));

  it("subagent-runs: a run whose terminal fields sit at the payload root", () =>
    expectConditionDrivesRepair({
      condition: "subagent-runs",
      create: ({ gateway }) =>
        gateway
          .prepare(
            "INSERT INTO subagent_runs (run_id, child_session_key, requester_session_key, created_at, payload_json) VALUES ('run-1', 'agent:main:child', 'agent:main:main', 1, ?)",
          )
          .run(JSON.stringify({ startedAt: 1, execution: { status: "running" } })),
    }));

  it("operator-approval-refs: the transport reference index is missing", () =>
    expectConditionDrivesRepair({
      condition: "operator-approval-refs",
      create: ({ gateway }) => gateway.exec("DROP INDEX idx_operator_approvals_resolution_ref"),
    }));

  it("audit-and-approval-schema: operator approvals in the two-kind legacy layout", () =>
    expectConditionDrivesRepair({
      condition: "audit-and-approval-schema",
      create: ({ gateway }) => {
        gateway.exec("DROP TABLE operator_approvals");
        gateway.exec(
          OLDER_OPERATOR_APPROVAL_SCHEMA_SQL.replace(
            "'exec', 'plugin', 'system-agent'",
            "'exec', 'plugin'",
          ),
        );
      },
      verify: ({ databasePath }) =>
        expect(
          dumpContent(databasePath).schema.find(({ name }) => name === "operator_approvals")?.sql,
        ).toContain("'system-agent'"),
    }));

  it("publication-drafts: a publication table without its draft column", () =>
    expectConditionDrivesRepair({
      condition: "publication-drafts",
      create: ({ gateway }) => {
        ensureRepositoryGitHubPublicationSchema(gateway);
        gateway.exec("ALTER TABLE github_repository_publication_requests DROP COLUMN draft");
      },
    }));

  it("historical-image-snapshots: a reserve snapshot with a retired image project", () =>
    expectConditionDrivesRepair({
      condition: "historical-image-snapshots",
      create: ({ gateway }) =>
        gateway
          .prepare(
            "INSERT INTO worker_environments " +
              "(environment_id,provider_id,profile_id,profile_snapshot_json,provision_operation_id,lease_id," +
              "preparation_key,preparation_purpose,preparation_demand_at_ms,preparation_expires_at_ms," +
              "preparation_consumed_at_ms,state,owner_epoch,attached_session_ids_json," +
              "created_at_ms,updated_at_ms,state_changed_at_ms,destroy_requested_at_ms) " +
              "VALUES ('image-env', 'synthetic','profile',?,'op','lease',?,'reserve',1000,2000,1500,'destroyed',7,'[]',1,2,2,2)",
          )
          .run(historicalOriginal, historicalPreparation.key),
      verify: ({ databasePath }) =>
        expect(
          JSON.parse(
            String(dumpContent(databasePath).rows.worker_environments?.[0]?.profile_snapshot_json),
          ),
        ).toHaveProperty("historicalProfileSnapshotJson", historicalOriginal),
    }));

  it("legacy-cron-run-logs: a retired cron run log table", () =>
    expectConditionDrivesRepair({
      condition: "legacy-cron-run-logs",
      create: ({ gateway }) =>
        gateway.exec(`CREATE TABLE cron_run_logs (
          store_key TEXT NOT NULL, job_id TEXT NOT NULL, seq INTEGER NOT NULL,
          ts INTEGER NOT NULL, entry_json TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY (store_key, job_id, seq)
        );
        CREATE INDEX idx_cron_run_logs_store_ts ON cron_run_logs(store_key, ts DESC, seq DESC);`),
      verify: ({ databasePath }) =>
        expect(dumpContent(databasePath).schema.map(({ name }) => name)).not.toContain(
          "cron_run_logs",
        ),
    }));

  it("canonical-indexes: a canonical index with a changed definition", () =>
    expectConditionDrivesRepair({
      condition: "canonical-indexes",
      create: ({ gateway }) =>
        gateway.exec(
          "DROP INDEX idx_plugin_state_listing; CREATE INDEX idx_plugin_state_listing ON plugin_state_entries(plugin_id)",
        ),
    }));

  it("canonical-catalog: a runtime table rebuilt without STRICT", () =>
    expectConditionDrivesRepair({
      condition: "canonical-catalog",
      create: ({ gateway }) =>
        gateway.exec(
          "DROP TABLE worker_turn_tool_authorities; CREATE TABLE worker_turn_tool_authorities (x TEXT)",
        ),
      refusal: true,
    }));
});
