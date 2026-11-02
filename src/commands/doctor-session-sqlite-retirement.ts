/** Retirement of producer-verified originals; never a suffix deletion policy. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireDirectorySync, syncDirectory } from "../infra/directory-durability.js";
import {
  isPendingMigrationArtifactClaim,
  moveMigrationArtifact,
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  statMigrationPath,
  type MigrationArtifact,
  type MigrationArtifactIdentity,
  type MigrationArtifactVerification,
} from "../infra/session-sqlite-migration-artifact.js";
import {
  hasSymbolicLinkInDirectoryPath,
  writeSessionSqliteMigrationManifest,
  type ActiveSessionSqliteMigrationRun,
  type SessionSqliteMigrationMove,
  type SessionSqliteMigrationTargetInput,
  type SessionSqliteMigrationTargetManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../state/openclaw-state-ownership-preflight.js";
import { collectHistoricalArchiveSources } from "./doctor-session-sqlite-discovery.js";
import { coalesceSessionSqliteArchiveReferences } from "./doctor-session-sqlite-migration-coalesce.js";
import {
  collectUpdateCleanupInventory,
  protectRecoveryDependencies,
  resolveRecoveryArtifact,
  summarizeRecoveryCleanup,
  type RecoveryArtifactReference,
  type RecoveryCleanupReport,
} from "./doctor-session-sqlite-recovery-inventory.js";
import {
  createRecoveryDestinationVerifier,
  verifyHistoricalMigrationArtifact,
} from "./doctor-session-sqlite-verification.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";
import { retireUpdateCaptures } from "./update-capture-cleanup.js";
import {
  assertUnmanifestedSelectionCurrent,
  retireUnmanifestedRecovery,
  selectUnmanifestedRecovery,
} from "./update-cleanup-unmanifested.js";

type RecoveryCleanupProgress = {
  phase: "verifying" | "claiming" | "removing-capture" | "removing-unmanifested";
  path: string;
  index: number;
  total: number;
  bytes: number;
};

function assertRecoveryOriginal(
  archivePath: string,
  artifact: MigrationArtifact,
  verification?: MigrationArtifactVerification,
): MigrationArtifactIdentity | undefined {
  const currentPath = statMigrationPath(archivePath)
    ? archivePath
    : artifact.disposal.state === "pending-disposal"
      ? artifact.disposal.claimPath
      : archivePath;
  if (!statMigrationPath(currentPath)) {
    if (
      artifact.disposal.state === "pending-disposal" &&
      artifact.disposal.phase === "unlink-pending"
    ) {
      return undefined;
    }
    throw new Error("artifact is unexpectedly missing");
  }
  const links = isPendingMigrationArtifactClaim(archivePath, artifact) ? 2n : 1n;
  const identity = readMigrationArtifactIdentity(currentPath, links, undefined, verification);
  if (
    !sameMigrationArtifact(identity, artifact.identity, {
      // APFS can assign a different st_dev after reboot while the retained inode and bytes stay
      // unchanged; the receipt still identifies the same protected recovery artifact.
      ignoreDevice: true,
    })
  ) {
    throw new Error("artifact identity or contents changed");
  }
  return identity;
}

/** Coalesce only exact raw copies; the surviving original preserves every rollback byte. */
export async function settleDuplicateSessionSqliteArchives(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  targets: readonly SessionSqliteMigrationTargetInput[];
}) {
  const {
    claims,
    inventory: { artifacts, references },
  } = collectHistoricalArchiveSources(params);
  const failures: ReturnType<typeof coalesceSessionSqliteArchiveReferences> = [];
  const recordFailure = (target: SessionSqliteMigrationTargetInput, message: string) => {
    failures.push({
      target,
      issues: [
        { code: "historical_transcript_deferred", message: `${message}; original retained.` },
      ],
    });
  };
  const selected: RecoveryCleanupReport["artifacts"] = [];
  const artifactsByPath = new Map<string, (typeof artifacts)[number]>();
  for (const item of artifacts) {
    if (!artifactsByPath.has(item.path)) {
      artifactsByPath.set(item.path, item);
    }
  }
  const replacements = new Map<string, RecoveryArtifactReference["move"]>();
  const assertSurvivor = (refs: RecoveryArtifactReference[]) => {
    const move = replacements.get(refs[0]!.move.archivePath)!;
    if (hasSymbolicLinkInDirectoryPath(path.dirname(move.archivePath))) {
      throw new Error("Retained duplicate archive directory changed.");
    }
    assertRecoveryOriginal(move.archivePath, move.artifact!);
  };
  for (const group of claims) {
    const target = group[0]![0]!.target;
    if (
      !params.targets.some(
        (candidate) =>
          candidate.agentId === target.agentId &&
          candidate.storePath === target.storePath &&
          candidate.sqlitePath === target.sqlitePath,
      )
    ) {
      continue;
    }
    const survivor = group.find(
      (refs) =>
        refs.every((ref) => ref.move.artifact!.disposal.state === "retained") &&
        statMigrationPath(refs[0]!.move.archivePath),
    );
    if (!survivor) {
      continue;
    }
    for (const refs of group.filter((candidate) => candidate !== survivor)) {
      const item = artifactsByPath.get(refs[0]!.move.archivePath)!;
      replacements.set(item.path, survivor[0]!.move);
      try {
        assertSurvivor(refs);
        const artifact = resolveRecoveryArtifact(refs)!;
        if (
          refs.some((ref) => ref.move.artifact!.disposal.state === "disposed") &&
          statMigrationPath(item.path)
        ) {
          throw new Error("Archive was recreated after disposal.");
        }
        // Missing retained originals need reference redirection only; pending claims still retire.
        if (
          artifact.disposal.state === "pending-disposal" ||
          (artifact.disposal.state === "retained" && statMigrationPath(item.path))
        ) {
          assertRecoveryOriginal(item.path, artifact);
          item.outcome = "candidate";
          selected.push(item);
        }
      } catch (error) {
        replacements.delete(item.path);
        recordFailure(target, `${item.path}: ${String(error)}`);
      }
    }
  }
  await disposeRecoveryArtifacts({ selected, references, assertDestinations: assertSurvivor });
  for (const [archivePath] of replacements) {
    const refs = references.get(archivePath)!;
    if (
      refs.every((ref) => ref.move.artifact!.disposal.state === "disposed") ||
      (refs.every((ref) => ref.move.artifact!.disposal.state === "retained") &&
        !statMigrationPath(archivePath))
    ) {
      assertSurvivor(refs);
    } else {
      replacements.delete(archivePath);
      const item = artifactsByPath.get(archivePath)!;
      recordFailure(refs[0]!.target, `${archivePath}: ${item.detail ?? item.reason}`);
    }
  }
  return [
    ...failures,
    ...coalesceSessionSqliteArchiveReferences(replacements, [
      ...new Set([...references.values()].flatMap((refs) => refs.map((ref) => ref.run))),
    ]),
  ];
}

