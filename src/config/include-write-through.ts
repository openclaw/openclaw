// One guarded owner for include-file publication: stage in memory (no disk
// effects), publish inside the caller's commit window under a per-target lock
// with a hash fence, and restore-only-if-unchanged on failure. Authority is
// asserted immediately before every disk effect via the caller-supplied
// assertConfigPathForWrite, the same contract the root config file uses.
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { formatErrorMessage, isMissingPathError } from "../infra/errors.js";
import { root as createFsRoot, type Root as FsSafeRoot } from "../infra/fs-safe.js";
import { isPathInside } from "../security/scan-paths.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { isRecord } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { prepareConfigFileWrite } from "./backup-rotation.js";
import { restoreEnvVarRefs } from "./env-preserve.js";
import {
  resolveKeyedAgentEntryIncludePreservation,
  resolveKeyedProviderModelsIncludePreservation,
} from "./include-write-boundary.js";
import {
  ConfigIncludeError,
  hashConfigIncludeRaw,
  isInternalIncludeWriteTarget,
  resolveConfigIncludeWritePath,
  type ConfigIncludeOwnership,
} from "./includes.js";
import {
  hashConfigRaw,
  rejectConfigNonFiniteNumbers,
  restoreAuthoredTildePathsForWrite,
} from "./io.read-helpers.js";
import { createConfigIncludeOwnershipError } from "./io.write-errors.js";
import {
  assertBaseSnapshotStillCurrent,
  captureConfigFileWritePathProof,
  createGuardedConfigFileSystem,
  rollbackConfigFileWriteIfUnchanged,
} from "./io.write-safety.js";
import { warnIfJSON5CommentsWillBeStripped } from "./json5-comments.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import type { ConfigFileSnapshot } from "./types.js";
import { withConfigWriteLock } from "./write-lock.js";

/** Combines the two keyed-preservation resolvers into the single path list
 * resolvePersistCandidateForWrite/captureIncludeWriteThrough need. */
export function resolveIncludeWriteThroughPaths(params: {
  configPath: string;
  provenance: Parameters<typeof resolveKeyedAgentEntryIncludePreservation>[0]["provenance"];
}): {
  keyedAgentEntryIncludePaths?: readonly (readonly string[])[];
  includeWriteThroughPaths: readonly (readonly string[])[];
} {
  const keyedAgentEntry = resolveKeyedAgentEntryIncludePreservation(params);
  const keyedProviderModels = resolveKeyedProviderModelsIncludePreservation(params);
  return {
    keyedAgentEntryIncludePaths: keyedAgentEntry?.includePaths,
    includeWriteThroughPaths: [
      ...(keyedAgentEntry?.includePaths ?? []),
      ...(keyedProviderModels?.includePaths ?? []),
    ],
  };
}

export type PendingIncludeWrite = {
  includePath: string[];
  value: unknown;
};

// Keyed-path predicates for the two write-through-eligible include shapes.
function isKeyedAgentEntryIncludePath(keyPath: readonly string[]): boolean {
  return keyPath.length === 3 && keyPath[0] === "agents" && keyPath[1] === "entries";
}

function isKeyedProviderModelsIncludePath(keyPath: readonly string[]): boolean {
  return (
    keyPath.length === 4 &&
    keyPath[0] === "models" &&
    keyPath[1] === "providers" &&
    keyPath[3] === "models"
  );
}

