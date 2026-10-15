import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { Client } from "pg";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { readTableColumns } from "../../state/openclaw-state-db-schema-helpers.js";
import { assertSqliteIntegrity } from "../sqlite-integrity.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../sqlite-schema-facts.js";
import {
  postgresCatalogQuery,
  readPostgresCatalog,
  type PostgresCatalogFact,
} from "./postgres-catalog.js";
import type { DatabaseEngineInput } from "./types.js";

export class DatabasePortDataError extends Error {}

export type DatabasePortProvider = {
  id: string;
  resolveRoots(context: {
    config: OpenClawConfig;
    stateDir: string;
    env: NodeJS.ProcessEnv;
    plugins: ReturnType<typeof resolvePluginMetadataSnapshot>;
  }): readonly string[];
  matchesSqlite(tables: ReadonlySet<string>): boolean;
  /** Includes the expected catalog from the same generated source as the bundled DDL. */
  loadDescriptor(): Promise<PortDescriptor>;
};

export type PortRow = Record<string, SQLInputValue>;
export type PortTable = {
  name: string;
  columns: readonly { name: string; type: string }[];
  pk: readonly string[];
  identities: readonly { column: string; autoIncrement: boolean }[];
};
type PortSchema = {
  tables: readonly PortTable[];
  sqlite: string;
  preData: string;
  postData: string;
  expectedCatalog: readonly PostgresCatalogFact[];
  triggers?: readonly { name: string; table: string; sql: string }[];
  projections?: readonly {
    tables: readonly string[];
    rebuild(target: PortEndpoint): void | Promise<void>;
  }[];
};
export type PortDescriptor = PortSchema & {
  id: string;
  version: number;
  minimumPostgresVersion: number;
  fragments?: readonly (PortSchema & { id: string; dependencies: readonly string[] })[];
  /** Populated from the admitted source, never from the configured feature set. */
  activeFragments?: readonly string[];
  inspectSqliteSource?: (db: DatabaseSync) => {
    version: number;
    migrationRequired: boolean;
    pendingColumns: Readonly<Record<string, readonly string[]>>;
  };
  /** Caller supplies an exclusively owned private copy, never the live source. */
  migrateSqliteSource?: (path: string, sourceVersion: number) => void | Promise<void>;
  admit?: (path: string, input?: DatabaseEngineInput) => void | Promise<void>;
  derive?: Readonly<Record<string, (row: PortRow) => PortRow>>;
};
export type PortEndpoint =
  | { engine: "sqlite"; db: DatabaseSync }
  | { engine: "postgres"; db: Client; namespace: string };
type Endpoint = PortEndpoint;
function selectFragments(descriptor: PortDescriptor, tables: ReadonlySet<string>): PortDescriptor {
  if (descriptor.activeFragments) {
    return descriptor;
  }
  const active =
    descriptor.fragments?.filter((fragment) =>
      fragment.tables.some((table) => tables.has(table.name)),
    ) ?? [];
  const ordered: typeof active = [];
  const visit = (fragment: (typeof active)[number], visiting = new Set<string>()) => {
    if (ordered.includes(fragment)) {
      return;
    }
    if (visiting.has(fragment.id)) {
      throw new DatabasePortDataError(`Cyclic port fragment dependency: ${fragment.id}`);
    }
    visiting.add(fragment.id);
    for (const id of fragment.dependencies) {
      const dependency = active.find((item) => item.id === id);
      if (!dependency) {
        throw new DatabasePortDataError(
          `Port fragment ${fragment.id} requires missing fragment ${id}`,
        );
      }
      visit(dependency, visiting);
    }
    visiting.delete(fragment.id);
    ordered.push(fragment);
  };
  active.forEach((fragment) => visit(fragment));
  const schemas = [descriptor, ...ordered];
  return {
    ...descriptor,
    activeFragments: ordered.map((fragment) => fragment.id),
    tables: schemas.flatMap((schema) => schema.tables),
    triggers: schemas.flatMap((schema) => schema.triggers ?? []),
    projections: schemas.flatMap((schema) => schema.projections ?? []),
    expectedCatalog: schemas.flatMap((schema) => schema.expectedCatalog),
    sqlite: schemas.map((schema) => schema.sqlite).join("\n;\n"),
    preData: schemas.map((schema) => schema.preData).join("\n;\n"),
    postData: schemas.map((schema) => schema.postData).join("\n;\n"),
  };
}

/** Resolve optional schema exactly once against the source's admitted catalog. */
export async function admitDatabasePortDescriptor(
  source: Endpoint,
  descriptor: PortDescriptor,
  requiredFragments?: readonly string[],
) {
  const admitted = descriptor.activeFragments
    ? descriptor
    : source.engine === "sqlite"
      ? inspectSqlitePortSchema(source.db, descriptor)
      : selectFragments(
          descriptor,
          new Set(
            readPostgresCatalog(
              (await source.db.query(postgresCatalogQuery(source.namespace))).rows[0].catalog,
            )
              .filter((fact) => fact.kind === "table")
              .map((fact) => fact.table),
          ),
        );
  if (
    requiredFragments &&
    !isDeepStrictEqual(requiredFragments.toSorted(), admitted.activeFragments!.toSorted())
  ) {
    throw new DatabasePortDataError("Port source fragments differ from the recorded backup");
  }
  return admitted;
}
/** Validate the canonical SQLite surface before scanning or owner migration. */
export function inspectSqlitePortSchema(
  db: DatabaseSync,
  baseDescriptor: PortDescriptor,
  pendingColumns: Readonly<Record<string, readonly string[]>> = {},
): PortDescriptor {
  assertSqliteIntegrity(db, "Port SQLite source");
  admitSqliteSchema(db);
  const facts = getAdmittedSqliteSchemaFacts(db);
  const descriptor = facts ? selectFragments(baseDescriptor, facts.tables) : baseDescriptor;
  if (
    !facts ||
    facts.views.size ||
    [...facts.triggers].some(
      ([name, trigger]) =>
        !descriptor.triggers?.some(
          (known) =>
            known.name === name &&
            known.table === trigger.table &&
            known.sql.trim() === trigger.sql?.trim(),
        ),
    ) ||
    [...facts.tables].some(
      (name) =>
        !name.startsWith("sqlite_") && !descriptor.tables.some((table) => table.name === name),
    )
  ) {
    throw new DatabasePortDataError(
      "Unknown SQLite table, trigger or view; complete descriptor coverage required",
    );
  }
  for (const table of descriptor.tables) {
    const columns = readTableColumns(db, table.name);
    const expected = new Set(table.columns.map((column) => column.name));
    const pending = pendingColumns[table.name] ?? [];
    if (
      !columns.size ||
      [...columns].some((name) => !expected.has(name)) ||
      [...expected].some((name) => !columns.has(name) && !pending.includes(name))
    ) {
      throw new DatabasePortDataError(
        `Unknown or missing columns in ${table.name}; complete descriptor coverage required`,
      );
    }
  }
  if (descriptor.triggers?.some((trigger) => !facts.triggers.has(trigger.name))) {
    throw new DatabasePortDataError("Missing canonical SQLite trigger");
  }
  return descriptor;
}
