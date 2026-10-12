import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { withUserPathBaseDirectory } from "./home-dir.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { isPathInside } from "./path-guards.js";
import { withRuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import { tryProcessCwd } from "./safe-cwd.js";
import {
  maintainRetainedUpdateRuntimes,
  registerRetainedUpdateRuntime,
  removeTemporaryArtifacts,
  reportRetainedUpdateRuntime,
} from "./temp-artifact-cleanup.js";
import { ignoreMissingUpdateCandidateFile } from "./update-candidate-files.js";
import { withUpdateCandidateIoBudget } from "./update-candidate-io.js";
import { prepareUpdateCandidatePluginTrees } from "./update-candidate-plugin-tree.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";
import { resolveNativePackageProjectRoot } from "./update-native-package-owner.js";
import { linkUpdateCandidatePluginTrees } from "./update-retained-runtime-tree.js";
import { prepareRuntimeRelocations, relocateRuntimePath } from "./update-runtime-relocation.js";

const log = createSubsystemLogger("update/retained-runtime");

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
  return await withUserPathBaseDirectory(tryProcessCwd(), () =>
    runWithRetainedUpdateRuntime(moduleUrl, operation),
  );
}

async function runWithRetainedUpdateRuntime<T>(
  moduleUrl: string,
  operation: (retain: RetainUpdateRuntime) => Promise<T>,
): Promise<T> {
  let directory: string | undefined;
  let prepared = false;
  let closing = false;
  let preparation: ReturnType<RetainUpdateRuntime> | undefined;
  let unregister: (() => void) | undefined;
  let parkedCwd: { original: string; parked: string } | undefined;
  return await withRuntimeWorkerGeneration(
    async (bind) =>
      await operation((params) => {
        preparation = (async () => {
          const { mutationRoots, installTarget, env, timeoutMs } = params;
          const assertCurrent = () => {
            if (closing) {
              throw new Error("The updater's retained runtime is closing");
            }
            params.assertCurrent();
          };
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
          // Boundaries use the same native spelling as sourceRoot. Windows 8.3
          // names and case-insensitive volumes otherwise hide that the update
          // replaces this runtime, and its workers load from the new package.
          const mutations = mutationRoots.map((entry) =>
            resolveIdentityPathViaExistingAncestorSync(path.resolve(entry)),
          );
          const packageOwner = installTarget
            ? (resolveNativePackageProjectRoot(installTarget, env) ?? installTarget.globalRoot)
            : undefined;
          const mutationBoundaries = [
            ...mutations,
            ...(packageOwner
              ? [resolveIdentityPathViaExistingAncestorSync(path.resolve(packageOwner))]
              : []),
          ];
          const cwd = tryProcessCwd();
          if (!parkedCwd && cwd) {
            const physicalCwd = resolveIdentityPathViaExistingAncestorSync(cwd);
            if (mutationBoundaries.some((entry) => isPathInside(entry, physicalCwd))) {
              const parked = path.parse(process.execPath).root;
              assertCurrent();
              // Node Worker bootstrap needs a live physical cwd before its own code runs.
              process.chdir(parked);
              parkedCwd = { original: cwd, parked: tryProcessCwd() ?? parked };
            }
          }
          if (
            !mutations.some(
              (entry) => isPathInside(entry, sourceRoot) || isPathInside(sourceRoot, entry),
            )
          ) {
            return undefined;
          }
          await maintainRetainedUpdateRuntimes({
            packageRoots: [sourceRoot],
            repair: true,
            assertCurrent,
          });
          assertCurrent();
          // Package inventories include their module owner, and native activation
          // replaces its whole project. Scratch must be a sibling of both boundaries.
          const boundaries = [sourceRoot, ...mutationBoundaries];
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
          // An unselected module install can copy its entire enclosing module
          // owner. Keep its scratch outside that owner; standalone checkouts
          // can retain current-main same-volume placement.
          if (
            (installTarget || !sourceRoot.split(path.sep).includes("node_modules")) &&
            outsideMutation(parent)
          ) {
            const sourceStat = await fs.stat(sourceRoot);
            assertCurrent();
            try {
              const parentStat = await fs.stat(parent);
              if (sourceStat.dev === parentStat.dev) {
                directory = await fs.mkdtemp(path.join(parent, "openclaw-update-runtime-"));
                unregister = registerRetainedUpdateRuntime(directory);
              }
            } catch (error) {
              if (
                !["EACCES", "EPERM", "EROFS", "ENOENT", "ENOTDIR", "ENOSPC", "EDQUOT"].some(
                  (code) => hasErrnoCode(error, code),
                )
              ) {
                throw error;
              }
            }
          }
          if (!directory) {
            const temporary = resolveIdentityPathViaExistingAncestorSync(path.resolve(os.tmpdir()));
            if (!outsideMutation(temporary)) {
              throw new Error(
                "Updater temporary directory is inside an installation being replaced",
              );
            }
            assertCurrent();
            directory = await fs.mkdtemp(path.join(temporary, "openclaw-update-runtime-"));
            unregister = registerRetainedUpdateRuntime(directory);
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
            const present = await fs.lstat(entry).catch(ignoreMissingUpdateCandidateFile);
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
            // Missing optional peers must not pull unrelated ancestor installations
            // into a retained runtime. Explicit linked dependency owners still travel.
            retainedDependencyRoot: packageOwner
              ? resolveIdentityPathViaExistingAncestorSync(path.resolve(packageOwner))
              : sourceRoot,
            onProgress: assertCurrent,
          });
          const inventoryMs = Math.round(performance.now() - inventoryStartedAt);
          const materializationStartedAt = performance.now();
          const counts = await withUpdateCandidateIoBudget(
            { directory: privateRoot, bytes: plan.bytes, timeoutMs, progress: "reported" },
            async (signal, reportProgress) =>
              await linkUpdateCandidatePluginTrees(plan, {
                targetStateDir: privateRoot,
                candidateRoot,
                onMaterialized: reportProgress,
                onProgress: () => {
                  signal.throwIfAborted();
                },
                assertCurrent: () => {
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
              ...(root === sourceRoot
                ? []
                : [{ sourceRoot: root, destinationRoot: candidateRoot }]),
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
        })();
        return preparation;
      }),
    async () => {
      closing = true;
      // A signal can arrive during projection; stop and join its last filesystem write.
      await preparation?.catch(() => undefined);
      if (directory) {
        if (prepared) {
          reportRetainedUpdateRuntime(
            directory,
            "worker generation settled; cleanup deferred to the next eligible update or openclaw doctor --fix",
          );
        } else {
          await removeTemporaryArtifacts(directory, "Updater runtime");
        }
      }
      unregister?.();
    },
    (reason) => {
      if (directory) {
        reportRetainedUpdateRuntime(directory, reason);
      }
      return directory;
    },
  ).finally(() => {
    if (!parkedCwd || tryProcessCwd() !== parkedCwd.parked) {
      return;
    }
    try {
      process.chdir(parkedCwd.original);
    } catch (error) {
      // Replacement can retire the launch path; keep the update's original outcome.
      if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ENOTDIR")) {
        log.warn(`Could not restore updater launch directory: ${formatErrorMessage(error)}`);
      }
    }
  });
}
