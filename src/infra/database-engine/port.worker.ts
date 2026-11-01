import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { Client } from "pg";
import { encodeSqliteValue, escapedSqliteText } from "../../snapshot/sqlite-cell-codec.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { decodePostgresRows } from "../postgres-sync/protocol.js";
import { assertSqliteIntegrity } from "../sqlite-integrity.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../sqlite-schema-facts.js";
import { quoteSqliteIdentifier as quote } from "../sqlite-schema-sql.js";
import {
  readAutoincrementHighWater,
  restoreAutoincrementHighWater,
  withSqliteForeignKeysDisabled,
} from "../sqlite-strict.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { writeSqliteUserVersion } from "../sqlite-user-version.js";
import {
  admitDatabasePortDescriptor,
  DatabasePortDataError,
  type PortDescriptor,
  type PortEndpoint,
  type PortRow,
  type PortTable,
} from "./port-descriptor.js";
import {
  assertPostgresCatalog,
  postgresCatalogQuery,
  readPostgresCatalog,
} from "./postgres-catalog.js";
import {
  refreshPostgresPlannerStatistics,
  type PostgresPlannerStatistics,
} from "./postgres-planner-statistics.js";
export {
  admitDatabasePortDescriptor,
  DatabasePortDataError,
  inspectSqlitePortSchema,
  type PortDescriptor,
} from "./port-descriptor.js";

export type PortVerification = {
  tables: Record<string, { rows: number; sha256: string }>;
  allocations: Record<string, { value: string; called: boolean }>;
};

/** The caller owns this private SQLite copy and retains custody through verification. */
export async function migrateDatabasePortSource(
  sourcePath: string,
  descriptor: PortDescriptor,
  sourceVersion: number,
  assertCurrent: () => void,
): Promise<PortVerification> {
  assertCurrent();
  await descriptor.migrateSqliteSource?.(sourcePath, sourceVersion, assertCurrent);
  using db = openNodeSqliteDatabase(sourcePath, { readOnly: true, readBigInts: true });
  const { tables, allocations: retainedAllocations } = await inspectDatabasePort(
    { engine: "sqlite", db },
    descriptor,
  );
  return { tables, allocations: retainedAllocations };
}
type Endpoint = PortEndpoint;
const copiedTables = (descriptor: PortDescriptor) =>
  descriptor.tables.filter(
    (table) =>
      !descriptor.projections?.some((projection) => projection.tables.includes(table.name)),
  );

const MAX_ROWS = 1000,
  MAX_BYTES = 4 * 1024 * 1024;
const qualified = (endpoint: Endpoint, table: string) =>
  endpoint.engine === "sqlite" ? quote(table) : `${quote(endpoint.namespace)}.${quote(table)}`;
const binding = (value: SQLInputValue) =>
  value instanceof Uint8Array ? Buffer.from(value) : value;

function sqliteStatement(db: DatabaseSync, sql: string) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement;
}

function checkRow(table: PortTable, row: PortRow): number {
  let bytes = 0;
  for (const { name } of table.columns) {
    const value = row[name];
    if (typeof value === "string" && (value.includes("\0") || !value.isWellFormed())) {
      const key = createHash("sha256")
        .update(JSON.stringify(table.pk.map((k) => encodeSqliteValue(row[k]))))
        .digest("hex");
      throw new DatabasePortDataError(
        `Port refused ${table.name}.${name}: unrepresentable UTF-8 text; key SHA-256 ${key}; byte offset ${Buffer.byteLength(value.slice(0, value.indexOf("\0")))}. Repair through the store owner.`,
      );
    }
    bytes +=
      typeof value === "string"
        ? Buffer.byteLength(value)
        : value instanceof Uint8Array
          ? value.byteLength
          : 8;
  }
  return bytes;
}

