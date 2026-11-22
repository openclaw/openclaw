import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { readRegularFile } from "../../infra/fs-safe.js";
import {
  gitReleaseForwardingEntry,
  GIT_RELEASE_LAUNCHER,
  resolveGitReleasePrefix,
} from "../../infra/git-release-paths.js";
import { restoreInterruptedNpmPackageRootLink } from "../../infra/package-update-npm-root.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { DEV_BRANCH, type UpdateChannel } from "../../infra/update-channels.js";
import {
  resolveDevUpdateTargetRevision,
  type DevUpdateTarget,
} from "../../infra/update-dev-target.js";
import {
  readGitUpdateFetchTarget,
  resolveGitUpdateTrackingRef,
} from "../../infra/update-git-metadata.js";
import type { CommandRunner as GlobalCommandRunner } from "../../infra/update-global-command-runner.js";
import {
  createGlobalInstallEnv,
  resolveGlobalInstallTarget,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
import {
  DEFAULT_UPDATE_STEP_TIMEOUT_MS,
  UPDATE_RUNNER_TIMEOUT_MS,
} from "../../infra/update-run-timeouts.js";
import { buildUpdateCommandRunner } from "../../infra/update-runner-command.js";
import { updateGitRelease } from "../../infra/update-runner-git-release.js";
import { readGitTargetSchemaVersions } from "../../infra/update-runner-git-schema.js";
import { readBranchName, selectChannelTag } from "../../infra/update-runner-git-target.js";
import type {
  CommandRunner as UpdateRunnerCommandRunner,
  UpdateRunnerOptions,
  UpdateRunResult,
  UpdateStepProgress,
} from "../../infra/update-runner-types.js";
import { createSystemPackageOwnershipInspection } from "../../infra/update-system-package-ownership.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { splitShellArgs } from "../../utils/shell-argv.js";
import { ensureGitCheckout, resolveGitInstallDir, resolveGlobalManager } from "./shared.js";
import { readPackageUpdateIdentity } from "./update-command-package-identity.js";
import { readOriginalUpdateRecovery } from "./update-command-recovery.js";

/**
 * The installer's `openclaw` wrapper for a checkout: retired after a switch to a package,
 * or pointed at the launcher beside `replacementRoot` (the release link) once a Git install runs
 * from releases. `previousRoot` is the checkout the installer wrote the wrapper for; a wrapper an
 * earlier Git update pointed at this installation's launcher is recognized too.
 */
export async function retireStandaloneGitWrapper(params: {
  previousRoot: string;
  replacementRoot?: string;
  platform?: NodeJS.Platform;
  searchDirs?: readonly string[];
  assertCurrent?: () => void;
}): Promise<{ error?: string }> {
  const platform = params.platform ?? process.platform;
  const wrapperName = platform === "win32" ? "openclaw.cmd" : "openclaw";
  const searchDirs = params.searchDirs ?? (process.env.PATH ?? "").split(path.delimiter);
  const pathApi = platform === "win32" ? path.win32 : path;
  const expectedEntries = [
    pathApi.join(params.previousRoot, "dist", "entry.js"),
    pathApi.join(resolveGitReleasePrefix(), GIT_RELEASE_LAUNCHER),
  ];
  const seen = new Set<string>();

  for (const directory of searchDirs) {
    if (!directory) {
      continue;
    }
    const wrapperPath = path.resolve(directory, wrapperName);
    if (seen.has(wrapperPath)) {
      continue;
    }
    seen.add(wrapperPath);

    let stat;
    try {
      stat = await fs.lstat(wrapperPath, { bigint: true });
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) {
        continue;
      }
      return { error: `Could not inspect ${wrapperPath}: ${String(error)}` };
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4096n ||
      (platform !== "win32" && (stat.mode & 0o111n) === 0n)
    ) {
      continue;
    }

    let contents: string;
    try {
      contents = await fs.readFile(wrapperPath, "utf8");
    } catch (error) {
      return { error: `Could not inspect ${wrapperPath}: ${String(error)}` };
    }
    const lines = contents.trimEnd().split(/\r?\n/u);
    // The installer's two-line wrapper, or the one an earlier update wrote (see below). install.ps1
    // wrote `dist\\entry.js` (a literal double backslash) before this fix; Windows resolves that and
    // differently-cased spellings to the same file.
    const windowsEntry =
      platform === "win32" &&
      ((lines.length === 2 && lines[0] === "@echo off") ||
        (lines.length === 5 &&
          lines[0] === "@goto run" &&
          /^@rem x*$/u.test(lines[1] ?? "") &&
          lines[2] === WINDOWS_WRAPPER_EXIT &&
          lines[3] === ":run"))
        ? /^@?node "(?<entry>[^"]+)" %\*$/u.exec(lines.at(-1) ?? "")?.groups?.entry
        : undefined;
    const sameWindowsPath = (left: string, right: string) =>
      path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
    const matchesWindows =
      windowsEntry !== undefined &&
      expectedEntries.some((entry) => sameWindowsPath(windowsEntry, entry));
    const execArgs =
      platform === "win32" || lines.length !== 3 ? null : splitShellArgs(lines[2] ?? "");
    const matchesPosix =
      platform !== "win32" &&
      lines[0] === "#!/usr/bin/env bash" &&
      lines[1] === "set -euo pipefail" &&
      execArgs?.length === 4 &&
      execArgs[0] === "exec" &&
      expectedEntries.includes(execArgs[2] ?? "") &&
      execArgs[3] === "$@";
    if (!matchesWindows && !matchesPosix) {
      continue;
    }
    await createSystemPackageOwnershipInspection(UPDATE_RUNNER_TIMEOUT_MS).assertEntryUnowned(
      wrapperPath,
    );
    try {
      // Filesystem and pkg reads can outlive this wrapper or the update's authority.
      const currentFile = await readRegularFile({ filePath: wrapperPath, maxBytes: 4096 });
      const current = await fs.lstat(wrapperPath, { bigint: true });
      if (
        !current.isFile() ||
        !sameFileIdentity(stat, currentFile.exactIdentity) ||
        !sameFileIdentity(currentFile.exactIdentity, current) ||
        currentFile.buffer.toString("utf8") !== contents
      ) {
        throw new Error("The installer wrapper changed before retirement.");
      }
    } catch (error) {
      return { error: `Could not retire ${wrapperPath}: ${String(error)}` };
    }
    // Ownership refusals must remain errors, never optional filesystem warnings.
    params.assertCurrent?.();
    try {
      if (params.replacementRoot) {
        // The installer's formats, which its wrapper checks (`install.sh`, `install.ps1`) also
        // recognize with the launcher entry. The launcher selects a pending release and counts a
        // foreground Gateway start.
        const entry = pathApi.join(pathApi.dirname(params.replacementRoot), GIT_RELEASE_LAUNCHER);
        if (
          windowsEntry !== undefined
            ? lines.length === 5 && sameWindowsPath(windowsEntry, entry)
            : execArgs?.[2] === entry
        ) {
          // Already this release's launcher; rewriting would only grow the padding below.
          continue;
        }
        // cmd.exe rereads a running batch file at its saved byte offset, and `openclaw update` usually
        // runs through this wrapper: once it returns, cmd resumes in the new file at the old file's
        // length. The padded comment ends exactly there, so cmd runs the exit line (keeping the
        // update's exit code) instead of the middle of the new command.
        const head = "@goto run\r\n@rem ";
        const pad = "x".repeat(Math.max(0, Buffer.byteLength(contents) - head.length - 2));
        const next =
          platform === "win32"
            ? `${head}${pad}\r\n${WINDOWS_WRAPPER_EXIT}\r\n:run\r\n@node "${entry}" %*\r\n`
            : `${lines[0]}\n${lines[1]}\nexec ${shellQuote(execArgs![1]!)} ${shellQuote(entry)} "$@"\n`;
        const temporary = `${wrapperPath}.${process.pid}.tmp`;
        await fs.writeFile(temporary, next, { mode: 0o755 });
        await fs.rename(temporary, wrapperPath);
      } else {
        await fs.unlink(wrapperPath);
      }
    } catch (error) {
      return {
        error: `Could not ${params.replacementRoot ? "update" : "retire"} ${wrapperPath}: ${String(error)}`,
      };
    }
  }
  return {};
}

