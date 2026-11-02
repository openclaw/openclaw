import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withDeferredPluginConfigRollback } from "../infra/deferred-plugin-migrations.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  pluginCohortPublicationContext as captures,
  type PluginCohortPublicationContext,
} from "../infra/update-plugin-cohort-context.js";
import type {
  PluginCohortConfigFileIntent,
  PluginCohortRecoveryPair,
} from "../infra/update-plugin-cohort-schema.js";
import {
  loadPluginCohortRecovery,
  writePluginCohortRecovery,
} from "../infra/update-run-recovery-store.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import {
  getConfigValueAtPath,
  setConfigValueAtPath,
  unsetConfigValueAtPath,
} from "./config-paths.js";
import { readConfigWriteMigrationFacts } from "./deferred-plugin-migration-config.js";
import {
  formatFutureConfigActionBlock,
  resolveFutureConfigActionBlock,
} from "./future-version-guard.js";
import { collectChangedConfigPaths } from "./include-write-boundary.js";
import { hashConfigIncludeRaw } from "./includes.js";
import { createConfigIO } from "./io.factory.js";
import { hashConfigRaw } from "./io.read-helpers.js";
import { createConfigValidationFailedError } from "./io.write-errors.js";
import { preflightConfigRuntimeWrite } from "./io.write-preflight.js";
import {
  assertConfigFileWritePathSnapshot,
  captureConfigFileWritePathProof,
  createConfigFileWriteGuard,
  rollbackConfigFileWriteIfUnchanged,
} from "./io.write-safety.js";
import {
  formatJsonFileValue,
  readRootBoundFileRawIfExists,
  resolveExpectedRootBoundIncludeFile,
  writeRootBoundJsonFile,
} from "./mutate.include-io.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import { resolveConfigPath, resolveStateDir } from "./paths.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";
import { createConfigWriteAuthorityGuard } from "./write-authority.js";
import { captureConfigWriteLockGuard, withConfigWriteLock } from "./write-lock.js";

type ConfigCohortAuthority = {
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
};
type ConfigCohortCapture = PluginCohortPublicationContext;

function assertPairSource(pair: PluginCohortRecoveryPair, authority: ConfigCohortCapture): void {
  authority.assertCurrent();
  if (
    pair.cohort.transactionId !== authority.transactionId ||
    pair.cohort.installKey !== authority.installKey ||
    pair.reservation.source?.stateDir !== resolveStateDir(authority.env) ||
    pair.reservation.source.configPath !== resolveConfigPath(authority.env)
  ) {
    throw new Error("Plugin cohort configuration capture lost its original update source.");
  }
}

/** Bind only this admitted updater/Doctor chain; unrelated writers retain their own context. */
export async function withPluginCohortConfigCapture<T>(
  authority: ConfigCohortAuthority & { runId: string; installKey: string },
  operation: () => Promise<T>,
): Promise<T> {
  authority.assertCurrent();
  // Preserve the installed updater's captured WAL family until Doctor admits it.
  const pair = loadPluginCohortRecovery(authority.runId, {
    env: authority.env,
  });
  if (!pair || pair.cohort.disposition !== "pending") {
    return await captures.exit(operation);
  }
  const capture: ConfigCohortCapture = {
    ...authority,
    transactionId: pair.cohort.transactionId,
    prepareConfigPublication: (file, assertWriterCurrent) =>
      recordConfigPublication(capture, file, assertWriterCurrent),
  };
  assertPairSource(pair, capture);
  return await captures.run(capture, operation);
}