async function* readBatches(
  endpoint: Endpoint,
  table: PortTable,
  maxRowBytes: number,
  derive: ((row: PortRow) => PortRow) | undefined,
  normalize: boolean,
  decode: ((row: PortRow) => PortRow) | undefined,
) {
  const names = table.columns.map((c) => quote(c.name));
  const keyed = table.pk.length > 0;
  const orderColumns = keyed ? table.pk : table.columns.map((column) => column.name);
  const keys = orderColumns
    .map((name) => `${quote(name)}${keyed ? "" : " ASC NULLS FIRST"}`)
    .join(",");
  // Keyless retained tables are tiny; value ordering preserves duplicate rows without inventing identities.
  const sourceOrder =
    endpoint.engine === "sqlite"
      ? orderColumns
          .map((name) => `${quote(table.name)}.${quote(name)}${keyed ? "" : " ASC NULLS FIRST"}`)
          .join(",")
      : keys;
  let offset = 0;
  const rowBytes = table.columns
    .map((c) =>
      ["text", "bytea"].includes(c.type) ? `coalesce(octet_length(${quote(c.name)}),0)` : "8",
    )
    .join("+");
  let cursor: SQLInputValue[] | undefined;
  const limit = Math.min(MAX_ROWS, Math.floor(59999 / table.columns.length));
  for (;;) {
    const params = cursor ?? [];
    const where = cursor
      ? ` WHERE (${keys}) > (${params.map((_, i) => (endpoint.engine === "sqlite" ? "?" : `$${i + 1}`)).join(",")})`
      : "";
    const projection =
      endpoint.engine === "sqlite"
        ? table.columns
            .flatMap(({ name }, i) => [
              `${escapedSqliteText(quote(name))} AS ${quote(name)}`,
              `CASE WHEN typeof(${quote(name)}) = 'text' THEN CAST(${quote(name)} AS BLOB) END AS ${quote(`__port_bytes_${i}`)}`,
            ])
            .join(",")
        : names.join(",");
    const page = `SELECT ${projection} FROM ${qualified(endpoint, table.name)}${where} ORDER BY ${sourceOrder} LIMIT ${limit}${keyed ? "" : ` OFFSET ${offset}`}`;
    const sql =
      endpoint.engine === "sqlite"
        ? page
        : `WITH page AS (${page}), sized AS (
      SELECT page.*, sum(${rowBytes}) OVER (ORDER BY ${keys} ROWS UNBOUNDED PRECEDING) AS __port_size,
      row_number() OVER (ORDER BY ${keys}) AS __port_row FROM page)
      SELECT ${names.join(",")} FROM sized WHERE __port_size <= ${MAX_BYTES} OR __port_row = 1 ORDER BY ${keys}`;
    let rows: Iterable<PortRow>;
    if (endpoint.engine === "sqlite") {
      const statement = sqliteStatement(endpoint.db, sql);
      rows = statement.iterate(...params);
    } else {
      const result = await endpoint.db.query(sql, params.map(binding));
      rows = decodePostgresRows(result, true);
    }
    let count = 0,
      bytes = 0;
    let batch: PortRow[] = [];
    for (const raw of rows) {
      const row: PortRow = {};
      table.columns.forEach(({ name }, i) => {
        let value = raw[name]!;
        if (endpoint.engine === "sqlite" && typeof value === "string") {
          // SAFETY: escapedSqliteText uses json_quote for every SQLite TEXT cell.
          value = JSON.parse(value) as string;
          const original = raw[`__port_bytes_${i}`];
          if (!(original instanceof Uint8Array) || !Buffer.from(value).equals(original)) {
            throw new DatabasePortDataError(`Port refused invalid UTF-8: ${table.name}.${name}`);
          }
        }
        row[name] = value;
      });
      if (endpoint.engine === "sqlite") {
        Object.assign(row, decode?.(row));
      }
      const derived = derive?.(row);
      if (
        !normalize &&
        derived &&
        Object.entries(derived).some(([key, value]) => !isDeepStrictEqual(value, row[key]))
      ) {
        throw new DatabasePortDataError(`Port derived columns differ: ${table.name}`);
      }
      Object.assign(row, derived);
      const size = checkRow(table, row);
      if (size > maxRowBytes) {
        throw new DatabasePortDataError(
          `Port row in ${table.name} needs ${size} bytes; increase maxRowBytes explicitly.`,
        );
      }
      if (batch.length && bytes + size > MAX_BYTES) {
        yield batch;
        batch = [];
        bytes = 0;
      }
      batch.push(row);
      bytes += size;
      count++;
      if (keyed) {
        cursor = table.pk.map((k) => row[k]!);
      } else {
        offset++;
      }
    }
    if (batch.length) {
      yield batch;
    }
    if (count === 0 || (endpoint.engine === "sqlite" && count < limit)) {
      break;
    }
  }
}

