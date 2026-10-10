import { createHash, type Hash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { z } from "zod";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../infra/kysely-sync.js";
import { parseSqliteTableDefinition } from "../infra/sqlite-schema-contract-assembly.js";
import { runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { LEGACY_CANONICAL_VALIDATION_TRIGGER_NAMES } from "./openclaw-agent-canonical-validation-migration.js";
import {
  assertOpenClawAgentSchemaContains,
  getOpenClawAgentMigrationSchema,
} from "./openclaw-agent-db-schema-helpers.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { assertCurrentStateRuntimeSchema } from "./openclaw-state-db-fast-path.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
import { resolveOpenClawRegisteredAgentDatabasePath } from "./openclaw-state-db.paths.js";

const identifier = z.string().max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const headerInteger = z.number().int().min(-2147483648).max(2147483647);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const registryRowSchema = z
  .object({ store: digest, locator: digest, schemaVersion: headerInteger, sha256: digest })
  .strict();
const tableSchema = z
  .object({
    name: identifier,
    columns: z.array(identifier).min(1).max(256),
    rowCount: count,
    sha256: digest,
    migrationSha256: digest,
    registryRows: z.array(registryRowSchema).max(4096).optional(),
  })
  .strict();
const witnessSchema = z
  .object({
    version: z.literal(1),
    role: z.enum(["agent", "global", "sqlite"]),
    schemaVersion: headerInteger,
    applicationId: headerInteger,
    agentId: identifier.min(1).nullable(),
    schemaSha256: digest,
    migrationSchemaSha256: digest,
    registryMigrationBinding: digest.nullable(),
    tables: z.array(tableSchema).max(512),
    gaps: z.object({ missingWindows: count, emptyWindows: count }).strict(),
  })
  .strict();

type OpenClawMigrationWitness = z.infer<typeof witnessSchema>;
type OpenClawMigrationWitnessOwner = { role: "agent"; agentId: string } | { role: "global" };

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error("Migration witness contains duplicate identities");
  }
}

/** Treat loaded evidence as untrusted; an empty or unsupported owner projection cannot pass. */
function parseOpenClawMigrationWitness(value: unknown): OpenClawMigrationWitness {
  const witness = witnessSchema.parse(value);
  assertUnique(witness.tables.map((table) => table.name));
  for (const table of witness.tables) {
    assertUnique(table.columns);
    if (table.registryRows) {
      assertUnique(table.registryRows.map((row) => row.locator));
    }
    if (
      table.registryRows &&
      !(
        witness.role === "global" &&
        witness.registryMigrationBinding &&
        table.name === "agent_databases"
      )
    ) {
      throw new Error("Migration witness has unexpected registry observations");
    }
    if (
      !(witness.role === "agent" && ["schema_meta", "session_key_contract"].includes(table.name)) &&
      !(
        witness.role === "global" &&
        witness.registryMigrationBinding &&
        table.name === "agent_databases"
      ) &&
      table.sha256 !== table.migrationSha256
    ) {
      throw new Error("Migration witness has an unsupported content transformation");
    }
  }
  if (
    (witness.role === "agent" &&
      (witness.agentId === null || ![24, 25].includes(witness.schemaVersion))) ||
    (witness.role !== "agent" && witness.agentId !== null) ||
    (witness.role !== "agent" && witness.schemaSha256 !== witness.migrationSchemaSha256) ||
    (witness.role !== "global" && witness.registryMigrationBinding !== null) ||
    (witness.role !== "agent" &&
      (witness.gaps.missingWindows !== 0 || witness.gaps.emptyWindows !== 0)) ||
    (witness.role === "global" && witness.schemaVersion !== OPENCLAW_STATE_SCHEMA_VERSION)
  ) {
    throw new Error("Unsupported migration witness owner or schema version");
  }
  const required =
    witness.role === "agent"
      ? [
          "schema_meta",
          "session_nodes",
          "session_windows",
          "transcript_events",
          "session_key_contract",
          "session_canonical_validation_pending",
        ]
      : witness.role === "global"
        ? ["schema_meta", "config_machine_state"]
        : [];
  if (required.some((name) => !witness.tables.some((table) => table.name === name))) {
    throw new Error("Migration witness is missing its owner's required tables");
  }
  return witness;
}

// Schema 25 changes these derived facts only. persistAgentSchemaMetadata also
// publishes the target app version and timestamp; payload and creation time stay exact.
function migrationColumn(role: OpenClawMigrationWitness["role"], table: string, column: string) {
  return !(
    role === "agent" &&
    ((table === "schema_meta" &&
      ["schema_version", "app_version", "updated_at"].includes(column)) ||
      (table === "session_key_contract" && column === "canonical_ready"))
  );
}

