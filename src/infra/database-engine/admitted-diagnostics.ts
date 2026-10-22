import path from "node:path";
import {
  hasAgentRosterProperty,
  listAgentIds,
  resolveEffectiveAgentDir,
} from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.js";
import {
  captureSqliteDatabaseAdmissions,
  getOrLoadSqliteDatabaseAdmissionForPath,
} from "../sqlite-database-admission.js";
import { schemaAdmission } from "../sqlite-schema-admission.js";
import { createDatabaseStoreDiagnostic } from "./diagnostic-record.js";
import type { DatabaseStoreDiagnostic } from "./diagnostics.js";
import { listLocalDatabaseDiagnosticStores } from "./local-diagnostics.js";
import { getPostgresPhysicalFactsForPath } from "./physical-facts.js";
import { databasePortProviders } from "./port-provider.js";
import { describeDatabaseEngineSelection } from "./report.js";

function unknownStore(
  family: string,
  configured: DatabaseStoreDiagnostic["configured"],
): DatabaseStoreDiagnostic {
  const result = createDatabaseStoreDiagnostic({ family, path: null, configured });
  result.issues.push("Status reports admitted facts; unobserved facts remain unknown.");
  result.nextSteps.push(
    "Run openclaw doctor on the Gateway host for physical connectivity, schema migrations, ownership, and backup diagnostics.",
  );
  return result;
}

/** Configured paths and admission facts only; never opens stores or probes PostgreSQL. */
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
    const configured = {
      default: selection.default,
      override: selection.override,
      effective: selection.effective,
      fixedLocal: selection.fixedLocal,
    };
    const entries = observed.get(selection.id) ?? [];
    if (selection.id === "agent" && hasAgentRosterProperty(config)) {
      for (const agentId of listAgentIds(config)) {
        const pathname = path.join(
          resolveEffectiveAgentDir(config, agentId),
          "openclaw-agent.sqlite",
        );
        if (!entries.some((entry) => entry.path === pathname)) {
          const row = unknownStore(selection.id, configured);
          row.path = pathname;
          entries.push(row);
        }
      }
    }
    return entries.length
      ? entries.toSorted((first, second) => (first.path ?? "").localeCompare(second.path ?? ""))
      : [unknownStore(selection.id, configured)];
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
