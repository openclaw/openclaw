import assert from "node:assert/strict";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import { resolveStateDir } from "../config/paths.js";
import { embedSessionColdArchivesInSnapshot } from "../config/sessions/session-cold-storage-backup.js";
import {
  createVerifiedSqliteSnapshot,
  type SqliteSnapshotValidator,
} from "../infra/sqlite-snapshot.js";
import { assertNotUpdateCapturePath } from "../infra/update-capture-paths.js";
import { isValidAgentId, normalizeAgentId } from "../routing/session-key.js";
import {
  assertOpenClawAgentDatabaseForMaintenance,
  assertOpenClawAgentDatabaseOwner,
} from "../state/openclaw-agent-db-maintenance.js";
import { assertSupportedAgentSchemaVersion } from "../state/openclaw-agent-db-schema-read.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  assertOpenClawStateDatabaseOwner,
} from "../state/openclaw-state-db-maintenance.js";
import { assertSupportedStateSchemaVersion } from "../state/openclaw-state-db-schema-version.js";
import {
  sanitizeOpenClawGlobalStateSnapshot,
  sanitizeOpenClawStateLeaseRows,
} from "../state/openclaw-state-snapshot-sanitizer.js";
import type { SnapshotDatabaseIdentity, SnapshotDatabaseRef } from "./snapshot-provider.js";

export function normalizeSnapshotIdentity(
  identity: SnapshotDatabaseIdentity,
): SnapshotDatabaseIdentity {
  if (identity.role === "global") {
    return identity;
  }
  if (identity.role === "agent") {
    const agentId = normalizeAgentId(identity.agentId);
    if (!isValidAgentId(identity.agentId) || agentId !== identity.agentId) {
      throw new Error(`SQLite snapshot agent id must be canonical: ${identity.agentId}`);
    }
    return { role: "agent", agentId };
  }
  const id = identity.id.trim();
  if (!id || id !== identity.id || id.length > 256 || containsAsciiControlCharacter(id)) {
    throw new Error("SQLite snapshot generic database id is invalid.");
  }
  return { role: "generic", id };
}

export function buildSnapshotValidator(
  identity: SnapshotDatabaseIdentity,
): SqliteSnapshotValidator {
  return (database, pathname) => {
    if (identity.role === "global") {
      const version = assertSupportedStateSchemaVersion(database, pathname);
      const owner = assertOpenClawStateDatabaseOwner(database, { pathname });
      assert(version > 0 && owner.schema_version === version, "Invalid snapshot schema version.");
    } else if (identity.role === "agent") {
      const version = assertSupportedAgentSchemaVersion(database, pathname);
      const owner = assertOpenClawAgentDatabaseOwner(database, {
        pathname,
        agentId: identity.agentId,
      });
      assert(version > 0 && owner.schemaVersion === version, "Invalid snapshot schema version.");
    }
  };
}

/** Produce the canonical sanitized, compact, verified copy used by every snapshot provider. */
export async function createOpenClawSnapshotCopy(params: {
  database: SnapshotDatabaseRef;
  targetPath: string;
}): Promise<{ identity: SnapshotDatabaseIdentity; path: string; userVersion: number }> {
  assertNotUpdateCapturePath(params.database.path, resolveStateDir());
  const identity = normalizeSnapshotIdentity(params.database.identity);
  const result = await createVerifiedSqliteSnapshot({
    sourcePath: params.database.path,
    targetPath: params.targetPath,
    requireNonEmptySource: identity.role !== "generic",
    transform: async (database) => {
      if (identity.role === "global") {
        sanitizeOpenClawGlobalStateSnapshot(database);
      } else if (identity.role === "agent") {
        sanitizeOpenClawStateLeaseRows(database);
      }
      await embedSessionColdArchivesInSnapshot({
        database,
        sourceStorePath: params.database.path,
      });
    },
    validate:
      identity.role === "global"
        ? (database, pathname) => assertOpenClawStateDatabaseForMaintenance(database, { pathname })
        : identity.role === "agent"
          ? (database, pathname) =>
              assertOpenClawAgentDatabaseForMaintenance(database, {
                pathname,
                agentId: identity.agentId,
              })
          : undefined,
  });
  return { identity, ...result };
}
