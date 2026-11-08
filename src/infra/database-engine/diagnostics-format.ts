import type { DatabaseStoreDiagnostic } from "./diagnostics.js";

/** The text view preserves unknowns and the same per-store facts exposed by JSON. */
export function formatDatabaseStoreDiagnostic(store: DatabaseStoreDiagnostic): string {
  const { configured, schema } = store;
  const local = store.observed === "sqlite";
  const fields = [
    `${store.family}${store.path ? ` (${store.path})` : ""}`,
    `default=${configured.default}, override=${configured.fixedLocal ? "fixed local (local by design)" : (configured.override ?? "inherit")}, effective=${configured.effective}`,
    `observed=${store.observed}${store.mismatch === true ? " (mismatch)" : store.mismatch === null ? " (mismatch unknown)" : ""}`,
    `schema=${schema.versioning === "unversioned" ? "unversioned" : (schema.version ?? "unknown")}, expected=${schema.versioning === "unversioned" ? "not applicable" : (schema.expectedVersion ?? "unknown")}, pending=${schema.pending ?? "unknown"}`,
    `connectivity=${store.connectivity}`,
    `namespace=${store.namespace ?? (local ? "not applicable" : "unknown")}`,
    `storeId=${store.storeId ?? (local ? "not applicable" : "unknown")}`,
    `database=${store.database ?? (local ? "local file" : "unknown")}`,
    `extensions=${store.extensions === null ? "unknown" : store.extensions.join(", ") || "none"}`,
    `admittedExtensions=${store.admittedExtensions === null ? "unknown" : store.admittedExtensions.join(", ") || "none"}`,
    `degraded=${store.degraded === null ? "unknown" : store.degraded.join(", ") || "none"}`,
    `custody=${store.custody}, lease=${store.lease}`,
    `backup=${store.backup?.status ?? "unknown"}`,
    `legacy=${store.legacyMigrations.state}${store.legacyMigrations.pending.length ? ` (${store.legacyMigrations.pending.join(", ")})` : ""}`,
  ];
  if (store.issues.length) {
    fields.push(store.issues.join(" "));
  }
  if (store.nextSteps.length) {
    fields.push(`Next: ${store.nextSteps.join(" ")}`);
  }
  return fields.join("; ");
}