function recordConfigPublication(
  capture: ConfigCohortCapture,
  file: PluginCohortConfigFileIntent,
  assertWriterCurrent: () => void,
): void {
  const assertCurrent = createConfigWriteAuthorityGuard(capture.assertCurrent, assertWriterCurrent);
  assertCurrent();
  // Doctor children and earlier writes can advance the journal. Never append through a cached pair.
  const pair = loadPluginCohortRecovery(capture.runId, { env: capture.env, allowNativeRead: true });
  if (!pair) {
    throw new Error("Plugin cohort configuration recovery was retired before publication.");
  }
  assertPairSource(pair, capture);
  if (
    pair.cohort.disposition !== "pending" ||
    file.rootConfigPath !== pair.reservation.source?.configPath
  ) {
    throw new Error("Plugin cohort configuration publication is outside its pending source.");
  }
  writePluginCohortRecovery(
    pair,
    { ...pair.cohort, publications: [...pair.cohort.publications, { kind: "config", file }] },
    { assertCurrent },
    { env: capture.env },
  );
}

function conflict(file: PluginCohortConfigFileIntent): never {
  throw new ConfigMutationConflictError(
    `Configuration changed after update publication: ${file.filePath}. Plugin cohort recovery preserved it.`,
    { retryable: false },
  );
}

