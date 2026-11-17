import fs from "node:fs/promises";
import path from "node:path";
import { gitPathspecBatches } from "../../agents/worktrees/git-path-inventory.js";
import { requireGit, requireGitPath } from "../../agents/worktrees/git.js";
import { root as fsRoot } from "../../infra/fs-safe.js";
import { gitNullConfigPath } from "../../infra/git-exec.js";
import {
  createStagedInputPathMatcher,
  stagedInputPathDirectory,
} from "../../media/staged-inputs.js";
import { readActualWorkspaceManifestImpl } from "./workspace-actual-manifest.js";
import {
  MAX_WORKSPACE_INVENTORY_ENTRIES,
  MAX_WORKSPACE_INVENTORY_PATH_BYTES,
} from "./workspace-inventory-limits.js";
import type { WorkerWorkspaceManifest } from "./workspace-manifest.js";
import { isDerivedWorkspacePath, projectWorkspaceEntries } from "./workspace-path-exclusions.js";

/** Temporary indexes borrow immutable objects; unchanged source paths retain accepted bytes. */
export async function readWorkspaceBaseRefreshTrees(
  input: {
    root: string;
    beforeTree: string;
    afterTree: string;
    temporaryRoot: string;
    baseCommit: string;
  },
  accepted: WorkerWorkspaceManifest,
): Promise<[WorkerWorkspaceManifest, WorkerWorkspaceManifest]> {
  const objects = await requireGitPath(input.root, ["rev-parse", "--git-path", "objects"]);
  const metadata = path.join(input.temporaryRoot, "metadata");
  const cleanEnv = {
    PATH: process.env.PATH,
    HOME: input.temporaryRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitNullConfigPath(),
    GIT_CONFIG_SYSTEM: gitNullConfigPath(),
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
  };
  await fs.mkdir(metadata);
  await requireGit(
    metadata,
    [
      "init",
      "--quiet",
      "--template=",
      "--object-format=" + (input.beforeTree.length === 40 ? "sha1" : "sha256"),
    ],
    { baseEnv: cleanEnv, env: cleanEnv },
  );
  const env = {
    ...cleanEnv,
    GIT_DIR: path.join(metadata, ".git"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(path.resolve(input.root, objects)),
  };
  const git = (root: string, args: string[], stdin?: string) =>
    requireGit(root, args, {
      baseEnv: env,
      env,
      input: stdin,
      timeoutMs: 300_000,
      maxOutputBytes: MAX_WORKSPACE_INVENTORY_PATH_BYTES,
    });
  const checkout = async (root: string, paths: string[]) => {
    if (paths.length) {
      await git(
        root,
        ["checkout-index", "--force", "--prefix=" + root + path.sep, "-z", "--stdin"],
        paths.join("\0") + "\0",
      );
    }
  };
  const inventories = [];
  for (const [index, tree] of [input.beforeTree, input.afterTree].entries()) {
    const root = path.join(input.temporaryRoot, index === 0 ? "before" : "after");
    await fs.mkdir(root);
    const markers = new Set<string>();
    const isStagedInput = createStagedInputPathMatcher(await fsRoot(root));
    const retained = new Set<string>();
    const inventory = [];
    let directories = [""];
    // Visit one level at a time: excluded subtrees must not consume Git output budgets.
    while (directories.length) {
      const children: string[] = [];
      for (const batch of gitPathspecBatches(directories)) {
        const listed = await git(metadata, [
          "ls-tree",
          "-z",
          "--full-tree",
          tree,
          "--",
          ...batch.filter(Boolean).map((directory) => `:(literal)${directory}/`),
        ]);
        const entries = listed
          .split("\0")
          .filter(Boolean)
          .map((record) => {
            const separator = record.indexOf("\t");
            const [mode, type, object] = record.slice(0, separator).split(" ");
            return {
              path: record.slice(separator + 1),
              type: type === "blob" ? "file" : "directory",
              mode,
              object,
            };
          });
        const addedMarkers = entries
          .filter(
            (entry) =>
              entry.type === "file" &&
              entry.path === `${stagedInputPathDirectory(entry.path)}/.gitignore`,
          )
          .map((entry) => entry.path);
        if (addedMarkers.length) {
          if (!markers.size) {
            await git(root, ["read-tree", tree]);
          }
          await checkout(root, addedMarkers);
          for (const marker of addedMarkers) {
            markers.add(marker);
          }
        }
        for (const entry of entries) {
          // Keep excluded roots so projection still prunes their otherwise-empty parents.
          inventory.push(entry);
          if (!isDerivedWorkspacePath(entry.path) || (await isStagedInput(entry.path))) {
            retained.add(entry.path);
            if (entry.mode === "040000") {
              children.push(entry.path);
            }
          }
        }
      }
      directories = children;
    }
    const eligible = projectWorkspaceEntries(inventory, (file) => retained.has(file));
    if (eligible.length > MAX_WORKSPACE_INVENTORY_ENTRIES) {
      throw new Error("Gateway workspace manifest has too many entries");
    }
    inventories.push({ root, markers, entries: eligible });
  }
  const before = inventories[0]!.entries;
  const after = inventories[1]!.entries;
  const previous = new Map(before.map((entry) => [entry.path, entry]));
  const next = new Map(after.map((entry) => [entry.path, entry]));
  // Attribute changes can alter checkout bytes even when the blob OID stays the same.
  const attributesChanged = [...before, ...after].some(
    (entry) =>
      (path.posix.basename(entry.path) === ".gitattributes" ||
        entry.path === `${stagedInputPathDirectory(entry.path)}/.gitignore`) &&
      previous.get(entry.path)?.object !== next.get(entry.path)?.object,
  );
  const saved = new Map(accepted.entries.map((entry) => [entry.path, entry]));
  const result: WorkerWorkspaceManifest[] = [];
  for (const [index, { root, markers, entries: eligible }] of inventories.entries()) {
    await git(root, ["read-tree", index === 0 ? input.beforeTree : input.afterTree]);
    const reused = [];
    const materialize = [];
    for (const entry of eligible) {
      if (entry.type === "directory") {
        continue;
      }
      const prior = previous.get(entry.path);
      const incoming = next.get(entry.path);
      const value = saved.get(entry.path);
      if (
        !attributesChanged &&
        entry.mode !== "120000" &&
        value?.type === "file" &&
        prior?.object === incoming?.object &&
        prior?.mode === incoming?.mode &&
        !markers.has(entry.path)
      ) {
        reused.push(value);
      } else if (!markers.has(entry.path)) {
        materialize.push(entry.path);
      }
    }
    await checkout(root, materialize);
    const { manifest } = await readActualWorkspaceManifestImpl({
      root,
      baseCommit: input.baseCommit,
    });
    manifest.entries.push(...reused);
    manifest.entries.sort((left, right) => left.path.localeCompare(right.path));
    manifest.directories = eligible
      .filter((entry) => entry.type === "directory")
      .map((entry) => entry.path);
    result.push(manifest);
  }
  return [result[0]!, result[1]!];
}
