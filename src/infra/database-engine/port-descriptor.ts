import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import type { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { readTableColumns } from "../../state/openclaw-state-db-schema-helpers.js";
import { assertSqliteIntegrity } from "../sqlite-integrity.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../sqlite-schema-facts.js";
import { normalizeSchemaSql } from "../sqlite-schema-sql.js";
import type { PortDescriptor, PortEndpoint } from "./port-types.js";
import { postgresCatalogQuery, readPostgresCatalog } from "./postgres-catalog.js";
import { DatabasePortDataError } from "./postgres-store-metadata.js";

export type { PortDescriptor, PortEndpoint, PortRow, PortTable } from "./port-types.js";

export { DatabasePortDataError };

export type DatabasePortProvider = {
  id: string;
  minimumPostgresVersion: number;
  /** Resolve the selected installation before loading its public port artifact. */
  requiresPluginOwner?: true;
  resolveRoots(context: {
    config: OpenClawConfig;
    stateDir: string;
    env: NodeJS.ProcessEnv;
    plugins: Pick<ReturnType<typeof resolvePluginMetadataSnapshot>, "plugins">;
  }): readonly string[] | Promise<readonly string[]>;
  matchesSqlite(tables: ReadonlySet<string>): boolean;
  /** Includes the expected catalog from the same generated source as the bundled DDL. */
  loadDescriptor(
    owner?: Pick<PluginManifestRecord, "id" | "rootDir" | "source" | "origin">,
    version?: number,
  ): Promise<PortDescriptor>;
};

export type DatabasePortPluginOwners = Record<
  string,
  NonNullable<Parameters<DatabasePortProvider["loadDescriptor"]>[0]>
>;

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
  const sourceTriggers = [
    ...(descriptor.triggers ?? []),
    ...(descriptor.omittedSqliteTriggers ?? []),
  ];
  if (
    !facts ||
    facts.views.size ||
    [...facts.triggers].some(
      ([name, trigger]) =>
        !sourceTriggers.some(
          (known) =>
            known.name === name &&
            known.table === trigger.table &&
            normalizeSchemaSql(known.sql) === normalizeSchemaSql(trigger.sql),
        ),
    ) ||
    [...facts.tables].some(
      (name) =>
        !name.startsWith("sqlite_") &&
        !descriptor.tables.some((table) => table.name === name) &&
        !descriptor.projections?.some((projection) => projection.tables.includes(name)),
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
