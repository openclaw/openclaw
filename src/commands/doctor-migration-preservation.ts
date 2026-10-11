import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { withVerifiedUpdateRecoveryBackup } from "../infra/update-recovery-backup-reader.js";
import type { UpdateRecoveryBaselineRef } from "../infra/update-recovery-baseline-capture.js";
import { resolveCapturedRegistryPath } from "../infra/update-recovery-path.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  captureOpenClawMigrationWitness,
  assertOpenClawMigrationWitnessPreserved,
} from "../state/openclaw-migration-witness.js";
import type { UpdateRecoveryBackupManifest } from "./backup-verify-manifest.js";

type Entry = UpdateRecoveryBackupManifest["entries"][number];
type DatabaseOwner = NonNullable<UpdateRecoveryBackupManifest["databases"]>[number];

function readWitness(
  ref: UpdateRecoveryBaselineRef,
  entry: Entry,
  owner?: DatabaseOwner,
  registry?: Parameters<typeof captureOpenClawMigrationWitness>[2],
) {
  if (entry.kind !== "file" || !entry.sqlite) {
    throw new Error(`Preservation requires a captured SQLite payload: ${entry.sourcePath}`);
  }
  const pathname = path.join(ref.directory, entry.archivePath);
  const db = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(pathname), { readOnly: true });
  try {
    // sqlite-allow-raw: disable schema-defined functions while inspecting an immutable backup.
    db.exec("PRAGMA trusted_schema = OFF;");
    assertSqliteIntegrity(db, entry.sourcePath);
    return captureOpenClawMigrationWitness(db, owner, registry);
  } finally {
    db.close();
  }
}