export async function readDatabasePortAllocations(
  endpoint: Endpoint,
  descriptor: PortDescriptor,
): Promise<PortVerification["allocations"]> {
  const result: PortVerification["allocations"] = {};
  for (const table of copiedTables(descriptor)) {
    for (const identity of table.identities) {
      const key = `${table.name}.${identity.column}`;
      if (endpoint.engine === "postgres") {
        const sequence = await endpoint.db.query("SELECT pg_get_serial_sequence($1, $2) AS name", [
          qualified(endpoint, table.name),
          identity.column,
        ]);
        // Matched backups retain resets and uncalled sequences, even below existing row IDs.
        const row = (
          await endpoint.db.query(
            `SELECT last_value::text AS value, is_called AS called FROM ${sequence.rows[0].name}`,
          )
        ).rows[0];
        result[key] = { value: row.value, called: row.called };
      } else {
        const statement = sqliteStatement(
          endpoint.db,
          `SELECT max(${quote(identity.column)}) AS value FROM ${quote(table.name)}`,
        );
        let value = statement.get()?.value;
        if (identity.autoIncrement) {
          const high = readAutoincrementHighWater(endpoint.db, table.name);
          if (
            high !== null &&
            (value === null || (typeof value === "bigint" && BigInt(high) > value))
          ) {
            value = BigInt(high);
          }
        }
        result[key] = { value: String(value ?? 1), called: value !== null && value !== undefined };
      }
    }
  }
  return result;
}

/** SQLite follows retained rows; AUTOINCREMENT also retains a called sequence high-watermark. */
export function sqlitePortAllocations(
  descriptor: PortDescriptor,
  physical: PortVerification["allocations"],
  source: PortVerification["allocations"],
): PortVerification["allocations"] {
  const expected = { ...source };
  for (const table of copiedTables(descriptor)) {
    for (const identity of table.identities) {
      const key = `${table.name}.${identity.column}`;
      if (
        !identity.autoIncrement ||
        !source[key]!.called ||
        BigInt(physical[key]!.value) > BigInt(source[key]!.value)
      ) {
        expected[key] = physical[key]!;
      }
    }
  }
  return expected;
}

async function restoreAllocations(
  endpoint: Endpoint,
  descriptor: PortDescriptor,
  facts: PortVerification["allocations"],
) {
  for (const table of copiedTables(descriptor)) {
    for (const identity of table.identities) {
      const fact = facts[`${table.name}.${identity.column}`]!;
      if (endpoint.engine === "postgres") {
        await endpoint.db.query("SELECT setval(pg_get_serial_sequence($1, $2), $3::bigint, $4)", [
          qualified(endpoint, table.name),
          identity.column,
          fact.value,
          fact.called,
        ]);
      } else if (identity.autoIncrement && fact.called) {
        restoreAutoincrementHighWater(endpoint.db, table.name, fact.value);
      }
    }
  }
}

async function insertBatch(
  endpoint: Endpoint,
  table: PortTable,
  rows: PortRow[],
  assertCurrent: () => void,
) {
  assertCurrent();
  const columns = table.columns.map((c) => quote(c.name)).join(",");
  if (endpoint.engine === "sqlite") {
    withSqliteForeignKeysDisabled(endpoint.db, () => {
      runSqliteImmediateTransactionSync(endpoint.db, () => {
        const statement = sqliteStatement(
          endpoint.db,
          `INSERT INTO ${quote(table.name)} (${columns}) VALUES (${table.columns.map(() => "?").join(",")})`,
        );
        for (const row of rows) {
          statement.run(...table.columns.map((c) => row[c.name]!));
        }
      });
    });
  } else {
    const values = rows.flatMap((row) => table.columns.map((c) => binding(row[c.name]!)));
    let index = 0;
    const tuples = rows
      .map(() => `(${table.columns.map(() => `$${++index}`).join(",")})`)
      .join(",");
    await endpoint.db.query(
      `INSERT INTO ${qualified(endpoint, table.name)} (${columns}) VALUES ${tuples}`,
      values,
    );
  }
}

