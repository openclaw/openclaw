import fs from "node:fs/promises";
import path from "node:path";
import { syncDirectoryIfSupported } from "./directory-durability.js";
import { ignoreMissingPath } from "./errno.js";
import { writeGitReleaseLauncher, type GitReleaseTrial } from "./git-release-launcher.js";
import { GIT_RELEASE_TRIAL, gitReleaseSlot } from "./git-release-paths.js";
import { readPackageVersion } from "./package-json.js";
import { collectPackageReleases } from "./package-release-retention.js";
import {
  PACKAGE_RELEASES_DIR,
  packageReleaseGlobalRoot,
  readPackageReleaseSlotSync,
} from "./package-release-slot-path.js";
import {
  capturePackageReleaseSlot,
  createPackageReleasePrefix,
  packageReleaseLinkTarget,
  sweepPackageReleaseTemporaryLinks,
  switchPackageReleaseLink,
} from "./package-release-slot.js";

/** An empty release directory; the worktree goes at the returned path. */
export async function createGitReleaseWorktreeDir(prefix: string, sha: string): Promise<string> {
  const releasePrefix = await createPackageReleasePrefix(prefix, sha.slice(0, 12));
  const globalRoot = packageReleaseGlobalRoot(releasePrefix);
  await fs.mkdir(globalRoot, { recursive: true });
  return path.join(globalRoot, "openclaw");
}

/**
 * Select `releaseRoot` with one rename. With `trial`, the launcher switches back
 * after two failed starts and the Gateway clears the record once it is ready.
 */
export async function publishGitRelease(params: {
  prefix: string;
  releaseRoot: string;
  trial: boolean;
  assertCurrent?: () => void;
}): Promise<{ previous: string | null; target: string }> {
  const slot = gitReleaseSlot(params.prefix);
  const target = packageReleaseLinkTarget(slot, params.releaseRoot);
  const trialFile = path.join(params.prefix, PACKAGE_RELEASES_DIR, GIT_RELEASE_TRIAL);
  await writeGitReleaseLauncher(params.prefix);
  const existing = await fs.lstat(slot).catch(ignoreMissingPath);
  let previous: string | null = null;
  if (existing) {
    const capture = await capturePackageReleaseSlot(slot);
    if (capture.kind !== "link") {
      throw new Error(`${slot} is not a release link; the installation was left unchanged.`);
    }
    previous = capture.target;
    // A stale trial must not switch the next release back.
    await fs.rm(trialFile, { force: true });
    await switchPackageReleaseLink({
      slot,
      expected: { identity: capture.identity, target: capture.target },
      target,
      assertCurrent: () => params.assertCurrent?.(),
    });
  } else {
    const globalRoot = path.dirname(slot);
    await fs.mkdir(globalRoot, { recursive: true });
    await sweepPackageReleaseTemporaryLinks(globalRoot);
    const temporary = path.join(globalRoot, `.openclaw.release-link-${process.pid}-${Date.now()}`);
    await fs.symlink(target, temporary);
    params.assertCurrent?.();
    await fs.rename(temporary, slot);
    await syncDirectoryIfSupported(globalRoot);
  }
  if (params.trial && previous) {
    const record: GitReleaseTrial = {
      target,
      previous,
      version: (await readPackageVersion(params.releaseRoot)) ?? "unknown",
      createdAt: Date.now(),
      attempts: 0,
    };
    const temporary = `${trialFile}.${process.pid}`;
    await fs.writeFile(temporary, JSON.stringify(record));
    await fs.rename(temporary, trialFile);
  }
  return { previous, target };
}

/** A ready Gateway ends the trial of the release it runs. */
export async function settleGitReleaseTrial(runningRoot: string | null): Promise<void> {
  const slot = runningRoot ? readPackageReleaseSlotSync(runningRoot) : null;
  if (!slot) {
    return;
  }
  const trialFile = path.join(slot.prefix, PACKAGE_RELEASES_DIR, GIT_RELEASE_TRIAL);
  const raw = await fs.readFile(trialFile, "utf8").catch(ignoreMissingPath);
  const trial = raw ? (JSON.parse(raw) as GitReleaseTrial) : null;
  if (trial?.target === slot.target) {
    await fs.rm(trialFile, { force: true });
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
