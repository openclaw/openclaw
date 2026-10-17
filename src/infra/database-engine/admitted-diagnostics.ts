import type { OpenClawConfig } from "../../config/types.js";
import {
  captureSqliteDatabaseAdmissions,
  getOrLoadSqliteDatabaseAdmissionForPath,
} from "../sqlite-database-admission.js";
import { schemaAdmission } from "../sqlite-schema-admission.js";
import type { DatabaseStoreDiagnostic } from "./diagnostics.js";
import { listLocalDatabaseDiagnosticStores } from "./local-diagnostics.js";
import { getPostgresPhysicalFactsForPath } from "./physical-facts.js";
import { databasePortProviders } from "./port-provider.js";
import { describeDatabaseEngineSelection } from "./report.js";

function unknownStore(
  family: string,
  configured: DatabaseStoreDiagnostic["configured"],
): DatabaseStoreDiagnostic {
  return {
    family,
    path: null,
    configured,
    observed: "unknown",
    mismatch: null,
    schema: { versioning: "unknown", version: null, expectedVersion: null, pending: null },
    connectivity: "unknown",
    namespace: null,
    storeId: null,
    database: null,
    extensions: null,
    admittedExtensions: null,
    degraded: null,
    custody: "unverifiable",
    lease: "unverifiable",
    backup: null,
    legacyMigrations: { state: "unknown", pending: [] },
    issues: ["Status reports admitted facts; unobserved facts remain unknown."],
    nextSteps: [
      "Run openclaw doctor on the Gateway host for physical connectivity, schema migrations, ownership, and backup diagnostics.",
    ],
  };
}

/** Pure admission projection: never opens stores, resolves roots, or probes PostgreSQL. */
export function describeAdmittedDatabaseStores(config: OpenClawConfig): DatabaseStoreDiagnostic[] {
  const selections = describeDatabaseEngineSelection(config);
  const observed = new Map<string, DatabaseStoreDiagnostic[]>();
  for (const admission of captureSqliteDatabaseAdmissions()) {
    const postgres = getPostgresPhysicalFactsForPath(admission.location);
    const sqlite = postgres
      ? undefined
      : getOrLoadSqliteDatabaseAdmissionForPath(
          admission.location,
          schemaAdmission,
          () => undefined,
        );
    const providers = postgres
      ? databasePortProviders.filter((entry) => entry.id === postgres.store)
      : sqlite
        ? databasePortProviders.filter((entry) => entry.matchesSqlite(sqlite.tables))
        : [];
    const provider = providers.length === 1 ? providers[0] : undefined;
    const selection = provider ? selections.find((entry) => entry.id === provider.id) : undefined;
    if (!selection || (!postgres && !sqlite)) {
      continue;
    }
    const row = unknownStore(selection.id, {
      default: selection.default,
      override: selection.override,
      effective: selection.effective,
      fixedLocal: selection.fixedLocal,
    });
    row.path = admission.location;
    row.observed = postgres ? "postgres" : "sqlite";
    row.mismatch = row.observed !== row.configured.effective;
    if (postgres || selection.id === "state" || selection.id === "agent") {
      row.schema.versioning = "versioned";
      row.schema.version = postgres?.version ?? sqlite?.userVersion ?? null;
    }
    if (postgres) {
      row.namespace = postgres.namespace;
      row.storeId = postgres.storeId;
    } else {
      row.connectivity = "local";
    }
    if (row.mismatch) {
      row.issues.push(`Configured ${row.configured.effective}, observed ${row.observed}.`);
      row.nextSteps.unshift(
        `Stop the Gateway and run openclaw database port --family ${row.family}, or restore the matching engine configuration.`,
      );
    }
    const entries = observed.get(selection.id) ?? [];
    entries.push(row);
    observed.set(selection.id, entries);
  }
  const rows = selections.flatMap((selection) => {
    const entries = observed.get(selection.id);
    return entries?.length
      ? entries.toSorted((first, second) => (first.path ?? "").localeCompare(second.path ?? ""))
      : [
          unknownStore(selection.id, {
            default: selection.default,
            override: selection.override,
            effective: selection.effective,
            fixedLocal: selection.fixedLocal,
          }),
        ];
  });
  for (const store of listLocalDatabaseDiagnosticStores()) {
    if (!selections.some((selection) => selection.id === store.id)) {
      rows.push(
        unknownStore(store.id, {
          default: config.database?.engine ?? "sqlite",
          override: null,
          effective: "sqlite",
          fixedLocal: true,
        }),
      );
    }
  }
  return rows;
}
