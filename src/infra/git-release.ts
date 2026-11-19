import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigPath } from "../config/paths.js";
import { sleep } from "../utils/sleep.js";
import { syncDirectoryIfSupported } from "./directory-durability.js";
import { ignoreMissingPath } from "./errno.js";
import { readGatewayOwnerLease } from "./gateway-owner-lease.js";
import { writeGitReleaseLauncher, type GitReleaseTrial } from "./git-release-launcher.js";
import { GIT_RELEASE_TRIAL, gitReleaseSlot } from "./git-release-paths.js";
import { readPackageVersion } from "./package-json.js";
import { packageReleaseLeaseDir, readPackageReleaseLeases } from "./package-release-lease.js";
import { collectPackageReleases } from "./package-release-retention.js";
import {
  PACKAGE_RELEASES_DIR,
  packageReleaseGlobalRoot,
  readPackageReleaseSlotSync,
  type PackageReleaseSlot,
} from "./package-release-slot-path.js";
import {
  capturePackageReleaseSlot,
  createPackageReleasePrefix,
  packageReleaseLinkTarget,
  sweepPackageReleaseTemporaryLinks,
  switchPackageReleaseLink,
} from "./package-release-slot.js";
import { readBuiltGatewayBuildId, verifyGitUpdateRecovery } from "./update-git-runtime.js";

/**
 * A new release directory. The worktree is built at `buildDir`, outside
 * `node_modules` (Node refuses to strip types there), then moved to `releaseRoot`.
 */
export async function createGitReleaseDirs(prefix: string) {
  const releasePrefix = await createPackageReleasePrefix(prefix, "git");
  const globalRoot = packageReleaseGlobalRoot(releasePrefix);
  await fs.mkdir(globalRoot, { recursive: true });
  return {
    releasePrefix,
    buildDir: path.join(releasePrefix, "build"),
    releaseRoot: path.join(globalRoot, "openclaw"),
  };
}

const gitReleaseTrialFile = (prefix: string) =>
  path.join(prefix, PACKAGE_RELEASES_DIR, GIT_RELEASE_TRIAL);

/** The ID of the release holding `releaseRoot` (`releases/<id>/lib/node_modules/openclaw`). */
export const gitReleaseId = (releaseRoot: string) =>
  path.basename(path.resolve(releaseRoot, "../../.."));

/**
 * Select `releaseRoot` with one rename. With `trial`, the launcher switches back
 * after two failed starts and the Gateway clears the record once it is ready.
 *
 * The link text is computed between real paths, because the filesystem resolves it from
 * the link's real directory (a state directory under macOS `/tmp` is really under
 * `/private/tmp`), and it must resolve to `releaseRoot` before the old link is replaced.
 * Arming a trial for the release the link already names changes nothing: its trial, if
 * any, keeps its own fallback, and a trial never falls back to its own target.
 */
export async function publishGitRelease(params: {
  prefix: string;
  releaseRoot: string;
  trial: boolean;
  /** Leave the link to the next service start, which selects the release on trial. */
  pending?: boolean;
  assertCurrent?: () => void;
}): Promise<{ previous: string | null; target: string }> {
  const slot = gitReleaseSlot(params.prefix);
  const globalRoot = path.dirname(slot);
  await fs.mkdir(globalRoot, { recursive: true });
  const realGlobalRoot = await fs.realpath(globalRoot);
  const releaseRoot = await fs.realpath(params.releaseRoot);
  const target = packageReleaseLinkTarget(path.join(realGlobalRoot, "openclaw"), releaseRoot);
  const resolved = await fs.realpath(path.resolve(realGlobalRoot, target)).catch(() => null);
  if (resolved !== releaseRoot) {
    throw new Error(
      `The release link text ${target} does not resolve to ${releaseRoot}; the installation was left unchanged.`,
    );
  }
  const trialFile = gitReleaseTrialFile(params.prefix);
  await writeGitReleaseLauncher(params.prefix);
  const existing = await fs.lstat(slot).catch(ignoreMissingPath);
  let previous: string | null = null;
  if (existing) {
    const capture = await capturePackageReleaseSlot(slot);
    if (capture.kind !== "link") {
      throw new Error(`${slot} is not a release link; the installation was left unchanged.`);
    }
    const selected = await fs
      .realpath(path.resolve(realGlobalRoot, capture.target))
      .catch(() => null);
    if (params.trial && selected === releaseRoot) {
      return { previous: null, target };
    }
    previous = capture.target;
    // A stale trial must not switch the next release back.
    await fs.rm(trialFile, { force: true });
    if (!params.pending) {
      await switchPackageReleaseLink({
        slot,
        expected: { identity: capture.identity, target: capture.target },
        target,
        assertCurrent: () => params.assertCurrent?.(),
      });
    }
  } else {
    await sweepPackageReleaseTemporaryLinks(globalRoot);
    const temporary = path.join(globalRoot, `.openclaw.release-link-${process.pid}-${Date.now()}`);
    await fs.symlink(target, temporary);
    params.assertCurrent?.();
    await fs.rename(temporary, slot);
    await syncDirectoryIfSupported(globalRoot);
  }
  if (params.trial && previous) {
    const buildId = await readBuiltGatewayBuildId(releaseRoot);
    const record: GitReleaseTrial = {
      target,
      previous,
      version: (await readPackageVersion(releaseRoot)) ?? "unknown",
      ...(buildId ? { buildId } : {}),
      // The update admits only a service whose config selection matches this process.
      config: resolveConfigPath(process.env),
      ...(params.pending ? { pending: true } : {}),
      createdAt: Date.now(),
      attempts: 0,
    };
    const temporary = `${trialFile}.${process.pid}`;
    await fs.writeFile(temporary, JSON.stringify(record));
    await fs.rename(temporary, trialFile);
  }
  return { previous, target };
}