type Cell = string | Uint8Array | null;
type RegistryMigrationContext = {
  sourcePath: string;
  agents: readonly { agentId: string; path: string; requireRegistration: boolean }[];
  phase: "original" | "candidate";
  resolvePath: (value: string) => string;
};
type WitnessMetadataDatabase = {
  sqlite_schema: { name: string; type: string; tbl_name: string; sql: string | null };
  schema_meta: { meta_key: string; role: string; agent_id: string | null; schema_version: number };
  session_nodes: { current_session_id: string };
  session_windows: { session_id: string };
  transcript_events: { session_id: string };
  session_transcript_cold_archives: { session_id: string };
};

function hashCell(hash: Hash, type: unknown, value: unknown): void {
  if (
    typeof type !== "string" ||
    (value !== null && typeof value !== "string" && !(value instanceof Uint8Array))
  ) {
    throw new Error("Unreadable migration witness cell");
  }
  const bytes =
    value === null ? Buffer.alloc(0) : typeof value === "string" ? Buffer.from(value) : value;
  hash.update(`${type}:${bytes.byteLength}:`).update(bytes).update(";");
}

function witnessIdentifier(name: string, allowedNames: readonly string[], qualifier?: "witness") {
  if (!allowedNames.includes(name)) {
    throw new Error(`Migration witness identifier is outside its schema inventory: ${name}`);
  }
  return /* kysely-allow-raw: closed schema inventory, preserving literal dots and empty names. */ sql.id(
    ...(qualifier ? [qualifier, name] : [name]),
  );
}

