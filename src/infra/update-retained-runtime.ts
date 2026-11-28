import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { UPDATE_NATIVE_GATE_SOURCE } from "../cli/update-cli/update-command-native-gate.generated.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { resolveCommandProcessSignal } from "../process/exec-spawn.js";
import { hasErrnoCode, ignoreMissingPath as ignoreMissingUpdateCandidateFile } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { withUserPathBaseDirectory } from "./home-dir.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./path-existence.js";
import { isPathInside } from "./path-guards.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeScriptEntrypointUrl } from "./runtime-process-url.js";
import { withRuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { tryProcessCwd } from "./safe-cwd.js";
import {
  maintainRetainedUpdateRuntimes,
  recordRetainedUpdateRuntimeOwner,
  registerRetainedUpdateRuntime,
  removeTemporaryArtifacts,
  reportRetainedUpdateRuntime,
  resolveRetainedUpdateRuntimeParents,
} from "./temp-artifact-cleanup.js";
import {
  parseUpdateStateInspectionWorker,
  runUpdateStateInspectionWorker,
} from "./update-candidate-state.inspection.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";
import { resolveNativePackageProjectRoot } from "./update-native-package-owner.js";
import {
  projectRetainedRuntimePath,
  readRetainedRuntimeFileList,
  RetainedRuntimeFilesSchema,
} from "./update-retained-runtime-files.js";
import { retainUpdateRuntimeImports } from "./update-retained-runtime-imports.js";
import { prepareRuntimeRelocations, relocateRuntimePath } from "./update-runtime-relocation.js";

const log = createSubsystemLogger("update/retained-runtime");

type RetainedUpdateRuntimeMetrics = {
  inventoryMs: number;
  materializationMs: number;
  entries: number;
  /** Allocated footprint estimate, including directories and aliases; not copied bytes. */
  estimatedBytes: number;
  linked: number;
  /** Published without a hard link; clones and byte copies are not told apart. */
  copied: number;
  linkFallback?: { count: number; code: string };
};

export type RetainUpdateRuntime = (params: {
  mutationRoots: readonly string[];
  installTarget?: ResolvedGlobalInstallTarget;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
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
        const signal = resolveCommandProcessSignal(params.signal);
        const assertCurrent = () => {
          signal?.throwIfAborted();
          if (closing) {
            throw new Error("The updater's retained runtime is closing");
          }
          params.assertCurrent();
        };
        preparation = (async () => {
          const { mutationRoots, installTarget, env, timeoutMs } = params;
          const temporaryRoot = (env ?? process.env).TMPDIR?.trim();
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
            temporaryDirectories: temporaryRoot ? [temporaryRoot] : undefined,
            repair: true,
            assertCurrent,
          });
          assertCurrent();
          // Package inventories include their module owner, and native activation
          // replaces its whole project. Scratch must stay outside both boundaries.
          const boundaries = [sourceRoot, ...mutationBoundaries];
          const parent = resolveRetainedUpdateRuntimeParents(sourceRoot, mutationBoundaries).at(
            -1,
          )!;
          const outsideMutation = (candidate: string) =>
            !boundaries.some((entry) => isPathInside(entry, candidate));
          if (
            !temporaryRoot &&
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
            const temporary = resolveIdentityPathViaExistingAncestorSync(
              path.resolve(temporaryRoot || os.tmpdir()),
            );
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
          await recordRetainedUpdateRuntimeOwner(privateRoot);
          assertCurrent();
          const nativeGateSource = resolveRuntimeWorkerUrl(
            runtimeProcessEntrypoints.updateNativeGate,
          );
          const nativeGate = resolveRuntimeScriptEntrypointUrl("updateNativeGate", privateRoot);
          await fs.writeFile(nativeGate, UPDATE_NATIVE_GATE_SOURCE, { mode: 0o600, flag: "wx" });
          assertCurrent();
          // Native recovery uses the retained helper after replacement removes the installed one.
          bind((url) => (url.href === nativeGateSource.href ? nativeGate : url));
          const candidateRoot = projectRetainedRuntimePath(privateRoot, sourceRoot);
          const roots: string[] = [];
          for (const name of ["package.json", "dist", "node_modules"]) {
            const entry = path.join(sourceRoot, name);
            const present = await fs.lstat(entry).catch(ignoreMissingUpdateCandidateFile);
            assertCurrent();
            if (present) {
              roots.push(entry);
            }
          }
          log.info("Runtime retention attempt 1/1: preparing the running updater");
          const retainedFiles = await runUpdateStateInspectionWorker({
            input: {
              mode: "runtime-retention",
              stateDir: privateRoot,
              config: {},
              privateRoot,
              sourceRoot,
              roots,
              // Missing optional peers stay within the package manager's owning project.
              retainedDependencyRoot: packageOwner
                ? resolveIdentityPathViaExistingAncestorSync(path.resolve(packageOwner))
                : sourceRoot,
            },
            nodeRunner: process.execPath,
            sourceEnv: env ?? process.env,
            stagingRoot: privateRoot,
            databases: [],
            timeoutMs,
            signal,
            ioBudget: "deadline",
            maxOutputBytes: 64 * 1024 * 1024,
            onProgress: ({ phase }) => log.info(phase),
          });
          assertCurrent();
          const retained = parseUpdateStateInspectionWorker(
            retainedFiles,
            RetainedRuntimeFilesSchema,
          );
          // Rollback after activation loads its code from this retained runtime: without it
          // a failed Doctor or boot cannot restore the previous release and its databases.
          // Every retention failure therefore stops the update before activation.
          if ("unusableReason" in retained) {
            throw new Error(retained.unusableReason);
          }
          const { relocations: retainedRelocations, fileCount, ...metrics } = retained;
          if (metrics.linkFallback) {
            const { count, code } = metrics.linkFallback;
            const cause =
              code === "EXDEV"
                ? ". The updater temporary directory is on a different filesystem or subvolume than the installation"
                : "";
            // Retention still succeeded; say why it cost a copy per file instead of a link.
            log.warn(
              `Runtime retention could not hard-link ${count} of ${metrics.linked + metrics.copied} files (first error ${code}); each was cloned or copied instead${cause}`,
            );
          }
          const files = await readRetainedRuntimeFileList(privateRoot, { fileCount });
          assertCurrent();
          const relocations = prepareRuntimeRelocations(
            [
              ...retainedRelocations,
              ...(root === sourceRoot
                ? []
                : [{ sourceRoot: root, destinationRoot: candidateRoot }]),
            ].map((entry) => Object.freeze({ ...entry })),
          );
          const resolve = (url: URL) =>
            url.href === nativeGateSource.href
              ? nativeGate
              : pathToFileURL(relocateRuntimePath(fileURLToPath(url), relocations));
          bind(resolve);
          // Workers and the parent must use the same generation after activation
          // replaces dist; preserving URLs also preserves already-loaded singletons.
          // Inventory uses physical paths; imports retain the running updater spelling.
          const importIdentities = prepareRuntimeRelocations([
            { sourceRoot, destinationRoot: root },
          ]);
          retainUpdateRuntimeImports(
            relocations.rules,
            files.map((sourcePath) => ({
              sourcePath,
              identityPath: relocateRuntimePath(sourcePath, importIdentities),
            })),
          );
          prepared = true;
          return metrics;
        })().catch((error: unknown) => {
          if (signal?.aborted || closing || hasCommandProcessCleanupError(error)) {
            throw error;
          }
          throw new Error(
            `Could not retain the running updater (${formatErrorMessage(error)}). The update stopped before changing the installation; retry it.`,
            { cause: error },
          );
        });
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
            "worker generation settled; the next eligible openclaw update or openclaw doctor --fix retries its cleanup",
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