export type RecoveryRetirementParams = {
  env: NodeJS.ProcessEnv;
  preview: RecoveryCleanupReport;
  readConfig(): Promise<OpenClawConfig>;
  confirm(report: RecoveryCleanupReport): Promise<boolean>;
  onProgress?: (progress: RecoveryCleanupProgress) => void;
  /** Automatic retirement leaves historical originals for explicit verified cleanup. */
  verifyHistorical?: boolean;
  /** A serving Gateway may mutate its owned destination while cleanup runs. */
  allowOwnedDestinationMutation?: boolean;
  /** Manual per-path consent only; automatic callers must leave this absent. */
  includeUnmanifested?: readonly string[];
};

function assertRecoveryStateWriteAllowed(stateDir: string, env: NodeJS.ProcessEnv) {
  return assertOpenClawStateWriteAllowedAtPath({
    databasePath: path.join(stateDir, "state", "openclaw.sqlite"),
    env,
    recoverOrphanedSidecars: false,
  });
}

/** Manual cleanup still requires the Gateway to be stopped. */
export async function retireSessionSqliteRecovery(
  params: RecoveryRetirementParams,
): Promise<RecoveryCleanupReport> {
  await assertRecoveryStateWriteAllowed(params.preview.stateDir, params.env);
  return withDoctorSqliteMaintenanceLock({
    env: params.env,
    operation: "update recovery cleanup",
    run: (authority) => retireOwnedSessionSqliteRecovery(params, authority),
  });
}