function captureTable(
  database: DatabaseSync,
  role: OpenClawMigrationWitness["role"],
  table: string,
  tableNames: readonly string[],
  withoutRowid: boolean,
  registry?: RegistryMigrationContext,
): OpenClawMigrationWitness["tables"][number] {
  const db = getNodeSqliteKysely<object>(database);
  const columns = executeSqliteQuerySync(
    database,
    db
      .selectFrom(
        // kysely-allow-raw: schema-owned table metadata, including declared primary-key order.
        sql<{
          name: string;
          pk: number;
          hidden: number;
          cid: number;
        }>`pragma_table_xinfo(${table})`.as("columns"),
      )
      .select(["name", "pk", "hidden"])
      .where("hidden", "!=", 1)
      .orderBy("cid"),
  ).rows;
  if (columns.length === 0 || columns.length > 256) {
    throw new Error(`Unsupported migration witness columns: ${table}`);
  }
  const names = columns.map(({ name }) => name);
  if (!withoutRowid) {
    const rowid = ["rowid", "_rowid_", "oid"].find(
      (alias) => !names.some((name) => name.toLowerCase() === alias),
    );
    if (!rowid) {
      throw new Error(`Migration witness cannot inspect implicit row identity: ${table}`);
    }
    names.unshift(rowid);
  }
  const retained = names.map((name) => migrationColumn(role, table, name));
  const sha256 = createHash("sha256").update(JSON.stringify(names));
  const migrationSha256 =
    retained.every(Boolean) && !registry
      ? undefined
      : createHash("sha256").update(JSON.stringify(names.filter((_, index) => retained[index])));
  let query = db
    .selectFrom(
      // kysely-allow-raw: table and columns come from the pinned schema inventory, including plugin stores.
      sql<Record<string, Cell>>`${witnessIdentifier(table, tableNames)}`.as("witness"),
    )
    .select(
      names.flatMap((name, index) => {
        const column = witnessIdentifier(name, names, "witness");
        return [
          // kysely-allow-raw: preserve SQLite value kinds and exact 64-bit integers without JS number rounding.
          sql<string>`typeof(${column})`.as(`type_${index}`),
          // kysely-allow-raw: numeric text is a lossless witness encoding, not a stored representation change.
          sql<Cell>`CASE typeof(${column})
            WHEN 'integer' THEN CAST(${column} AS TEXT)
            WHEN 'real' THEN printf('%!.17g', ${column})
            WHEN 'text' THEN CAST(${column} AS BLOB)
            ELSE ${column} END`.as(`value_${index}`),
        ];
      }),
    );
  const primary = columns.filter(({ pk }) => pk > 0).toSorted((a, b) => a.pk - b.pk);
  const primaryNames = primary.map(({ name }) => name);
  for (const column of [...primaryNames, ...names.filter((name) => !primaryNames.includes(name))]) {
    query = query.orderBy(witnessIdentifier(column, names, "witness"));
  }
  let rowCount = 0;
  const expectedRegistrations = new Set(
    registry?.agents.map((agent) => `${agent.agentId}\0${agent.path}`),
  );
  const requiredRegistrations = new Set(
    registry?.agents
      .filter((agent) => agent.requireRegistration)
      .map((agent) => `${agent.agentId}\0${agent.path}`),
  );
  const seenRegistrations = new Set<string>();
  const readyRegistrations = new Set<string>();
  const registryRows: z.infer<typeof registryRowSchema>[] = [];
  const registryText = (row: Record<string, unknown>, column: string): string | null => {
    const value = row[`value_${names.indexOf(column)}`];
    if (value === null || typeof value === "string") {
      return value;
    }
    if (value instanceof Uint8Array) {
      return Buffer.from(value).toString("utf8");
    }
    throw new Error(`Unreadable registry migration field: ${column}`);
  };
  for (const row of iterateSqliteQuerySync(database, query)) {
    rowCount++;
    let migratingRegistration = false;
    let registryKey = "";
    let registryLocator = "";
    let registryVersion = 0;
    if (registry) {
      const agentId = registryText(row, "agent_id");
      const storedPath = registryText(row, "path");
      const key = `${agentId}\0${storedPath === null ? "" : registry.resolvePath(resolveOpenClawRegisteredAgentDatabasePath(registry.sourcePath, storedPath))}`;
      migratingRegistration = expectedRegistrations.has(key);
      if (migratingRegistration) {
        registryKey = key;
        registryLocator = `${agentId}\0${storedPath}`;
        registryVersion = Number(registryText(row, "schema_version"));
        if (registryVersion === 25) {
          readyRegistrations.add(key);
        }
        const observedAt = registryText(row, "last_seen_at");
        const sizeBytes = registryText(row, "size_bytes");
        if (
          observedAt === null ||
          BigInt(observedAt) < 0n ||
          (sizeBytes !== null && BigInt(sizeBytes) < 0n)
        ) {
          throw new Error("Registry migration contains invalid observation metadata");
        }
        seenRegistrations.add(key);
      }
    }
    const registryRowHash = migratingRegistration
      ? createHash("sha256").update(JSON.stringify(names))
      : undefined;
    for (let index = 0; index < names.length; index++) {
      hashCell(sha256, row[`type_${index}`], row[`value_${index}`]);
      if (registryRowHash) {
        hashCell(registryRowHash, row[`type_${index}`], row[`value_${index}`]);
      }
      if (retained[index] && migrationSha256) {
        if (
          migratingRegistration &&
          ["schema_version", "last_seen_at", "size_bytes"].includes(names[index]!)
        ) {
          hashCell(migrationSha256, "null", null);
        } else {
          hashCell(migrationSha256, row[`type_${index}`], row[`value_${index}`]);
        }
      }
    }
    sha256.update("\n");
    migrationSha256?.update("\n");
    if (registryRowHash) {
      if (registryRows.length === 4096) {
        throw new Error("Migration witness exceeds its 4096-registry-locator bound");
      }
      registryRows.push({
        store: createHash("sha256").update(registryKey).digest("hex"),
        locator: createHash("sha256").update(registryLocator).digest("hex"),
        schemaVersion: registryVersion,
        sha256: registryRowHash.digest("hex"),
      });
    }
  }
  if (registry && seenRegistrations.size !== expectedRegistrations.size) {
    throw new Error(
      "Cannot bind registry observations to every captured agent store; the original alias evidence may be unavailable",
    );
  }
  if (
    registry?.phase === "candidate" &&
    [...requiredRegistrations].some((key) => !readyRegistrations.has(key))
  ) {
    throw new Error("Registry schema version contradicts the verified agent migration");
  }
  const hash = sha256.digest("hex");
  return {
    name: table,
    columns: names,
    rowCount,
    sha256: hash,
    migrationSha256: migrationSha256?.digest("hex") ?? hash,
    ...(registry ? { registryRows } : {}),
  };
}

