import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "pg";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { describeAdmittedDatabaseStores } from "../infra/database-engine/admitted-diagnostics.js";
import { formatDatabaseStoreDiagnostic } from "../infra/database-engine/diagnostics-format.js";
import type { DatabaseStoreDiagnostic } from "../infra/database-engine/diagnostics.js";
import { readBackupEngine } from "../infra/database-engine/physical-store.js";
import type { PortDescriptor } from "../infra/database-engine/port-descriptor.js";
import { databasePortProviders } from "../infra/database-engine/port-provider.js";
import { materializeDatabasePort } from "../infra/database-engine/port.worker.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationJournalPath,
} from "../infra/package-update-activation-paths.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { inspectDoctorDatabaseEngines } from "./doctor-database-engine-inspection.js";
import {
  buildStatusDatabaseStoreRows,
  resolveStatusDatabaseEngines,
} from "./status-database-engines.js";

const fixtureAdmissionPaths = new Set<string>();

export const diagnosticPaths = {
  state: "state/openclaw.sqlite",
  agent: "agents/main/agent/openclaw-agent.sqlite",
  workboard: "plugins/workboard/workboard.sqlite",
  logbook: "logbook/logbook.sqlite",
  "team-reports": "plugins/team-reports/team-reports.sqlite",
};
export const matrixRoot =
  "matrix/accounts/retained/server__user/1111111111111111/state/openclaw.sqlite";
export const retainedAgentRoot = "agents/retained/agent/openclaw-agent.sqlite";

function fixtureStores(root: string) {
  return [
    ...Object.entries(diagnosticPaths),
    ["state", matrixRoot],
    ["agent", retainedAgentRoot],
  ].map(([family, relative]) => ({ family: family!, file: path.join(root, relative!) }));
}

export function diagnosticConfig(connection?: string): OpenClawConfig {
  return {
    plugins: {
      entries: {
        matrix: { enabled: false },
        workboard: { enabled: false },
        logbook: { enabled: false },
        "team-reports": { enabled: false },
      },
    },
    ...(connection ? { database: { engine: "postgres", postgres: { connection } } } : {}),
  };
}

function initializeSqlite(file: string, descriptor: PortDescriptor) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  using db = openNodeSqliteDatabase(file);
  db.exec(descriptor.sqlite);
  for (const fragment of descriptor.fragments ?? []) {
    db.exec(fragment.sqlite);
  }
  db.exec(`PRAGMA user_version = ${descriptor.version}`);
  if (descriptor.id === "state") {
    db.prepare("INSERT INTO schema_meta VALUES ('primary', 'global', ?, NULL, NULL, 1, 1)").run(
      OPENCLAW_STATE_SCHEMA_VERSION,
    );
    db.prepare("INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', ?, 1)").run(
      String(OPENCLAW_STATE_SCHEMA_VERSION),
    );
  } else if (descriptor.id === "agent") {
    db.prepare("INSERT INTO schema_meta VALUES ('primary', 'agent', ?, 'main', NULL, 1, 1)").run(
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
  } else if (descriptor.id === "workboard") {
    db.prepare("INSERT INTO workboard_schema_migrations VALUES (?, 1)").run(
      `schema-${descriptor.version}`,
    );
  } else if (descriptor.id === "team-reports") {
    db.exec("INSERT INTO team_reports_schema_migrations VALUES ('schema-1', 1)");
  }
}

export async function createDiagnosticStores(root: string) {
  const descriptors = new Map<string, PortDescriptor>();
  for (const provider of databasePortProviders) {
    const descriptor = await provider.loadDescriptor();
    descriptors.set(provider.id, descriptor);
    const relative = diagnosticPaths[provider.id as keyof typeof diagnosticPaths];
    initializeSqlite(path.join(root, relative), descriptor);
  }
  initializeSqlite(path.join(root, matrixRoot), descriptors.get("state")!);
  const retained = path.join(root, retainedAgentRoot);
  initializeSqlite(retained, descriptors.get("agent")!);
  using db = openNodeSqliteDatabase(retained);
  db.exec("UPDATE schema_meta SET agent_id = 'retained'");
  for (const { file } of fixtureStores(root)) {
    fixtureAdmissionPaths.add(file);
  }
  return descriptors;
}

/** Populate actual owner admissions, independently from Doctor's inspection worker. */
async function admittedStatusOutput(
  root: string,
  config: OpenClawConfig,
  descriptors: Map<string, PortDescriptor>,
  connection?: string,
) {
  for (const file of fixtureAdmissionPaths) {
    retireSqliteDatabaseAdmissionForPath(file);
  }
  for (const { family, file } of fixtureStores(root)) {
    fixtureAdmissionPaths.add(file);
    const descriptor = descriptors.get(family)!;
    if (readBackupEngine(file).engine === "postgres") {
      assert(connection, "PostgreSQL fixture admission requires its synthetic connection");
      await descriptor.admit?.(file, { connection, schemaPrefix: "doctor_proof" });
    } else {
      using db = openNodeSqliteDatabase(file, { readOnly: true });
      descriptor.inspectSqliteSource?.(db);
    }
  }
  const stores = describeAdmittedDatabaseStores(config);
  const report = await resolveStatusDatabaseEngines(config, stores);
  assert.equal(report.source, "admitted");
  for (const store of stores) {
    assert.equal(store.schema.pending, null);
    if (store.observed === "postgres") {
      assert.equal(store.connectivity, "unknown");
    }
  }
  return { source: report.source, text: buildStatusDatabaseStoreRows(report), json: stores };
}

