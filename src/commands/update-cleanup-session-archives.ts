/** Explicit relinquishment of session history, never evidence that it was imported. */
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  isPendingMigrationArtifactClaim,
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  statMigrationPath,
  type MigrationArtifact,
  type MigrationArtifactIdentity,
  type MigrationArtifactVerification,
} from "../infra/session-sqlite-migration-artifact.js";
import { isSessionSqliteMigrationWarning } from "../infra/session-sqlite-migration-issues.js";
import {
  hasSymbolicLinkInDirectoryPath,
  type ActiveSessionSqliteMigrationRun,
  type SessionSqliteMigrationMove,
} from "../infra/session-sqlite-migration-manifest.js";
import {
  summarizeRecoveryCleanup,
  type collectUpdateCleanupInventory,
  type RecoveryArtifactReference,
} from "./doctor-session-sqlite-recovery-inventory.js";
import type { RecoveryCleanupArtifact, RecoveryRetirementParams } from "./update-cleanup-types.js";
import { assertExplicitRecoveryPathsInactive } from "./update-cleanup-unmanifested.js";

type Inventory = ReturnType<typeof collectUpdateCleanupInventory>;
type Original = {
  item: RecoveryCleanupArtifact;
  refs: RecoveryArtifactReference[];
  identity: MigrationArtifactIdentity;
  backupPath: string;
};
export type SessionArchiveRetirementSelection = {
  originals: Original[];
  backups: Map<string, MigrationArtifactIdentity>;
  manifests: Map<string, { backupPath: string; sha256: string; before: string }>;
  verification: MigrationArtifactVerification;
};

const REASON = "explicit-history-retirement";

export function assertSessionArchiveRetirementOptions(
  options: Pick<
    RecoveryRetirementParams,
    "retireSessionArchive" | "archiveBackup" | "acceptHistoryLoss" | "includeUnmanifested"
  > & { dryRun?: boolean },
): void {
  if (options.retireSessionArchive?.length) {
    if (options.includeUnmanifested?.length) {
      throw new Error("--retire-session-archive cannot be combined with --include-unmanifested.");
    }
    if (!options.archiveBackup) {
      throw new Error("--retire-session-archive requires --archive-backup <directory>.");
    }
    if (!options.dryRun && !options.acceptHistoryLoss) {
      throw new Error(
        "Session archive retirement requires --accept-history-loss separately from --yes: these archives may contain unique history absent from SQLite.",
      );
    }
  } else if (options.archiveBackup !== undefined || options.acceptHistoryLoss) {
    throw new Error("--archive-backup and --accept-history-loss require --retire-session-archive.");
  }
}

function backupRoot(inventory: Inventory, directory: string): string {
  const root = path.resolve(directory);
  const stateDir = inventory.report.stateDir;
  if (
    !fs.lstatSync(root).isDirectory() ||
    hasSymbolicLinkInDirectoryPath(root) ||
    isPathInside(stateDir, root) ||
    isPathInside(root, stateDir) ||
    inventory.report.artifacts.some((item) => isPathInside(item.path, root))
  ) {
    throw new Error(
      "Archive backup must be an independent, unaliased directory outside the selected state and cleanup roots.",
    );
  }
  return root;
}

function backedUpPath(stateDir: string, root: string, file: string): string {
  if (!isPathInside(stateDir, file)) {
    throw new Error(`Recovery file is outside the selected state: ${file}`);
  }
  const backup = path.join(root, path.relative(stateDir, file));
  if (hasSymbolicLinkInDirectoryPath(path.dirname(backup))) {
    throw new Error(`Archive backup path is aliased: ${backup}`);
  }
  return backup;
}

function isSettled(ref: RecoveryArtifactReference): boolean {
  return ref.consumedByRestore || ref.move.artifact?.disposal.state === "disposed";
}

