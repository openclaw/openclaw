import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { hasErrnoCode } from "./errno.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { isPathInside } from "./path-guards.js";
import { withRuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import { removeTemporaryArtifacts } from "./temp-artifact-cleanup.js";
import { withUpdateCandidateIoBudget } from "./update-candidate-io.js";
import { prepareUpdateCandidatePluginTrees } from "./update-candidate-plugin-tree.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";
import { resolveNativePackageProjectRoot } from "./update-native-package-owner.js";
import { linkUpdateCandidatePluginTrees } from "./update-retained-runtime-tree.js";
import { prepareRuntimeRelocations, relocateRuntimePath } from "./update-runtime-relocation.js";

type RetainedUpdateRuntimeMetrics = {
  inventoryMs: number;
  materializationMs: number;
  entries: number;
  /** Allocated footprint estimate, including directories and aliases; not copied bytes. */
  estimatedBytes: number;
  linked: number;
  copied: number;
};

export type RetainUpdateRuntime = (params: {
  mutationRoots: readonly string[];
  installTarget?: ResolvedGlobalInstallTarget;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  assertCurrent: () => void;
}) => Promise<RetainedUpdateRuntimeMetrics | void>;

/** The command retains its own workers through reporting, rollback, and native settlement. */
export async function withRetainedUpdateRuntime<T>(
  moduleUrl: string,
  operation: (retain: RetainUpdateRuntime) => Promise<T>,
): Promise<T> {
  let directory: string | undefined;
  let prepared = false;
  return await withRuntimeWorkerGeneration(
    async (bind) =>
      await operation(async ({ mutationRoots, installTarget, env, timeoutMs, assertCurrent }) => {
        assertCurrent();
        if (prepared) {
          return undefined;
        }
        const root = await resolveOpenClawPackageRoot({ moduleUrl });
        if (!root) {
          throw new Error("Cannot retain the running updater's package root");
        }
        const sourceRoot = await fs.realpath(root);
        assertCurrent();
        const mutations = mutationRoots.map((entry) =>
          resolvePathViaExistingAncestorSync(path.resolve(entry)),
        );
        if (
          !mutations.some(
            (entry) => isPathInside(entry, sourceRoot) || isPathInside(sourceRoot, entry),
          )
        ) {
          return undefined;
        }
        // Package inventories include their module owner, and native activation
        // replaces its whole project. Scratch must be a sibling of both boundaries.
        const packageOwner = installTarget
          ? (resolveNativePackageProjectRoot(installTarget, env) ?? installTarget.globalRoot)
          : undefined;
        const boundaries = [
          sourceRoot,
          ...mutations,
          ...(packageOwner ? [resolvePathViaExistingAncestorSync(path.resolve(packageOwner))] : []),
        ];
        let parent = path.dirname(sourceRoot);
        while (boundaries.some((entry) => isPathInside(entry, parent))) {
          const ancestor = path.dirname(parent);
          if (ancestor === parent) {
            break;
          }
          parent = ancestor;
        }
        const outsideMutation = (candidate: string) =>
          !boundaries.some((entry) => isPathInside(entry, candidate));
        if (outsideMutation(parent)) {
          const sourceStat = await fs.stat(sourceRoot);
          assertCurrent();
          try {
            const parentStat = await fs.stat(parent);
            if (sourceStat.dev === parentStat.dev) {
              directory = await fs.mkdtemp(path.join(parent, "openclaw-update-runtime-"));
            }
          } catch (error) {
            if (
              !["EACCES", "EPERM", "EROFS", "ENOENT", "ENOTDIR", "ENOSPC", "EDQUOT"].some((code) =>
                hasErrnoCode(error, code),
              )
            ) {
              throw error;
            }
          }
        }
        if (!directory) {
          const temporary = resolvePathViaExistingAncestorSync(path.resolve(os.tmpdir()));
          if (!outsideMutation(temporary)) {
            throw new Error("Updater temporary directory is inside an installation being replaced");
          }
          assertCurrent();
          directory = await fs.mkdtemp(path.join(temporary, "openclaw-update-runtime-"));
        }
        const privateRoot = await fs.realpath(directory);
        assertCurrent();
        if (!outsideMutation(privateRoot)) {
          throw new Error("Retained updater directory overlaps an installation being replaced");
        }
        const project = (source: string) => {
          const base = path.parse(source).root;
          return path.join(
            privateRoot,
            "tree",
            Buffer.from(base).toString("hex"),
            path.relative(base, source),
          );
        };
        const candidateRoot = project(sourceRoot);
        const roots = new Map<string, string>();
        for (const name of ["package.json", "dist", "node_modules"]) {
          const entry = path.join(sourceRoot, name);
          const present = await fs.lstat(entry).catch((error: unknown) => {
            if (hasErrnoCode(error, "ENOENT")) {
              return undefined;
            }
            throw error;
          });
          assertCurrent();
          if (present) {
            roots.set(entry, project(entry));
          }
        }
        const inventoryStartedAt = performance.now();
        const plan = await prepareUpdateCandidatePluginTrees({
          roots,
          project,
          targetStateDir: privateRoot,
          candidateRoot,
          retainedHostRoot: sourceRoot,
          onProgress: assertCurrent,
        });
        const inventoryMs = Math.round(performance.now() - inventoryStartedAt);
        const materializationStartedAt = performance.now();
        const counts = await withUpdateCandidateIoBudget(
          { directory: privateRoot, bytes: plan.bytes, timeoutMs },
          async (signal) =>
            await linkUpdateCandidatePluginTrees(plan, {
              targetStateDir: privateRoot,
              candidateRoot,
              onProgress: () => {
                signal.throwIfAborted();
                assertCurrent();
              },
            }),
        );
        const materializationMs = Math.round(performance.now() - materializationStartedAt);
        assertCurrent();
        const relocations = prepareRuntimeRelocations(
          [
            ...plan.relocations,
            ...(root === sourceRoot ? [] : [{ sourceRoot: root, destinationRoot: candidateRoot }]),
          ].map((entry) => Object.freeze({ ...entry })),
        );
        const resolve = (url: URL) =>
          pathToFileURL(relocateRuntimePath(fileURLToPath(url), relocations));
        bind(resolve);
        prepared = true;
        return {
          inventoryMs,
          materializationMs,
          entries: plan.entries.length,
          estimatedBytes: plan.bytes,
          ...counts,
        };
      }),
    async () => {
      if (directory) {
        await removeTemporaryArtifacts(directory, "Updater runtime");
      }
    },
    () => directory,
  );
}