export async function portDiagnosticStore(params: {
  file: string;
  descriptor: PortDescriptor;
  client: Client;
  connection: string;
  namespaces: Set<string>;
}) {
  const { file, descriptor, client, namespaces } = params;
  const storeId = randomUUID();
  const namespace = `doctor_proof_${storeId.replaceAll("-", "")}`;
  namespaces.add(namespace);
  {
    using source = openNodeSqliteDatabase(file, { readOnly: true, readBigInts: true });
    await materializeDatabasePort({
      source: { engine: "sqlite", db: source },
      destination: { engine: "postgres", db: client, namespace },
      descriptor,
      storeId,
      assertCurrent() {},
    });
  }
  fs.unlinkSync(file);
  {
    using anchor = openNodeSqliteDatabase(file);
    anchor.exec(
      "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
    );
    anchor
      .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
      .run(storeId, namespace);
  }
  await descriptor.admit?.(file, { connection: params.connection, schemaPrefix: "doctor_proof" });
}

const currentCoreSchemaVersions = new Map([
  ["state", OPENCLAW_STATE_SCHEMA_VERSION],
  ["agent", OPENCLAW_AGENT_SCHEMA_VERSION],
]);

function snapshotStoreSchema(store: DatabaseStoreDiagnostic) {
  const current = currentCoreSchemaVersions.get(store.family);
  if (current === undefined) {
    return store;
  }
  const { version, expectedVersion } = store.schema;
  if (version !== null) {
    assert.equal(version, current, `${store.family} schema at ${store.path}`);
  }
  if (expectedVersion !== null) {
    assert.equal(expectedVersion, current, `${store.family} expected schema at ${store.path}`);
  }
  // Keep unknowns and migration state exact; only validated current versions vary on upgrades.
  const marker = `<current-${store.family}-schema>`;
  return {
    ...store,
    schema: {
      ...store.schema,
      version: version === null ? null : marker,
      expectedVersion: expectedVersion === null ? null : marker,
    },
  };
}

function snapshotSchemaText(text: string): string {
  for (const [family, current] of currentCoreSchemaVersions) {
    if (text.startsWith(`${family} `) || text.startsWith(`${family};`)) {
      return text.replace(/(; schema=|, expected=)(\d+)(?=,)/g, (_match, field, version) => {
        assert.equal(Number(version), current, `${family} schema in diagnostic text`);
        return `${field}<current-${family}-schema>`;
      });
    }
  }
  return text;
}

type DiagnosticSnapshot = {
  text: string | string[];
  json: DatabaseStoreDiagnostic | DatabaseStoreDiagnostic[];
  status: Awaited<ReturnType<typeof admittedStatusOutput>>;
};

export async function inspectDiagnosticStores(root: string, config = diagnosticConfig()) {
  return (
    await inspectDoctorDatabaseEngines({
      config,
      stateDir: root,
      env: { OPENCLAW_STATE_DIR: root, HOME: path.join(root, "home") },
    })
  ).stores!;
}

export async function diagnosticOutput(
  root: string,
  config: OpenClawConfig,
  descriptors: Map<string, PortDescriptor>,
  stores: DatabaseStoreDiagnostic | DatabaseStoreDiagnostic[],
  connection?: string,
  normalizedConnection = connection,
) {
  const text = Array.isArray(stores)
    ? stores.map(formatDatabaseStoreDiagnostic)
    : formatDatabaseStoreDiagnostic(stores);
  const status = await admittedStatusOutput(root, config, descriptors, connection);
  return normalizeDiagnosticOutput({ text, json: stores, status }, root, normalizedConnection);
}

function normalizeDiagnosticOutput(value: DiagnosticSnapshot, root: string, connection?: string) {
  const packageJournal = resolvePackageActivationJournalPath(
    resolvePackageActivationAnchor(process.cwd()),
  );
  const snapshot = {
    ...value,
    json: Array.isArray(value.json)
      ? value.json.map(snapshotStoreSchema)
      : snapshotStoreSchema(value.json),
    text: Array.isArray(value.text)
      ? value.text.map(snapshotSchemaText)
      : snapshotSchemaText(value.text),
    status: {
      ...value.status,
      json: value.status.json.map(snapshotStoreSchema),
      text: value.status.text.map((row) => ({ ...row, Value: snapshotSchemaText(row.Value) })),
    },
  };
  let text = JSON.stringify(snapshot, null, 2)
    .replaceAll(packageJournal, "<package-activation-journal>")
    .replaceAll(root, "<state>")
    .replaceAll(process.cwd(), "<install>");
  text = text.replaceAll(os.tmpdir(), "<temporary>").replaceAll(/openclaw-\d+/g, "openclaw-<uid>");
  text = text.replaceAll(/doctor_proof_[a-f0-9]+/g, "<namespace>");
  text = text.replaceAll(
    /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g,
    "<store-id>",
  );
  if (connection) {
    assert(!text.includes(connection), "diagnostics must not expose the connection string");
    const parsed = new URL(connection);
    const database = decodeURIComponent(parsed.pathname.slice(1));
    text = text
      .replaceAll(`"database": "${database}"`, '"database": "<database>"')
      .replaceAll(`database=${database};`, "database=<database>;");
    if (parsed.password) {
      assert(!text.includes(parsed.password), "diagnostics must not expose credentials");
    }
  }
  return JSON.parse(text) as unknown;
}