function assertReferenceGroup(refs: RecoveryArtifactReference[], file: string): void {
  const first = refs[0]!;
  if (
    refs.some(
      (ref) =>
        !ref.trusted ||
        ref.target.databaseIdentity ||
        ref.move.kind === "database-backup" ||
        ref.move.sourcePath !== first.move.sourcePath ||
        path.dirname(ref.target.storePath) !== path.dirname(first.target.storePath) ||
        !ref.run.manifest.completedAt ||
        ref.run.manifest.failedAt ||
        ref.target.validationBeforeArchive !== "passed" ||
        ref.target.issues.some((issue) => !isSessionSqliteMigrationWarning(issue)) ||
        ref.consumedByRestore ||
        (!ref.move.retirement &&
          ref.move.artifact?.disposal.state !== undefined &&
          ref.move.artifact.disposal.state !== "retained"),
    )
  ) {
    throw new Error(
      `Cannot retire ${file}: incomplete, conflicting, or unsupported recovery operation.`,
    );
  }
  const original = (move: SessionSqliteMigrationMove) =>
    move.retirement?.previousArtifact ?? (move.retirement ? undefined : move.artifact);
  if (
    refs.some(({ move }) => JSON.stringify(original(move)) !== JSON.stringify(original(first.move)))
  ) {
    throw new Error(`Cannot retire ${file}: conflicting original recovery evidence.`);
  }
  const claims = refs.flatMap(({ move }) =>
    move.artifact?.disposal.state === "pending-disposal" ? [move.artifact.disposal.claimPath] : [],
  );
  if (new Set(claims).size > 1) {
    throw new Error(`Cannot retire ${file}: conflicting disposal claims.`);
  }
}

/** Missing proof does not disclose dependencies: explicitly relinquish the whole session-directory component. */
function assertCompleteSelection(inventory: Inventory, requested: Set<string>): void {
  const directories = new Set<string>();
  for (const file of requested) {
    const refs = inventory.references.get(file);
    if (!refs?.length) {
      throw new Error(`Not a manifested session-import archive: ${file}`);
    }
    assertReferenceGroup(refs, file);
    directories.add(path.dirname(refs[0]!.target.storePath));
  }
  const missing: string[] = [];
  for (const [file, refs] of inventory.references) {
    if (!refs.some((ref) => directories.has(path.dirname(ref.target.storePath)))) {
      continue;
    }
    if (refs.every(isSettled) && !statMigrationPath(file)) {
      continue;
    }
    if (!requested.has(file)) {
      missing.push(file);
    }
  }
  if (missing.length) {
    throw new Error(
      `Select the complete recovery group explicitly; also select: ${missing.join(", ")}`,
    );
  }
  const archiveDirs = new Set(
    [...directories].map((dir) => path.join(path.dirname(dir), "session-sqlite-import-archive")),
  );
  if (
    inventory.report.artifacts.some(
      (item) => archiveDirs.has(path.dirname(item.path)) && !inventory.references.has(item.path),
    )
  ) {
    throw new Error(
      "Recovery group contains unmanifested archives; preserve them and reconcile the unknown dependencies first.",
    );
  }
}

function verifyCopy(
  selection: SessionArchiveRetirementSelection,
  backup: string,
  expected: MigrationArtifactIdentity,
): void {
  const identity = readMigrationArtifactIdentity(backup, 1n, undefined, selection.verification);
  assertIndependentCopy(identity, expected);
  if (identity.size !== expected.size || identity.sha256 !== expected.sha256) {
    throw new Error(`Archive backup does not contain the selected current bytes: ${backup}`);
  }
  selection.backups.set(backup, identity);
}

function assertIndependentCopy(
  copy: MigrationArtifactIdentity,
  original: MigrationArtifactIdentity,
): void {
  // Bind-mounted aliases can share an inode without increasing the link count.
  if (copy.dev === original.dev && copy.ino === original.ino) {
    throw new Error("Archive backup aliases its original; preserve an independent copy.");
  }
}

function verifyManifestBackup(
  selection: SessionArchiveRetirementSelection,
  run: ActiveSessionSqliteMigrationRun,
  stateDir: string,
  root: string,
  selectedRefs: RecoveryArtifactReference[],
): void {
  if (selection.manifests.has(run.manifestPath)) {
    return;
  }
  const backup = backedUpPath(stateDir, root, run.manifestPath);
  const receipts = selectedRefs.flatMap(({ move }) => (move.retirement ? [move.retirement] : []));
  if (receipts.length > 0 && selectedRefs.some(({ move }) => !move.retirement)) {
    throw new Error(
      "Cannot extend a pending retirement within a recorded manifest; finish the original selection first.",
    );
  }
  const current = readMigrationArtifactIdentity(run.manifestPath);
  const copied = readMigrationArtifactIdentity(backup, 1n, undefined, selection.verification);
  assertIndependentCopy(copied, current);
  const expected = receipts[0]?.backupManifestSha256 ?? current.sha256;
  if (
    copied.sha256 !== expected ||
    receipts.some(
      (receipt) =>
        receipt.backupManifestPath !== backup || receipt.backupManifestSha256 !== expected,
    )
  ) {
    throw new Error(`Archive backup does not contain the original recovery manifest: ${backup}`);
  }
  selection.backups.set(backup, copied);
  selection.manifests.set(run.manifestPath, {
    backupPath: backup,
    sha256: expected,
    before: JSON.stringify(run.manifest),
  });
}

