/** Explicit per-path retirement, never automatic eligibility or suffix-based discovery. */
import fs from "node:fs";
import path from "node:path";
import { resolveAllAgentSessionStoreCandidateTargetsSync } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { requireDirectorySync, syncDirectory } from "../infra/directory-durability.js";
import { sameFileMutationFingerprint } from "../infra/file-descriptor.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { isPathInside } from "../infra/path-guards.js";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import { hasSymbolicLinkInDirectoryPath } from "../infra/session-sqlite-migration-manifest.js";
import { resolveTargetSqlitePath } from "../infra/session-sqlite-migration-readers.js";
import { resolveSqliteDatabaseFilePaths, SQLITE_SIDECAR_SUFFIXES } from "../infra/sqlite-files.js";
import { isUpdateRecoveryPending } from "../infra/update-run-recovery-schema.js";
import { inspectUpdateRecoveries } from "../infra/update-run-recovery.js";
import { withSynchronousArtifactPreservingStateSnapshot } from "../state/openclaw-state-db-readonly.js";
import {
  summarizeRecoveryCleanup,
  type collectUpdateCleanupInventory,
} from "./doctor-session-sqlite-recovery-inventory.js";
import type { RecoveryCleanupArtifact } from "./update-cleanup-types.js";

type Inventory = ReturnType<typeof collectUpdateCleanupInventory>;
type SelectionIdentity = Map<string, { stat: fs.BigIntStats; sha256?: string }>;
export type UnmanifestedSelection = Map<string, SelectionIdentity>;

function overlaps(left: string, right: string): boolean {
  // Recovery locators may use an older alias even though the selected original may not.
  const canonical = resolvePathViaExistingAncestorSync(right);
  return isPathInside(left, canonical) || isPathInside(canonical, left);
}

function pendingRecoveryRoots(env: NodeJS.ProcessEnv): string[] {
  return inspectUpdateRecoveries({ env })
    .filter(({ record }) => isUpdateRecoveryPending(record))
    .flatMap(({ record }) => {
      const manifests = [
        record.preimages?.ref.manifestPath,
        record.checkpoint?.ref.manifestPath,
        record.checkpoint?.preimageRef?.manifestPath,
        record.restore?.planPath,
        ...(record.afterImages ?? []).flatMap((image) => [
          image.checkpointRef.manifestPath,
          image.afterUpdate.ref.manifestPath,
          image.afterUpdate.preimageRef?.manifestPath,
        ]),
      ];
      return manifests
        .filter((file): file is string => Boolean(file))
        .map((file) => path.dirname(resolvePathViaExistingAncestorSync(file)))
        .concat(
          absolutePaths(record.package, env),
          record.effects.flatMap((effect) => absolutePaths(effect.package, env)),
          record.effects.map((effect) => effect.resourceId).filter((file) => path.isAbsolute(file)),
        );
    });
}