/** Read a caller-owned snapshot; no open, repair, backup, or schema mutation occurs here. */
export function captureOpenClawMigrationWitness(
  database: DatabaseSync,
  owner?: OpenClawMigrationWitnessOwner,
  registry?: RegistryMigrationContext,
): OpenClawMigrationWitness {
  return runSqliteReadSnapshotSync(database, () => {
    const db = getNodeSqliteKysely<WitnessMetadataDatabase>(database);
    const role = owner?.role ?? "sqlite";
    if (
      registry &&
      (role !== "global" || registry.agents.length === 0 || registry.agents.length > 4096)
    ) {
      throw new Error("Invalid registry migration witness context");
    }
    const userVersion = readSqliteUserVersion(database);
    const applicationId = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom(
          // kysely-allow-raw: read the persistent format identifier from SQLite's header.
          sql<{ application_id: number }>`pragma_application_id()`.as("header"),
        )
        .select("application_id"),
    )?.application_id;
    const schemaVersion = role === "global" ? readStateSchemaContentVersion(database) : userVersion;
    if (owner) {
      const metadata = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("schema_meta")
          .select(["role", "agent_id"])
          .select((eb) => eb.cast<string>("schema_version", "text").as("schema_version"))
          .where("meta_key", "=", "primary"),
      );
      if (
        metadata?.role !== owner.role ||
        (owner.role === "agent" && metadata.agent_id !== owner.agentId) ||
        metadata.schema_version !== String(userVersion)
      ) {
        throw new Error("Migration witness database owner does not match the backup inventory");
      }
      if (owner.role === "agent") {
        if (![24, 25].includes(schemaVersion)) {
          throw new Error(`Unsupported agent migration witness schema: ${schemaVersion}`);
        }
        assertOpenClawAgentSchemaContains(
          database,
          "migration witness",
          getOpenClawAgentMigrationSchema(schemaVersion),
        );
      } else {
        if (schemaVersion !== OPENCLAW_STATE_SCHEMA_VERSION) {
          throw new Error(`Unsupported shared-state migration witness schema: ${schemaVersion}`);
        }
        assertCurrentStateRuntimeSchema(database, "migration witness");
      }
    }
    const catalog = executeSqliteQuerySync(
      database,
      db
        .selectFrom("sqlite_schema")
        .select("name")
        .where("type", "=", "table")
        .orderBy("name")
        .limit(513),
    ).rows;
    if (catalog.length > 512) {
      throw new Error("Migration witness exceeds its 512-table bound");
    }
    const tableKinds = new Map(
      executeSqliteQuerySync(
        database,
        db
          .selectFrom(
            // kysely-allow-raw: SQLite owns rowid availability, including WITHOUT ROWID tables.
            sql<{
              name: string;
              wr: number;
              strict: number;
              schema: string;
            }>`pragma_table_list()`.as("tables"),
          )
          .select(["name", "wr", "strict"])
          .where("schema", "=", "main"),
      ).rows.map((table) => [
        table.name,
        { withoutRowid: table.wr !== 0, strict: table.strict !== 0 },
      ]),
    );
    const tableNames = catalog
      .map(({ name }) => identifier.parse(name))
      // Planner statistics are derived; sqlite_sequence still carries future row identity.
      .filter((name) => !name.startsWith("sqlite_stat"));
    const tables = tableNames.map((name) => {
      const kind = tableKinds.get(name);
      if (kind === undefined) {
        throw new Error(`Migration witness table disappeared: ${name}`);
      }
      return captureTable(
        database,
        role,
        name,
        tableNames,
        kind.withoutRowid,
        name === "agent_databases" ? registry : undefined,
      );
    });
    const schemaHash = createHash("sha256");
    const migrationSchemaHash = createHash("sha256");
    for (const object of iterateSqliteQuerySync(
      database,
      db
        .selectFrom("sqlite_schema")
        .select(["type", "name", "tbl_name", "sql"])
        .orderBy("type")
        .orderBy("name"),
    )) {
      if (object.name.startsWith("sqlite_stat")) {
        continue;
      }
      schemaHash.update(JSON.stringify(object)).update("\n");
      if (
        role === "agent" &&
        schemaVersion === 24 &&
        object.type === "trigger" &&
        LEGACY_CANONICAL_VALIDATION_TRIGGER_NAMES.includes(object.name)
      ) {
        continue;
      }
      if (role === "agent" && object.type === "table" && object.name === "session_key_contract") {
        const definition = parseSqliteTableDefinition(object.sql, object.name);
        definition.columns.delete("canonical_ready");
        migrationSchemaHash
          .update(
            JSON.stringify({
              ...object,
              sql: {
                columns: [...definition.columns],
                constraints: definition.constraints,
                ...tableKinds.get(object.name),
              },
            }),
          )
          .update("\n");
      } else {
        migrationSchemaHash.update(JSON.stringify(object)).update("\n");
      }
    }
    const gaps = { missingWindows: 0, emptyWindows: 0 };
    if (role === "agent") {
      gaps.missingWindows = Number(
        executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("session_nodes as node")
            .select((eb) => eb.fn.countAll().as("count"))
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom("session_windows as window")
                    .select("window.session_id")
                    .whereRef("window.session_id", "=", "node.current_session_id"),
                ),
              ),
            ),
        )?.count,
      );
      gaps.emptyWindows = Number(
        executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("session_windows as window")
            .select((eb) => eb.fn.countAll().as("count"))
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom("transcript_events as event")
                    .select("event.session_id")
                    .whereRef("event.session_id", "=", "window.session_id"),
                ),
              ),
            )
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom("session_transcript_cold_archives as cold")
                    .select("cold.session_id")
                    .whereRef("cold.session_id", "=", "window.session_id"),
                ),
              ),
            ),
        )?.count,
      );
    }
    return parseOpenClawMigrationWitness({
      version: 1,
      role,
      schemaVersion,
      applicationId,
      agentId: owner?.role === "agent" ? owner.agentId : null,
      schemaSha256: schemaHash.digest("hex"),
      migrationSchemaSha256: migrationSchemaHash.digest("hex"),
      registryMigrationBinding: registry
        ? createHash("sha256")
            .update(
              JSON.stringify([
                registry.sourcePath,
                registry.agents
                  .toSorted(
                    (left, right) =>
                      left.agentId.localeCompare(right.agentId) ||
                      left.path.localeCompare(right.path),
                  )
                  .map((agent) => [agent.agentId, agent.path, agent.requireRegistration]),
              ]),
            )
            .digest("hex")
        : null,
      tables,
      gaps,
    });
  });
}