async function scan(
  endpoint: Endpoint,
  descriptor: PortDescriptor,
  maxRowBytes: number,
  destination?: Endpoint,
  assertCurrent = () => {},
  transformRow?: (table: string, row: PortRow) => PortRow | undefined,
) {
  const tables: PortVerification["tables"] = {};
  for (const table of copiedTables(descriptor)) {
    const hash = createHash("sha256").update(JSON.stringify(table.columns) + "\n");
    let rows = 0;
    let pending: Promise<void> | undefined;
    const stream = readBatches(
      endpoint,
      table,
      maxRowBytes,
      descriptor.derive?.[table.name],
      Boolean(destination),
      descriptor.decodeSqlite?.[table.name],
    );
    try {
      let next = stream.next();
      for (;;) {
        const { value: batch, done } = await next;
        if (done) {
          break;
        }
        const copied = transformRow
          ? batch.flatMap((row) => {
              const transformed = transformRow(table.name, row);
              return transformed ? [transformed] : [];
            })
          : batch;
        for (const row of copied) {
          hash.update(
            JSON.stringify(table.columns.map((c) => encodeSqliteValue(row[c.name]))) + "\n",
          );
          rows++;
        }
        await pending;
        // Start the remote read before a synchronous SQLite write; PG writes can start first.
        if (destination?.engine === "sqlite") {
          next = stream.next();
        }
        if (destination && copied.length) {
          pending = insertBatch(destination, table, copied, assertCurrent);
          void pending.catch(() => {});
        }
        if (destination?.engine !== "sqlite") {
          next = stream.next();
        }
        void next.catch(() => {});
      }
    } finally {
      await Promise.all([pending, stream.return(undefined)]);
    }
    tables[table.name] = { rows, sha256: hash.digest("hex") };
  }
  return tables;
}

async function catalogEvidence(
  endpoint: Extract<Endpoint, { engine: "postgres" }>,
  descriptor: PortDescriptor,
  sourceProjection = false,
) {
  await endpoint.db.query("SELECT set_config('search_path', $1, false)", [
    quote(endpoint.namespace),
  ]);
  const facts = readPostgresCatalog(
    (await endpoint.db.query(postgresCatalogQuery(endpoint.namespace, true))).rows[0].catalog,
  ).filter((f) => f.table !== "openclaw_schema_meta");
  if (
    !sourceProjection &&
    facts.some(
      (fact) =>
        fact.kind === "viewDefinition" ||
        (fact.kind === "triggerDefinition" &&
          // Derived search tables carry only their generated maintenance triggers.
          !descriptor.postgresDerivedTables?.includes(fact.table) &&
          !descriptor.triggers?.some(
            (trigger) =>
              fact.value !== null &&
              typeof fact.value === "object" &&
              "name" in fact.value &&
              fact.value.name === trigger.name &&
              fact.table === trigger.table,
          )),
    )
  ) {
    throw new DatabasePortDataError(
      "Unknown PostgreSQL trigger or view; complete descriptor coverage required",
    );
  }
  if (!sourceProjection) {
    assertPostgresCatalog(
      facts.filter(
        (f) =>
          !f.kind.endsWith("Definition") && !descriptor.postgresDerivedTables?.includes(f.table),
      ),
      descriptor.expectedCatalog,
    );
  }
  const invalid = await endpoint.db.query(
    `SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND NOT c.convalidated UNION ALL SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT i.indisvalid`,
    [endpoint.namespace],
  );
  if (invalid.rowCount) {
    throw new DatabasePortDataError("Port catalog has unvalidated constraints or invalid indexes");
  }
  return facts.map((f) => ({
    table: f.table,
    kind: f.kind,
    value: JSON.parse(
      JSON.stringify(f.value).replaceAll(endpoint.namespace, "__port_schema__"),
    ) as unknown,
  }));
}

async function referenceCatalog(
  endpoint: Extract<Endpoint, { engine: "postgres" }>,
  descriptor: PortDescriptor,
  source?: Extract<Endpoint, { engine: "postgres" }>,
) {
  const sourcePostData = source && (await descriptor.postgresSourcePostData?.(source));
  const reference = { ...endpoint, namespace: `port_verify_${randomUUID().replaceAll("-", "")}` };
  await endpoint.db.query("BEGIN");
  try {
    await endpoint.db.query(
      `CREATE SCHEMA ${quote(reference.namespace)}; SET LOCAL search_path = ${quote(reference.namespace)}`,
    );
    await endpoint.db.query(
      descriptor.preData +
        "\n;\n" +
        descriptor.postData +
        "\n;\n" +
        (descriptor.postgresPostData?.(reference.namespace) ?? ""),
    );
    const base = await catalogEvidence(reference, descriptor);
    if (sourcePostData) {
      await endpoint.db.query(sourcePostData(reference.namespace));
      return { base, source: await catalogEvidence(reference, descriptor, true) };
    }
    return { base, source: undefined };
  } finally {
    await endpoint.db.query("ROLLBACK");
  }
}