function selectedIdentity(
  refs: RecoveryArtifactReference[],
  file: string,
): MigrationArtifactIdentity {
  const receipt = refs.find((ref) => ref.move.retirement)?.move.artifact;
  if (!receipt) {
    return readMigrationArtifactIdentity(file);
  }
  if (
    refs.some(
      (ref) =>
        ref.move.retirement &&
        !sameMigrationArtifact(ref.move.artifact!.identity, receipt.identity),
    )
  ) {
    throw new Error(`Conflicting retirement identities: ${file}`);
  }
  const disposal = receipt.disposal;
  const current = statMigrationPath(file)
    ? file
    : disposal.state === "pending-disposal"
      ? disposal.claimPath
      : file;
  if (!statMigrationPath(current)) {
    if (
      disposal.state === "disposed" ||
      (disposal.state === "pending-disposal" && disposal.phase === "unlink-pending")
    ) {
      return receipt.identity;
    }
    throw new Error(`Selected recovery original is unexpectedly missing: ${file}`);
  }
  if (
    statMigrationPath(file) &&
    (disposal.state === "disposed" ||
      (disposal.state === "pending-disposal" && disposal.phase === "unlink-pending"))
  ) {
    throw new Error(`Selected recovery original was recreated after retirement: ${file}`);
  }
  const identity = readMigrationArtifactIdentity(
    current,
    isPendingMigrationArtifactClaim(file, receipt) ? 2n : 1n,
  );
  if (!sameMigrationArtifact(identity, receipt.identity, { ignoreDevice: true })) {
    throw new Error(`Selected recovery original changed after retirement intent: ${file}`);
  }
  return receipt.identity;
}

export function selectSessionArchiveRetirement(params: {
  inventory: Inventory;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  paths: readonly string[];
  backupDirectory: string;
}): SessionArchiveRetirementSelection {
  const { inventory, cfg, env } = params;
  const requested = new Set(params.paths.map((file) => path.resolve(file)));
  if (
    !requested.size ||
    inventory.report.artifacts.some((item) =>
      ["unreadable-manifest", "manifest-directory-alias", "incomplete-recovery-inventory"].includes(
        item.reason,
      ),
    )
  ) {
    throw new Error(
      "Explicit retirement needs a complete, readable recovery inventory and exact paths.",
    );
  }
  const root = backupRoot(inventory, params.backupDirectory);
  assertCompleteSelection(inventory, requested);
  const refsByManifest = new Map<string, RecoveryArtifactReference[]>();
  for (const file of requested) {
    for (const ref of inventory.references.get(file)!) {
      const refs = refsByManifest.get(ref.run.manifestPath) ?? [];
      refs.push(ref);
      refsByManifest.set(ref.run.manifestPath, refs);
    }
  }
  assertSessionArchivePathsInactive(inventory, cfg, env, [...requested]);
  const selection: SessionArchiveRetirementSelection = {
    originals: [],
    backups: new Map(),
    manifests: new Map(),
    verification: new Map(),
  };
  for (const file of requested) {
    if (hasSymbolicLinkInDirectoryPath(path.dirname(file))) {
      throw new Error(`Recovery original is aliased: ${file}`);
    }
    const refs = inventory.references.get(file)!;
    const identity = selectedIdentity(refs, file);
    const backup = backedUpPath(inventory.report.stateDir, root, file);
    if (refs.some(({ move }) => move.retirement && move.retirement.backupPath !== backup)) {
      throw new Error(`Resume retirement with its recorded backup: ${file}`);
    }
    verifyCopy(selection, backup, identity);
    for (const { run } of refs) {
      verifyManifestBackup(
        selection,
        run,
        inventory.report.stateDir,
        root,
        refsByManifest.get(run.manifestPath)!,
      );
    }
    let item = inventory.report.artifacts.find((candidate) => candidate.path === file);
    if (!item) {
      item = {
        path: file,
        runs: [...new Set(refs.map((ref) => ref.run.manifest.runId))],
        bytes: 0,
        outcome: "disposed",
        reason: REASON,
      };
      inventory.report.artifacts.push(item);
    }
    const disposed = refs.every(
      (ref) => ref.move.retirement && ref.move.artifact?.disposal.state === "disposed",
    );
    item.outcome = disposed ? "disposed" : "candidate";
    item.reason = REASON;
    item.detail = `Backup verified: ${backup}; selected SHA-256: ${identity.sha256}. No import proof is inferred.`;
    item.consequence =
      "Permanently relinquishes this recovery group, including unique or never-imported history. Changed bytes may not match the formerly recorded original.";
    selection.originals.push({ item, refs, identity, backupPath: backup });
  }
  for (const item of inventory.report.artifacts) {
    if (
      !requested.has(item.path) &&
      (item.outcome === "candidate" || item.outcome === "verification-required")
    ) {
      item.outcome = "protected";
      item.reason = "not-selected-for-explicit-retirement";
    }
  }
  inventory.report = summarizeRecoveryCleanup(
    inventory.report.stateDir,
    inventory.report.artifacts,
    "preview",
    inventory.report.missingOriginals,
  );
  return selection;
}