/** The caller binds original evidence to a verified original backup, never to a new capture. */
export function assertOpenClawMigrationWitnessPreserved(
  originalValue: unknown,
  currentValue: unknown,
): { warnings: string[] } {
  const original = parseOpenClawMigrationWitness(originalValue);
  const current = parseOpenClawMigrationWitness(currentValue);
  const crossing =
    original.role === "agent" && original.schemaVersion === 24 && current.schemaVersion === 25;
  if (
    original.role !== current.role ||
    original.agentId !== current.agentId ||
    original.applicationId !== current.applicationId ||
    original.registryMigrationBinding !== current.registryMigrationBinding ||
    (!crossing && original.schemaVersion !== current.schemaVersion)
  ) {
    throw new Error("Unsupported migration witness owner or version transition");
  }
  if (
    (crossing ? original.migrationSchemaSha256 : original.schemaSha256) !==
    (crossing ? current.migrationSchemaSha256 : current.schemaSha256)
  ) {
    throw new Error("Migration changed or lost retained database schema");
  }
  if (current.registryMigrationBinding) {
    const originalRows = new Map(
      (original.tables.find((table) => table.name === "agent_databases")?.registryRows ?? []).map(
        (row) => [row.locator, row],
      ),
    );
    const currentRows = current.tables.find(
      (table) => table.name === "agent_databases",
    )?.registryRows;
    if (!currentRows || originalRows.size !== currentRows.length) {
      throw new Error("Missing registry row witnesses");
    }
    for (const row of currentRows) {
      const before = originalRows.get(row.locator);
      if (
        !before ||
        before.store !== row.store ||
        (row.schemaVersion !== 25 && row.sha256 !== before.sha256)
      ) {
        throw new Error("Unrefreshed registry alias changed during migration");
      }
    }
  }
  const projected = (witness: OpenClawMigrationWitness) =>
    witness.tables
      .filter((table) => !crossing || table.name !== "session_canonical_validation_pending")
      .map((table) => ({
        name: table.name,
        columns: crossing
          ? table.columns.filter((column) => migrationColumn(witness.role, table.name, column))
          : table.columns,
        rowCount: table.rowCount,
        sha256: crossing || witness.registryMigrationBinding ? table.migrationSha256 : table.sha256,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  const originalTables = projected(original);
  const currentTables = new Map(projected(current).map((table) => [table.name, table]));
  for (const table of originalTables) {
    if (JSON.stringify(table) !== JSON.stringify(currentTables.get(table.name))) {
      throw new Error(`Migration changed or lost retained database content: ${table.name}`);
    }
    currentTables.delete(table.name);
  }
  if (currentTables.size > 0) {
    throw new Error("Migration added unclassified database content");
  }
  return {
    warnings: Object.entries(original.gaps)
      .filter(([, value]) => value > 0)
      .map(([kind, value]) => `Preexisting session history gap: ${kind} (${value})`),
  };
}
