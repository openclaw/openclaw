import fs from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode } from "@openclaw/fs-safe/path";
import {
  executeGitCommand as runGit,
  normalizeGitPathForFilesystem,
  requireGitCommand as requireGit,
  requireGitCommandOutput,
} from "../infra/git-exec.js";
import {
  GIT_BACKUP_MANIFEST,
  GIT_BACKUP_SCHEMA,
  GIT_BACKUP_TABLES,
  gitBackupScopePath,
  parseGitBackupManifest,
  type GitBackupManifest,
} from "./git-backup-codec.js";

export type GitBackupScopeUpdate = {
  relative: string;
  previousFiles: string[];
  files: string[];
};

export type GitBackupRepositoryState = {
  head?: string;
  headFiles: Map<string, string>;
  files: Set<string>;
  directories: Set<string>;
};

export function gitBackupArtifactFiles(manifest: GitBackupManifest): string[] {
  if (manifest.schemaVersion === 2) {
    return [
      GIT_BACKUP_MANIFEST,
      ...["manifest.json", "anchor.sqlite", "database.sqlite"].map((name) =>
        path.join("postgres", name),
      ),
    ];
  }
  return [
    GIT_BACKUP_MANIFEST,
    GIT_BACKUP_SCHEMA,
    ...Object.keys(manifest.tables).map((table) => path.join(GIT_BACKUP_TABLES, `${table}.jsonl`)),
  ];
}

async function lstatIfPresent(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export async function readGitBackupRepositoryState(
  repositoryPath: string,
  env?: NodeJS.ProcessEnv,
): Promise<GitBackupRepositoryState> {
  const gitDirectory = normalizeGitPathForFilesystem(
    await requireGit(repositoryPath, ["rev-parse", "--absolute-git-dir"], { env }),
  );
  const operations = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
  ];
  const pending = await Promise.all(
    operations.map((operation) => lstatIfPresent(path.join(gitDirectory, operation))),
  );
  const index = (await requireGit(repositoryPath, ["ls-files", "--stage", "-z"], { env }))
    .split("\0")
    .filter(Boolean);
  // An alternate index does not isolate commit's merge/sequencer state.
  if (pending.some(Boolean) || index.some((entry) => entry.split("\t")[0]?.split(" ")[2] !== "0")) {
    throw new Error("Git operation is in progress; finish or abort it before creating a backup.");
  }
  const head = await runGit(repositoryPath, ["rev-parse", "--verify", "--quiet", "HEAD"], { env });
  if (head.code !== 0 && head.code !== 1) {
    requireGitCommandOutput("git rev-parse HEAD", head);
  }
  const entries =
    head.code === 0
      ? (
          await requireGit(
            repositoryPath,
            ["ls-tree", "-r", "-z", head.stdout.trim(), "--", "global", "agents", "stores"],
            {
              env,
            },
          )
        )
          .split("\0")
          .filter(Boolean)
      : [];
  const headFiles = new Map(entries.map((entry) => [entry.slice(entry.indexOf("\t") + 1), entry]));
  const files = new Set([
    ...headFiles.keys(),
    ...index.map((entry) => entry.slice(entry.indexOf("\t") + 1)),
  ]);
  const directories = new Set<string>();
  for (const file of files) {
    for (
      let directory = path.posix.dirname(file);
      directory !== ".";
      directory = path.posix.dirname(directory)
    ) {
      directories.add(directory);
    }
  }
  return { head: head.code === 0 ? head.stdout.trim() : undefined, headFiles, files, directories };
}

function refuseBackupOverwrite(file: string): never {
  throw new Error(
    `Refusing to replace non-backup-owned path ${file}; preserve or move it before refreshing this scope.`,
  );
}

async function assertBackupDirectory(
  repositoryPath: string,
  relative: string,
  state: GitBackupRepositoryState,
): Promise<void> {
  const directory = path.join(repositoryPath, relative);
  const stat = await lstatIfPresent(directory);
  if ((stat && !stat.isDirectory()) || state.files.has(relative.split(path.sep).join("/"))) {
    refuseBackupOverwrite(directory);
  }
}

async function readOwnedScopeManifest(
  repositoryPath: string,
  relative: string,
  state: GitBackupRepositoryState,
  env?: NodeJS.ProcessEnv,
): Promise<GitBackupManifest | undefined> {
  const file = path.join(repositoryPath, relative, GIT_BACKUP_MANIFEST);
  const stat = await lstatIfPresent(file);
  let contents: string;
  if (stat) {
    if (!stat.isFile()) {
      return undefined;
    }
    contents = await fs.readFile(file, "utf8");
  } else {
    // Missing working files may still be owned by the last committed manifest.
    const gitPath = path.join(relative, GIT_BACKUP_MANIFEST).split(path.sep).join("/");
    const entry = state.headFiles.get(gitPath);
    if (!entry?.startsWith("100644 blob ") && !entry?.startsWith("100755 blob ")) {
      return undefined;
    }
    contents = await requireGit(repositoryPath, ["show", `${state.head}:${gitPath}`], { env });
  }
  try {
    const manifest = parseGitBackupManifest(contents, file);
    return gitBackupScopePath(manifest.identity) === relative ? manifest : undefined;
  } catch {
    return undefined;
  }
}