async function readGitReleaseTrial(prefix: string): Promise<GitReleaseTrial | null> {
  const raw = await fs.readFile(gitReleaseTrialFile(prefix), "utf8").catch(ignoreMissingPath);
  // SAFETY: publishGitRelease and the launcher are the only writers of the trial record.
  return raw ? (JSON.parse(raw) as GitReleaseTrial) : null;
}

/** A ready Gateway ends the trial of the release it runs. */
export async function settleGitReleaseTrial(runningRoot: string | null): Promise<void> {
  const slot = runningRoot ? readPackageReleaseSlotSync(runningRoot) : null;
  if (!slot) {
    return;
  }
  const trial = await readGitReleaseTrial(slot.prefix);
  if (trial?.target === slot.target) {
    await fs.rm(gitReleaseTrialFile(slot.prefix), { force: true });
  }
}

export type GitReleasePlacement = {
  /** What serves: the link's release, unless it is a never-started placed release. */
  serving: string;
  /** The release that last served and passed its trial: the next trial's fallback. */
  fallback: string;
  /**
   * A release an earlier update placed that never started: the launcher counted no start
   * and no process holds it. A started trial stays under the launcher's control, which
   * owns its state rollback, so it is never reported here.
   */
  unserved?: {
    root: string;
    /** The link names it (the update failed after the switch), rather than a deferred trial. */
    selected: boolean;
  };
  /**
   * The trial's fallback (link text) is missing or its build does not verify. `commit` is
   * what the fallback was built from, which is what serves: a release rebuilt from it is a
   * safe fallback. Without it there is none.
   */
  unsafeFallback?: { previous: string; reason: "missing" | "unverified"; commit?: string };
};

/** A release worktree's checked-out commit, read from its Git metadata without running Git. */
async function readReleaseHead(root: string): Promise<string | null> {
  const dotGit = await fs.readFile(path.join(root, ".git"), "utf8").catch(() => "");
  const gitDir = /^gitdir: (.+)$/mu.exec(dotGit)?.[1]?.trim();
  const head = gitDir
    ? (await fs.readFile(path.resolve(root, gitDir, "HEAD"), "utf8").catch(() => "")).trim()
    : "";
  return /^[0-9a-f]{40,64}$/u.test(head) ? head : null;
}

/** Present and intact: its runtime artifacts verify against the commit it was built from. */
export async function verifiesAsGitRelease(root: string): Promise<boolean> {
  return (await verifyGitUpdateRecovery({ root, sha: await readReleaseHead(root) }))
    .serviceRestartSafe;
}

/** A verified release built from `commit`, other than `exclude`, if one is on disk. */
export async function findVerifiedGitRelease(params: {
  prefix: string;
  commit: string;
  exclude: readonly string[];
}): Promise<string | null> {
  const releasesDir = path.join(params.prefix, PACKAGE_RELEASES_DIR);
  const excluded = new Set(
    await Promise.all(params.exclude.map((root) => fs.realpath(root).catch(() => root))),
  );
  for (const id of await fs.readdir(releasesDir).catch(() => [] as string[])) {
    if (id.startsWith(".")) {
      continue;
    }
    const root = await fs
      .realpath(path.join(packageReleaseGlobalRoot(path.join(releasesDir, id)), "openclaw"))
      .catch(() => null);
    if (
      root &&
      !excluded.has(root) &&
      (await readReleaseHead(root)) === params.commit &&
      (await verifiesAsGitRelease(root))
    ) {
      return root;
    }
  }
  return null;
}

/**
 * What the trial record says about the link. The link alone is not evidence of what
 * serves: an update that fails after the switch but before any Gateway starts the new
 * release leaves the link on a release that never served, with its trial still armed.
 * That trial's `previous` is the release that last served, and the next update builds on it.
 * A fallback is safe only while it is present and its build verifies; the trial's
 * `previous` matches what serves because a switch records the release the link left.
 */