const WINDOWS_WRAPPER_EXIT = "@exit /b %errorlevel%";

/** Bash `printf %q` style quoting, as the installer writes the wrapper. */
const shellQuote = (value: string) => value.replace(/[^\w@%+=:,./-]/gu, "\\$&");

type GitInspectionParams = {
  runCommand: GlobalCommandRunner;
  root: string;
  timeoutMs: number;
};

async function runReadOnlyGitCommand(params: GitInspectionParams & { args: string[] }) {
  return params
    .runCommand(["git", "-C", params.root, ...params.args], {
      cwd: params.root,
      timeoutMs: params.timeoutMs,
    })
    .catch(() => null);
}

type RemoteRevisionResolution =
  | { status: "ok"; revision: string }
  | { status: "missing" }
  | { status: "unreadable"; reason: string; failureCode?: "target-git-cache-stale" };

async function resolveCurrentRemoteBranchRevision(
  params: GitInspectionParams & { useDevDefault: boolean },
): Promise<RemoteRevisionResolution> {
  const readGit = async (...args: string[]) => {
    const result = await runReadOnlyGitCommand({ ...params, args });
    return result?.code === 0 ? result.stdout.trim() || null : null;
  };
  const source = await readGitUpdateFetchTarget(readGit, DEV_BRANCH, params.useDevDefault);
  if (!source) {
    return { status: "missing" };
  }
  const trackingRef = await resolveGitUpdateTrackingRef(readGit, DEV_BRANCH, source);
  const localRevision = trackingRef ? await readGit("rev-parse", trackingRef) : null;
  if (source.remote === ".") {
    return localRevision ? { status: "ok", revision: localRevision } : { status: "missing" };
  }
  const remoteLabel = `${source.remote}/${source.mergeRef.replace(/^refs\/heads\//u, "")}`;
  const remoteResult = await readGit("ls-remote", "--exit-code", source.remote, source.mergeRef);
  const remoteRevision = remoteResult
    ? readExactRemoteRevision(remoteResult, source.mergeRef)
    : null;
  if (!remoteRevision) {
    return {
      status: "unreadable",
      reason: `could not inspect current remote target ${remoteLabel}`,
    };
  }
  return localRevision === remoteRevision
    ? { status: "ok", revision: remoteRevision }
    : {
        status: "unreadable",
        reason: `cached ${trackingRef?.replace(/^refs\/remotes\//u, "") ?? "Git target"} differs from current remote ${remoteLabel}`,
        failureCode: "target-git-cache-stale",
      };
}

