import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { Client } from "pg";
import { encodeSqliteValue, escapedSqliteText } from "../../snapshot/sqlite-cell-codec.js";
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
  assertPostgresCatalog,
  postgresCatalogQuery,
  readPostgresCatalog,
  type PostgresCatalogFact,
} from "./postgres-catalog.js";

type PortRow = Record<string, SQLInputValue>;
type PortTable = {
  name: string;
  columns: readonly { name: string; type: string }[];
  pk: readonly string[];
  identities: readonly { column: string; autoIncrement: boolean }[];
};
export type PortDescriptor = {
  id: string;
  version: number;
  minimumPostgresVersion: number;
  tables: readonly PortTable[];
  sqlite: string;
  preData: string;
  postData: string;
  expectedCatalog: readonly PostgresCatalogFact[];
  derive?: Readonly<Record<string, (row: PortRow) => PortRow>>;
};
export type PortVerification = {
  tables: Record<string, { rows: number; sha256: string }>;
  allocations: Record<string, { value: string; called: boolean }>;
};
type Endpoint =
  | { engine: "sqlite"; db: DatabaseSync }
  | { engine: "postgres"; db: Client; namespace: string };
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
      throw new Error(
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
) {
  if (!table.pk.length) {
    throw new Error(`Port requires a canonical key: ${table.name}`);
  }
  const names = table.columns.map((c) => quote(c.name));
  const keys = table.pk.map(quote).join(",");
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
    const page = `SELECT ${projection} FROM ${qualified(endpoint, table.name)}${where} ORDER BY ${keys} LIMIT ${limit}`;
    const sql =
      endpoint.engine === "sqlite"
        ? page
        : `WITH page AS (${page}), sized AS (
      SELECT page.*, sum(${rowBytes}) OVER (ORDER BY ${keys}) AS __port_size,
      row_number() OVER (ORDER BY ${keys}) AS __port_row FROM page)
      SELECT ${names.join(",")} FROM sized WHERE __port_size <= ${MAX_BYTES} OR __port_row = 1 ORDER BY ${keys}`;
    let rows: Iterable<PortRow>;
    if (endpoint.engine === "sqlite") {
      const statement = sqliteStatement(endpoint.db, sql);
      rows = statement.iterate(...params);
    } else {
      const result = await endpoint.db.query(sql, params.map(binding));
      rows = decodePostgresRows({ ...result, rowCount: result.rowCount ?? 0 }, true);
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
            throw new Error(`Port refused invalid UTF-8: ${table.name}.${name}`);
          }
        }
        row[name] = value;
      });
      const derived = derive?.(row);
      if (
        !normalize &&
        derived &&
        Object.entries(derived).some(([key, value]) => !isDeepStrictEqual(value, row[key]))
      ) {
        throw new Error(`Port derived columns differ: ${table.name}`);
      }
      Object.assign(row, derived);
      const size = checkRow(table, row);
      if (size > maxRowBytes) {
        throw new Error(
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
      cursor = table.pk.map((k) => row[k]!);
    }
    if (batch.length) {
      yield batch;
    }
    if (count === 0 || (endpoint.engine === "sqlite" && count < limit)) {
      break;
    }
  }
}