/** Shared retirement under exclusive offline custody or the serving Gateway's live authority. */
export async function retireOwnedSessionSqliteRecovery(
  params: RecoveryRetirementParams,
  authority: { assertCurrent(): void },
): Promise<RecoveryCleanupReport> {
  authority.assertCurrent();
  const cfg = await params.readConfig();
  const inventory = collectUpdateCleanupInventory({ cfg, env: params.env });
  const unmanifested = selectUnmanifestedRecovery({
    inventory,
    cfg,
    env: params.env,
    paths: params.includeUnmanifested,
  });
  const { report, references, manifestPaths, captureIdentities } = inventory;
  authority.assertCurrent();
  if (
    report.stateDir !== params.preview.stateDir ||
    JSON.stringify(report.artifacts) !== JSON.stringify(params.preview.artifacts)
  ) {
    throw new Error("Recovery selection changed; preview cleanup again.");
  }
  await assertRecoveryStateWriteAllowed(report.stateDir, params.env);
  const adoptions = new Map<RecoveryArtifactReference, MigrationArtifact>();
  const verification: MigrationArtifactVerification = new Map();
  const assertDestinations = createRecoveryDestinationVerifier(
    report.stateDir,
    () => authority.assertCurrent(),
    { allowOwnedMutation: params.allowOwnedDestinationMutation },
  );
  const originals = report.artifacts.filter(
    (item) =>
      item.kind !== "update-capture" &&
      !unmanifested.has(item.path) &&
      (item.outcome === "candidate" || item.outcome === "verification-required"),
  );
  // Unfinished/blocked historical originals may already be protected. Their
  // retained references still have unknown dependencies when proof is absent.
  const deferOriginalDisposal =
    params.verifyHistorical === false &&
    report.artifacts.some((item) => references.get(item.path)?.some((ref) => !ref.move.artifact));
  for (const [index, item] of originals.entries()) {
    params.onProgress?.({
      phase: "verifying",
      path: item.path,
      index: index + 1,
      total: originals.length,
      bytes: item.bytes,
    });
    if (deferOriginalDisposal) {
      // Historical indexes can reference originals in other manifests. Without
      // that verification the dependency graph is incomplete, so defer original
      // disposal as a group. Captures retain their independent eligibility rules.
      if (item.outcome === "candidate") {
        item.reason = "historical-recovery-dependencies-unverified";
      }
      item.outcome = "protected";
      continue;
    }
    if (item.outcome === "verification-required") {
      const refs = references.get(item.path)!;
      try {
        for (const ref of refs) {
          if (ref.move.artifact) {
            continue;
          }
          const artifact = verifyHistoricalMigrationArtifact({
            target: ref.target,
            move: ref.move,
            env: params.env,
          });
          if (!artifact) {
            throw new Error("historical-import-proof-unavailable");
          }
          adoptions.set(ref, artifact);
        }
        item.outcome = "candidate";
        item.reason = "verified-historical-import";
      } catch (error) {
        item.outcome = "protected";
        item.reason = "historical-import-proof-unavailable";
        item.detail = String(error);
      }
    }
    if (item.outcome !== "candidate") {
      continue;
    }
    try {
      const refs = references.get(item.path)!;
      const artifact = resolveRecoveryArtifact(refs) ?? adoptions.get(refs[0]!)!;
      assertRecoveryOriginal(item.path, artifact, verification);
    } catch (error) {
      item.outcome = "blocked";
      item.reason = "artifact-verification-failed";
      item.detail = String(error);
    }
  }
  // Historical adoption also opens SQLite readers; finish those before fencing sidecar state.
  for (const item of report.artifacts) {
    if (
      item.outcome !== "candidate" ||
      item.kind === "update-capture" ||
      unmanifested.has(item.path)
    ) {
      continue;
    }
    try {
      assertDestinations(references.get(item.path)!);
    } catch (error) {
      item.outcome = "blocked";
      item.reason = "destination-verification-failed";
      item.detail = String(error);
    }
  }
  // Verified historical dependencies affect selection now, but stay provisional until consent.
  protectRecoveryDependencies(report.artifacts, references, adoptions);
  const verified = summarizeRecoveryCleanup(
    report.stateDir,
    report.artifacts,
    "preview",
    report.missingOriginals,
  );
  const candidates = verified.artifacts.filter((item) => item.outcome === "candidate");
  const explicit = candidates.filter((item) => unmanifested.has(item.path));
  const selected = candidates.filter(
    (item) => item.kind !== "update-capture" && !unmanifested.has(item.path),
  );
  const captures = candidates.filter(
    (item) => item.kind === "update-capture" && !unmanifested.has(item.path),
  );
  if (!(await params.confirm(verified))) {
    return { ...verified, status: "refused" };
  }
  authority.assertCurrent();
  const currentConfig = await params.readConfig();
  const rechecked = collectUpdateCleanupInventory({ cfg: currentConfig, env: params.env });
  const currentUnmanifested = selectUnmanifestedRecovery({
    inventory: rechecked,
    cfg: currentConfig,
    env: params.env,
    paths: params.includeUnmanifested,
  });
  assertUnmanifestedSelectionCurrent(unmanifested, currentUnmanifested);
  // Existing artifacts can become protected during confirmation, not only newly added manifests.
  // Revalidate the whole selection before retiring any dependent originals.
  if (
    rechecked.report.stateDir !== report.stateDir ||
    JSON.stringify(rechecked.manifestPaths) !== JSON.stringify(manifestPaths) ||
    JSON.stringify(rechecked.report.artifacts) !== JSON.stringify(params.preview.artifacts)
  ) {
    throw new Error("Recovery selection changed during confirmation; preview again.");
  }
  const manifests = (refs: typeof references) =>
    new Map([...refs.values()].flat().map(({ run }) => [run.manifestPath, run.manifest]));
  const currentManifests = manifests(rechecked.references);
  for (const [manifestPath, manifest] of manifests(references)) {
    if (JSON.stringify(currentManifests.get(manifestPath)) !== JSON.stringify(manifest)) {
      throw new Error("Recovery manifest changed during confirmation; preview again.");
    }
  }
  for (const ref of [...references.values()].flat()) {
    if (
      !(rechecked.references.get(ref.move.archivePath) ?? []).some(
        (current) =>
          current.trusted === ref.trusted &&
          current.target.storePath === ref.target.storePath &&
          current.target.sqlitePath === ref.target.sqlitePath,
      )
    ) {
      throw new Error("Recovery target changed during confirmation; preview again.");
    }
  }
  await assertRecoveryStateWriteAllowed(report.stateDir, params.env);
  authority.assertCurrent();
  for (const item of selected) {
    const refs = references.get(item.path)!;
    assertDestinations(refs);
    assertRecoveryOriginal(
      item.path,
      resolveRecoveryArtifact(refs) ?? adoptions.get(refs[0]!)!,
      verification,
    );
  }
  for (const [ref, artifact] of adoptions) {
    if (!selected.some((item) => item.path === ref.move.archivePath)) {
      continue;
    }
    if (ref.run.manifest.manifestVersion !== 4) {
      ref.run.manifest.manifestVersion = 3;
    }
    for (const move of [...ref.target.plannedMoves, ...ref.target.completedMoves]) {
      if (move.archivePath === ref.move.archivePath) {
        move.artifact = artifact;
      }
    }
  }
  await disposeRecoveryArtifacts({
    selected,
    references,
    assertDestinations,
    assertCurrent: () => authority.assertCurrent(),
    verification,
    onProgress: params.onProgress,
  });
  await retireUpdateCaptures({
    selected: captures,
    identities: captureIdentities,
    assertCurrent: () => authority.assertCurrent(),
    onProgress: (item, index) =>
      params.onProgress?.({
        phase: "removing-capture",
        path: item.path,
        index: index + 1,
        total: captures.length,
        bytes: item.bytes,
      }),
  });
  await retireUnmanifestedRecovery({
    selected: explicit,
    identities: unmanifested,
    assertCurrent: () => authority.assertCurrent(),
    assertReferences: async (item) => {
      const effectConfig = await params.readConfig();
      authority.assertCurrent();
      const fresh = collectUpdateCleanupInventory({ cfg: effectConfig, env: params.env });
      const selection = selectUnmanifestedRecovery({
        inventory: fresh,
        cfg: effectConfig,
        env: params.env,
        paths: [item.path],
      });
      assertUnmanifestedSelectionCurrent(
        new Map([[item.path, unmanifested.get(item.path)!]]),
        selection,
      );
    },
    onProgress: (item, index) =>
      params.onProgress?.({
        phase: "removing-unmanifested",
        path: item.path,
        index: index + 1,
        total: explicit.length,
        bytes: item.bytes,
      }),
  });
  return summarizeRecoveryCleanup(
    report.stateDir,
    report.artifacts,
    report.artifacts.some((item) => item.outcome === "failed" || item.outcome === "blocked")
      ? "blocked"
      : "complete",
    report.missingOriginals,
  );
}

