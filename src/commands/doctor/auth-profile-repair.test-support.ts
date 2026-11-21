import type { maybeMigrateAuthProfileJsonStoresToSqlite } from "../doctor-auth-flat-profiles.js";

type ImportResult = Awaited<ReturnType<typeof maybeMigrateAuthProfileJsonStoresToSqlite>>;

export function createAuthProfileImportResult(overrides: Partial<ImportResult> = {}): ImportResult {
  return {
    detected: [],
    changes: [],
    migratedProfileIds: new Set(),
    blockedProfileIds: new Set(),
    warnings: [],
    findings: [],
    aliasFindings: [],
    ...overrides,
  };
}