function readExactRemoteRevision(stdout: string, ref: string): string | null {
  const matches = stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter((parts) => parts.length === 2 && parts[1] === ref)
    .map((parts) => parts[0] ?? "")
    .filter((sha) => /^[0-9a-f]{40,64}$/iu.test(sha));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function readRemoteTagRevisions(stdout: string): Map<string, string> | null {
  const direct = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const [sha = "", ref = "", extra] = line.trim().split(/\s+/u);
    if (extra || !/^[0-9a-f]{40,64}$/iu.test(sha)) {
      if (line.trim()) {
        return null;
      }
      continue;
    }
    const match = /^refs\/tags\/(v.+?)(\^\{\})?$/u.exec(ref);
    if (!match) {
      return null;
    }
    (match[2] ? peeled : direct).set(match[1]!, sha);
  }
  return new Map([...direct, ...peeled]);
}

async function resolveCurrentRemoteTagRevision(
  params: GitInspectionParams & { channel: Exclude<UpdateChannel, "dev" | "extended-stable"> },
): Promise<{ revision?: string; metadataUnreadable?: string }> {
  const remoteList = await runReadOnlyGitCommand({ ...params, args: ["remote"] });
  if (remoteList?.code !== 0) {
    return { metadataUnreadable: "could not inspect configured Git remotes" };
  }
  const remotes = remoteList.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (remotes.length === 0) {
    return { metadataUnreadable: "could not resolve a remote for the selected Git release" };
  }
  const tagRevisions = new Map<string, string>();
  for (const remote of remotes) {
    const result = await runReadOnlyGitCommand({
      ...params,
      args: ["ls-remote", "--tags", remote, "refs/tags/v*"],
    });
    const remoteTags = result?.code === 0 ? readRemoteTagRevisions(result.stdout) : null;
    if (!remoteTags) {
      return { metadataUnreadable: `could not inspect current release tags from ${remote}` };
    }
    for (const [tag, revision] of remoteTags) {
      const existing = tagRevisions.get(tag);
      if (existing && existing !== revision) {
        return { metadataUnreadable: `release tag ${tag} resolves differently across remotes` };
      }
      tagRevisions.set(tag, revision);
    }
  }
  const tag = selectChannelTag([...tagRevisions.keys()], params.channel);
  return tag
    ? { revision: tagRevisions.get(tag) }
    : { metadataUnreadable: "could not resolve the selected Git release tag" };
}

