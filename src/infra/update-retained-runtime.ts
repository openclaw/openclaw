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
import {
  copyUpdateCandidatePluginTrees,
  prepareUpdateCandidatePluginTrees,
} from "./update-candidate-plugin-tree.js";
import { relocateRuntimePath } from "./update-runtime-relocation.js";

export type RetainUpdateRuntime = (params: {
  mutationRoots: readonly string[];
  timeoutMs: number;
  assertCurrent: () => void;
}) => Promise<void>;

/** The command retains its own workers through reporting, rollback, and native settlement. */
export async function withRetainedUpdateRuntime<T>(
  moduleUrl: string,
  operation: (retain: RetainUpdateRuntime) => Promise<T>,
): Promise<T> {
  let directory: string | undefined;
  let prepared = false;
  return await withRuntimeWorkerGeneration(
    async (bind) =>
      await operation(async ({ mutationRoots, timeoutMs, assertCurrent }) => {
        assertCurrent();
        if (prepared) {
          return;
        }
        const root = await resolveOpenClawPackageRoot({ moduleUrl });
        if (!root) {
          throw new Error("Cannot retain the running updater's package root");
        }
        const sourceRoot = await fs.realpath(root);
        assertCurrent();
        if (
          !mutationRoots.some((entry) => {
            const mutation = resolvePathViaExistingAncestorSync(path.resolve(entry));
            return isPathInside(mutation, sourceRoot) || isPathInside(sourceRoot, mutation);
          })
        ) {
          return;
        }
        directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-runtime-"));
        const privateRoot = await fs.realpath(directory);
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
        const plan = await prepareUpdateCandidatePluginTrees({
          roots,
          project,
          targetStateDir: privateRoot,
          candidateRoot,
          retainedHostRoot: sourceRoot,
          onProgress: assertCurrent,
        });
        await withUpdateCandidateIoBudget(
          { directory: privateRoot, bytes: plan.bytes, timeoutMs },
          async (signal) =>
            await copyUpdateCandidatePluginTrees(plan, {
              targetStateDir: privateRoot,
              candidateRoot,
              onProgress: () => {
                signal.throwIfAborted();
                assertCurrent();
              },
            }),
        );
        assertCurrent();
        const relocations = [
          ...plan.relocations,
          ...(root === sourceRoot ? [] : [{ sourceRoot: root, destinationRoot: candidateRoot }]),
        ].map((entry) => Object.freeze({ ...entry }));
        const resolve = (url: URL) =>
          pathToFileURL(relocateRuntimePath(fileURLToPath(url), relocations));
        bind(resolve);
        prepared = true;
      }),
    async () => {
      if (directory) {
        await removeTemporaryArtifacts(directory, "Updater runtime");
      }
    },
    () => directory,
  );
}
