import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigPath } from "../config/paths.js";
import { resolveCommandProcessSignal } from "../process/exec-spawn.js";
import { sleep } from "../utils/sleep.js";
import { syncDirectoryIfSupported } from "./directory-durability.js";
import { ignoreMissingPath } from "./errno.js";
import { readGatewayOwnerLease } from "./gateway-owner-lease.js";
import { GATEWAY_RESTART_REPLACEMENT_TIMEOUT_MS } from "./gateway-shutdown-budget.js";
import { writeGitReleaseLauncher, type GitReleaseTrial } from "./git-release-launcher.js";
import { GIT_RELEASE_TRIAL, gitReleaseSlot } from "./git-release-paths.js";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";
import { readPackageVersion } from "./package-json.js";
import { readPackageReleaseLeases } from "./package-release-lease.js";
import { collectPackageReleases } from "./package-release-retention.js";
import {
  PACKAGE_RELEASES_DIR,
  packageReleasePrefixOfRoot,
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
import { isPathStrictlyInside } from "./path-guards.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "./restart-budget.js";
import {
  readBuiltGatewayBuildId,
  readBuiltRuntimeCommit,
  verifyGitUpdateRecovery,
} from "./update-git-runtime.js";

/** A new release directory; its worktree is built at `releaseRoot`, where it serves. */
export async function createGitReleaseDirs(prefix: string) {
  const releasePrefix = await createPackageReleasePrefix(prefix, "git");
  return { releasePrefix, releaseRoot: path.join(releasePrefix, "openclaw") };
}

const gitReleaseTrialFile = (prefix: string) =>
  path.join(prefix, PACKAGE_RELEASES_DIR, GIT_RELEASE_TRIAL);

/** The ID of the release holding `releaseRoot` (`releases/<id>/openclaw`, or the earlier
 * `releases/<id>/lib/node_modules/openclaw`). */
export const gitReleaseId = (releaseRoot: string) =>
  path.basename(packageReleasePrefixOfRoot(releaseRoot) ?? releaseRoot);

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
  // The launcher is written once the link it starts exists: a legacy service already names this
  // file, so a launcher written first would start a missing link if the publisher died between.
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
    // POSIX ignores the type; on Windows a junction needs no administrator rights.
    await fs.symlink(target, temporary, "junction");
    params.assertCurrent?.();
    await fs.rename(temporary, slot);
    await syncDirectoryIfSupported(globalRoot);
  }
  await writeGitReleaseLauncher(params.prefix);
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
  // A Windows junction stores absolute text; compare the releases the texts name.
  const linked = (target: string) => path.resolve(path.dirname(slot.slot), target);
  if (trial && linked(trial.target) === linked(slot.target)) {
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
   * The trial's fallback (link text) is missing, has no evidence that its commit serves, or
   * its build does not verify. `commit` is set only when the commit serves: a release
   * rebuilt from it is a safe fallback. Without it there is none, and nothing is repaired.
   */
  unsafeFallback?: {
    previous: string;
    reason: "missing" | "unverified" | "unproven";
    commit?: string;
  };
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

/**
 * The only evidence on disk that a fallback's commit is what the Gateway serves: no
 * Gateway has ever run from a release, so the service still runs the checkout, and the
 * checkout's own build reports that commit. That is the state a conversion leaves before
 * its first restart. Every Gateway that runs from a release takes a lease there first, and
 * its lease directory stays, so any lease directory means the checkout may not serve.
 * Nothing on disk records that a release's trial passed (settling deletes the record),
 * and a lease is taken before the Gateway is ready, so neither shows what serves. A
 * publisher before this change recorded whatever the link named, which can be a release
 * that never started.
 */
async function isCheckoutServingCommit(
  prefix: string,
  checkout: string | undefined,
  commit: string,
): Promise<boolean> {
  const leases = path.join(prefix, PACKAGE_RELEASES_DIR, ".leases");
  if (!checkout || (await fs.readdir(leases).catch((): string[] => [])).length > 0) {
    return false;
  }
  // The install's own checkout, named by the caller: when it is a linked worktree, the
  // releases' common Git directory belongs to another repository with its own build.
  return (await readBuiltRuntimeCommit(checkout)) === commit;
}

/**
 * Present and intact: its runtime artifacts verify against the commit it was built from,
 * and the entry the launcher imports (`dist/index.js`) is there.
 */
export async function verifiesAsGitRelease(root: string): Promise<boolean> {
  const verified = await verifyGitUpdateRecovery({ root, sha: await readReleaseHead(root) });
  const entry = await fs.stat(path.join(root, "dist", "index.js")).catch(() => null);
  return verified.serviceRestartSafe && entry?.isFile() === true;
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
  for (const id of await fs.readdir(releasesDir).catch((): string[] => [])) {
    if (id.startsWith(".")) {
      continue;
    }
    const root = await fs
      .realpath(path.join(releasesDir, id, path.basename(gitReleaseSlot(params.prefix))))
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
 * A recorded package fallback outside this install's releases stays in place; its dist
 * entries must still exist. A Git fallback needs evidence that its commit serves (see
 * `isCheckoutServingCommit`) and a verified build; otherwise `unsafeFallback` says why.
 */
export async function readGitReleasePlacement(
  slot: PackageReleaseSlot,
  /** The install's own checkout, whose build is the only evidence of what serves. */
  checkout?: string,
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
  // npm-to-Git records the package that served, not a rebuilt copy of the clone's HEAD.
  // It has no worktree metadata or Git build stamps, and retention never owns its path.
  if (previous && !isPathStrictlyInside(path.join(slot.prefix, PACKAGE_RELEASES_DIR), previous)) {
    const entries = await Promise.all(
      ["index.js", "entry.js"].map((entry) =>
        fs.stat(path.join(previous, "dist", entry)).catch(() => null),
      ),
    );
    if (entries.every((entry) => entry?.isFile())) {
      return { serving: previous, fallback: previous, unserved };
    }
    return {
      ...current,
      unserved,
      unsafeFallback: { previous: trial.previous, reason: "unverified" },
    };
  }
  const commit = previous ? await readReleaseHead(previous) : null;
  // A fallback is used, or its commit rebuilt, only on evidence that the commit serves.
  const served = Boolean(
    previous && commit && (await isCheckoutServingCommit(slot.prefix, checkout, commit)),
  );
  if (served && (await verifiesAsGitRelease(previous!))) {
    return { serving: previous!, fallback: previous!, unserved };
  }
  const known = served ? previous! : slot.releaseRoot;
  return {
    serving: known,
    fallback: known,
    unserved,
    unsafeFallback: {
      previous: trial.previous,
      reason: !previous ? "missing" : served ? "unverified" : "unproven",
      ...(served ? { commit: commit! } : {}),
    },
  };
}

/**
 * Put the link back on the fallback, deselecting the placed release, which never started.
 * A reread right before the switch must still find it never started and on its trial;
 * otherwise the launcher or a ready Gateway has taken over and nothing is touched. A
 * failed switch throws. The placed release is not removed here: an updater started
 * through the link runs from it, so only `collectGitReleases` retires it, with the
 * collector's checks and its 24 hour grace from this deselection.
 */
export async function supersedeUnservedGitRelease(params: {
  prefix: string;
  placement: GitReleasePlacement;
}): Promise<boolean> {
  const placed = params.placement.unserved?.root;
  const before = readPackageReleaseSlotSync(gitReleaseSlot(params.prefix));
  const fresh = before ? (await readGitReleasePlacement(before)).unserved : undefined;
  if (!placed || fresh?.root !== placed) {
    return false;
  }
  // Also clears a deferred trial, so no start selects the deselected release.
  await publishGitRelease({
    prefix: params.prefix,
    releaseRoot: params.placement.fallback,
    trial: false,
  });
  return true;
}

/**
 * Remove releases the link does not name that are past the 24 hour minimum age
 * and unleased (#198835's rule), never the one this updater runs from, then let Git
 * forget their worktrees.
 */
export async function collectGitReleases(params: {
  prefix: string;
  keep: readonly string[];
  prune: () => Promise<unknown>;
  /** The package root this updater runs from; tests name a release instead. */
  runningRoot?: string | null;
}): Promise<{ removed: string[]; warnings: string[] }> {
  const slot = gitReleaseSlot(params.prefix);
  // An updater started through the link runs from the release the link named then.
  const running =
    params.runningRoot === undefined
      ? resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url })
      : params.runningRoot;
  // The shared collector compares real paths in the link's resolved prefix (a state dir
  // can be a symlink).
  const keep = await Promise.all(
    [...params.keep, ...(running ? [running] : [])].map((root) =>
      fs.realpath(root).catch(() => root),
    ),
  );
  const collected = await collectPackageReleases({
    slot,
    prefix: readPackageReleaseSlotSync(slot)?.prefix ?? params.prefix,
    keep,
  });
  if (collected.removed.length > 0) {
    await params.prune();
  }
  return collected;
}

/** Wait for this release's resident to leave, not merely for delivery of SIGUSR2.
 * Only the resident can say whether its running policy admitted a deferred restart. */
export async function waitForGitReleaseSuccessor(params: {
  serviceEnv: NodeJS.ProcessEnv;
  gatewayPort: number;
  allowGitReleaseRestartSignal?: boolean;
  signal?: AbortSignal;
}): Promise<
  { status: "no-incumbent" | "changed" } | { status: "unverified"; incumbentPid?: number }
> {
  const signal = resolveCommandProcessSignal(params.signal);
  signal?.throwIfAborted();
  const readOwner = () => {
    try {
      return readGatewayOwnerLease({ env: params.serviceEnv, current: true });
    } catch {
      return null; // Unreadable is not the same as a confirmed absent lease.
    }
  };
  const start = performance.now();
  const waitStartedAtMs = Date.now();
  let incumbent = readOwner();
  if (incumbent === undefined || incumbent?.state === "dead") {
    return { status: "no-incumbent" };
  }
  if (incumbent && incumbent.port !== params.gatewayPort) {
    return { status: "unverified" };
  }
  const signalAt = start + 35_000; // The watcher normally checks the installation every 30s.
  let until = start + 90_000; // Old residents do not publish a receipt.
  let sentAt: number | undefined;
  let previousReceipt: string | undefined;
  let maySignal = params.allowGitReleaseRestartSignal === true;
  while (performance.now() < until) {
    await sleep(Math.min(1_000, until - performance.now()), signal);
    const current = readOwner();
    if (current === undefined || current?.state === "dead") {
      // Supervised replacement normally has a gap between leases. Never nudge the
      // departed owner, but keep looking for its successor within the same budget.
      maySignal = false;
      continue;
    }
    if (!current || current.port !== params.gatewayPort) {
      continue;
    }
    if (!incumbent) {
      // After an unreadable first poll, only a lease that demonstrably predates
      // the wait can identify the incumbent. A new arrival is not ours to signal.
      const predatesWait = [current.listeningAt, current.heartbeatAt].some(
        (at) => at !== undefined && at < waitStartedAtMs,
      );
      if (!predatesWait) {
        continue;
      }
      incumbent = current;
    }
    if (
      current.state === "live" &&
      current.owner !== incumbent.owner &&
      (current.pid !== incumbent.pid ||
        (current.startedAt !== null &&
          incumbent.startedAt !== null &&
          current.startedAt !== incumbent.startedAt))
    ) {
      return { status: "changed" };
    }
    const now = performance.now();
    if (
      current.state !== "live" ||
      current.pid !== incumbent.pid ||
      current.owner !== incumbent.owner ||
      (incumbent.startedAt !== null && current.startedAt !== incumbent.startedAt)
    ) {
      // A transient inconclusive poll at the watcher boundary must not signal an
      // unknown owner. A subsequent fresh live match may still receive our one request.
      continue;
    }
    if (maySignal && sentAt === undefined && now >= signalAt) {
      signal?.throwIfAborted();
      previousReceipt = current.externalRestartReceipt;
      try {
        process.kill(incumbent.pid, "SIGUSR2");
      } catch {
        // Undelivered is not accepted: don't retry or extend the deadline. The watcher
        // can still replace the incumbent independently within the original budget.
        maySignal = false;
        continue;
      }
      sentAt = now;
    } else if (
      sentAt !== undefined &&
      current.externalRestartReceipt &&
      current.externalRestartReceipt !== previousReceipt
    ) {
      // A receipt is evidence to wait, never permission to signal or evidence of readiness.
      // Anchor the budget to our single request, even if other signals arrive later.
      until =
        sentAt + resolveGatewayRestartDeferralTimeoutMs() + GATEWAY_RESTART_REPLACEMENT_TIMEOUT_MS;
    }
  }
  return incumbent
    ? { status: "unverified", incumbentPid: incumbent.pid }
    : { status: "unverified" };
}
