import fsSync from "node:fs";
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
import { collectPackageReleases } from "./package-release-retention.js";
import {
  PACKAGE_RELEASES_DIR,
  packageReleaseGlobalRoot,
  readPackageReleaseSlotSync,
} from "./package-release-slot-path.js";
import {
  assertPackageReleaseIdentity,
  type PackageReleaseIdentity,
  capturePackageReleaseSlot,
  createPackageReleasePrefix,
  packageReleaseLinkTarget,
  sweepPackageReleaseTemporaryLinks,
  switchPackageReleaseLink,
} from "./package-release-slot.js";
import { readBuiltGatewayBuildId } from "./update-git-runtime.js";

/** Publication evidence, usable only under the update's original executor. */
export type GitReleaseSelectionRollback = {
  slot: string;
  selected: { identity: string; target: string };
  previous: { target: string; release: PackageReleaseIdentity };
  trial: { path: string; identity: string; contents: string };
};

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

/**
 * Select `releaseRoot` with one rename. With `trial`, the launcher switches back
 * after two failed starts and the Gateway clears the record once it is ready.
 */
export async function publishGitRelease(params: {
  prefix: string;
  releaseRoot: string;
  trial: boolean;
  /** Leave the link to the next service start, which selects the release on trial. */
  pending?: boolean;
  assertCurrent?: () => void;
}): Promise<{ previous: string | null; target: string; rollback?: GitReleaseSelectionRollback }> {
  const slot = gitReleaseSlot(params.prefix);
  const target = packageReleaseLinkTarget(slot, params.releaseRoot);
  const trialFile = path.join(params.prefix, PACKAGE_RELEASES_DIR, GIT_RELEASE_TRIAL);
  await writeGitReleaseLauncher(params.prefix);
  const existing = await fs.lstat(slot).catch(ignoreMissingPath);
  let previous: string | null = null;
  let previousRelease: PackageReleaseIdentity | undefined;
  let selected: GitReleaseSelectionRollback["selected"] | undefined;
  let rollback: GitReleaseSelectionRollback | undefined;
  if (existing) {
    const capture = await capturePackageReleaseSlot(slot);
    if (capture.kind !== "link") {
      throw new Error(`${slot} is not a release link; the installation was left unchanged.`);
    }
    previous = capture.target;
    previousRelease = capture.release;
    // A stale trial must not switch the next release back.
    await fs.rm(trialFile, { force: true });
    if (!params.pending) {
      selected = await switchPackageReleaseLink({
        slot,
        expected: { identity: capture.identity, target: capture.target },
        target,
        assertCurrent: () => params.assertCurrent?.(),
      });
    }
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
    const buildId = await readBuiltGatewayBuildId(params.releaseRoot);
    const record: GitReleaseTrial = {
      target,
      previous,
      version: (await readPackageVersion(params.releaseRoot)) ?? "unknown",
      ...(buildId ? { buildId } : {}),
      // The update admits only a service whose config selection matches this process.
      config: resolveConfigPath(process.env),
      ...(params.pending ? { pending: true } : {}),
      createdAt: Date.now(),
      attempts: 0,
    };
    const temporary = `${trialFile}.${process.pid}`;
    const contents = JSON.stringify(record);
    await fs.writeFile(temporary, contents);
    const identity = await fs.lstat(temporary, { bigint: true });
    await fs.rename(temporary, trialFile);
    if (selected && previousRelease && !params.pending) {
      rollback = {
        slot,
        selected,
        previous: { target: previous, release: previousRelease },
        trial: { path: trialFile, identity: `${identity.dev}:${identity.ino}`, contents },
      };
    }
  }
  return { previous, target, ...(rollback ? { rollback } : {}) };
}

/**
 * Compensate only a refused conversion, before its launcher ever starts the target.
 * No target boot means no startup data migration to undo. Started trials retain
 * the launcher's state-aware recovery; this operation only restores selection.
 */
export async function restoreUnstartedGitReleaseSelection(
  publication: GitReleaseSelectionRollback,
  assertCurrent: () => void,
): Promise<void> {
  const assertTrial = () => {
    const entry = fsSync.lstatSync(publication.trial.path, { bigint: true });
    if (
      !entry.isFile() ||
      `${entry.dev}:${entry.ino}` !== publication.trial.identity ||
      fsSync.readFileSync(publication.trial.path, "utf8") !== publication.trial.contents
    ) {
      throw new Error("Git release trial changed or started; selection recovery was withheld.");
    }
  };
  assertCurrent();
  assertTrial();
  await switchPackageReleaseLink({
    slot: publication.slot,
    expected: publication.selected,
    target: publication.previous.target,
    assertCurrent,
    assertCandidate: async () => {
      await assertPackageReleaseIdentity(publication.previous.release);
      assertTrial();
    },
  });
  // Keep a replacement/started trial even if it appeared during link publication.
  assertTrial();
  assertCurrent();
  fsSync.unlinkSync(publication.trial.path);
}

/** A ready Gateway ends the trial of the release it runs. */
export async function settleGitReleaseTrial(runningRoot: string | null): Promise<void> {
  const slot = runningRoot ? readPackageReleaseSlotSync(runningRoot) : null;
  if (!slot) {
    return;
  }
  const trialFile = path.join(slot.prefix, PACKAGE_RELEASES_DIR, GIT_RELEASE_TRIAL);
  const raw = await fs.readFile(trialFile, "utf8").catch(ignoreMissingPath);
  // SAFETY: publishGitRelease and the launcher are the only writers of the trial record.
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