/** Configured paths can name an active store even when its filename resembles an original. */
function absolutePaths(value: unknown, env: NodeJS.ProcessEnv): string[] {
  if (typeof value === "string") {
    return path.isAbsolute(value) || value.startsWith("~/") ? [resolveUserPath(value, env)] : [];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.values(value).flatMap((entry) => absolutePaths(entry, env));
}

function activePaths(cfg: OpenClawConfig, env: NodeJS.ProcessEnv, inventory: Inventory): string[] {
  const paths = [
    path.join(inventory.report.stateDir, "state", "openclaw.sqlite"),
    ...absolutePaths(cfg, env),
    ...resolveAllAgentSessionStoreCandidateTargetsSync(cfg, { env }).flatMap((target) => [
      target.storePath,
      resolveTargetSqlitePath(target, env),
    ]),
    ...[...inventory.references.values()].flatMap((refs) =>
      refs.flatMap(({ target }) => [target.storePath, target.sqlitePath]),
    ),
  ];
  return paths.flatMap((file) => {
    const absolute = path.resolve(file);
    const canonical = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
    return resolveSqliteDatabaseFilePaths(absolute).concat(
      resolveSqliteDatabaseFilePaths(canonical),
    );
  });
}

function assertNotDatabase(file: string, livePaths: readonly string[]): void {
  if (
    livePaths.some((live) => isPathInside(file, live)) ||
    SQLITE_SIDECAR_SUFFIXES.some((suffix) => file.endsWith(suffix)) ||
    SQLITE_SIDECAR_SUFFIXES.some((suffix) =>
      fs.lstatSync(`${file}${suffix}`, { throwIfNoEntry: false }),
    )
  ) {
    throw new Error("Active database path or database sidecar; keep the database family intact.");
  }
}

/** No following links and no recursive rm over uninspected files. */
function inspectSelection(
  item: RecoveryCleanupArtifact,
  livePaths: readonly string[],
): SelectionIdentity {
  const identities: SelectionIdentity = new Map();
  if (
    hasSymbolicLinkInDirectoryPath(path.dirname(item.path)) ||
    fs.realpathSync(item.path) !== item.path
  ) {
    throw new Error("Recovery path is aliased.");
  }
  const pending = [item.path];
  while (pending.length > 0) {
    const file = pending.pop()!;
    const stat = fs.lstatSync(file, { bigint: true });
    assertNotDatabase(file, livePaths);
    if (stat.isDirectory() && item.kind === "update-capture") {
      identities.set(file, { stat });
      for (const name of fs.readdirSync(file).toSorted().toReversed()) {
        pending.push(path.join(file, name));
      }
    } else if (stat.isFile() && stat.nlink === 1n) {
      // A standalone SQLite filename is not a recovery original, even if its name
      // also contains a repair suffix. Consolidated databases inside captures are payloads.
      if (item.kind !== "update-capture" && /\.(?:sqlite(?:3)?|db)$/iu.test(file)) {
        throw new Error("Live database filename is not an unmanifested recovery original.");
      }
      // Always hash: a same-size rewrite can retain every timestamp at runtime precision.
      identities.set(file, { stat, sha256: readMigrationArtifactIdentity(file).sha256 });
    } else {
      throw new Error("Recovery selection contains a symlink, hardlink, or nonregular file.");
    }
  }
  return identities;
}

/** Selection consumes the inventory owner's known paths; it never discovers new deletion roots. */
export function selectUnmanifestedRecovery(params: {
  inventory: Inventory;
  paths?: readonly string[];
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): UnmanifestedSelection {
  const selected: UnmanifestedSelection = new Map();
  if (!params.paths?.length) {
    return selected;
  }
  const { inventory } = params;
  const requested = [...new Set(params.paths.map((file) => path.resolve(file)))];
  // Refuse the entire explicit request before other cleanup effects when any path is unsafe.
  withSynchronousArtifactPreservingStateSnapshot(
    () => {
      const pending = pendingRecoveryRoots(params.env);
      const livePaths = activePaths(params.cfg, params.env, inventory);
      for (const file of requested) {
        const item = inventory.report.artifacts.find((artifact) => artifact.path === file);
        if (
          !item ||
          item.outcome !== "protected" ||
          ![
            "unmanifested-recovery-original",
            "orphan-update-capture",
            "superseded-unsealed-capture",
          ].includes(item.reason)
        ) {
          throw new Error(
            `Cannot include unmanifested path ${file}: not an eligible known recovery original or orphan capture.`,
          );
        }
        if (
          inventory.report.artifacts.some((artifact) =>
            ["unreadable-manifest", "manifest-directory-alias"].includes(artifact.reason),
          )
        ) {
          throw new Error(
            "Cannot include unmanifested recovery with unreadable recovery dependencies.",
          );
        }
        if (
          pending.some((root) => overlaps(file, root)) ||
          [...inventory.references.values()].some((refs) =>
            refs.some(({ move }) =>
              [
                move.sourcePath,
                move.archivePath,
                ...(move.artifact?.dependencies ?? []),
                ...(move.artifact?.disposal.state === "pending-disposal"
                  ? [move.artifact.disposal.claimPath]
                  : []),
              ].some((dependency) => overlaps(file, dependency)),
            ),
          )
        ) {
          throw new Error(
            `Cannot include ${file}: pending or retained recovery references this path.`,
          );
        }
        selected.set(file, inspectSelection(item, livePaths));
      }
    },
    { current: { env: params.env } },
  );
  for (const [file, identities] of selected) {
    const item = inventory.report.artifacts.find((artifact) => artifact.path === file)!;
    const { stat } = identities.get(file)!;
    item.outcome = "candidate";
    item.reason = "explicit-unmanifested-selection";
    item.bytes = [...identities.values()].reduce(
      (bytes, { stat: entry }) => bytes + (entry.isFile() ? Number(entry.size) : 0),
      0,
    );
    item.modifiedAt = new Date(Number(stat.mtimeMs)).toISOString();
    item.detail =
      "Explicitly selected with --include-unmanifested. No import or rollback proof is inferred.";
    item.consequence =
      item.kind === "update-capture"
        ? "Permanently deletes this orphan original-state capture and all recovery generations inside it."
        : "Permanently deletes this unmanifested original; pre-repair history, branches, and metadata may be unrecoverable.";
  }
  inventory.report = summarizeRecoveryCleanup(
    inventory.report.stateDir,
    inventory.report.artifacts,
    "preview",
    inventory.report.missingOriginals,
  );
  return selected;
}

export function assertUnmanifestedSelectionCurrent(
  expected: UnmanifestedSelection,
  current: UnmanifestedSelection,
): void {
  for (const [root, files] of expected) {
    const actual = current.get(root);
    if (
      !actual ||
      files.size !== actual.size ||
      [...files].some(([file, { stat, sha256 }]) => {
        const next = actual.get(file);
        return !next || !sameFileMutationFingerprint(stat, next.stat) || sha256 !== next.sha256;
      })
    ) {
      throw new Error(`Explicit recovery selection changed: ${root}; preview cleanup again.`);
    }
  }
}

/** Existing maintenance/owner custody remains held through every synchronous point of effect. */
export async function retireUnmanifestedRecovery(params: {
  selected: RecoveryCleanupArtifact[];
  identities: UnmanifestedSelection;
  assertCurrent(): void;
  assertReferences(item: RecoveryCleanupArtifact): Promise<void>;
  onProgress?: (item: RecoveryCleanupArtifact, index: number) => void;
}): Promise<void> {
  for (const [index, item] of params.selected.entries()) {
    try {
      params.onProgress?.(item, index);
      params.assertCurrent();
      await params.assertReferences(item);
      params.assertCurrent();
      const expected = params.identities.get(item.path)!;
      const current = inspectSelection(item, []);
      assertUnmanifestedSelectionCurrent(
        new Map([[item.path, expected]]),
        new Map([[item.path, current]]),
      );
      // Reverse traversal removes children first. No awaited I/O between identity and unlink.
      for (const [file, { stat, sha256 }] of [...expected].toReversed()) {
        params.assertCurrent();
        if (hasSymbolicLinkInDirectoryPath(path.dirname(file))) {
          throw new Error("Recovery directory changed before removal.");
        }
        const actual = fs.lstatSync(file, { bigint: true });
        if (stat.isDirectory()) {
          if (!actual.isDirectory() || actual.dev !== stat.dev || actual.ino !== stat.ino) {
            throw new Error("Recovery directory changed before removal.");
          }
          fs.rmdirSync(file);
        } else {
          if (
            !actual.isFile() ||
            actual.nlink !== 1n ||
            !sameFileMutationFingerprint(stat, actual) ||
            readMigrationArtifactIdentity(file).sha256 !== sha256
          ) {
            throw new Error("Recovery original changed before removal.");
          }
          assertNotDatabase(file, []);
          fs.unlinkSync(file);
          item.removedBytes = (item.removedBytes ?? 0) + Number(stat.size);
        }
      }
      item.outcome = "removed";
      item.reason = "explicit-unmanifested-retired";
      requireDirectorySync(
        await syncDirectory(path.dirname(item.path)),
        "Explicit recovery retirement",
      );
    } catch (error) {
      item.outcome = "failed";
      item.reason = "explicit-unmanifested-retirement-failed";
      item.detail = String(error);
      for (const remaining of params.selected.slice(index + 1)) {
        remaining.outcome = "blocked";
        remaining.reason = "retirement-stopped";
      }
      break;
    }
  }
}
