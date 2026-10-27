import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasSymbolicLinkInDirectoryPath } from "../infra/session-sqlite-migration-manifest.js";
import { isStatePostgres } from "../state/openclaw-state-db-engine.js";
import { resolveDatabasePath } from "../state/openclaw-state-db.paths.js";
import { collectUpdateCleanupInventory } from "./doctor-session-sqlite-recovery-inventory.js";
import { RecoveryInventoryScan } from "./recovery-inventory-scan.js";
import type { RecoveryCleanupArtifact } from "./update-cleanup-types.js";

type UsageCount = { count: number; logicalBytes: number };
type UsageGroup = UsageCount & {
  retirable: UsageCount;
  protected: UsageCount;
  unmanifestedOrOrphan: UsageCount;
};
function group(): UsageGroup {
  return {
    count: 0,
    logicalBytes: 0,
    retirable: { count: 0, logicalBytes: 0 },
    protected: { count: 0, logicalBytes: 0 },
    unmanifestedOrOrphan: { count: 0, logicalBytes: 0 },
  };
}

/** A bounded, read-only projection of cleanup's inventory, never a deletion policy. */
export function collectRecoveryDiskUsage(params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv }) {
  const scan = new RecoveryInventoryScan();
  const byKind = { updateCaptures: group(), doctorCaptures: group(), migrationOriginals: group() };
  const total = group();
  let artifacts: RecoveryCleanupArtifact[] = [];
  try {
    const database = resolveDatabasePath({ env: params.env });
    // Artifact-preserving ledger reads can copy DB/WAL bytes. Do not turn a cheap
    // status scan into a multi-GB snapshot; unknown eligibility stays protected.
    const readHistory =
      !isStatePostgres() &&
      !hasSymbolicLinkInDirectoryPath(database) &&
      [database, `${database}-wal`, `${database}-shm`].every((file) => scan.metadata(file));
    if (!readHistory) {
      scan.reasons.add("eligibility-not-verified");
    }
    artifacts = collectUpdateCleanupInventory({ ...params, scan, readHistory }).report.artifacts;
  } catch {
    scan.reasons.add("inventory-unavailable");
  }
  for (const item of artifacts) {
    if (item.reason === "unreadable-manifest" || item.reason === "manifest-directory-alias") {
      scan.reasons.add(item.reason);
      continue;
    }
    if (item.reason === "unreadable-update-history" || item.reason === "capture-directory-alias") {
      scan.reasons.add(item.reason);
    }
    if (item.outcome === "disposed" || item.outcome === "removed") {
      continue;
    }
    const kind =
      item.kind !== "update-capture"
        ? "migrationOriginals"
        : item.captureSource === "doctor"
          ? "doctorCaptures"
          : "updateCaptures";
    const category = /^(?:unmanifested-|orphan-)/u.test(item.reason)
      ? "unmanifestedOrOrphan"
      : item.outcome === "candidate"
        ? "retirable"
        : "protected";
    for (const count of [byKind[kind], total]) {
      count.count++;
      count.logicalBytes += item.bytes;
      count[category].count++;
      count[category].logicalBytes += item.bytes;
    }
  }
  return {
    scope: "local" as const,
    measurement: scan.incomplete ? ("partial" as const) : ("logical" as const),
    incomplete: scan.incomplete,
    incompleteReasons: [...scan.reasons],
    total,
    byKind,
  };
}

export type RecoveryDiskUsage = ReturnType<typeof collectRecoveryDiskUsage>;

export function formatRecoveryDiskUsage(usage: RecoveryDiskUsage): string {
  const counts = (value: UsageGroup) =>
    `${value.logicalBytes} logical bytes in ${value.count} copies; ${value.retirable.count} retirable, ${value.protected.count} protected, ${value.unmanifestedOrOrphan.count} unmanifested/orphan`;
  return [
    `${usage.incomplete ? "Incomplete estimate (observed bytes only; eligibility may be unverified): " : ""}${counts(usage.total)}`,
    ...Object.entries(usage.byKind).map(([kind, value]) => `${kind}: ${counts(value)}`),
    "Inspect: openclaw update cleanup --dry-run. Logical bytes are not physical space reclaimed.",
  ].join("\n");
}