async function assertSourceIdentity(
  source: Extract<Endpoint, { engine: "postgres" }>,
  descriptor: PortDescriptor,
  storeId: string,
) {
  const meta = (
    await source.db.query(
      `SELECT store, version, store_id FROM ${qualified(source, "openclaw_schema_meta")}`,
    )
  ).rows;
  if (
    meta.length !== 1 ||
    meta[0].store !== descriptor.id ||
    meta[0].store_id !== storeId ||
    BigInt(meta[0].version) !== BigInt(descriptor.version)
  ) {
    throw new DatabasePortDataError("Port source identity or schema version differs");
  }
}

/** Offline recovery inspection, never a runtime foreign-writer probe. */
export async function inspectDatabasePort(
  source: Endpoint,
  baseDescriptor: PortDescriptor,
  storeId?: string,
  verifyDefinitions = false,
) {
  const descriptor = await admitDatabasePortDescriptor(source, baseDescriptor);
  let definitions: Awaited<ReturnType<typeof referenceCatalog>> | undefined;
  if (source.engine === "postgres") {
    await assertSourceIdentity(source, descriptor, storeId ?? "");
    definitions =
      verifyDefinitions || descriptor.postgresSourcePostData
        ? await referenceCatalog(source, descriptor, source)
        : undefined;
    await source.db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  } else {
    source.db.exec("BEGIN");
  }
  try {
    let catalog =
      source.engine === "postgres"
        ? await catalogEvidence(source, descriptor, Boolean(definitions?.source))
        : [];
    if (definitions) {
      assertPostgresCatalog(catalog, definitions.source ?? definitions.base);
      catalog = definitions.base;
    }
    return {
      catalog,
      tables: await scan(source, descriptor, 64 * 1024 * 1024),
      allocations: await readDatabasePortAllocations(source, descriptor),
    };
  } finally {
    if (source.engine === "postgres") {
      await source.db.query("ROLLBACK");
    } else {
      source.db.exec("ROLLBACK");
    }
  }
}

/** One capability contract for dry-run evidence and the actual copy session. */
export async function readPostgresPortCapabilities(
  db: Client,
  descriptor: Pick<PortDescriptor, "minimumPostgresVersion">,
) {
  const server = (
    await db.query<{ version: number; encoding: string; client_encoding: string }>(
      "SELECT current_setting('server_version_num')::int AS version, current_setting('server_encoding') AS encoding, current_setting('client_encoding') AS client_encoding",
    )
  ).rows[0];
  if (
    !server ||
    server.version < descriptor.minimumPostgresVersion * 10000 ||
    server.encoding !== "UTF8" ||
    server.client_encoding !== "UTF8"
  ) {
    throw new DatabasePortDataError(
      `Observed PostgreSQL ${server?.version}/${server?.encoding}/${server?.client_encoding}; required PostgreSQL >=${descriptor.minimumPostgresVersion} and UTF8 server/client`,
    );
  }
  return { version: server.version, encoding: server.encoding };
}

