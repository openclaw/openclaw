import { DatabaseSync } from "node:sqlite";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { removePreparedWorkerOwnershipColumns } from "../../state/openclaw-state-schema-v17.test-support.js";
import { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import type { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";

export function createSelectedTargetStateDatabase(databasePath: string) {
  openOpenClawStateDatabase();
  closeOpenClawStateDatabaseForTest();
  const db = new DatabaseSync(databasePath);
  try {
    removePreparedWorkerOwnershipColumns(db);
    db.exec(
      "PRAGMA user_version=16; UPDATE schema_meta SET schema_version=16, app_version='2026.9.2'",
    );
  } finally {
    db.close();
  }
}

export async function captureFreshManagedServiceAdmission(params: {
  root: string;
  owned: boolean;
  writable: boolean;
  restart: boolean;
}): Promise<Awaited<ReturnType<typeof inspectUpdateDatabaseContexts>>> {
  return {
    service: params.owned
      ? {
          stopped: false,
          inspected: true,
          runtimeInspected: true,
          running: true,
          serviceNodeRunner: "/service/node",
          serviceMutationAllowed: params.restart,
          serviceUpdateVerdict: {
            kind: "owned",
            root: params.root,
            fingerprint: "fixture",
            refreshDefinition: params.writable,
          },
        }
      : undefined,
    services: new Map(),
    contexts: [await captureTargetDatabaseSchemaContext(process.env)],
    managedEnv: undefined,
  };
}

// Discovery-known service runners stay protected when schema inspection has no service context.
export const freshManagedServiceRuntimeCases = [
  {
    name: "owned writable service",
    discovered: true,
    owned: true,
    writable: true,
    restart: true,
    expectedFallback: "/current/node",
    expectedRecovery: true,
  },
  {
    name: "discovered service without inspected ownership",
    discovered: true,
    owned: false,
    writable: false,
    restart: true,
    expectedFallback: undefined,
    expectedRecovery: false,
  },
  {
    name: "owned service with no restart",
    discovered: true,
    owned: true,
    writable: true,
    restart: false,
    expectedFallback: undefined,
    expectedRecovery: false,
  },
  {
    name: "owned non-rewritable service",
    discovered: true,
    owned: true,
    writable: false,
    restart: true,
    expectedFallback: undefined,
    expectedRecovery: false,
  },
  {
    name: "no discovered service",
    discovered: false,
    owned: false,
    writable: false,
    restart: true,
    expectedFallback: undefined,
    expectedRecovery: true,
  },
  {
    name: "no discovered service with no restart",
    discovered: false,
    owned: false,
    writable: false,
    restart: false,
    expectedFallback: undefined,
    expectedRecovery: true,
  },
] as const;