// Filters collectIncludeOwnedPaths's tree walk (owned by io.write-prepare.ts,
// which still does the walk) down to the two write-through-eligible shapes,
// honoring caller overrides of either result list.
export function resolveIncludeOwnedWriteThroughPaths(params: {
  includeOwnedPaths?: readonly (readonly string[])[];
  keyedAgentEntryIncludePathsOverride?: readonly (readonly string[])[];
  includeWriteThroughPathsOverride?: readonly (readonly string[])[];
}): {
  keyedAgentEntryIncludePaths?: readonly (readonly string[])[];
  includeWriteThroughPaths?: readonly (readonly string[])[];
} {
  const keyedAgentEntryPaths = params.includeOwnedPaths?.filter(isKeyedAgentEntryIncludePath);
  const keyedAgentEntryIncludePaths =
    params.keyedAgentEntryIncludePathsOverride ??
    (params.includeWriteThroughPathsOverride === undefined ? keyedAgentEntryPaths : undefined);
  const includeWriteThroughPaths =
    params.includeWriteThroughPathsOverride ??
    (params.includeOwnedPaths
      ? [
          ...keyedAgentEntryPaths!,
          ...params.includeOwnedPaths.filter(isKeyedProviderModelsIncludePath),
        ]
      : undefined);
  return { keyedAgentEntryIncludePaths, includeWriteThroughPaths };
}

function includeConfigPathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

