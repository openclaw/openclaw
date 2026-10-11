import { createHash } from "node:crypto";
import fsSync, { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { runCommandWithTimeout } from "../process/exec.js";
import { requireDirectorySync, syncDirectory, syncDirectorySync } from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import {
  packageActivationRuntimeIdentity,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
} from "./package-update-activation-paths.js";
import { isPathInside } from "./path-guards.js";
import { collectGitRuntimeErrors, readGitRuntimeArtifactIdentity } from "./update-git-runtime.js";
import { gitCleanCheckArgs } from "./update-runner-git-commands.js";
import type { CommandRunner } from "./update-runner-types.js";

type GenerationEntry = { file: string; stat: Stats };

/** Preparation and verification must inspect their selected tree, not the caller's Git context. */
export function resolveImmutableGenerationEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_NAMESPACE: undefined,
    GIT_GRAFT_FILE: undefined,
    GIT_SHALLOW_FILE: undefined,
    GIT_REPLACE_REF_BASE: undefined,
    GIT_PREFIX: undefined,
    GIT_IMPLICIT_WORK_TREE: undefined,
  };
}

async function inspectGenerationTree(root: string, sealed: boolean): Promise<GenerationEntry[]> {
  const physicalRoot = await fs.realpath(root);
  if (physicalRoot !== path.resolve(root)) {
    throw new Error("Immutable generation must be a physical directory.");
  }
  const entries: GenerationEntry[] = [];
  const visit = async (file: string): Promise<void> => {
    const stat = await fs.lstat(file);
    if (stat.uid !== 0) {
      throw new Error(`Immutable generation is not root-owned: ${file}`);
    }
    if (stat.isSymbolicLink()) {
      if (!isPathInside(root, await fs.realpath(file))) {
        throw new Error(`Immutable generation symlink escapes its release: ${file}`);
      }
    } else {
      if (!stat.isDirectory() && !stat.isFile()) {
        throw new Error(`Unsupported immutable generation entry: ${file}`);
      }
      if (stat.isFile() && stat.nlink !== 1) {
        throw new Error(`Immutable generation must not share hardlinked files: ${file}`);
      }
      if (sealed && ((stat.mode & 0o222) !== 0 || (stat.mode & 0o444) !== 0o444)) {
        throw new Error(`Immutable generation is not sealed and readable: ${file}`);
      }
      if (sealed && stat.isDirectory() && (stat.mode & 0o111) !== 0o111) {
        throw new Error(`Immutable generation directory is not traversable: ${file}`);
      }
      if (stat.isDirectory()) {
        for (const name of await fs.readdir(file)) {
          await visit(path.join(file, name));
        }
      }
    }
    entries.push({ file, stat });
  };
  await visit(root);
  return entries;
}

/** Seal a private, fully materialized tree; never chmod pnpm's shared store or symlink targets. */
export async function sealImmutableGeneration(root: string): Promise<void> {
  const entries = await inspectGenerationTree(root, false);
  for (const { file, stat } of entries) {
    if (stat.isSymbolicLink()) {
      continue;
    }
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await handle.stat();
      if (current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== stat.nlink) {
        throw new Error(`Immutable generation changed while sealing: ${file}`);
      }
      await handle.chmod(stat.isDirectory() ? 0o555 : 0o444 | (stat.mode & 0o111));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function verifyPluginSdkExports(root: string): Promise<void> {
  const manifest = asNullableRecord(
    JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")),
  );
  const exports = asNullableRecord(manifest?.exports);
  const sdk = Object.entries(exports ?? {}).filter(([key]) => key.startsWith("./plugin-sdk/"));
  if (manifest?.name !== "openclaw" || sdk.length === 0) {
    throw new Error("Immutable generation has no OpenClaw plugin SDK exports.");
  }
  const verifyTarget = async (target: unknown): Promise<void> => {
    if (typeof target === "string") {
      const file = path.resolve(root, target);
      if (
        !target.startsWith("./dist/plugin-sdk/") ||
        !isPathInside(root, file) ||
        !(await fs.stat(file)).isFile()
      ) {
        throw new Error(`Invalid immutable plugin SDK export: ${target}`);
      }
      return;
    }
    const conditions = asNullableRecord(target);
    if (!conditions || Object.keys(conditions).length === 0) {
      throw new Error("Immutable generation contains an invalid plugin SDK export.");
    }
    for (const value of Object.values(conditions)) {
      await verifyTarget(value);
    }
  };
  for (const [, target] of sdk) {
    await verifyTarget(target);
  }
}

/** Artifact facts only; this cannot authorize publication or a service restart. */
export async function verifyImmutableGeneration(
  root: string,
  expectedSha: string,
  runCommand: CommandRunner = runCommandWithTimeout,
  options: { sealed?: boolean } = {},
): Promise<{ buildDigest: string; identity: string }> {
  if (!/^[a-f0-9]{40}$/u.test(expectedSha)) {
    throw new Error("Immutable generation requires an exact full commit SHA.");
  }
  const sealed = options.sealed !== false;
  await inspectGenerationTree(root, sealed);
  if (sealed) {
    if (!(await fs.lstat(path.join(root, ".git"))).isDirectory()) {
      throw new Error("A sealed generation requires its own Git metadata directory.");
    }
    const alternates = await fs
      .readFile(path.join(root, ".git", "objects", "info", "alternates"), "utf8")
      .catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return "";
        }
        throw error;
      });
    if (alternates.trim()) {
      throw new Error("A sealed generation must not borrow another repository's Git objects.");
    }
  }
  // Git status ordinarily refreshes the index. A sealed release is always read-only.
  const commandOptions = {
    cwd: root,
    timeoutMs: 60_000,
    env: { ...resolveImmutableGenerationEnv(), GIT_OPTIONAL_LOCKS: "0" },
  };
  const head = await runCommand(["git", "-C", root, "rev-parse", "HEAD"], commandOptions);
  if (head.code !== 0 || head.stdout.trim() !== expectedSha) {
    throw new Error("Immutable generation Git HEAD does not match the selected SHA.");
  }
  const clean = await runCommand(gitCleanCheckArgs(root), commandOptions);
  if (clean.code !== 0 || clean.stdout.trim()) {
    throw new Error("Immutable generation has uncommitted source changes.");
  }
  const errors = await collectGitRuntimeErrors({ root, sha: expectedSha });
  if (errors.length) {
    throw new Error(errors.join("; "));
  }
  if (!(await fs.stat(path.join(root, "dist", "index.js"))).isFile()) {
    throw new Error("Immutable generation Gateway entrypoint is missing.");
  }
  await verifyPluginSdkExports(root);
  const artifact = await readGitRuntimeArtifactIdentity(root);
  const stat = await fs.lstat(root, { bigint: true });
  return { buildDigest: artifact.distDigest, identity: `${stat.dev}:${stat.ino}` };
}