export async function inspectGitDryRunTargetSchemaVersions(params: {
  root: string;
  timeoutMs: number;
  channel: UpdateChannel;
  devTarget?: DevUpdateTarget;
}): Promise<{
  schemaVersions?: OpenClawSchemaVersions;
  nodeEngine?: string | null;
  metadataUnreadable?: string;
  failureCode?: "target-git-cache-stale";
}> {
  const { runCommand: runUpdateCommand } = await buildUpdateCommandRunner();
  const runCommand: UpdateRunnerCommandRunner = (argv, options) =>
    runUpdateCommand(argv, {
      ...options,
      env: { ...options.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
    });
  let revision: string | null = null;
  if (params.channel === "extended-stable") {
    return { metadataUnreadable: "extended-stable is unavailable for Git updates" };
  }
  if (params.channel !== "dev") {
    const resolved = await resolveCurrentRemoteTagRevision({
      runCommand,
      root: params.root,
      timeoutMs: params.timeoutMs,
      channel: params.channel,
    });
    if (resolved.metadataUnreadable) {
      return { metadataUnreadable: resolved.metadataUnreadable };
    }
    revision = resolved.revision ?? null;
  } else if (params.devTarget) {
    const selected = resolveDevUpdateTargetRevision(params.devTarget);
    if (!/^[0-9a-f]{40,64}$/iu.test(selected)) {
      return { metadataUnreadable: "the explicit symbolic Git target requires a fetch to verify" };
    }
    revision = selected;
  } else {
    const branch = await readBranchName(runCommand, params.root, params.timeoutMs);
    const resolved = await resolveCurrentRemoteBranchRevision({
      runCommand,
      root: params.root,
      timeoutMs: params.timeoutMs,
      useDevDefault: branch !== DEV_BRANCH,
    });
    if (resolved.status === "ok") {
      revision = resolved.revision;
    } else if (resolved.status === "unreadable") {
      return { metadataUnreadable: resolved.reason, failureCode: resolved.failureCode };
    }
  }
  if (!revision) {
    return { metadataUnreadable: "could not resolve the selected Git target" };
  }
  const target = await readGitTargetSchemaVersions({
    runCommand,
    root: params.root,
    revision,
    timeoutMs: params.timeoutMs,
  });
  return target.status === "ok"
    ? { schemaVersions: target.schemaVersions, nodeEngine: target.nodeEngine }
    : {
        metadataUnreadable: target.reason,
        ...(target.reason.startsWith("git show ")
          ? { failureCode: "target-git-cache-stale" as const }
          : {}),
      };
}

export async function updateGitInstall(params: {
  root: string;
  switchToGit: boolean;
  deferReleaseActivation?: boolean;
  installKind: "git" | "package" | "unknown";
  timeoutMs: number | undefined;
  startedAt: number;
  progress: UpdateStepProgress;
  channel: UpdateChannel;
  devTarget?: DevUpdateTarget;
  beforeGitMutation: UpdateRunnerOptions["beforeGitMutation"];
  validateCandidate: UpdateRunnerOptions["validateCandidate"];
  assertCurrent?: () => void;
  nodeRunner?: string;
  inspectGitTarget: (
    target: Parameters<UpdateRunnerOptions["inspectGitTarget"]>[0],
    installTarget?: ResolvedGlobalInstallTarget,
  ) => Promise<void>;
}): Promise<UpdateRunResult> {
  const assertCurrent = params.assertCurrent;
  const updateRoot = params.switchToGit ? resolveGitInstallDir() : params.root;
  const effectiveTimeout = params.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;
  const pkgOwnership = createSystemPackageOwnershipInspection(effectiveTimeout);
  await pkgOwnership.assertUnowned(updateRoot);
  const installTarget = params.switchToGit
    ? await resolveGlobalInstallTarget({
        manager: await resolveGlobalManager({
          root: params.root,
          installKind: params.installKind,
          timeoutMs: effectiveTimeout,
          pkgOwnership,
        }),
        runCommand: runCommandWithTimeout,
        timeoutMs: effectiveTimeout,
        pkgRoot: params.root,
        pkgOwnership,
      })
    : null;
  const previousPackage = installTarget
    ? await readPackageUpdateIdentity(installTarget.packageRoot ?? params.root)
    : undefined;
  // A package-to-Git switch clones the checkout; its first release is a fresh worktree of it.
  const checkout = params.switchToGit
    ? await ensureGitCheckout({
        dir: updateRoot,
        assertCurrent,
        env: await createGlobalInstallEnv(undefined, installTarget ?? {}),
        timeoutMs: effectiveTimeout,
        progress: params.progress,
      })
    : null;
  const cloneSteps = checkout?.step ? [checkout.step] : [];
  if (checkout?.step && checkout.step.exitCode !== 0) {
    return {
      status: "error",
      mode: "git",
      root: params.root,
      reason: "git-clone-failed",
      recovery: await readOriginalUpdateRecovery(params, effectiveTimeout),
      steps: cloneSteps,
      durationMs: Date.now() - params.startedAt,
    };
  }
  const gitRoot = checkout?.checkoutDir ?? updateRoot;
  const result = await updateGitRelease({
    ...(await buildUpdateCommandRunner(undefined, assertCurrent)),
    gitRoot,
    previousPackageRoot: installTarget ? (installTarget.packageRoot ?? params.root) : undefined,
    timeoutMs: params.timeoutMs ?? UPDATE_RUNNER_TIMEOUT_MS,
    startedAt: params.startedAt,
    opts: {
      deferReleaseActivation: params.deferReleaseActivation,
      releaseNode: params.nodeRunner,
      timeoutMs: params.timeoutMs,
      progress: params.progress,
      channel: params.channel,
      devTarget: params.devTarget,
      beforeGitMutation: async (target) => {
        await params.beforeGitMutation(target);
        await createSystemPackageOwnershipInspection(effectiveTimeout).assertUnowned(gitRoot);
        assertCurrent?.();
      },
      inspectGitTarget: (target) => params.inspectGitTarget(target, installTarget ?? undefined),
      validateCandidate: params.validateCandidate,
    },
  });
  const steps = [...cloneSteps, ...result.steps];
  if (result.status === "ok" && result.root) {
    // `openclaw` on PATH resolves through the npm package path or the installer's wrapper, both
    // written for the checkout; they now run the release. A release-driven update (the Control
    // UI, or `openclaw` started from a release or the old lib/node_modules link) has a root under
    // the release prefix, so the checkout comes from the release's Git common directory: the main
    // repository, so PATH entries written for a linked-worktree checkout are matched only from
    // that checkout.
    // Real paths: a state directory reached through a symlink (macOS /tmp) still matches.
    const realOf = (entry: string) => fs.realpath(entry).catch(() => path.resolve(entry));
    const releaseDriven = !path
      .relative(await realOf(resolveGitReleasePrefix()), await realOf(gitRoot))
      .startsWith("..");
    const checkoutRoot = releaseDriven
      ? await resolveGitReleaseCheckout(result.root, gitRoot, effectiveTimeout)
      : gitRoot;
    const releaseRoot = result.root;
    const packageRoots = installTarget?.packageRoot
      ? [installTarget.packageRoot]
      : await findGlobalPackagesLinkedTo(checkoutRoot, effectiveTimeout);
    const warnings = [
      ...(await Promise.all(
        packageRoots.map((packageRoot) =>
          exposeGlobalPackageThroughRelease(packageRoot, releaseRoot, checkoutRoot),
        ),
      )),
      (
        await retireStandaloneGitWrapper({
          previousRoot: checkoutRoot,
          replacementRoot: result.root,
          assertCurrent,
        })
      ).error,
    ].filter((warning): warning is string => Boolean(warning));
    for (const warning of warnings) {
      defaultRuntime.error(`Warning: ${warning}`);
      steps.push({
        name: "git-release-cli",
        command: "point `openclaw` on PATH at the release launcher",
        cwd: checkoutRoot,
        durationMs: 0,
        exitCode: 0,
        advisory: { kind: "recoverable-maintenance", message: warning },
      });
    }
  }
  return {
    ...result,
    before: previousPackage ?? result.before,
    steps,
    durationMs: Date.now() - params.startedAt,
  };
}

/** The checkout a release is a worktree of. */
export async function resolveGitReleaseCheckout(
  release: string,
  fallback: string,
  timeoutMs: number,
) {
  const res = await runCommandWithTimeout(
    ["git", "-C", release, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { timeoutMs },
  ).catch(() => null);
  const commonDir = res?.code === 0 ? res.stdout.trim() : "";
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : fallback;
}

/** Global packages (npm, pnpm or Bun) linked to this checkout, by a user or an earlier switch. */
async function findGlobalPackagesLinkedTo(checkout: string, timeoutMs: number) {
  // A checkout is linked globally with `npm link`, `pnpm add -g openclaw@link:` or `bun link`;
  // whichever bin directory is first on PATH must run the release, so every link moves.
  const linked = new Set<string>();
  for (const manager of ["npm", "pnpm", "bun"] as const) {
    const target = await resolveGlobalInstallTarget({
      manager,
      runCommand: runCommandWithTimeout,
      timeoutMs,
    }).catch(() => null);
    const packageRoot = target?.packageRoot;
    if (!packageRoot) {
      continue;
    }
    // A swap killed between its two renames left the link under its backup name.
    if (!(await fs.lstat(packageRoot).catch(() => null))) {
      await restoreInterruptedNpmPackageRootLink(
        path.dirname(packageRoot),
        packageRoot,
        checkout,
        false,
      ).catch(() => undefined);
    }
    if (await isLinkTo(packageRoot, checkout)) {
      linked.add(packageRoot);
    }
  }
  return [...linked];
}

async function isLinkTo(link: string, dir: string): Promise<boolean> {
  if (!(await fs.lstat(link).catch(() => null))?.isSymbolicLink()) {
    return false;
  }
  const [linked, real] = await Promise.all(
    [link, dir].map((entry) => fs.realpath(entry).catch(() => null)),
  );
  return linked !== null && linked === real;
}

/**
 * Point the global npm package's `openclaw.mjs`, which its bin shims run, at the release launcher,
 * so `openclaw` on PATH runs the release the launcher selects (a `--no-restart` target is pending
 * until the next Gateway start) and a foreground Gateway start counts toward the trial. The rest
 * of the package stays: this updater and a running Gateway still load from it, and an old service
 * definition may still name its `dist/index.js`. Its disk space stays used until a switch back to
 * npm replaces it (destination ownership recognizes this exact entry).
 *
 * An updater before #200578 switched to Git by linking the global package to the checkout, which
 * it then rebuilt in place. Releases never rebuild the checkout, so that link is replaced by a
 * directory holding only the entries (writing through it would edit the checkout). Its
 * `dist/index.js` also starts the launcher, for a service definition that names the package path
 * and is not refreshed (`--no-restart`). Other links (a pnpm store path) are written through, as
 * before. The link moves to the backup name npm package updates use, so a process killed before
 * the stage takes its place leaves it where the next Git update puts it back and retries.
 */
export async function exposeGlobalPackageThroughRelease(
  packageRoot: string,
  slot: string,
  checkout: string,
): Promise<string | undefined> {
  const launcher = path.join(path.dirname(slot), GIT_RELEASE_LAUNCHER);
  const contents = gitReleaseForwardingEntry(launcher);
  const linked = await isLinkTo(packageRoot, checkout);
  const stage = `${packageRoot}.release-${process.pid}`;
  const backup = path.join(
    path.dirname(packageRoot),
    `.openclaw.package-backup-${process.pid}-${Date.now()}`,
  );
  let moved = false;
  try {
    if (linked) {
      await fs.mkdir(path.join(stage, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(stage, "package.json"),
        `${JSON.stringify({ name: "openclaw", private: true, type: "module", bin: { openclaw: "openclaw.mjs" } })}\n`,
      );
      await fs.writeFile(path.join(stage, "dist", "index.js"), contents);
      await fs.writeFile(path.join(stage, "openclaw.mjs"), contents, { mode: 0o755 });
      await fs.rename(packageRoot, backup);
      moved = true;
      await fs.rename(stage, packageRoot);
      moved = false;
      await fs.unlink(backup).catch(() => {});
    } else {
      await fs.writeFile(stage, contents, { mode: 0o755 });
      await fs.rename(stage, path.join(packageRoot, "openclaw.mjs"));
    }
    return undefined;
  } catch (error) {
    if (moved) {
      await fs.rename(backup, packageRoot).catch(() => {});
    }
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    return `${packageRoot} could not start ${launcher} (${String(error)}); \`openclaw\` on PATH still starts the previous build.`;
  }
}