/** Read-only cold evidence. It cannot admit a migration, start a service, or replace originals. */
export async function inspectDoctorMigrationPreservation(params: {
  original: UpdateRecoveryBaselineRef;
  candidate: UpdateRecoveryBaselineRef;
}) {
  return withVerifiedUpdateRecoveryBackup(params.original, async (original) =>
    withVerifiedUpdateRecoveryBackup(params.candidate, async (candidate) => {
      if (
        original.generation?.kind !== "baseline" ||
        original.stateDir !== candidate.stateDir ||
        original.configPath !== candidate.configPath ||
        original.installRoot !== candidate.installRoot ||
        !isDeepStrictEqual(original.excludedRoots, candidate.excludedRoots) ||
        (candidate.generation?.kind !== "baseline" &&
          candidate.generation?.baselineSha256 !== params.original.manifestSha256)
      ) {
        throw new Error("Preservation captures do not share the admitted original scope.");
      }
      const candidates = new Map(candidate.entries.map((entry) => [entry.sourcePath, entry]));
      const originalLinks = new Map(
        original.entries
          .filter((entry) => entry.kind === "symlink")
          .map((entry) => [entry.sourcePath, entry.target]),
      );
      const candidateLinks = new Map(
        candidate.entries
          .filter((entry) => entry.kind === "symlink")
          .map((entry) => [entry.sourcePath, entry.target]),
      );
      const originalDirectories = new Set(
        original.entries
          .filter((entry) => entry.kind === "directory")
          .map((entry) => entry.sourcePath),
      );
      const candidateDirectories = new Set(
        candidate.entries
          .filter((entry) => entry.kind === "directory")
          .map((entry) => entry.sourcePath),
      );
      const originalPaths = new Set(original.entries.map((entry) => entry.sourcePath));
      for (const entry of candidate.entries) {
        if (!originalPaths.has(entry.sourcePath)) {
          throw new Error(`Preservation added an unclassified resource: ${entry.sourcePath}`);
        }
      }
      const originalOwners = new Map(original.databases!.map((owner) => [owner.path, owner]));
      const candidateOwners = new Map(candidate.databases!.map((owner) => [owner.path, owner]));
      if (
        originalOwners.size !== candidateOwners.size ||
        [...originalOwners].some(
          ([pathname, owner]) => !isDeepStrictEqual(owner, candidateOwners.get(pathname)),
        )
      ) {
        throw new Error("Preservation database ownership inventory changed");
      }
      const warnings = new Set(
        [...(original.warnings ?? []), ...(candidate.warnings ?? [])].map(
          (warning) => warning.message,
        ),
      );
      const agentPairs = new Map<
        string,
        {
          before: ReturnType<typeof readWitness>;
          after: ReturnType<typeof readWitness>;
        }
      >();
      const migratingAgents: {
        agentId: string;
        path: string;
        requireRegistration: boolean;
      }[] = [];
      for (const entry of original.entries) {
        const owner = originalOwners.get(entry.sourcePath);
        if (entry.kind !== "file" || !entry.sqlite || owner?.role !== "agent") {
          continue;
        }
        const after = candidates.get(entry.sourcePath);
        if (!after) {
          throw new Error(`Preservation lost an inventoried resource: ${entry.sourcePath}`);
        }
        const beforeWitness = readWitness(params.original, entry, owner);
        const afterWitness = readWitness(params.candidate, after, owner);
        assertOpenClawMigrationWitnessPreserved(beforeWitness, afterWitness);
        agentPairs.set(entry.sourcePath, { before: beforeWitness, after: afterWitness });
        if (afterWitness.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION) {
          migratingAgents.push({
            agentId: owner.agentId,
            path: owner.path,
            requireRegistration: beforeWitness.schemaVersion < OPENCLAW_AGENT_SCHEMA_VERSION,
          });
        }
      }
      let databases = 0;
      let files = 0;
      for (const entry of original.entries) {
        const after = candidates.get(entry.sourcePath);
        if (!after) {
          throw new Error(`Preservation lost an inventoried resource: ${entry.sourcePath}`);
        }
        if (entry.kind === "missing") {
          if (!isDeepStrictEqual(entry, after)) {
            throw new Error(
              `Preservation changed a previously missing resource: ${entry.sourcePath}`,
            );
          }
          warnings.add(`Preexisting missing resource: ${entry.sourcePath}`);
          continue;
        }
        if (entry.kind === "file" && entry.sqlite) {
          if (after.kind !== "file" || !after.sqlite || after.mode !== entry.mode) {
            throw new Error(`Preservation changed SQLite file kind or mode: ${entry.sourcePath}`);
          }
          const owner = originalOwners.get(entry.sourcePath);
          const registry =
            owner?.role === "global" && migratingAgents.length > 0
              ? { sourcePath: entry.sourcePath, agents: migratingAgents }
              : undefined;
          const pair = agentPairs.get(entry.sourcePath);
          const beforeWitness =
            pair?.before ??
            readWitness(
              params.original,
              entry,
              owner,
              registry
                ? {
                    ...registry,
                    phase: "original",
                    resolvePath: (value) =>
                      resolveCapturedRegistryPath(value, originalLinks, originalDirectories),
                  }
                : undefined,
            );
          const afterWitness =
            pair?.after ??
            readWitness(
              params.candidate,
              after,
              owner,
              registry
                ? {
                    ...registry,
                    phase: "candidate",
                    resolvePath: (value) =>
                      resolveCapturedRegistryPath(value, candidateLinks, candidateDirectories),
                  }
                : undefined,
            );
          const result = assertOpenClawMigrationWitnessPreserved(beforeWitness, afterWitness);
          for (const warning of result.warnings) {
            warnings.add(`${entry.sourcePath}: ${warning}`);
          }
          databases++;
        } else if (entry.kind === "file") {
          if (
            after.kind !== "file" ||
            after.sqlite ||
            entry.sha256 !== after.sha256 ||
            entry.size !== after.size ||
            entry.mode !== after.mode
          ) {
            throw new Error(
              `Preservation changed protected file bytes or mode: ${entry.sourcePath}`,
            );
          }
          files++;
        } else if (!isDeepStrictEqual(entry, after)) {
          throw new Error(`Preservation changed protected resource: ${entry.sourcePath}`);
        }
      }
      return {
        schema: "openclaw.migration-preservation.v1" as const,
        status: warnings.size ? ("preserved-with-warnings" as const) : ("preserved" as const),
        original: params.original,
        candidate: params.candidate,
        resources: original.entries.length,
        databases,
        files,
        warnings: [...warnings],
        activationAuthorized: false as const,
      };
    }),
  );
}