async function allocations(
  endpoint: Endpoint,
  descriptor: PortDescriptor,
): Promise<PortVerification["allocations"]> {
  const result: PortVerification["allocations"] = {};
  for (const table of descriptor.tables) {
    for (const identity of table.identities) {
      const key = `${table.name}.${identity.column}`;
      if (endpoint.engine === "postgres") {
        const sequence = await endpoint.db.query("SELECT pg_get_serial_sequence($1, $2) AS name", [
          qualified(endpoint, table.name),
          identity.column,
        ]);
        const row = (
          await endpoint.db.query(
            `SELECT greatest(last_value, coalesce(retained, last_value))::text AS value, is_called OR coalesce(retained >= last_value, false) AS called FROM ${sequence.rows[0].name} CROSS JOIN (SELECT max(${quote(identity.column)}) AS retained FROM ${qualified(endpoint, table.name)}) m`,
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

async function restoreAllocations(
  endpoint: Endpoint,
  descriptor: PortDescriptor,
  facts: PortVerification["allocations"],
) {
  for (const table of descriptor.tables) {
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
) {
  const tables: PortVerification["tables"] = {};
  for (const table of descriptor.tables) {
    const hash = createHash("sha256").update(JSON.stringify(table.columns) + "\n");
    let rows = 0;
    let pending: Promise<void> | undefined;
    const stream = readBatches(
      endpoint,
      table,
      maxRowBytes,
      descriptor.derive?.[table.name],
      Boolean(destination),
    );
    try {
      let next = stream.next();
      for (;;) {
        const { value: batch, done } = await next;
        if (done) {
          break;
        }
        for (const row of batch) {
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
        if (destination) {
          pending = insertBatch(destination, table, batch, assertCurrent);
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
) {
  await endpoint.db.query("SELECT set_config('search_path', $1, false)", [
    quote(endpoint.namespace),
  ]);
  const facts = readPostgresCatalog(
    (await endpoint.db.query(postgresCatalogQuery(endpoint.namespace, true))).rows[0].catalog,
  ).filter((f) => f.table !== "openclaw_schema_meta");
  assertPostgresCatalog(
    facts.filter((f) => !f.kind.endsWith("Definition")),
    descriptor.expectedCatalog,
  );
  const invalid = await endpoint.db.query(
    `SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND NOT c.convalidated UNION ALL SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT i.indisvalid`,
    [endpoint.namespace],
  );
  if (invalid.rowCount) {
    throw new Error("Port catalog has unvalidated constraints or invalid indexes");
  }
  return facts
    .filter((f) => f.kind.endsWith("Definition"))
    .map((f) => ({
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
) {
  const reference = { ...endpoint, namespace: `port_verify_${randomUUID().replaceAll("-", "")}` };
  await endpoint.db.query("BEGIN");
  try {
    await endpoint.db.query(
      `CREATE SCHEMA ${quote(reference.namespace)}; SET LOCAL search_path = ${quote(reference.namespace)}`,
    );
    await endpoint.db.query(descriptor.preData + "\n" + descriptor.postData);
    return await catalogEvidence(reference, descriptor);
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
    throw new Error("Port source identity or schema version differs");
  }
}

/** Offline recovery inspection, never a runtime foreign-writer probe. */
export async function inspectDatabasePort(
  source: Extract<Endpoint, { engine: "postgres" }>,
  descriptor: PortDescriptor,
  storeId: string,
) {
  await assertSourceIdentity(source, descriptor, storeId);
  await source.db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    return {
      catalog: await catalogEvidence(source, descriptor),
      tables: await scan(source, descriptor, 64 * 1024 * 1024),
      allocations: await allocations(source, descriptor),
    };
  } finally {
    await source.db.query("ROLLBACK");
  }
}

/** Offline worker API: caller owns tracked readBigInts SQLite handles, migrated source, fresh destination, and exclusive custody. No publication. */
export async function materializeDatabasePort(params: {
  source: Endpoint;
  destination: Endpoint;
  descriptor: PortDescriptor;
  storeId: string;
  assertCurrent: () => void;
  maxRowBytes?: number;
  sourceAllocations?: PortVerification["allocations"];
}): Promise<PortVerification> {
  const { source, destination, descriptor, assertCurrent } = params;
  if (source.engine === destination.engine) {
    throw new Error("Port endpoints must use different engines");
  }
  const maxRowBytes = params.maxRowBytes ?? 64 * 1024 * 1024;
  const postgres = [source, destination].find(
    (endpoint): endpoint is Extract<Endpoint, { engine: "postgres" }> =>
      endpoint.engine === "postgres",
  )!;
  const server = (
    await postgres.db.query(
      "SELECT current_setting('server_version_num')::int AS version, current_setting('server_encoding') AS encoding",
    )
  ).rows[0];
  if (server.version < descriptor.minimumPostgresVersion * 10000 || server.encoding !== "UTF8") {
    throw new Error("Port requires supported PostgreSQL with UTF8 encoding");
  }
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
      throw new Error("Port destination must have admitted empty schema facts");
    }
  }
  assertCurrent();
  const definitions = await referenceCatalog(postgres, descriptor);
  if (source.engine === "postgres") {
    assertPostgresCatalog(await catalogEvidence(source, descriptor), definitions);
  }
  if (source.engine === "postgres") {
    await source.db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  } else {
    source.db.exec("BEGIN");
  }
  try {
    if (destination.engine === "postgres") {
      await destination.db.query("SET synchronous_commit = on; SET statement_timeout = '1h'");
      assertCurrent();
      await destination.db.query(`CREATE SCHEMA ${quote(destination.namespace)}`);
      await destination.db.query(`SET search_path = ${quote(destination.namespace)}`);
      await destination.db.query(descriptor.preData);
    } else {
      withSqliteForeignKeysDisabled(destination.db, () => destination.db.exec(descriptor.sqlite));
    }
    const facts = params.sourceAllocations ?? (await allocations(source, descriptor));
    const tables = await scan(source, descriptor, maxRowBytes, destination, assertCurrent);
    assertCurrent();
    await restoreAllocations(destination, descriptor, facts);
    if (destination.engine === "postgres") {
      assertCurrent();
      await destination.db.query(descriptor.postData);
      assertPostgresCatalog(await catalogEvidence(destination, descriptor), definitions);
      await destination.db.query(
        "CREATE TABLE openclaw_schema_meta (store TEXT PRIMARY KEY, version BIGINT NOT NULL, store_id TEXT NOT NULL)",
      );
      await destination.db.query("INSERT INTO openclaw_schema_meta VALUES ($1,$2,$3)", [
        descriptor.id,
        descriptor.version,
        params.storeId,
      ]);
    } else {
      writeSqliteUserVersion(destination.db, descriptor.version);
      assertSqliteIntegrity(destination.db, "Port SQLite destination");
    }
    const verified = {
      tables: await scan(destination, descriptor, maxRowBytes),
      allocations: await allocations(destination, descriptor),
    };
    if (!isDeepStrictEqual(verified, { tables, allocations: facts })) {
      throw new Error("Port canonical verification failed");
    }
    return verified;
  } finally {
    if (source.engine === "postgres") {
      await source.db.query("ROLLBACK");
    } else {
      source.db.exec("ROLLBACK");
    }
  }
}