// Canonical immutable path get/set, moved from io.write-prepare.ts (which
// re-imports them) so there is exactly one copy. Config paths can traverse
// array indices (roster entries), hence parseConfigPathArrayIndex.
export function getPathValue(value: unknown, keyPath: string[]): unknown {
  let current = value;
  for (const segment of keyPath) {
    if (Array.isArray(current)) {
      const index = parseConfigPathArrayIndex(segment);
      if (index === undefined || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

export function setPathValue(value: unknown, keyPath: string[], nextValue: unknown): unknown {
  if (keyPath.length === 0) {
    return structuredClone(nextValue);
  }
  const head = expectDefined(keyPath[0], "config path head");
  const tail = keyPath.slice(1);
  if (Array.isArray(value)) {
    const index = parseConfigPathArrayIndex(head);
    if (index === undefined || index >= value.length) {
      return value;
    }
    const next = [...value];
    next[index] = setPathValue(value[index], tail, nextValue);
    return next;
  }
  if (!isRecord(value)) {
    return value;
  }
  return {
    ...value,
    [head]: setPathValue(value[head], tail, nextValue),
  };
}

/** Diff-and-capture pass: pulls keyed include-owned values out of nextConfig
 * into pendingIncludeWrites and restores the root-authored value in their
 * place, so the root persist candidate never carries include-owned content. */
export function captureIncludeWriteThrough(params: {
  includeWriteThroughPaths: readonly (readonly string[])[];
  nextConfig: unknown;
  sourceConfig: unknown;
  runtimeConfig: unknown;
  pendingIncludeWrites: PendingIncludeWrite[];
}): unknown {
  let nextConfig = params.nextConfig;
  for (const includePath of params.includeWriteThroughPaths) {
    const segments = [...includePath];
    const nextValue = getPathValue(nextConfig, segments);
    const sourceValue = getPathValue(params.sourceConfig, segments);
    const runtimeValue = getPathValue(params.runtimeConfig, segments);
    if (
      nextValue === undefined ||
      isDeepStrictEqual(nextValue, sourceValue) ||
      isDeepStrictEqual(nextValue, runtimeValue)
    ) {
      continue;
    }
    params.pendingIncludeWrites.push({ includePath: segments, value: nextValue });
    const restoreValue = sourceValue !== undefined ? sourceValue : runtimeValue;
    if (restoreValue !== undefined) {
      nextConfig = setPathValue(nextConfig, segments, restoreValue);
    }
  }
  return nextConfig;
}

export function formatJsonFileValue(value: unknown): string {
  rejectConfigNonFiniteNumbers(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

export type RootBoundIncludeFile = {
  absolutePath: string;
  relativePath: string;
  root: FsSafeRoot;
};

async function resolveRootBoundIncludeFile(params: {
  configPath: string;
  includePath: string;
  allowedRoots: readonly string[];
}): Promise<RootBoundIncludeFile> {
  const absolutePath = resolveConfigIncludeWritePath(params);
  const candidateRoots = [path.dirname(params.configPath), ...params.allowedRoots];
  for (const candidateRoot of candidateRoots) {
    const rootReal = await fs.realpath(candidateRoot).catch(() => null);
    if (!rootReal || !isPathInside(rootReal, absolutePath)) {
      continue;
    }
    const relativePath = path.relative(rootReal, absolutePath);
    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath.split(path.sep)[0] === ".."
    ) {
      continue;
    }
    return {
      absolutePath,
      relativePath,
      root: await createFsRoot(rootReal, {
        hardlinks: "reject",
        mkdir: true,
        mode: 0o600,
        symlinks: "reject",
      }),
    };
  }
  throw new Error(`Config include write path has no approved existing root: ${absolutePath}`);
}

export async function resolveExpectedRootBoundIncludeFile(params: {
  configPath: string;
  includePath: string;
  allowedRoots: readonly string[];
  expectedAbsolutePath: string;
}): Promise<RootBoundIncludeFile> {
  let target: RootBoundIncludeFile;
  try {
    target = await resolveRootBoundIncludeFile(params);
  } catch (error) {
    if (
      error instanceof ConfigIncludeError ||
      (error instanceof Error &&
        error.message.startsWith("Config include write path has no approved existing root:"))
    ) {
      throw new ConfigMutationConflictError("included config target changed since last load");
    }
    throw error;
  }
  if (path.normalize(target.absolutePath) !== path.normalize(params.expectedAbsolutePath)) {
    throw new ConfigMutationConflictError("included config target changed since last load");
  }
  return target;
}

export async function readRootBoundFileRawIfExists(
  target: RootBoundIncludeFile,
): Promise<string | null> {
  try {
    return await target.root.readText(target.relativePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

export async function rollbackJsonFileWriteIfUnchanged(params: {
  target: RootBoundIncludeFile;
  previousRaw: string | null;
  committedRaw: string | null;
  assertCurrent?: () => void;
}): Promise<boolean> {
  return await rollbackConfigFileWriteIfUnchanged({
    configPath: params.target.absolutePath,
    previousSnapshot: {
      path: params.target.absolutePath,
      exists: params.previousRaw !== null,
      raw: params.previousRaw,
    },
    // rollbackConfigFileWriteIfUnchanged compares the CURRENT file via
    // hashConfigRaw (io.write-safety.ts:343), not hashConfigIncludeRaw --
    // the two hash different byte layouts for the same non-null input.
    committedHash: hashConfigRaw(params.committedRaw),
    fsModule: fsNode,
    assertCurrent: params.assertCurrent,
    preserveDirectoryMode: true,
    durable: true,
    destinationHardlinks: "reject",
  });
}

export type StagedIncludeWrite = {
  includePath: string[];
  // Authored path identity. Keep it lexical so containment and path-proof
  // checks preserve supported symlinked config roots.
  targetPath: string;
  // Load-time canonical identity for the same target. This is the comparison
  // and lock key; resolving the lexical path must continue to land here.
  canonicalTargetPath: string;
  // Load-graph key for this target (path.normalize(ownership.targetPath)).
  // Publication advances this exact key; nothing downstream re-derives it.
  includeGraphKey: string;
  bytes: string;
  previousRaw: string | null;
  previousHash: string;
};

export type IncludeLoadGraph = { hashes: Record<string, string>; targets: Record<string, string> };

/** Pure staging: no disk writes. Resolves ownership/target from provenance,
 * refuses external targets, reads the current raw + hash fence, and projects
 * the pending delta onto the AUTHORED include value so ${VAR} placeholders
 * survive (finding 3) instead of ever serializing the resolved config. */
// Both windows are fenced: snapshot-to-stage via the caller's load-time
// include graph and stage-to-publish via previousHash re-hashed under the
// publish lock.
export type StagedIncludeWriteResult = {
  staged: StagedIncludeWrite[];
  // Keyed by normalized target path; feeds context.resolveRuntimePreflightSourceConfig
  // so validation/revision-hashing see the bytes publish will produce.
  overlay: ReadonlyMap<string, string> | undefined;
};

export async function stageIncludeWriteThrough(params: {
  snapshot: Pick<ConfigFileSnapshot, "path" | "exists" | "raw" | "readError"> & {
    includeProvenance?: readonly ConfigIncludeOwnership[];
  };
  pendingIncludeWrites: readonly PendingIncludeWrite[];
  envForRestore: NodeJS.ProcessEnv;
  homedir: string;
  // Load-time include graph (hashes AND canonical targets, intermediates
  // included; caller-captured or bound to the snapshot by its read), keyed by
  // the normalized lexical include path -- the same value the provenance
  // targetPath below carries. Required: io.write.ts fails closed before
  // staging when authored includes exist with no bound graph.
  includeLoadGraph: IncludeLoadGraph;
}): Promise<StagedIncludeWriteResult> {
  if (params.pendingIncludeWrites.length > 0) {
    // Snapshot-to-stage fence, fenced whole before any pending value is
    // projected: an intermediate include redirected since load must conflict
    // even when the leaf it currently selects is untouched.
    assertBaseSnapshotStillCurrent(
      params.snapshot,
      params.snapshot.path,
      fsNode,
      params.includeLoadGraph,
    );
  }
  const staged: StagedIncludeWrite[] = [];
  for (const pending of params.pendingIncludeWrites) {
    const ownership = params.snapshot.includeProvenance?.find(
      (entry) =>
        includeConfigPathsEqual(entry.path, pending.includePath) &&
        typeof entry.targetPath === "string",
    );
    const targetPath = ownership?.targetPath;
    if (!targetPath) {
      throw createConfigIncludeOwnershipError({
        ownedConfigPath: pending.includePath.join("."),
      });
    }
    if (
      !isInternalIncludeWriteTarget({
        configPath: params.snapshot.path,
        includePath: targetPath,
      })
    ) {
      throw new Error(
        `Config mutation cannot update external $include target ${targetPath}; edit the included file directly or move it under the config directory.`,
      );
    }
    const includeGraphKey = path.normalize(targetPath);
    const canonicalTargetPath = params.includeLoadGraph.targets[includeGraphKey];
    if (!canonicalTargetPath) {
      throw new ConfigMutationConflictError("included config target changed since last load");
    }
    const target = await resolveExpectedRootBoundIncludeFile({
      configPath: params.snapshot.path,
      includePath: targetPath,
      allowedRoots: [],
      expectedAbsolutePath: canonicalTargetPath,
    });
    const previousRaw = await readRootBoundFileRawIfExists(target);
    const previousHash = hashConfigIncludeRaw(previousRaw);
    // Target resolution/read above yields after the whole-graph assertion.
    // Recheck the selected leaf against its load-time hash so a writer in that
    // window cannot become the staging baseline and then be overwritten.
    if (params.includeLoadGraph.hashes[includeGraphKey] !== previousHash) {
      throw new ConfigMutationConflictError("included config changed since last load");
    }
    let authoredIncludeValue: unknown;
    if (previousRaw !== null) {
      authoredIncludeValue = parseJsonWithJson5Fallback(previousRaw);
    }
    // Runtime values carry expanded home paths; restore authored ~ paths the
    // same way the root writer does so an unrelated save keeps them portable.
    const stagedValue = restoreAuthoredTildePathsForWrite(
      restoreEnvVarRefs(pending.value, authoredIncludeValue, params.envForRestore),
      authoredIncludeValue,
      undefined,
      params.homedir,
    );
    staged.push({
      includePath: pending.includePath,
      targetPath,
      canonicalTargetPath: target.absolutePath,
      includeGraphKey,
      bytes: formatJsonFileValue(stagedValue),
      previousRaw,
      previousHash,
    });
  }
  return {
    staged,
    overlay:
      staged.length > 0
        ? new Map(staged.map((entry) => [path.normalize(entry.canonicalTargetPath), entry.bytes]))
        : undefined,
  };
}

export type IncludeWriteRestorer = {
  // Lexical and canonical identities stay paired through compensation so a
  // symlinked config root is revalidated instead of mistaken for a redirect.
  targetPath: string;
  canonicalTargetPath: string;
  previousRaw: string | null;
  committedRaw: string | null;
  // Same hardlink/inode identity proof publish itself relied on, carried
  // forward so restore verifies the file is still the one it wrote.
  pathProof: ReturnType<typeof captureConfigFileWritePathProof>;
};

/** Publish inside the caller's commit window, before the root file. Per
 * target: re-resolve (target moved/symlinked since stage -> conflict),
 * re-hash-fence against previousHash (concurrent edit -> conflict), durable
 * temp-file+rename write, then push the restorer immediately so a throw at
 * entry N leaves 1..N-1 restorable. */
export async function publishStagedIncludeWrites(params: {
  staged: readonly StagedIncludeWrite[];
  restorers: IncludeWriteRestorer[];
  configPath: string;
  env?: NodeJS.ProcessEnv;
  assertConfigPathForWrite?: () => void;
  skipOutputLogs?: boolean;
  // This write's own copy of the load-time graph. Each published leaf advances
  // its key here, so later leaves and the caller's root guard expect the bytes
  // just committed. It never holds a root entry: the root guard reuses it.
  includeGraph?: IncludeLoadGraph;
  // Root's load-time raw, overlaid per leaf so a leaf publish also conflicts on
  // a root changed since load. Absent when the root does not exist yet.
  rootRawForGraph?: string | null;
}): Promise<void> {
  const ordered = params.staged.toSorted((a, b) =>
    a.canonicalTargetPath.localeCompare(b.canonicalTargetPath),
  );
  const includeGraph = params.includeGraph ?? { hashes: {}, targets: {} };
  const rootRaw = params.rootRawForGraph;
  const leafIncludeGraph = (): IncludeLoadGraph =>
    rootRaw == null
      ? includeGraph
      : {
          hashes: { ...includeGraph.hashes, [params.configPath]: hashConfigIncludeRaw(rootRaw) },
          targets: {
            ...includeGraph.targets,
            [params.configPath]: fsNode.realpathSync(params.configPath),
          },
        };
  // The child lock gets the caller's live authority explicitly: without it,
  // an ambient guarded owner (mutation flows) makes the lock capture a guard
  // for a path that has no scope yet, refusing every authorized mixed save.
  const liveAuthority = () => {
    params.assertConfigPathForWrite?.();
  };
  for (const entry of ordered) {
    await withConfigWriteLock(
      entry.canonicalTargetPath,
      async () => {
        params.assertConfigPathForWrite?.();
        const target = await resolveExpectedRootBoundIncludeFile({
          configPath: params.configPath,
          includePath: entry.targetPath,
          allowedRoots: [],
          expectedAbsolutePath: entry.canonicalTargetPath,
        });
        const currentRaw = await readRootBoundFileRawIfExists(target);
        if (hashConfigIncludeRaw(currentRaw) !== entry.previousHash) {
          throw new ConfigMutationConflictError("included config changed while preparing write");
        }
        const pathProof = captureConfigFileWritePathProof(
          entry.targetPath,
          target.absolutePath,
          fsNode,
        );
        const assertCurrent = () => {
          params.assertConfigPathForWrite?.();
          pathProof.assertCurrent();
        };
        warnIfJSON5CommentsWillBeStripped({
          raw: currentRaw,
          filePath: target.absolutePath,
          skipOutputLogs: params.skipOutputLogs,
        });
        const removal = { removed: false };
        const guardedFs = createGuardedConfigFileSystem(
          target.absolutePath,
          fsNode,
          assertCurrent,
          {
            snapshot: { path: target.absolutePath, exists: currentRaw !== null, raw: currentRaw },
            includeGraph: leafIncludeGraph(),
            targetPathProof: pathProof,
            preserveDirectoryMode: true,
            onRootRemoved: () => {
              removal.removed = true;
            },
          },
        );
        await using preparedFile = await prepareConfigFileWrite({
          configPath: target.absolutePath,
          previousRaw: currentRaw,
          content: entry.bytes,
          fsModule: guardedFs,
          assertCurrent,
          destinationHardlinks: "reject",
          durable: true,
        });
        // publish()'s copy fallback removes the target (guarded rmSync ->
        // onRootRemoved) before rewriting it; a throw after that removal must
        // still register a restorer, fenced on what the failure actually left
        // behind -- not on entry.bytes (never committed) and not unconditional
        // (a writer could land in the gap before restoration runs). Reading
        // the target now, while this per-target lock is still held, captures
        // exactly the failure's own damage as the fence: restoration later
        // proceeds only if the file still matches this snapshot, so a
        // concurrent save after this point makes the fence miss and survives.
        try {
          preparedFile.publish();
        } catch (error) {
          if (removal.removed) {
            const damageRaw = await readRootBoundFileRawIfExists(target);
            params.restorers.push({
              targetPath: entry.targetPath,
              canonicalTargetPath: target.absolutePath,
              previousRaw: entry.previousRaw,
              committedRaw: damageRaw,
              pathProof,
            });
          }
          throw error;
        }
        // Advance only this key: a later leaf in the same publish, and the
        // caller's own root guard, must see the bytes just committed here.
        includeGraph.hashes[entry.includeGraphKey] = hashConfigIncludeRaw(entry.bytes);
        params.restorers.push({
          targetPath: entry.targetPath,
          canonicalTargetPath: target.absolutePath,
          previousRaw: entry.previousRaw,
          committedRaw: entry.bytes,
          pathProof,
        });
      },
      params.env,
      liveAuthority,
    );
  }
}

/** Restore-only-if-unchanged, reverse publish order. An external edit made
 * after publish survives (rollbackJsonFileWriteIfUnchanged compares current
 * bytes to committedRaw before restoring previousRaw). Failures aggregate;
 * the original failure that triggered restoration always stays primary.
 * Compensation authorizes on the original source owner plus each target's
 * path proof -- like root rollback, it must not require the old config to
 * still be the selected one. */
export async function restoreStagedIncludeWrites(
  restorers: readonly IncludeWriteRestorer[],
  params: { configPath: string; env?: NodeJS.ProcessEnv; restoreAuthority?: () => void },
): Promise<void> {
  const failures: unknown[] = [];
  const liveAuthority = () => {
    params.restoreAuthority?.();
  };
  for (const restorer of restorers.toReversed()) {
    try {
      await withConfigWriteLock(
        restorer.canonicalTargetPath,
        async () => {
          params.restoreAuthority?.();
          const target = await resolveExpectedRootBoundIncludeFile({
            configPath: params.configPath,
            includePath: restorer.targetPath,
            allowedRoots: [],
            expectedAbsolutePath: restorer.canonicalTargetPath,
          });
          await rollbackJsonFileWriteIfUnchanged({
            target,
            previousRaw: restorer.previousRaw,
            committedRaw: restorer.committedRaw,
            assertCurrent: () => {
              params.restoreAuthority?.();
              restorer.pathProof.assertCurrent();
            },
          });
        },
        params.env,
        liveAuthority,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Include restore failed for one or more targets");
  }
}

/** Same as restoreStagedIncludeWrites, but folds a restore failure onto the
 * caller's primary failure (original stays primary) instead of throwing --
 * for use inside an already-failed commit-window catch block. */
export async function restoreStagedIncludeWritesOrFold(
  restorers: readonly IncludeWriteRestorer[],
  failure: unknown,
  params: { configPath: string; env?: NodeJS.ProcessEnv; restoreAuthority?: () => void },
): Promise<unknown> {
  try {
    await restoreStagedIncludeWrites(restorers, params);
    return failure;
  } catch (includeRestoreError) {
    return new AggregateError(
      [failure, includeRestoreError],
      `${formatErrorMessage(failure)} Include restore failed: ${formatErrorMessage(includeRestoreError)}`,
    );
  }
}
