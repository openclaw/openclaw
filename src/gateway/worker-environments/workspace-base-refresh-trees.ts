import fs from "node:fs/promises";
import path from "node:path";
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
import { projectWorkspaceEntries } from "./workspace-path-exclusions.js";

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
  const inventories = [];
  for (const tree of [input.beforeTree, input.afterTree]) {
    const listed = await git(metadata, ["ls-tree", "-r", "-t", "-z", "--full-tree", tree]);
    const records = listed.split("\0").filter(Boolean);
    // Recursive ls-tree already places parents before their children.
    inventories.push(
      records.map((record) => {
        const separator = record.indexOf("\t");
        const [mode, type, object] = record.slice(0, separator).split(" ");
        return {
          path: record.slice(separator + 1),
          type: type === "blob" ? "file" : "directory",
          mode,
          object,
        };
      }),
    );
  }
  const [before, after] = inventories;
  const previous = new Map(before!.map((entry) => [entry.path, entry]));
  const next = new Map(after!.map((entry) => [entry.path, entry]));
  // Attribute changes can alter checkout bytes even when the blob OID stays the same.
  const attributesChanged = [...before!, ...after!].some(
    (entry) =>
      (path.posix.basename(entry.path) === ".gitattributes" ||
        entry.path === `${stagedInputPathDirectory(entry.path)}/.gitignore`) &&
      previous.get(entry.path)?.object !== next.get(entry.path)?.object,
  );
  const saved = new Map(accepted.entries.map((entry) => [entry.path, entry]));
  const result: WorkerWorkspaceManifest[] = [];
  for (const [index, inventory] of inventories.entries()) {
    const root = path.join(input.temporaryRoot, index === 0 ? "before" : "after");
    await fs.mkdir(root);
    await git(root, ["read-tree", index === 0 ? input.beforeTree : input.afterTree]);
    const checkout = async (paths: string[]) => {
      if (paths.length) {
        await git(
          root,
          ["checkout-index", "--force", "--prefix=" + root + path.sep, "-z", "--stdin"],
          paths.join("\0") + "\0",
        );
      }
    };
    // The scanner's staged-input marker owns inclusion, including derived-looking inputs.
    const markers = new Set(
      inventory
        .filter(
          (entry) =>
            entry.type === "file" &&
            entry.path === `${stagedInputPathDirectory(entry.path)}/.gitignore`,
        )
        .map((entry) => entry.path),
    );
    await checkout([...markers]);
    const isStagedInput = createStagedInputPathMatcher(await fsRoot(root));
    const retained = new Set<string>();
    for (const entry of inventory) {
      if (await isStagedInput(entry.path)) {
        retained.add(entry.path);
      }
    }
    const eligible = projectWorkspaceEntries(inventory, (file) => retained.has(file));
    if (eligible.length > MAX_WORKSPACE_INVENTORY_ENTRIES) {
      throw new Error("Gateway workspace manifest has too many entries");
    }
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
    await checkout(materialize);
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