function authoredChangedPaths(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[][] {
  return collectChangedConfigPaths(before, after).paths.flatMap((entry) => {
    const previous = getConfigValueAtPath(before, entry);
    const next = getConfigValueAtPath(after, entry);
    if ((previous === undefined || isRecord(previous)) && (next === undefined || isRecord(next))) {
      // A newly added object owns its authored leaves, not a later writer's sibling.
      return authoredChangedPaths(previous ?? {}, next ?? {}).map((child) => entry.concat(child));
    }
    return [[...entry]];
  });
}

function mergedAuthoredPreimage(
  file: PluginCohortConfigFileIntent,
  currentRaw: string | null,
): string {
  if (currentRaw === null) {
    return conflict(file);
  }
  let before: unknown;
  let after: unknown;
  let current: unknown;
  try {
    before = file.beforeRaw === null ? {} : parseJsonWithJson5Fallback(file.beforeRaw);
    after = parseJsonWithJson5Fallback(file.afterRaw);
    current = parseJsonWithJson5Fallback(currentRaw);
  } catch {
    return conflict(file);
  }
  if (!isRecord(before) || !isRecord(after) || !isRecord(current)) {
    return conflict(file);
  }
  const result = structuredClone(current);
  const changedPaths = authoredChangedPaths(before, after);
  let changedOwnValue = false;
  for (const changedPath of changedPaths) {
    const logicalPath = file.include?.boundaryPath.concat(changedPath) ?? changedPath;
    if (
      logicalPath.length === 2 &&
      logicalPath[0] === "meta" &&
      logicalPath[1] === "lastTouchedVersion"
    ) {
      // A merged file has a later writer, even when both writers used the same version.
      // Only exact owned bytes qualify for restoring the prior writer's stamp.
      continue;
    }
    const previous = getConfigValueAtPath(before, changedPath);
    const next = getConfigValueAtPath(after, changedPath);
    const present = getConfigValueAtPath(current, changedPath);
    if (isDeepStrictEqual(present, previous)) {
      continue;
    }
    if (!isDeepStrictEqual(present, next)) {
      return conflict(file);
    }
    for (let depth = 1; depth < changedPath.length; depth++) {
      const parent = getConfigValueAtPath(current, changedPath.slice(0, depth));
      if (parent !== undefined && !isRecord(parent)) {
        return conflict(file);
      }
    }
    changedOwnValue = true;
    if (previous === undefined) {
      unsetConfigValueAtPath(result, [...changedPath], current);
    } else {
      setConfigValueAtPath(result, changedPath, previous);
    }
  }
  return changedOwnValue ? formatJsonFileValue(result) : currentRaw;
}

/** Reopen the canonical config owner; historical facts never revive its former lock or authority. */
export async function restorePluginCohortConfigPublication(
  file: PluginCohortConfigFileIntent,
  authority: ConfigCohortAuthority,
): Promise<void> {
  await captures.exit(() =>
    withConfigWriteLock(
      file.rootConfigPath,
      async () => {
        const rootGuard = captureConfigWriteLockGuard(file.rootConfigPath);
        const pathProof = captureConfigFileWritePathProof(file.filePath, file.targetPath, fsNode);
        const filesystemRoot = path.parse(file.targetPath).root;
        const anchored = file.pathSnapshot.entries.some(
          (entry) =>
            entry.kind === "existing" &&
            entry.link === undefined &&
            entry.path !== filesystemRoot &&
            isPathInside(entry.path, file.targetPath),
        );
        const freshRoot = anchored
          ? pathProof.snapshot.entries.find((entry) => entry.path === filesystemRoot)
          : undefined;
        // A reopened mount namespace can change its root device. A stable target
        // ancestor still anchors recovery; retain every historical inode and link,
        // and fence the complete fresh lookup through publication.
        const historicalPathSnapshot =
          freshRoot?.kind === "existing"
            ? {
                ...file.pathSnapshot,
                entries: file.pathSnapshot.entries.map((entry) =>
                  entry.kind === "existing" && entry.path === filesystemRoot
                    ? { ...entry, dev: freshRoot.dev }
                    : entry,
                ),
              }
            : file.pathSnapshot;
        const assertCurrent = createConfigWriteAuthorityGuard(
          authority.assertCurrent,
          rootGuard,
          () => {
            if (resolveConfigPath(authority.env) !== file.rootConfigPath) {
              throw new ConfigMutationConflictError(
                "Plugin cohort configuration selection changed",
                { retryable: false },
              );
            }
            assertConfigFileWritePathSnapshot(historicalPathSnapshot, fsNode);
          },
          pathProof.assertCurrent,
        );
        assertCurrent();
        const io = createConfigIO({
          env: authority.env,
          configPath: file.rootConfigPath,
          pluginValidation: "skip",
          observe: false,
        });
        const prepared = await io.readConfigFileSnapshotForWrite();
        assertCurrent();
        if (file.include) {
          const ownership = prepared.snapshot.includeProvenance?.find((entry) =>
            isDeepStrictEqual(entry.path, file.include!.boundaryPath),
          );
          if (
            !ownership ||
            ownership.kind !== "single" ||
            ownership.hasSiblingOverrides ||
            ownership.hasArrayAncestor ||
            ownership.targetPath !== file.targetPath ||
            prepared.writeOptions.includeFileTargetsForWrite?.[file.filePath] !== file.targetPath
          ) {
            conflict(file);
          }
        }
        const restore = async () => {
          const fileGuard = captureConfigWriteLockGuard(file.filePath);
          const assertOwner = createConfigWriteAuthorityGuard(assertCurrent, fileGuard);
          const target = await resolveExpectedRootBoundIncludeFile({
            configPath: file.rootConfigPath,
            includePath: file.filePath,
            expectedAbsolutePath: file.targetPath,
            allowedRoots: [],
          });
          assertOwner();
          const currentRaw = await readRootBoundFileRawIfExists(target);
          assertOwner();
          if (currentRaw === file.beforeRaw) {
            return;
          }
          const graphHashes = {
            ...prepared.writeOptions.includeFileHashesForWrite,
            ...(file.include
              ? { [prepared.snapshot.path]: hashConfigIncludeRaw(prepared.snapshot.raw) }
              : {}),
          };
          const graphTargets = {
            ...prepared.writeOptions.includeFileTargetsForWrite,
            ...(file.include
              ? { [prepared.snapshot.path]: fsNode.realpathSync(prepared.snapshot.path) }
              : {}),
          };
          const referenceGuards: Array<() => void> = [];
          for (const [sourcePath, hash] of Object.entries(graphHashes)) {
            const targetPath = graphTargets[sourcePath];
            if (!targetPath || targetPath === file.targetPath) {
              continue;
            }
            const raw = await fs.readFile(targetPath, "utf8");
            assertOwner();
            if (hashConfigIncludeRaw(raw) !== hash) {
              conflict(file);
            }
            const proof = captureConfigFileWritePathProof(sourcePath, targetPath, fsNode);
            referenceGuards.push(
              createConfigFileWriteGuard(targetPath, fsNode, assertOwner, {
                snapshot: { path: targetPath, exists: true, raw },
                includeGraph: { hashes: {}, targets: {} },
                targetPathProof: proof,
              }).assertBeforeMutation,
            );
          }
          const assertPublicationCurrent = createConfigWriteAuthorityGuard(
            assertOwner,
            ...referenceGuards,
          );
          if (currentRaw === file.afterRaw) {
            const stat = fsNode.lstatSync(file.targetPath, { bigint: true });
            const restored = await rollbackConfigFileWriteIfUnchanged({
              configPath: file.targetPath,
              previousSnapshot: {
                path: file.targetPath,
                exists: file.beforeRaw !== null,
                raw: file.beforeRaw,
              },
              committedHash: hashConfigRaw(file.afterRaw),
              fsModule: fsNode,
              assertCurrent: assertPublicationCurrent,
              publicationIdentity: { dev: stat.dev, ino: stat.ino },
              preserveDirectoryMode: true,
              destinationHardlinks: "reject",
              durable: true,
              withPublication: (publish, didMutate) =>
                withDeferredPluginConfigRollback(
                  {
                    configPath: file.rootConfigPath,
                    env: authority.env,
                    assertCurrent: assertPublicationCurrent,
                  },
                  publish,
                  didMutate,
                ),
            });
            if (!restored) {
              conflict(file);
            }
            return;
          }
          // Only the exact owned postimage qualifies for old-schema byte compensation.
          // A merge keeps normal future-writer protection and the later writer's stamp.
          if (!prepared.snapshot.valid) {
            conflict(file);
          }
          const future = resolveFutureConfigActionBlock({
            action: "restore plugin cohort configuration",
            snapshot: prepared.snapshot,
            env: authority.env,
          });
          if (future) {
            throw new Error(formatFutureConfigActionBlock(future));
          }
          const mergedRaw = mergedAuthoredPreimage(file, currentRaw);
          if (mergedRaw === currentRaw) {
            return;
          }
          const mergedValue = parseJsonWithJson5Fallback(mergedRaw);
          let candidateRaw = mergedRaw;
          if (file.include) {
            if (!prepared.snapshot.authoredConfig) {
              conflict(file);
            }
            const candidate = structuredClone(prepared.snapshot.authoredConfig);
            setConfigValueAtPath(candidate, file.include.boundaryPath, mergedValue);
            candidateRaw = formatJsonFileValue(candidate);
          }
          const candidate = await io.readConfigFileSnapshotFromRaw(candidateRaw);
          assertPublicationCurrent();
          if (!candidate.valid) {
            throw createConfigValidationFailedError(candidate.issues);
          }
          const pendingMigrations = await readConfigWriteMigrationFacts(
            prepared.snapshot,
            authority.env,
          );
          assertPublicationCurrent();
          const source = candidate.sourceConfigBeforeMigrations ?? candidate.sourceConfig;
          const validated = validateConfigObjectRawWithPlugins(source, {
            env: authority.env,
            pluginValidation: "skip",
            semanticValidation: "strict",
            deferredPluginMigrations: pendingMigrations,
          });
          if (!validated.ok) {
            throw createConfigValidationFailedError(validated.issues);
          }
          await preflightConfigRuntimeWrite(file.rootConfigPath, source, undefined);
          assertPublicationCurrent();
          await writeRootBoundJsonFile({
            env: authority.env,
            deferredPluginMigrations: pendingMigrations,
            configPath: file.rootConfigPath,
            includePath: file.filePath,
            allowedRoots: [],
            expectedTargetPath: file.targetPath,
            value: mergedValue,
            expectedRaw: currentRaw,
            includeGraph: { hashes: graphHashes, targets: graphTargets },
            assertIncludeGraphForWrite: async () => assertPublicationCurrent(),
            assertConfigPathForWrite: assertPublicationCurrent,
            assertOwnerForRollback: assertPublicationCurrent,
          });
        };
        if (file.include) {
          await withConfigWriteLock(file.filePath, restore, authority.env, assertCurrent);
        } else {
          await restore();
        }
      },
      authority.env,
      authority.assertCurrent,
    ),
  );
}