export function assertSessionArchivePathsInactive(
  inventory: Inventory,
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  paths: readonly string[],
): void {
  assertExplicitRecoveryPathsInactive({
    inventory,
    cfg,
    env,
    paths: paths.flatMap((file) => [
      file,
      ...inventory.references
        .get(file)!
        .flatMap(({ move }) =>
          move.artifact?.disposal.state === "pending-disposal"
            ? [move.artifact.disposal.claimPath]
            : [],
        ),
    ]),
    relatedPaths: paths.flatMap((file) =>
      inventory.references
        .get(file)!
        .flatMap(({ run, target }) => [run.manifestPath, target.storePath, target.sqlitePath]),
    ),
  });
}

/** Retain verified backup facts within one offline operation; changed bytes invalidate hashing reuse. */
export function assertSessionArchiveBackupsCurrent(
  selection: SessionArchiveRetirementSelection,
  refs?: RecoveryArtifactReference[],
): void {
  const files = refs
    ? new Set(
        refs.flatMap(({ move }) =>
          move.retirement ? [move.retirement.backupPath, move.retirement.backupManifestPath] : [],
        ),
      )
    : selection.backups.keys();
  for (const file of files) {
    const expected = selection.backups.get(file)!;
    if (
      hasSymbolicLinkInDirectoryPath(path.dirname(file)) ||
      !sameMigrationArtifact(
        readMigrationArtifactIdentity(file, 1n, undefined, selection.verification),
        expected,
      )
    ) {
      throw new Error(`Archive backup changed during retirement: ${file}`);
    }
  }
}

/** Confirmation authorizes the exact originals, recovery graph, and independent backup observed. */
export function assertSessionArchiveSelectionCurrent(
  before: { inventory: Inventory; selection: SessionArchiveRetirementSelection },
  after: { inventory: Inventory; selection: SessionArchiveRetirementSelection },
): void {
  const snapshot = ({ inventory, selection }: typeof before) => ({
    report: inventory.report,
    manifestPaths: inventory.manifestPaths,
    originals: selection.originals.map(({ item, identity }) => [item.path, identity]),
    manifests: [...selection.manifests],
    backups: [...selection.backups],
  });
  if (JSON.stringify(snapshot(before)) !== JSON.stringify(snapshot(after))) {
    throw new Error("Recovery selection or backup changed during confirmation; preview again.");
  }
}

/** Only the disposal owner writes these together with durable intent, before moving any original. */
export function recordSessionArchiveRetirement(selection: SessionArchiveRetirementSelection): void {
  const acceptedAt = new Date().toISOString();
  for (const { item, refs, identity, backupPath } of selection.originals) {
    if (item.outcome !== "candidate") {
      continue;
    }
    const existing = refs.find(({ move }) => move.retirement)?.move;
    const artifact: MigrationArtifact = existing?.artifact ?? {
      identity,
      classification: "protected",
      reason: REASON,
      dependencies: refs[0]!.move.artifact?.dependencies ?? [],
      disposal: { state: "retained" },
    };
    for (const { run, target } of refs) {
      const manifest = selection.manifests.get(run.manifestPath)!;
      run.manifest.manifestVersion = 5;
      for (const move of [...target.plannedMoves, ...target.completedMoves]) {
        if (move.archivePath !== item.path || move.retirement) {
          continue;
        }
        move.retirement = {
          acceptedAt: existing?.retirement?.acceptedAt ?? acceptedAt,
          backupPath,
          backupManifestPath: manifest.backupPath,
          backupManifestSha256: manifest.sha256,
          ...(move.artifact ? { previousArtifact: structuredClone(move.artifact) } : {}),
        };
        move.artifact = structuredClone(artifact);
      }
    }
  }
}
