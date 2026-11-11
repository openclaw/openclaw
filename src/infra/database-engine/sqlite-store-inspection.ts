import type { DatabaseSync } from "node:sqlite";
import { assertOpenClawStateDatabaseForMaintenance } from "../../state/openclaw-state-db-maintenance.js";
import { readStateSchemaContentVersion } from "../../state/openclaw-state-db-schema-version.js";
import { readGatewayOwnerLeaseFromDatabase } from "../gateway-owner-lease.read.js";
import type { GatewayOwnerLeaseIdentity } from "../gateway-owner-lease.types.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../sqlite-schema-facts.js";
import type { DatabaseStoreDiagnostic } from "./diagnostic-record.js";
import { readEngineAnchorIdentity, type BackupEngine } from "./physical-store.js";
import type { PortDescriptor } from "./port-types.js";

export function observeLease(
  result: DatabaseStoreDiagnostic,
  lease: GatewayOwnerLeaseIdentity | undefined,
) {
  result.lease =
    !lease || lease.state === "dead"
      ? "none"
      : lease.state === "live"
        ? "live-owner"
        : "unverifiable";
  if (result.lease === "unverifiable") {
    result.nextSteps.push("Inspect the recorded Gateway lease before offline maintenance.");
  }
}

export function observeVersion(result: DatabaseStoreDiagnostic, version: number) {
  result.schema.versioning = "versioned";
  result.schema.version = version;
  const expected = result.schema.expectedVersion;
  if (expected === null) {
    return;
  }
  result.schema.pending = Math.max(0, expected - version);
  if (version < expected) {
    result.issues.push(`Schema migrations pending: version ${version}, expected ${expected}.`);
    result.nextSteps.push("Run openclaw doctor --fix with the matching OpenClaw version.");
  } else if (version > expected) {
    result.issues.push(`Schema version ${version} is newer than supported version ${expected}.`);
    result.nextSteps.push(
      "Use an OpenClaw version that supports this schema, or restore its matching backup.",
    );
  }
}

function inspectSqlite(
  result: DatabaseStoreDiagnostic,
  db: DatabaseSync,
  descriptor?: PortDescriptor,
) {
  admitSqliteSchema(db);
  const facts = getAdmittedSqliteSchemaFacts(db)!;
  result.connectivity = "local";
  result.extensions = [];
  let version = facts.userVersion;
  try {
    if (result.family === "state") {
      // Unfenced updaters retain an older header after content migration. Health
      // admission uses the state owner; porting still requires a published header.
      version = readStateSchemaContentVersion(db);
      assertOpenClawStateDatabaseForMaintenance(db, {
        pathname: "shared-state diagnostic snapshot",
      });
      observeVersion(result, version);
    } else if (descriptor?.inspectSqliteSource) {
      const source = descriptor.inspectSqliteSource(db);
      observeVersion(result, source.version);
      if (source.migrationRequired && source.version === result.schema.expectedVersion) {
        // Port preparation includes same-version repairs; it is not a schema-version gap.
        result.issues.push("Store preparation is required before porting.");
        result.nextSteps.push("Database porting performs this preparation on a private copy.");
      }
    } else if (result.schema.versioning === "versioned") {
      observeVersion(result, version);
    }
  } catch {
    // Preserve decoded state content, or the physical header if decoding failed.
    if (result.family === "state" || result.family === "agent") {
      observeVersion(result, version);
    }
    result.issues.push("The SQLite schema could not be admitted by its store owner.");
    result.nextSteps.push("Run openclaw doctor --fix with the matching OpenClaw version.");
  }
  if (result.family === "state") {
    try {
      observeLease(result, readGatewayOwnerLeaseFromDatabase(db));
    } catch {
      result.issues.push("The recorded Gateway lease could not be verified.");
      result.nextSteps.push("Check the Gateway owner and rerun openclaw doctor.");
    }
  }
}

/** One read-only connection: a private copy, or a live WAL source pinned by its read transaction. */
export function inspectSqliteStoreImage(
  result: DatabaseStoreDiagnostic,
  db: DatabaseSync,
  sourcePath: string,
  descriptor?: PortDescriptor,
): BackupEngine {
  const engine = readEngineAnchorIdentity(db, sourcePath);
  result.observed = engine.engine;
  result.mismatch = engine.engine !== result.configured.effective;
  if (result.mismatch) {
    result.issues.push(
      `Configured ${result.configured.effective}, but the physical store is ${engine.engine}.`,
    );
    result.nextSteps.push(
      result.configured.fixedLocal
        ? "Restore the fixed-local SQLite store from its verified backup."
        : `Stop the Gateway and run openclaw database port --family ${result.family} --to ${result.configured.effective}, or restore the matching engine configuration.`,
    );
  }
  if (engine.engine === "sqlite") {
    inspectSqlite(result, db, descriptor);
  }
  return engine;
}