export async function readGitReleasePlacement(
  slot: PackageReleaseSlot,
): Promise<GitReleasePlacement> {
  const current = { serving: slot.releaseRoot, fallback: slot.releaseRoot };
  const trial = await readGitReleaseTrial(slot.prefix).catch(() => null);
  const resolve = (target: string) =>
    fs.realpath(path.resolve(path.dirname(slot.slot), target)).catch(() => null);
  const leased = (root: string) =>
    readPackageReleaseLeases(slot.prefix, gitReleaseId(root)).live > 0;
  if (trial?.pending && trial.previous === slot.target) {
    const root = await resolve(trial.target);
    return root && root !== slot.releaseRoot && !leased(root)
      ? { ...current, unserved: { root, selected: false } }
      : current;
  }
  // The launcher counts every start of the release the link names on trial.
  if (
    !trial ||
    trial.pending ||
    trial.target !== slot.target ||
    trial.attempts !== 0 ||
    leased(slot.releaseRoot)
  ) {
    return current;
  }
  const previous = await resolve(trial.previous);
  if (previous === slot.releaseRoot) {
    return current;
  }
  const unserved = { root: slot.releaseRoot, selected: true };
  if (previous && (await verifiesAsGitRelease(previous))) {
    return { serving: previous, fallback: previous, unserved };
  }
  const commit = previous ? await readReleaseHead(previous) : null;
  // Without its commit the old fallback cannot even be read as a Git release.
  const known = commit ? previous! : slot.releaseRoot;
  return {
    serving: known,
    fallback: known,
    unserved,
    unsafeFallback: {
      previous: trial.previous,
      reason: previous ? "unverified" : "missing",
      ...(commit ? { commit } : {}),
    },
  };
}

/**
 * Put the link on the fallback and remove the placed release, which never started. A
 * reread right before the switch must still find it never started and on its trial;
 * otherwise the launcher or a ready Gateway has taken over and nothing is touched. A
 * failed switch throws; a failed removal keeps the files for `collectGitReleases`.
 */
export async function supersedeUnservedGitRelease(params: {
  prefix: string;
  placement: GitReleasePlacement;
  prune: () => Promise<unknown>;
}): Promise<{ superseded: boolean; removed: boolean; error?: unknown }> {
  const placed = params.placement.unserved?.root;
  const before = readPackageReleaseSlotSync(gitReleaseSlot(params.prefix));
  const fresh = before ? (await readGitReleasePlacement(before)).unserved : undefined;
  if (!placed || fresh?.root !== placed) {
    return { superseded: false, removed: false };
  }
  // Also clears a deferred trial, so no start selects the release being removed.
  await publishGitRelease({
    prefix: params.prefix,
    releaseRoot: params.placement.fallback,
    trial: false,
  });
  const after = readPackageReleaseSlotSync(gitReleaseSlot(params.prefix));
  const id = gitReleaseId(placed);
  // Recheck at removal: a process may have started it since the placement was read.
  if (
    !after ||
    after.releaseRoot === placed ||
    readPackageReleaseLeases(after.prefix, id).live > 0
  ) {
    return { superseded: true, removed: false };
  }
  const releasesDir = path.join(after.prefix, PACKAGE_RELEASES_DIR);
  try {
    // Out of the release namespace first, so a partial removal is never a release.
    const doomed = path.join(releasesDir, `.collecting-${id}-${randomBytes(4).toString("hex")}`);
    await fs.rename(path.join(releasesDir, id), doomed);
    await fs.rm(doomed, { recursive: true, force: true });
    await fs.rm(packageReleaseLeaseDir(releasesDir, id), { recursive: true, force: true });
    await params.prune();
    return { superseded: true, removed: true };
  } catch (error) {
    return { superseded: true, removed: false, error };
  }
}

/**
 * Remove releases the link does not name that are past the 24 hour minimum age
 * and unleased (#198835's rule), then let Git forget their worktrees.
 */
export async function collectGitReleases(params: {
  prefix: string;
  keep: readonly string[];
  prune: () => Promise<unknown>;
}): Promise<{ removed: string[]; warnings: string[] }> {
  const collected = await collectPackageReleases({
    slot: gitReleaseSlot(params.prefix),
    prefix: params.prefix,
    keep: params.keep,
  });
  if (collected.removed.length > 0) {
    await params.prune();
  }
  return collected;
}

/**
 * The serving Gateway restarts itself once its maintenance tick (30 s) sees the link
 * move. Wait for a new Gateway owner before verifying; after 35 s, ask it to restart
 * (SIGUSR2), which also covers a plugin-only restart where the link did not move.
 */
export async function waitForGitReleaseSuccessor(
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  const ownerPid = () => {
    try {
      return readGatewayOwnerLease({ env, current: true })?.pid;
    } catch {
      return undefined;
    }
  };
  const servingPid = ownerPid();
  for (let waited = servingPid ? 0 : 90; waited < 90; waited++) {
    if (waited === 35) {
      try {
        process.kill(servingPid!, "SIGUSR2");
      } catch {
        // A Gateway that already exited has a successor coming.
      }
    }
    await sleep(1_000, signal);
    if (ownerPid() !== servingPid) {
      return;
    }
  }
}