// Exact launcher shipped by slice 1 (99babf272543); only its shebang is installation-specific.
const IMMUTABLE_V1_LAUNCHER_SHA256 =
  "7e3bcd5e1143c2b054ab2bd184b159143b2d2a45893fc462741b8f51780ad5d3";

function upgradeImmutableLauncher(params: {
  root: string;
  launcher: string;
  runtime: string;
  content: string;
  previous: string;
  previousStat: Stats;
  assertCurrent: () => void;
}): void {
  const normalized = params.previous.replace(/^#![^\n]*\n/u, "#!/usr/bin/env node\n");
  if (
    !params.previous.startsWith(`#!${params.runtime}\n`) ||
    createHash("sha256").update(normalized).digest("hex") !== IMMUTABLE_V1_LAUNCHER_SHA256
  ) {
    throw new Error(
      "An existing immutable Gateway launcher conflicts with the known v1 upgrade; it was preserved.",
    );
  }
  const control = resolvePackageActivationControl(resolvePackageActivationAnchor(params.root));
  const bin = path.dirname(params.launcher);
  const directories = [params.root, bin, control].map((file) => ({
    file,
    stat: fsSync.lstatSync(file),
  }));
  const runtimeIdentity = packageActivationRuntimeIdentity(params.runtime);
  const assertUpgrade = () => {
    params.assertCurrent();
    for (const { file, stat: previous } of directories) {
      const stat = fsSync.lstatSync(file);
      if (
        !stat.isDirectory() ||
        stat.uid !== 0 ||
        (stat.mode & 0o022) !== 0 ||
        stat.dev !== previous.dev ||
        stat.ino !== previous.ino ||
        fsSync.realpathSync(file) !== file
      ) {
        throw new Error("Immutable launcher upgrade directory identity changed.");
      }
    }
    const current = fsSync.lstatSync(params.launcher);
    if (
      !current.isFile() ||
      current.uid !== 0 ||
      current.nlink !== 1 ||
      (current.mode & 0o022) !== 0 ||
      current.dev !== params.previousStat.dev ||
      current.ino !== params.previousStat.ino ||
      fsSync.readFileSync(params.launcher, "utf8") !== params.previous ||
      packageActivationRuntimeIdentity(params.runtime) !== runtimeIdentity
    ) {
      throw new Error("Immutable launcher changed before its v1 upgrade.");
    }
  };
  assertUpgrade();
  const stage = fsSync.mkdtempSync(path.join(bin, ".launcher-upgrade-"));
  const stageIdentity = fsSync.lstatSync(stage);
  const backup = path.join(control, "openclaw-gateway.v1");
  const isExpectedBackup = (stat: Stats) =>
    stat.isFile() &&
    stat.uid === 0 &&
    stat.nlink === 1 &&
    (stat.mode & 0o222) === 0 &&
    fsSync.readFileSync(backup, "utf8") === params.previous;
  const writeDurable = (file: string, content: string, mode: number) => {
    const fd = fsSync.openSync(file, "wx", mode);
    try {
      fsSync.writeFileSync(fd, content);
      fsSync.fchmodSync(fd, mode);
      fsSync.fsyncSync(fd);
    } finally {
      fsSync.closeSync(fd);
    }
  };
  try {
    const previousBackup = fsSync.lstatSync(backup, { throwIfNoEntry: false });
    if (previousBackup) {
      if (!isExpectedBackup(previousBackup)) {
        throw new Error("Existing immutable v1 launcher backup differs; it was preserved.");
      }
    } else {
      const stagedBackup = path.join(stage, "previous");
      writeDurable(stagedBackup, params.previous, 0o444);
      assertUpgrade();
      if (fsSync.lstatSync(backup, { throwIfNoEntry: false })) {
        throw new Error("Immutable v1 launcher backup appeared during upgrade.");
      }
      fsSync.renameSync(stagedBackup, backup);
      requireDirectorySync(syncDirectorySync(control), "Immutable v1 launcher backup");
    }
    const candidate = path.join(stage, "next");
    writeDurable(candidate, params.content, 0o755);
    assertUpgrade();
    if (!isExpectedBackup(fsSync.lstatSync(backup))) {
      throw new Error("Immutable v1 launcher backup changed before publication.");
    }
    fsSync.renameSync(candidate, params.launcher);
    requireDirectorySync(syncDirectorySync(bin), "Immutable launcher upgrade");
    params.assertCurrent();
  } finally {
    const remaining = fsSync.lstatSync(stage, { throwIfNoEntry: false });
    if (remaining?.dev === stageIdentity.dev && remaining.ino === stageIdentity.ino) {
      fsSync.rmSync(stage, { recursive: true });
    }
  }
}

export async function installImmutableLauncher(params: {
  root: string;
  runtimePath: string;
  upgradeFromV1?: { assertCurrent: () => void };
}): Promise<string> {
  const root = await fs.realpath(params.root);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.uid !== 0 || (rootStat.mode & 0o022) !== 0) {
    throw new Error("Immutable launcher installation root is not root-owned and protected.");
  }
  const runtime = await fs.realpath(params.runtimePath);
  const runtimeStat = await fs.lstat(runtime);
  if (
    !runtimeStat.isFile() ||
    runtimeStat.uid !== 0 ||
    (runtimeStat.mode & 0o022) !== 0 ||
    (runtimeStat.mode & 0o111) === 0 ||
    isPathInside(root, runtime) ||
    /\s/u.test(runtime)
  ) {
    throw new Error(
      "Immutable launcher requires a root-owned external Node executable without whitespace in its path.",
    );
  }
  const packageRoot = await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url });
  if (!packageRoot) {
    throw new Error("Cannot locate the packaged immutable Gateway launcher.");
  }
  const source = await fs.readFile(
    path.join(packageRoot, "scripts", "openclaw-immutable-launcher.mjs"),
    "utf8",
  );
  const content = source.replace(/^#![^\n]*\n/u, `#!${runtime}\n`);
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { mode: 0o755 }).catch((error: unknown) => {
    if (!hasErrnoCode(error, "EEXIST")) {
      throw error;
    }
  });
  requireDirectorySync(await syncDirectory(root), "Immutable launcher installation root");
  const binStat = await fs.lstat(bin);
  if (!binStat.isDirectory() || binStat.uid !== 0 || (binStat.mode & 0o022) !== 0) {
    throw new Error("Immutable launcher directory is not root-owned and protected.");
  }
  const launcher = path.join(bin, "openclaw-gateway");
  const handle = await fs.open(launcher, "wx", 0o755).catch(async (error: unknown) => {
    if (!hasErrnoCode(error, "EEXIST")) {
      throw error;
    }
    const existing = await fs.lstat(launcher);
    if (!existing.isFile() || existing.uid !== 0 || (existing.mode & 0o022) !== 0) {
      throw new Error(
        "An existing immutable Gateway launcher conflicts with this adoption; it was preserved.",
      );
    }
    const previous = await fs.readFile(launcher, "utf8");
    if (previous !== content) {
      if (!params.upgradeFromV1) {
        throw new Error(
          "An existing immutable Gateway launcher conflicts with this adoption; it was preserved.",
        );
      }
      upgradeImmutableLauncher({
        root,
        launcher,
        runtime,
        content,
        previous,
        previousStat: existing,
        assertCurrent: params.upgradeFromV1.assertCurrent,
      });
    }
    return null;
  });
  if (!handle) {
    return launcher;
  }
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  requireDirectorySync(await syncDirectory(bin), "Immutable launcher directory");
  return launcher;
}