/** Offline worker API: caller owns tracked SQLite handles (data statements read BigInts), migrated source, fresh destination, and exclusive custody. No publication. */
export async function materializeDatabasePort(params: {
  source: Endpoint;
  destination: Endpoint;
  descriptor: PortDescriptor;
  storeId: string;
  assertCurrent: () => void;
  maxRowBytes?: number;
  sourceAllocations?: PortVerification["allocations"];
  activeFragments?: readonly string[];
  onPlannerStatistics?: (result: PostgresPlannerStatistics) => void;
  /** Export-only redaction before hashing/copying; retained rows preserve keys and column types. */
  transformRow?: (table: string, row: PortRow) => PortRow | undefined;
}): Promise<PortVerification> {
  const { source, destination, assertCurrent } = params;
  if (source.engine === destination.engine) {
    throw new DatabasePortDataError("Port endpoints must use different engines");
  }
  const descriptor = await admitDatabasePortDescriptor(
    source,
    params.descriptor,
    params.activeFragments,
  );
  const maxRowBytes = params.maxRowBytes ?? 64 * 1024 * 1024;
  const postgres = [source, destination].find(
    (endpoint): endpoint is Extract<Endpoint, { engine: "postgres" }> =>
      endpoint.engine === "postgres",
  )!;
  await readPostgresPortCapabilities(postgres.db, descriptor);
  await postgres.db.query("SET row_security = off");
  if (source.engine === "postgres") {
    await assertSourceIdentity(source, descriptor, params.storeId);
  }
  if (destination.engine === "sqlite") {
    admitSqliteSchema(destination.db);
    const facts = getAdmittedSqliteSchemaFacts(destination.db);
    if (
      !facts ||
      facts.tables.size ||
      facts.views.size ||
      facts.indexes.size ||
      facts.triggers.size
    ) {
      throw new DatabasePortDataError("Port destination must have admitted empty schema facts");
    }
  }
  assertCurrent();
  const definitions = await referenceCatalog(
    postgres,
    descriptor,
    source.engine === "postgres" ? source : undefined,
  );
  if (source.engine === "postgres") {
    assertPostgresCatalog(
      await catalogEvidence(source, descriptor, Boolean(definitions.source)),
      definitions.source ?? definitions.base,
    );
  }
  if (source.engine === "postgres") {
    await source.db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  } else {
    source.db.exec("BEGIN");
  }
  try {
    if (destination.engine === "postgres") {
      await destination.db.query(
        "BEGIN; SET LOCAL synchronous_commit = on; SET LOCAL statement_timeout = '1h'",
      );
      assertCurrent();
      await destination.db.query(`CREATE SCHEMA ${quote(destination.namespace)}`);
      await destination.db.query(`SET search_path = ${quote(destination.namespace)}`);
      await destination.db.query(descriptor.preData);
    } else {
      withSqliteForeignKeysDisabled(destination.db, () => destination.db.exec(descriptor.sqlite));
      for (const trigger of descriptor.triggers ?? []) {
        destination.db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
      }
    }
    const facts =
      params.sourceAllocations ?? (await readDatabasePortAllocations(source, descriptor));
    const tables = await scan(
      source,
      descriptor,
      maxRowBytes,
      destination,
      assertCurrent,
      params.transformRow,
    );
    assertCurrent();
    await restoreAllocations(destination, descriptor, facts);
    for (const projection of descriptor.projections ?? []) {
      assertCurrent();
      await projection.rebuild(destination);
    }
    if (destination.engine === "postgres") {
      assertCurrent();
      await destination.db.query(
        descriptor.postData +
          "\n;\n" +
          (descriptor.postgresPostData?.(destination.namespace) ?? ""),
      );
      assertPostgresCatalog(await catalogEvidence(destination, descriptor), definitions.base);
      await destination.db.query(
        "CREATE TABLE openclaw_schema_meta (store TEXT PRIMARY KEY, version BIGINT NOT NULL, store_id TEXT NOT NULL)",
      );
      await destination.db.query("INSERT INTO openclaw_schema_meta VALUES ($1,$2,$3)", [
        descriptor.id,
        descriptor.version,
        params.storeId,
      ]);
    } else {
      for (const trigger of descriptor.triggers ?? []) {
        destination.db.exec(trigger.sql);
      }
      writeSqliteUserVersion(destination.db, descriptor.version);
      assertSqliteIntegrity(destination.db, "Port SQLite destination");
    }
    const verified = {
      tables: await scan(destination, descriptor, maxRowBytes),
      allocations: await readDatabasePortAllocations(destination, descriptor),
    };
    const expected =
      destination.engine === "sqlite"
        ? sqlitePortAllocations(descriptor, verified.allocations, facts)
        : facts;
    if (!isDeepStrictEqual(verified, { tables, allocations: expected })) {
      throw new DatabasePortDataError("Port canonical verification failed");
    }
    if (destination.engine === "postgres") {
      assertCurrent();
      await destination.db.query("COMMIT");
      const statistics = await refreshPostgresPlannerStatistics(
        destination.db,
        destination.namespace,
      );
      params.onPlannerStatistics?.(statistics);
    }
    return verified;
  } catch (error) {
    if (destination.engine === "postgres") {
      await destination.db.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    if (source.engine === "postgres") {
      await source.db.query("ROLLBACK");
    } else {
      source.db.exec("ROLLBACK");
    }
  }
}
