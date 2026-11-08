import type { DatabaseEngineId } from "./types.js";

export type DatabaseStoreDiagnostic = {
  family: string;
  path: string | null;
  configured: {
    default: DatabaseEngineId;
    override: DatabaseEngineId | null;
    effective: DatabaseEngineId;
    fixedLocal: boolean;
  };
  observed: DatabaseEngineId | "unknown";
  mismatch: boolean | null;
  schema: {
    versioning: "versioned" | "unversioned" | "unknown";
    version: number | null;
    expectedVersion: number | null;
    pending: number | null;
  };
  connectivity: "reachable" | "unreachable" | "unknown" | "local";
  namespace: string | null;
  storeId: string | null;
  database: string | null;
  extensions: string[] | null;
  admittedExtensions: string[] | null;
  degraded: string[] | null;
  custody: "live-owner" | "none" | "unverifiable";
  lease: "live-owner" | "none" | "unverifiable";
  backup: { status: string } | null;
  legacyMigrations: { state: "pending" | "none" | "unknown"; pending: string[] };
  issues: string[];
  nextSteps: string[];
};

export function createDatabaseStoreDiagnostic(
  input: Pick<DatabaseStoreDiagnostic, "family" | "path" | "configured">,
): DatabaseStoreDiagnostic {
  return {
    ...input,
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
    issues: [],
    nextSteps: [],
  };
}
