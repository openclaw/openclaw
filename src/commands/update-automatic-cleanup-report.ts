import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
/** What automatic update cleanup removed and kept, in the update result's own words. */
import { formatDiskSpaceBytes } from "../infra/disk-space.js";
import type { RecoveryCleanupArtifact } from "./update-cleanup-types.js";
import { NOT_PROVABLY_UPDATER_OWNED_REASONS } from "./update-run-artifact-ownership.js";

const KEPT_REASONS: Record<string, string> = {
  "pending-update-recovery": "a pending update recovery needs it",
  "unfinished-update-run": "its update run has not finished",
  "newest-unverified-update-backup":
    "newest backup of an update that was not verified; repair may need it",
  "awaiting-settled-update-history":
    "kept while an update recovery is pending or an update run is unfinished",
  "unresolved-failed-update": "recovery source for a failed update that is not resolved",
  "awaiting-later-completed-update": "kept until a later successful update",
  "awaiting-later-verified-update": "kept until a later verified update",
  "incomplete-recovery-operation": "its Doctor backup was never confirmed complete",
  "archive-consumed-by-restore": "a restore used it",
  "retained-recovery-dependency": "another kept backup depends on it",
};

/** Kept because cleanup could not verify them, not because policy needs them. */
const UNVERIFIED_REASONS: ReadonlySet<string> = new Set([
  "unreadable-update-history",
  "historical-manifest-without-import-proof",
  "historical-recovery-dependencies-unverified",
]);

/** File lengths, not allocated blocks: sparse or cloned backups can release less disk. */
function sizeOf(bytes: number): string {
  return `${bytes} logical bytes, ${formatDiskSpaceBytes(bytes)}`;
}

/** Each line is a run-record step, so long lists end with a pointer to the full preview. */
const LISTED_LINES = 15;

export function describeAutomaticCleanup(artifacts: readonly RecoveryCleanupArtifact[]): {
  diagnostics: string[];
  warning?: string;
} {
  const removed = artifacts.filter((item) => item.outcome === "removed");
  const failed = artifacts.filter((item) => item.outcome === "failed");
  const unproven = artifacts.filter(
    (item) => item.outcome === "protected" && NOT_PROVABLY_UPDATER_OWNED_REASONS.has(item.reason),
  );
  // Anything cleanup could not verify, or left selectable without removing, needs a look.
  const unverified = artifacts.filter(
    (item) =>
      ["blocked", "candidate", "verification-required"].includes(item.outcome) ||
      UNVERIFIED_REASONS.has(item.reason),
  );
  const kept = artifacts.filter(
    (item) =>
      item.outcome === "protected" && !unproven.includes(item) && !unverified.includes(item),
  );
  // A partly removed family still counts what it removed.
  const removedBytes = artifacts.reduce((bytes, item) => bytes + (item.removedBytes ?? 0), 0);
  const unprovenBytes = unproven.reduce((bytes, item) => bytes + item.bytes, 0);
  const summary = [
    `Update backup cleanup removed ${removed.length} ${removed.length === 1 ? "item" : "items"} (${sizeOf(removedBytes)}).`,
    kept.length ? `Kept ${kept.length} the updater still needs.` : "",
    unproven.length
      ? `Kept ${unproven.length} not provably created by the updater (${sizeOf(unprovenBytes)}); to decide about them, ask your agent with openclaw triage.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const lines = [
    ...removed.map((item) => `Removed ${item.path} (${sizeOf(item.removedBytes ?? 0)}).`),
    ...unproven.map(
      (item) =>
        `Kept: not provably ours: ${item.path} (${sizeOf(item.bytes)}). Ask your agent with openclaw triage${
          item.reason === "unmanifested-recovery-original"
            ? `, or remove it yourself with openclaw update cleanup --include-unmanifested ${(process.platform === "win32" ? quotePowerShellArg : quoteCliArg)(item.path)}`
            : ""
        }.`,
    ),
    ...kept.map(
      (item) =>
        `Kept ${item.path} (${sizeOf(item.bytes)}): ${KEPT_REASONS[item.reason] ?? item.reason}.`,
    ),
  ];
  const listed =
    lines.length > LISTED_LINES
      ? [
          ...lines.slice(0, LISTED_LINES - 1),
          `${lines.length - LISTED_LINES + 1} more; see openclaw update cleanup --dry-run.`,
        ]
      : lines;
  const problems = [
    failed.length
      ? `Could not remove ${failed.map((item) => `${item.path} (${item.detail ?? item.reason})`).join("; ")}.`
      : "",
    unverified.length
      ? `Not verified, so kept: ${unverified.map((item) => `${item.path} (${item.reason}${item.detail ? `: ${item.detail}` : ""})`).join("; ")}.`
      : "",
  ].filter(Boolean);
  const warning = problems.length
    ? `${problems.join(" ")} The update outcome is unchanged and the next update retries; ask your agent with openclaw triage, or inspect with openclaw update cleanup --dry-run.`
    : undefined;
  return { diagnostics: [summary, ...listed], ...(warning ? { warning } : {}) };
}
