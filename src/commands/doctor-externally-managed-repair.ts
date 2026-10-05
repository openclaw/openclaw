/** Structured evidence for Doctor repairs whose config and service lifecycle are external. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { resolveConfigPath } from "../config/paths.js";
import { formatErrorMessage } from "../infra/errors.js";
import type {
  LegacyStateMigrationStepReceipt,
  MigrationMessages,
} from "../infra/state-migrations.types.js";

const REPORT_SCHEMA_VERSION = 1 as const;

type AppliedRepair = { stepId: string; changes: string[] };
type RemainingRepair = { stepId: string; message: string };

export type ExternallyManagedDoctorRepairReport = {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  mode: "externally-managed";
  ok: boolean;
  config: { path: string; status: "unchanged"; sha256: string | null };
  service: { status: "externally-managed" };
  applied: AppliedRepair[];
  skipped: Array<{ scope: "config" | "service"; reason: string }>;
  remaining: RemainingRepair[];
};

export type DoctorRepairEvidenceSink = {
  applied(stepId: string, changes: readonly string[]): void;
  complete(): void;
  remaining(stepId: string, messages: readonly string[]): void;
  migration(stepId: string, result: MigrationMessages): void;
  receipts(receipts: readonly LegacyStateMigrationStepReceipt[] | undefined): void;
};

function readConfigBytes(pathname: string): Buffer | undefined {
  try {
    return fs.readFileSync(pathname);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function sha256(value: Buffer | undefined): string | null {
  return value ? createHash("sha256").update(value).digest("hex") : null;
}

export function createExternallyManagedDoctorRepairEvidence(): {
  sink: DoctorRepairEvidenceSink;
  fail(error: unknown): void;
  finish(): ExternallyManagedDoctorRepairReport;
} {
  const configPath = resolveConfigPath();
  const configBefore = readConfigBytes(configPath);
  const applied: AppliedRepair[] = [];
  const remaining: RemainingRepair[] = [];
  let repairCompleted = false;
  const sink: DoctorRepairEvidenceSink = {
    applied(stepId, changes) {
      if (changes.length > 0) {
        applied.push({ stepId, changes: [...changes] });
      }
    },
    complete() {
      repairCompleted = true;
    },
    remaining(stepId, messages) {
      remaining.push(...messages.map((message) => ({ stepId, message })));
    },
    migration(stepId, result) {
      sink.applied(stepId, result.changes);
      sink.remaining(stepId, result.warnings);
    },
    receipts(receipts) {
      for (const receipt of receipts ?? []) {
        sink.applied(receipt.id, receipt.changes);
        sink.remaining(receipt.id, receipt.warnings);
        if (receipt.outcome === "refused" && receipt.warnings.length === 0) {
          sink.remaining(receipt.id, [receipt.refusal?.message ?? "Repair was refused."]);
        }
      }
    },
  };
  return {
    sink,
    fail(error) {
      sink.remaining("repair", [
        `Repair stopped after an unexpected failure: ${formatErrorMessage(error)}`,
      ]);
    },
    finish() {
      const configAfter = readConfigBytes(configPath);
      if (!Buffer.from(configAfter ?? []).equals(Buffer.from(configBefore ?? []))) {
        throw new Error(
          "Externally managed Doctor repair changed deployment-owned config; repair stopped without reporting success.",
        );
      }
      if (!repairCompleted) {
        sink.remaining("repair-flow", [
          "Doctor repair did not complete; pending repairs may remain.",
        ]);
      }
      const dedupedRemaining = remaining.filter(
        (entry, index, entries) =>
          entries.findIndex(
            (candidate) => candidate.stepId === entry.stepId && candidate.message === entry.message,
          ) === index,
      );
      const dedupedApplied = applied.filter(
        (entry, index, entries) =>
          entries.findIndex(
            (candidate) =>
              candidate.stepId === entry.stepId &&
              candidate.changes.length === entry.changes.length &&
              candidate.changes.every(
                (change, changeIndex) => change === entry.changes[changeIndex],
              ),
          ) === index,
      );
      return {
        schemaVersion: REPORT_SCHEMA_VERSION,
        mode: "externally-managed",
        ok: dedupedRemaining.length === 0,
        config: { path: configPath, status: "unchanged", sha256: sha256(configAfter) },
        service: { status: "externally-managed" },
        applied: dedupedApplied,
        skipped: [
          {
            scope: "config",
            reason: "Deployment-owned config is read-only in this repair posture.",
          },
          {
            scope: "service",
            reason: "The deployment supervisor owns Gateway stop and start.",
          },
        ],
        remaining: dedupedRemaining,
      };
    },
  };
}
