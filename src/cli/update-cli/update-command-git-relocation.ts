import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { hasNodeErrorCode, isPathInside } from "../../infra/path-guards.js";
import {
  matchesNpmGitCmdShim,
  matchesStandaloneGitWrapper,
} from "../../infra/update-git-launcher.js";
import {
  verifyGitUpdateRecovery,
  type GitRuntimeIdentity,
} from "../../infra/update-git-runtime.js";
import {
  resolveGlobalInstallTarget,
  resolveNpmGlobalPrefixLayoutFromPrefix,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
import { gitCleanCheckArgs } from "../../infra/update-runner-git-commands.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveGitInstallDir, UpdatePreMutationError } from "./shared.js";

export type GitUpdateRelocation = {
  directory: string;
  installTarget: ResolvedGlobalInstallTarget;
  previousGitCheckout: GitRuntimeIdentity;
  assertCurrent: (options?: { requireFreshDestination?: boolean }) => Promise<void>;
};

const refuse = (message: string): never => {
  throw new UpdatePreMutationError(
    "dirty",
    `Update could not move the dev installation: ${message} The original checkout was not changed.`,
  );
};

function ignoreMissingPath(error: unknown): undefined {
  if (!hasNodeErrorCode(error, "ENOENT")) {
    throw error;
  }
  return undefined;
}

/** A dirty source tree can move only through the launcher that already owns this installation. */
export async function prepareDirtyGitUpdateRelocation(params: {
  root: string;
  timeoutMs: number;
}): Promise<GitUpdateRelocation | undefined> {
  const status = await runCommandWithTimeout(gitCleanCheckArgs(params.root), {
    cwd: params.root,
    timeoutMs: params.timeoutMs,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (status.code !== 0) {
    throw new UpdatePreMutationError(
      "clean-check-failed",
      "Update could not inspect the Git checkout. Run git status in the installation directory and resolve the reported error.",
    );
  }
  if (!status.stdout.trim()) {
    return undefined;
  }
  const root = await fs.realpath(params.root);
  const wrapperName = process.platform === "win32" ? "openclaw.cmd" : "openclaw";
  let launcher: string | undefined;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, wrapperName);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0)) {
        launcher = candidate;
        break;
      }
    } catch (error) {
      if (!hasNodeErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  if (!launcher) {
    return refuse(
      "the active CLI launcher could not be found. Use the installer-managed openclaw command, or run openclaw triage for repair help.",
    );
  }
  const launcherPath = launcher;
  const launcherStat = await fs.lstat(launcherPath);
  const standalone =
    launcherStat.isFile() && launcherStat.size <= 4096
      ? await fs.readFile(launcherPath, "utf8")
      : undefined;
  const generated =
    standalone !== undefined &&
    (await matchesStandaloneGitWrapper(standalone, root, process.platform, process.execPath));
  const launcherReal = await fs.realpath(launcherPath);
  const npmShim =
    standalone !== undefined &&
    (await matchesNpmGitCmdShim(standalone, launcherPath, root, process.execPath));
  const npmSymlink =
    process.platform !== "win32" &&
    launcherStat.isSymbolicLink() &&
    launcherReal === path.join(root, "openclaw.mjs");
  if (!generated && !npmShim && !npmSymlink) {
    return refuse(
      "the first openclaw command on PATH is a custom or unrelated launcher. Use this installation's managed launcher, or run openclaw triage for repair help.",
    );
  }
  const bin = path.dirname(launcherPath);
  if (process.platform !== "win32" && path.basename(bin) !== "bin") {
    return refuse(
      "the active launcher has no supported global prefix. Run openclaw triage for repair help.",
    );
  }
  const prefix = process.platform === "win32" ? bin : path.dirname(bin);
  const layout = resolveNpmGlobalPrefixLayoutFromPrefix(prefix);
  const npm = await resolveGlobalInstallTarget({
    manager: "npm",
    runCommand: runCommandWithTimeout,
    timeoutMs: params.timeoutMs,
  });
  // The active launcher owns this prefix; npm's current default may belong to another installation.
  const packageRoot = path.join(layout.globalRoot, "openclaw");
  const installTarget: ResolvedGlobalInstallTarget = {
    ...npm,
    globalRoot: layout.globalRoot,
    packageRoot,
  };
  const packageOwner = await fs.realpath(packageRoot).catch(ignoreMissingPath);
  const packageEntry = await fs.lstat(packageRoot).catch(ignoreMissingPath);
  if (packageEntry && !packageOwner) {
    return refuse(
      "the launcher package target is a broken link. Run openclaw triage for repair help.",
    );
  }
  if (packageOwner === root && !packageEntry?.isSymbolicLink()) {
    return refuse(
      "the launcher package target is the original checkout itself. Run openclaw triage for repair help.",
    );
  }
  if (packageOwner && packageOwner !== root) {
    return refuse(
      "the launcher prefix contains another OpenClaw installation. Choose the intended managed launcher before retrying.",
    );
  }
  if (!generated && packageOwner !== root) {
    return refuse(
      "the active launcher's npm package link does not own this checkout. Use this installation's managed launcher, or run openclaw triage for repair help.",
    );
  }
  const requestedDirectory = resolveGitInstallDir();
  const override = Boolean(process.env.OPENCLAW_GIT_DIR?.trim());
  let directory = resolvePathViaExistingAncestorSync(requestedDirectory);
  const entries = await fs.readdir(directory).catch(ignoreMissingPath);
  if (
    !override &&
    (entries !== undefined || isPathInside(root, directory) || isPathInside(directory, root))
  ) {
    directory = resolvePathViaExistingAncestorSync(`${requestedDirectory}-update-${randomUUID()}`);
  } else if (entries?.length || isPathInside(root, directory) || isPathInside(directory, root)) {
    return refuse("OPENCLAW_GIT_DIR must name an empty directory outside the original checkout.");
  }
  if (isPathInside(packageRoot, directory) || isPathInside(directory, packageRoot)) {
    return refuse(
      "OPENCLAW_GIT_DIR overlaps the CLI package target. Choose an empty directory outside the launcher prefix.",
    );
  }
  const directoryEntry = await fs.lstat(directory).catch(ignoreMissingPath);
  const head = await runCommandWithTimeout(["git", "-C", root, "rev-parse", "HEAD"], {
    cwd: root,
    timeoutMs: params.timeoutMs,
  });
  const identity = { root, sha: head.code === 0 ? head.stdout.trim() : null };
  const previous = await verifyGitUpdateRecovery(identity);
  if (!previous.serviceRestartSafe || !previous.buildId) {
    return refuse(
      "the existing built runtime cannot be verified for rollback. Run openclaw triage for repair help.",
    );
  }
  const previousGitCheckout = { ...identity, buildId: previous.buildId };
  const assertCurrent: GitUpdateRelocation["assertCurrent"] = async (options) => {
    if (options?.requireFreshDestination) {
      const currentDirectoryEntry = await fs.lstat(directory).catch(ignoreMissingPath);
      if (
        currentDirectoryEntry?.dev !== directoryEntry?.dev ||
        currentDirectoryEntry?.ino !== directoryEntry?.ino ||
        (currentDirectoryEntry && (await fs.readdir(directory)).length !== 0)
      ) {
        refuse(
          "the fresh destination changed during preparation; choose an empty directory and retry.",
        );
      }
    }
    if (!(await verifyGitUpdateRecovery(previousGitCheckout)).serviceRestartSafe) {
      refuse("the previous built runtime changed during preparation; retry the update.");
    }
    const currentLauncher = await fs.lstat(launcherPath);
    if (
      currentLauncher.dev !== launcherStat.dev ||
      currentLauncher.ino !== launcherStat.ino ||
      (await fs.realpath(launcherPath)) !== launcherReal ||
      (generated &&
        ((await fs.readFile(launcherPath, "utf8")) !== standalone ||
          !(await matchesStandaloneGitWrapper(
            standalone ?? "",
            root,
            process.platform,
            process.execPath,
          )))) ||
      (npmShim &&
        ((await fs.readFile(launcherPath, "utf8")) !== standalone ||
          !(await matchesNpmGitCmdShim(standalone ?? "", launcherPath, root, process.execPath))))
    ) {
      refuse("the active launcher changed during preparation; retry the update.");
    }
    const currentOwner = await fs.realpath(packageRoot).catch(ignoreMissingPath);
    const currentEntry = await fs.lstat(packageRoot).catch(ignoreMissingPath);
    if (
      currentEntry?.dev !== packageEntry?.dev ||
      currentEntry?.ino !== packageEntry?.ino ||
      currentOwner !== packageOwner ||
      (await fs.realpath(root)) !== root ||
      resolvePathViaExistingAncestorSync(directory) !== directory
    ) {
      refuse("an installation path changed during preparation; retry the update.");
    }
  };
  await assertCurrent({ requireFreshDestination: true });
  return { directory, installTarget, previousGitCheckout, assertCurrent };
}
