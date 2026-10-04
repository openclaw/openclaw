import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  isPackageActivationComplete,
  packageActivationIdentity,
  privatePackageActivationIdentity,
  resolvePackageActivationAnchor,
} from "./package-update-activation-paths.js";
import type {
  PackageActivationPhase,
  PackageActivationRecord,
} from "./package-update-activation-schema.js";
import { withExistingSqliteRollbackDatabase } from "./sqlite-existing-database.js";

/** Released in-anchor journals remain inspection-only; their helper owns recovery. */
export function readReleasedPackageActivationReceipt(installKey: string) {
  const anchor = resolvePackageActivationAnchor(installKey);
  const journal = path.join(anchor, "operation.sqlite");
  if (!fs.lstatSync(journal, { throwIfNoEntry: false })) {
    return undefined;
  }
  const anchorIdentity = privatePackageActivationIdentity(anchor, true);
  const journalIdentity = privatePackageActivationIdentity(journal, false);
  const parentIdentity = packageActivationIdentity(path.dirname(anchor), true);
  const assertIdentity = () => {
    if (
      privatePackageActivationIdentity(anchor, true) !== anchorIdentity ||
      privatePackageActivationIdentity(journal, false) !== journalIdentity ||
      packageActivationIdentity(path.dirname(anchor), true) !== parentIdentity ||
      fs.realpathSync(anchor) !== anchor
    ) {
      throw new Error("Released package activation journal identity changed.");
    }
  };
  const query = (db: DatabaseSync) =>
    getNodeSqliteKysely<{
      package_activation: { slot: number; phase: string; descriptor_json: string };
    }>(db).selectFrom("package_activation");
  return withExistingSqliteRollbackDatabase(
    journal,
    {
      write: false,
      busyTimeoutMs: 0,
      assertIdentity,
      validate: (db) => {
        executeSqliteQuerySync(db, query(db).select(["slot", "phase", "descriptor_json"]).limit(0));
      },
    },
    (db) => {
      const rows = executeSqliteQuerySync(
        db,
        query(db)
          .select(["slot", "phase"])
          .select((eb) =>
            eb
              .case()
              .when(
                eb.fn<number>("length", [eb.cast("descriptor_json", "blob")]),
                "<=",
                1024 * 1024,
              )
              .then(eb.ref("descriptor_json"))
              .else(null)
              .end()
              .as("descriptor_json"),
          )
          .limit(2),
      ).rows;
      const row = rows[0];
      if (rows.length !== 1 || row?.slot !== 1 || row.descriptor_json === null) {
        throw new Error("Released package activation journal must contain one bounded operation.");
      }
      // Project only displayed facts and their identities, never writer authority.
      const descriptor = z
        .object({
          version: z.literal(1),
          layout: z.never().optional(),
          operationId: z.uuid(),
          authority: z.object({ installKey: z.string() }),
          anchorIdentity: z.literal(anchorIdentity),
          journalIdentity: z.literal(journalIdentity),
          parentIdentity: z.literal(parentIdentity),
        })
        .parse(JSON.parse(row.descriptor_json));
      if (descriptor.authority.installKey !== installKey) {
        throw new Error("Released package activation journal does not match its installation.");
      }
      const phase = z
        .enum([
          "prepared",
          "publishing",
          "publication-complete",
          "rollback-in-progress",
          "rolled-back",
          "aborted",
          "retiring",
          "retired",
        ])
        .parse(row.phase);
      return {
        phase,
        operationId: descriptor.operationId,
        installKey,
        recoveryCommand: `node ${quoteCliArg(path.join(anchor, "recovery.mjs"))} status`,
      };
    },
  );
}

export function assertPackageActivationOperation(
  record: PackageActivationRecord,
  operationId: string,
): void {
  if (record.descriptor.operationId !== operationId) {
    throw new Error("Package recovery command belongs to a different operation.");
  }
}

export type PackageActivationStatus = {
  phase: PackageActivationPhase | "complete";
  operationId: string;
  installKey: string;
};

export function readPackageActivationRecordStatus(
  record: PackageActivationRecord,
): PackageActivationStatus {
  return {
    phase: isPackageActivationComplete(
      resolvePackageActivationAnchor(record.descriptor.authority.installKey),
      record,
    )
      ? "complete"
      : record.phase,
    operationId: record.descriptor.operationId,
    installKey: record.descriptor.authority.installKey,
  };
}

export const selectedPackageRetirementGeneration = (record: PackageActivationRecord) =>
  record.intent?.kind === "remove" ||
  record.intent?.kind === "retire" ||
  record.intent?.kind === "remove-anchor" ||
  record.intent?.kind === "unlink-helper"
    ? record.intent.selected
    : record.phase === "publication-complete"
      ? "candidate"
      : "previous";