export async function prepareScopeUpdate(
  repositoryPath: string,
  relative: string,
  state: GitBackupRepositoryState,
  manifest?: GitBackupManifest,
  env?: NodeJS.ProcessEnv,
): Promise<GitBackupScopeUpdate | undefined> {
  if (relative !== "global") {
    await assertBackupDirectory(
      repositoryPath,
      relative.startsWith("stores") ? "stores" : "agents",
      state,
    );
  }
  const scopePath = path.join(repositoryPath, relative);
  await assertBackupDirectory(repositoryPath, relative, state);
  const previous = await readOwnedScopeManifest(repositoryPath, relative, state, env);
  if (!manifest && !previous) {
    return undefined;
  }
  await assertBackupDirectory(repositoryPath, path.join(relative, GIT_BACKUP_TABLES), state);
  if (manifest?.schemaVersion === 2 || previous?.schemaVersion === 2) {
    await assertBackupDirectory(repositoryPath, path.join(relative, "postgres"), state);
  }
  const previousFiles = previous ? gitBackupArtifactFiles(previous) : [];
  const files = manifest ? gitBackupArtifactFiles(manifest) : [];
  const owned = new Set(previousFiles);
  // Ownership covers declared artifacts, not every file in their directory.
  // Preflight every scope before any refresh or pruning can remove files.
  for (const file of new Set([...previousFiles, ...files])) {
    const destination = path.join(scopePath, file);
    const stat = await lstatIfPresent(destination);
    const gitPath = path.join(relative, file).split(path.sep).join("/");
    if (
      (stat && (!stat.isFile() || !owned.has(file))) ||
      state.directories.has(gitPath) ||
      (!owned.has(file) && state.files.has(gitPath))
    ) {
      refuseBackupOverwrite(destination);
    }
  }
  return { relative, previousFiles, files };
}

export async function prepareStaleScopeUpdates(
  repositoryPath: string,
  retainedScopes: Set<string>,
  state: GitBackupRepositoryState,
  env?: NodeJS.ProcessEnv,
): Promise<GitBackupScopeUpdate[]> {
  const scopes = new Set<string>();
  for (const root of ["agents", "stores"]) {
    const rootPath = path.join(repositoryPath, root);
    const stat = await lstatIfPresent(rootPath);
    if (stat && !stat.isDirectory()) {
      continue;
    }
    if (stat) {
      for (const entry of await fs.readdir(rootPath, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          scopes.add(path.join(root, entry.name));
        }
      }
    }
    for (const file of state.headFiles.keys()) {
      const parts = file.split("/");
      const id = parts[1];
      if (parts.length === 3 && parts[0] === root && parts[2] === GIT_BACKUP_MANIFEST && id) {
        scopes.add(path.join(root, id));
      }
    }
  }
  const updates: GitBackupScopeUpdate[] = [];
  for (const relative of scopes) {
    if (!retainedScopes.has(relative)) {
      const update = await prepareScopeUpdate(repositoryPath, relative, state, undefined, env);
      if (update) {
        updates.push(update);
      }
    }
  }
  return updates;
}

export async function applyScopeUpdate(
  stagingRoot: string,
  repositoryPath: string,
  update: GitBackupScopeUpdate,
): Promise<void> {
  const scopePath = path.join(repositoryPath, update.relative);
  if (update.files.length > 0) {
    await fs.mkdir(path.join(scopePath, GIT_BACKUP_TABLES), { recursive: true, mode: 0o700 });
  }
  // Unlink owned entries instead of overwriting inode bytes: hardlink aliases
  // outside the backup scope must retain their previous contents.
  for (const file of update.previousFiles) {
    await fs.rm(path.join(scopePath, file), { force: true });
  }
  for (const file of update.files) {
    await fs.mkdir(path.dirname(path.join(scopePath, file)), { recursive: true, mode: 0o700 });
    await fs.cp(path.join(stagingRoot, update.relative, file), path.join(scopePath, file), {
      force: false,
      errorOnExist: true,
    });
  }
  if (update.files.length === 0) {
    for (const directory of [path.join(scopePath, GIT_BACKUP_TABLES), scopePath]) {
      await fs.rmdir(directory).catch((error: unknown) => {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].some((code) => hasNodeErrorCode(error, code))) {
          throw error;
        }
      });
    }
  }
}