async function disposeRecoveryArtifacts({
  selected,
  references,
  assertDestinations,
  assertCurrent,
  verification,
  onProgress,
}: {
  selected: RecoveryCleanupReport["artifacts"];
  references: Map<string, RecoveryArtifactReference[]>;
  assertDestinations: (refs: RecoveryArtifactReference[]) => void;
  assertCurrent?: () => void;
  verification?: MigrationArtifactVerification;
  onProgress?: (progress: RecoveryCleanupProgress) => void;
}): Promise<void> {
  const runs = new Set<ActiveSessionSqliteMigrationRun>();
  const movesByTarget = new Map<
    SessionSqliteMigrationTargetManifest,
    Map<string, SessionSqliteMigrationMove[]>
  >();
  const movesFor = (ref: RecoveryArtifactReference, archivePath: string) => {
    let byPath = movesByTarget.get(ref.target);
    if (!byPath) {
      byPath = new Map();
      for (const move of [...ref.target.plannedMoves, ...ref.target.completedMoves]) {
        if (move.artifact) {
          const moves = byPath.get(move.archivePath) ?? [];
          moves.push(move);
          byPath.set(move.archivePath, moves);
        }
      }
      movesByTarget.set(ref.target, byPath);
    }
    return byPath.get(archivePath) ?? [];
  };
  for (const item of selected) {
    const refs = references.get(item.path)!;
    const pending = refs
      .map(({ move }) => move.artifact!.disposal)
      .find((receipt) => receipt.state === "pending-disposal");
    const disposal: MigrationArtifact["disposal"] = pending ?? {
      state: "pending-disposal",
      intendedAt: new Date().toISOString(),
      phase: "intent",
      claimPath: path.join(path.dirname(item.path), `.cleanup-${randomUUID()}`),
    };
    for (const ref of refs) {
      for (const move of movesFor(ref, item.path)) {
        move.artifact!.disposal = disposal;
      }
      runs.add(ref.run);
    }
  }
  // Every referencing manifest is durable before the first artifact in this selection moves.
  for (const run of runs) {
    assertCurrent?.();
    writeSessionSqliteMigrationManifest(run);
  }
  let activeItem: (typeof selected)[number] | undefined;
  const claims = selected.map((item) => {
    const refs = references.get(item.path)!;
    const artifact = refs[0]!.move.artifact!;
    const disposal = artifact.disposal;
    if (
      disposal.state !== "pending-disposal" ||
      path.dirname(disposal.claimPath) !== path.dirname(item.path) ||
      !path.basename(disposal.claimPath).startsWith(".cleanup-")
    ) {
      throw new Error("invalid disposal claim");
    }
    return { item, refs, artifact, disposal, present: false };
  });
  try {
    // Claim the entire selection before retiring any member: a changed later transcript
    // must not lose its index or siblings. Durable intent also owns partially moved claims.
    for (const [index, claim] of claims.entries()) {
      const { item, refs, artifact, disposal } = claim;
      activeItem = item;
      onProgress?.({
        phase: "claiming",
        path: item.path,
        index: index + 1,
        total: claims.length,
        bytes: item.bytes,
      });
      assertCurrent?.();
      assertDestinations(refs);
      if (hasSymbolicLinkInDirectoryPath(path.dirname(item.path))) {
        throw new Error("archive directory changed");
      }
      if (statMigrationPath(item.path)) {
        if (disposal.phase === "unlink-pending") {
          throw new Error("archive was recreated after claim");
        }
        const identity = assertRecoveryOriginal(item.path, artifact, verification);
        if (!identity) {
          throw new Error("artifact is unexpectedly missing");
        }
        await moveMigrationArtifact(
          item.path,
          disposal.claimPath,
          identity,
          () => {
            // Publication awaited durable I/O; the host may have revoked this worker.
            assertCurrent?.();
            return undefined;
          },
          undefined,
          verification,
        );
      }
      assertCurrent?.();
      assertDestinations(refs);
      assertRecoveryOriginal(item.path, artifact, verification);
      claim.present = statMigrationPath(disposal.claimPath) !== undefined;
      disposal.phase = "unlink-pending";
    }
    // All claims, including their unlink intents, must survive a crash before disposal starts.
    for (const run of runs) {
      assertCurrent?.();
      writeSessionSqliteMigrationManifest(run);
    }
    for (const { item, artifact, disposal, present } of claims) {
      activeItem = item;
      if (hasSymbolicLinkInDirectoryPath(path.dirname(item.path))) {
        throw new Error("archive directory changed");
      }
      if (statMigrationPath(item.path)) {
        throw new Error("archive was recreated after claim");
      }
      assertRecoveryOriginal(item.path, artifact, verification);
      if (present !== (statMigrationPath(disposal.claimPath) !== undefined)) {
        throw new Error("disposal claim changed after intent");
      }
    }
    assertCurrent?.();
    for (const { item, refs } of claims) {
      activeItem = item;
      assertDestinations(refs);
    }
    // The host can revoke worker authority even between synchronous unlinks.
    // Durable unlink-pending receipts make every partial failure retryable.
    for (const { item, artifact, disposal } of claims) {
      activeItem = item;
      const claim = statMigrationPath(disposal.claimPath);
      if (claim) {
        assertCurrent?.();
        fs.unlinkSync(disposal.claimPath);
        item.removedBytes = artifact.identity.size;
      }
      item.outcome = claim ? "removed" : "disposed";
      item.bytes = claim ? artifact.identity.size : 0;
      item.reason = claim ? "rollback-original-retired" : "completed-interrupted-disposal";
    }
    const syncedDirectories = new Set<string>();
    for (const { item, refs } of claims) {
      activeItem = item;
      const directory = path.dirname(item.path);
      if (item.outcome === "removed" && !syncedDirectories.has(directory)) {
        requireDirectorySync(await syncDirectory(directory), "Recovery artifact removal");
        syncedDirectories.add(directory);
      }
      assertCurrent?.();
      assertDestinations(refs);
      for (const ref of refs) {
        for (const move of movesFor(ref, item.path)) {
          move.artifact!.disposal = {
            state: "disposed",
            disposedAt: new Date().toISOString(),
          };
        }
      }
    }
    for (const run of runs) {
      assertCurrent?.();
      writeSessionSqliteMigrationManifest(run);
    }
  } catch (error) {
    if (activeItem) {
      activeItem.outcome = "failed";
      activeItem.reason = "artifact-retirement-failed";
      activeItem.detail = String(error);
    }
    for (const item of selected) {
      if (item.outcome === "candidate") {
        item.outcome = "blocked";
        item.reason = "retirement-stopped";
      }
    }
  }
}
