import fs from "node:fs/promises";
import path from "node:path";
import {
  gitReleaseSlot,
  resolveGitReleasePrefix,
  servingGitReleaseSlot,
} from "./git-release-paths.js";
import {
  collectGitReleases,
  createGitReleaseDirs,
  gitReleaseId,
  publishGitRelease,
  findVerifiedGitRelease,
  readGitReleasePlacement,
  verifiesAsGitRelease,
  supersedeUnservedGitRelease,
} from "./git-release.js";
import { readPackageVersion } from "./package-json.js";
import {
  PACKAGE_RELEASES_DIR,
  packageReleaseGlobalRoot,
  packageReleasePrefixOfRoot,
  readPackageReleaseSlotSync,
} from "./package-release-slot-path.js";
import {
  capturePackageReleaseSlot,
  packageReleaseLinkTarget,
  switchPackageReleaseLink,
} from "./package-release-slot.js";
import { isPathStrictlyInside } from "./path-guards.js";
import { DEV_BRANCH, type UpdateChannel } from "./update-channels.js";
import {
  readBuiltGatewayBuildId,
  readBuiltRuntimeCommit,
  readGitRuntimeArtifactIdentity,
  verifyGitUpdateRecovery,
} from "./update-git-runtime.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import { runStep } from "./update-runner-command.js";
import { resolveGitUpdateCommandEnv } from "./update-runner-git-commands.js";
import { runGitCandidatePreflight } from "./update-runner-git-preflight.js";
import {
  fetchGitUpdateTarget,
  prepareGitMutation,
  readBranchName,
  selectGitInspectionTarget,
} from "./update-runner-git-target.js";
import type {
  CommandRunner,
  RunStepOptions,
  UpdateRunResult,
  UpdateRunnerOptions,
} from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

/** Thrown from `beforeCandidate` when the candidate is a placed release's tree: stop before building. */
class PlacedReleaseMatch extends Error {}

/**
 * Update a Git checkout install by building the target as a new release (a
 * detached worktree of the checkout) and switching the release link to it. The
 * checkout and the running release are never written; the Gateway that starts
 * from the new release upgrades state at boot. A package switch keeps the serving
 * package as fallback; a checkout conversion builds its serving commit as the first release.
 */
export async function updateGitRelease(params: {
  opts: UpdateRunnerOptions;
  gitRoot: string;
  /** The package that serves before a package-to-Git switch; kept intact as the trial fallback. */
  previousPackageRoot?: string;
  runCommand: CommandRunner;
  defaultCommandEnv: NodeJS.ProcessEnv | undefined;
  timeoutMs: number;
  startedAt: number;
}): Promise<UpdateRunResult> {
  const { opts, timeoutMs, startedAt, runCommand } = params;
  const defaultCommandEnv = resolveGitUpdateCommandEnv(params.defaultCommandEnv);
  const channel: UpdateChannel = opts.channel ?? "dev";
  const steps: UpdateStepResult[] = [];
  const prefix = resolveGitReleasePrefix();
  const slot = gitReleaseSlot(prefix);
  const selected = readPackageReleaseSlotSync(slot);
  const converting = !selected;
  let placement = selected ? await readGitReleasePlacement(selected, params.gitRoot) : null;
  // Repair moves the link, which a launcher-backed Gateway follows by restarting, so an
  // update with --no-restart leaves a placed release, its trial and the link exactly as an
  // earlier updater would, for the next update that restarts.
  const deferredLeftover = opts.deferReleaseActivation ? placement?.unserved : undefined;
  if (deferredLeftover && selected) {
    placement = { serving: selected.releaseRoot, fallback: selected.releaseRoot };
  }
  const unserved = opts.deferReleaseActivation ? undefined : placement?.unserved;
  const packageFallback =
    params.previousPackageRoot ??
    (placement &&
    !placement.unsafeFallback &&
    !isPathStrictlyInside(path.join(prefix, PACKAGE_RELEASES_DIR), placement.serving)
      ? placement.serving
      : undefined);
  let stepIndex = 0;
  const forRunner =
    (deadline: number | undefined) =>
    (name: string, argv: string[], cwd: string, env?: NodeJS.ProcessEnv): RunStepOptions => ({
      runCommand,
      name,
      argv,
      cwd,
      timeoutMs: deadline,
      env,
      progress: opts.progress,
      stepIndex: stepIndex++,
      totalSteps: converting ? 10 : 8,
      results: steps,
    });
  const step = forRunner(timeoutMs);
  const workStep = forRunner(opts.timeoutMs);
  // A release is a worktree of the developer's checkout; Git work happens there.
  // The release that serves, even when this CLI runs from the preserved checkout: the
  // link's release, unless an interrupted update left it on trial and nothing runs from it.
  // A link at the earlier `lib/node_modules` path serves until this update replaces it.
  const serving = servingGitReleaseSlot(prefix);
  const running =
    packageFallback ??
    placement?.serving ??
    (readPackageReleaseSlotSync(serving) ? serving : params.gitRoot);
  const git = (root: string, ...args: string[]) =>
    runCommand(["git", "-C", root, ...args], { cwd: root, timeoutMs });
  // npm's serving package is not a checkout; Git inspection still belongs to the clone.
  const runningGit = packageFallback ? params.gitRoot : running;
  const commonDir = (
    await git(runningGit, "rev-parse", "--path-format=absolute", "--git-common-dir")
  ).stdout.trim();
  const gitRoot = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : params.gitRoot;
  // A checkout serves what its dist was built from, which can trail a pulled HEAD; the
  // first release, the trial's fallback, must be that serving commit.
  const builtCommit = converting && !packageFallback ? await readBuiltRuntimeCommit(running) : null;
  const runningHead = await git(
    runningGit,
    "rev-parse",
    "--verify",
    `${builtCommit ?? "HEAD"}^{commit}`,
  );
  const head = await git(gitRoot, "rev-parse", "HEAD");
  const runningSha = runningHead.stdout.trim() || null;
  const beforeSha = head.stdout.trim() || null;
  const [beforeVersion, beforeBuildId] = await Promise.all([
    readPackageVersion(running),
    readBuiltGatewayBuildId(running),
  ]);
  const before = {
    sha: runningSha,
    version: beforeVersion,
    ...(beforeBuildId ? { buildId: beforeBuildId } : {}),
  };
  // The running release and the checkout stay untouched until the link moves. A restart
  // starts the placed release on its trial, which without a safe fallback is not safe.
  const recovery: UpdateRunResult["recovery"] =
    placement?.unsafeFallback && unserved
      ? { serviceRestartSafe: false, reason: "runtime-verification-failed" }
      : await verifyGitUpdateRecovery({ root: running, sha: runningSha });
  const result = (status: UpdateRunResult["status"], reason?: string): UpdateRunResult => ({
    status,
    mode: "git",
    root: converting ? gitRoot : slot,
    ...(reason ? { reason } : {}),
    before,
    recovery,
    // A release is built where it stays; nothing regenerates runtime inside it later.
    sourceRuntimePrepared: true,
    steps,
    durationMs: Date.now() - startedAt,
  });
  if (channel === "extended-stable") {
    return result("error", "unsupported_git_channel");
  }
  if (head.code !== 0 || !beforeSha || !runningSha) {
    return result("error", "git-root-unresolved");
  }
  const fetched = await fetchGitUpdateTarget({
    root: gitRoot,
    step,
    workStep,
    name: "git-fetch",
    channel,
    devTarget: opts.devTarget,
    steps,
  });
  if (!fetched.ok) {
    return result("error", fetched.reason ?? "fetch-failed");
  }

  // Replayed local commits get new IDs on every rebuild; the same tree is the same release.
  const treeOf = async (sha: string) =>
    (await git(gitRoot, "rev-parse", `${sha}^{tree}`)).stdout.trim() || sha;
  // A release an interrupted update placed but that does not serve is reused, not rebuilt,
  // when the target turns out to be its tree: candidates reach `beforeCandidate` after local
  // replay and before any install or build.
  let placedSha = "";
  let placedTree: string | null = null;
  let rebuiltFallback = false;

  // A release is built and validated at the path it serves from: a path rule that breaks
  // the release (#201874: Node refuses to strip types under node_modules) breaks the build.
  const buildRelease = async (
    select: (
      release: Parameters<typeof runGitCandidatePreflight>[0]["release"] & {},
      common: Omit<
        Parameters<typeof runGitCandidatePreflight>[0],
        "release" | "beforeRuntimeVerified" | "validateCandidate" | "beforeCandidate"
      >,
      retainCleanup: (cleanup: () => Promise<boolean>) => boolean,
    ) => ReturnType<typeof runGitCandidatePreflight>,
  ) => {
    const dirs = await createGitReleaseDirs(prefix);
    let cleanup: (() => Promise<boolean>) | undefined;
    const common = {
      gitRoot,
      artifactRoot: prefix,
      frozenLockfile: true,
      refreshedRemotes: fetched.refreshedRemotes,
      devSource: fetched.devSource,
      beforeSha,
      needsCheckoutMain: false,
      runCommand,
      timeoutMs,
      defaultCommandEnv,
      steps,
      step,
      workStep,
      workTimeoutMs: opts.timeoutMs,
    };
    const built = await select(
      { prefix: dirs.releasePrefix, worktreeDir: dirs.releaseRoot },
      common,
      (retained) => {
        cleanup = retained;
        return true;
      },
    ).catch(async (error: unknown) => {
      await cleanup?.();
      // The preflight can wrap a candidate's error; the match stays its cause.
      if (
        error instanceof PlacedReleaseMatch ||
        (error instanceof Error && error.cause instanceof PlacedReleaseMatch)
      ) {
        return { status: "placed" as const };
      }
      throw error;
    });
    if (built.status === "placed") {
      // The match can stop the preflight before it owns the new release's directory.
      await fs.rm(dirs.releasePrefix, { recursive: true, force: true });
      // The reused release passes the same candidate checks as a fresh build.
      steps.push(...((await opts.validateCandidate(unserved!.root)) ?? []));
      return {
        status: "ok" as const,
        candidateSha: placedSha,
        selectedDevUpstream: null,
        selectedDevSource: null,
        localDevBranchExists: null,
        releaseRoot: unserved!.root,
      };
    }
    if (built.status !== "ok") {
      await cleanup?.();
      return built;
    }
    if (
      !converting &&
      !packageFallback &&
      recovery.serviceRestartSafe &&
      (await treeOf(built.candidateSha)) === (await treeOf(runningSha))
    ) {
      await cleanup?.();
      return { status: "skipped" as const, reason: "already-current" as const };
    }
    return { ...built, releaseRoot: dirs.releaseRoot };
  };

  const prune = () =>
    runCommand(["git", "-C", gitRoot, "worktree", "prune"], { cwd: gitRoot, timeoutMs });
  // States what serves and what this update did with a release an interrupted update placed.
  const reportPlacement = async (message: string, context = true) => {
    const placed = unserved ? gitReleaseId(unserved.root) : "";
    const fallback = gitReleaseId(placement!.fallback);
    const note: UpdateStepResult = {
      name: "git-release-placement",
      command: "reconcile release link",
      cwd: prefix,
      durationMs: 0,
      exitCode: 0,
      advisory: {
        kind: "recoverable-maintenance",
        message:
          unserved && context
            ? `Release ${placed} was placed by an earlier update and never started. Release ${fallback} is the fallback. ${message}`
            : message,
      },
    };
    steps.push(note);
    const { progress, stepIndex: index, totalSteps: total } = step(note.name, [], prefix);
    await progress?.onStepComplete?.({ ...note, index, total });
  };
  const supersedeUnserved = async () => {
    if (!unserved || !placement) {
      return true;
    }
    const superseded = await supersedeUnservedGitRelease({ prefix, placement });
    await reportPlacement(
      superseded
        ? "The link is back on the fallback; the release collection of a later update that publishes a release removes the placed release once it has been deselected for 24 hours."
        : "It started or ended its trial during this update, so the link and trial stay with the launcher.",
    );
    return superseded;
  };
  if (deferredLeftover) {
    await reportPlacement(
      `Release ${gitReleaseId(deferredLeftover.root)} was placed by an earlier update and never started. With --no-restart this update does not repair it; the link and trial are handled as an earlier updater would.`,
      false,
    );
  }
  // No safe fallback: the trial's fallback is gone, unproven or incomplete. Only when its
  // commit is shown to serve does a release rebuilt from that commit become the fallback.
  // Otherwise nothing is switched: restarting would start the placed release with nothing
  // to back out to.
  if (placement?.unsafeFallback && unserved) {
    const { previous, reason, commit } = placement.unsafeFallback;
    const lost = `Release ${gitReleaseId(unserved.root)} on the release link never passed its trial, and its fallback ${gitReleaseId(path.resolve(path.dirname(slot), previous))} ${reason === "missing" ? "no longer exists" : reason === "unproven" ? "has no record that it is the build the Gateway serves" : "does not verify as a complete build"}.`;
    // An earlier attempt's rebuild of the same commit is reused, so retries keep one copy.
    const earlier = commit
      ? await findVerifiedGitRelease({
          prefix,
          commit,
          exclude: [unserved.root, placement.fallback],
        })
      : null;
    const rebuilt = earlier
      ? {
          status: "ok" as const,
          candidateSha: commit!,
          selectedDevUpstream: null,
          selectedDevSource: null,
          localDevBranchExists: null,
          releaseRoot: earlier,
        }
      : commit
        ? await buildRelease((release, common, retainCleanup) =>
            runGitCandidatePreflight({
              ...common,
              release,
              retainCleanup,
              targetRevision: commit,
              beforeRuntimeVerified: false,
              validateCandidate: async () => [],
              beforeCandidate: async () => {},
            }),
          )
        : undefined;
    const verified = rebuilt?.status === "ok" && (await verifiesAsGitRelease(rebuilt.releaseRoot));
    if (!verified || rebuilt?.status !== "ok") {
      if (rebuilt?.status === "ok" && !earlier) {
        await fs.rm(packageReleasePrefixOfRoot(rebuilt.releaseRoot) ?? rebuilt.releaseRoot, {
          recursive: true,
          force: true,
        });
        await prune();
      }
      steps.push({
        name: "git-release-fallback",
        command: "establish a fallback release",
        cwd: prefix,
        durationMs: 0,
        exitCode: 1,
        stderrTail: `${lost} ${commit ? `Rebuilding the commit it was built from (${commit.slice(0, 12)}) did not produce a verified release` : "The commit that serves is not recorded"}, so a switch could not back out to a working Gateway. This update changed nothing; do not restart the Gateway into the release link. Run \`openclaw triage\` to have an agent rebuild a fallback from the serving commit, then run \`openclaw update\` again.`,
      });
      return {
        ...result("error", "git-release-fallback-unavailable"),
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      };
    }
    await reportPlacement(
      `${lost} ${earlier ? "An earlier attempt rebuilt" : "This update rebuilt"} the commit it was built from (${commit!.slice(0, 12)}) as release ${gitReleaseId(rebuilt.releaseRoot)}, which becomes the fallback when the update switches.`,
      false,
    );
    // Selected only at the normal switch, after the target passed its checks.
    placement = { ...placement, fallback: rebuilt.releaseRoot };
    rebuiltFallback = true;
  }
  // F: only a placed release whose build verifies is reused.
  // Only a placed release whose build verifies and whose tracked files are unchanged is reused.
  const status = unserved
    ? await git(unserved.root, "status", "--porcelain", "--untracked-files=no")
    : null;
  const placedClean = status?.code === 0 && status.stdout.trim() === "";
  placedSha =
    unserved && placedClean && (await verifiesAsGitRelease(unserved.root))
      ? (await git(unserved.root, "rev-parse", "HEAD")).stdout.trim()
      : "";
  placedTree = placedSha ? await treeOf(placedSha) : null;

  // The first release is the code that runs now. It is not a candidate: it runs already.
  let previousRelease = converting ? packageFallback : undefined;
  if (converting && !previousRelease) {
    const current = await buildRelease((release, common, retainCleanup) =>
      runGitCandidatePreflight({
        ...common,
        release,
        retainCleanup,
        // The fallback is the code that serves now, which can differ from the checkout's HEAD.
        targetRevision: runningSha,
        beforeRuntimeVerified: false,
        validateCandidate: async () => [],
        beforeCandidate: async () => {},
      }),
    );
    if (current.status !== "ok") {
      return result("error", `git-release-current-failed: ${current.reason}`);
    }
    previousRelease = current.releaseRoot;
  }

  const branch = await readBranchName(runCommand, gitRoot, timeoutMs);
  const target = await buildRelease((release, common, retainCleanup) =>
    selectGitInspectionTarget({
      ...common,
      release,
      retainCleanup,
      channel,
      devTarget: opts.devTarget,
      // Same source is current only when the running release's artifacts verify (#158931).
      // A conversion from a linked worktree can serve a different commit than the checkout.
      beforeRuntimeVerified:
        !packageFallback && recovery.serviceRestartSafe && beforeSha === runningSha,
      validateCandidate: opts.validateCandidate,
      needsCheckoutMain: channel === "dev" && !opts.devTarget && branch !== DEV_BRANCH,
      beforeCandidate: async (revision) => {
        // The caller admits the target and observes its service here, reused release or not.
        await prepareGitMutation({
          runCommand,
          root: gitRoot,
          revision,
          timeoutMs,
          beforeGitMutation: opts.inspectGitTarget,
        });
        // Only the call after checkout and local replay sees the tree that would be built.
        const checkedOut = placedTree
          ? (
              await runCommand(["git", "-C", release.worktreeDir, "rev-parse", "HEAD"], {
                cwd: gitRoot,
                timeoutMs,
              })
            ).stdout.trim()
          : "";
        if (placedTree && checkedOut === revision && (await treeOf(revision)) === placedTree) {
          throw new PlacedReleaseMatch();
        }
      },
    }),
  );
  // The serving release is the target: the link goes back to it unless it already names it.
  if (
    target.status === "skipped" &&
    target.reason === "already-current" &&
    !previousRelease &&
    unserved !== undefined
  ) {
    // The serving release about to be selected passes the candidate checks, then the
    // caller's mutation check, before the link, trial or placed release change.
    steps.push(...((await opts.validateCandidate(placement!.serving)) ?? []));
    await prepareGitMutation({
      runCommand,
      root: gitRoot,
      revision: runningSha,
      timeoutMs,
      beforeGitMutation: opts.beforeGitMutation,
    });
    // The placed release started or passed its trial meanwhile: the target is no longer
    // what is selected, so this update is not current.
    // The restart verdict was for the earlier selection; the next start runs another release.
    if (!(await supersedeUnserved())) {
      return {
        ...result("error", "git-release-selection-changed"),
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      };
    }
  }
  if (target.status !== "ok" && (!previousRelease || target.reason !== "already-current")) {
    return result(target.status, target.reason);
  }
  // A converted install that is already current keeps its first release.
  const releaseRoot = target.status === "ok" ? target.releaseRoot : previousRelease!;
  const afterSha = target.status === "ok" ? target.candidateSha : beforeSha;
  const version = await readPackageVersion(releaseRoot);
  // The service's Node must load the release before the link names it.
  const smoke = await runStep(
    step(
      "git-release-smoke",
      [opts.releaseNode ?? process.execPath, path.join(releaseRoot, "openclaw.mjs"), "--version"],
      releaseRoot,
      defaultCommandEnv,
    ),
  );
  if (isFailedUpdateStep(smoke) || (version && !smoke.stdoutTail?.includes(version))) {
    return result("error", "git-release-smoke-failed");
  }
  await prepareGitMutation({
    runCommand,
    root: gitRoot,
    revision: afterSha,
    timeoutMs,
    beforeGitMutation: opts.beforeGitMutation,
  });
  // Publishing even the fallback changes what the unchanged launcher resolves to.
  // Keep the serving slot intact through admission, validation and ownership revalidation.
  if (previousRelease) {
    await publishGitRelease({ prefix, releaseRoot: previousRelease, trial: false });
  }
  if (target.status === "ok") {
    if (releaseRoot !== unserved?.root) {
      await supersedeUnserved();
    } else {
      await reportPlacement(
        opts.deferReleaseActivation
          ? "It is the target; the next service start activates it."
          : "It is the target, so this update finishes activating it instead of rebuilding it.",
      );
      // Its armed trial falls back to the incomplete release; re-arm it on the rebuilt one,
      // but only while it is still never started: a counted start belongs to the launcher.
      const current = readPackageReleaseSlotSync(slot);
      const fresh = current ? (await readGitReleasePlacement(current)).unserved : undefined;
      if (rebuiltFallback && placement && fresh?.root === releaseRoot && fresh.selected) {
        await publishGitRelease({ prefix, releaseRoot: placement.fallback, trial: false });
      }
    }
    // A release the link already names keeps its trial and fallback; the publisher leaves it.
    await publishGitRelease({
      prefix,
      releaseRoot,
      trial: true,
      pending: opts.deferReleaseActivation,
    });
  }
  // The 7db69bedeab6-era launcher and CLI enter through lib/node_modules: keep that path, but
  // make it follow the new link, so there is one selection. A --no-restart update leaves it (the
  // running Gateway reads its build through it, and a changed build would restart it); the
  // launcher redirects it when that deferred release starts, and any later update repairs it.
  const legacySlot = path.join(packageReleaseGlobalRoot(prefix), "openclaw");
  const legacyTarget = packageReleaseLinkTarget(legacySlot, slot);
  const legacyEntry = await fs.lstat(legacySlot).catch(() => null);
  if (!opts.deferReleaseActivation && legacyEntry?.isSymbolicLink()) {
    const legacy = await capturePackageReleaseSlot(legacySlot);
    if (legacy.kind === "link" && legacy.target !== legacyTarget) {
      await switchPackageReleaseLink({
        slot: legacySlot,
        expected: { identity: legacy.identity, target: legacy.target },
        target: legacyTarget,
        assertCurrent: () => {},
      });
    }
  }
  const collected = await collectGitReleases({
    prefix,
    // The trial's fallback is kept however long ago the link left it.
    keep: [releaseRoot, previousRelease ?? placement?.fallback, placement?.serving].filter(
      (root) => root !== undefined,
    ),
    prune,
  }).catch((error: unknown) => ({ removed: [], warnings: [String(error)] }));
  if (collected.warnings.length > 0) {
    steps.push({
      name: "git-release-collect",
      command: "collect releases",
      cwd: prefix,
      durationMs: 0,
      exitCode: 0,
      advisory: { kind: "recoverable-maintenance", message: collected.warnings.join(" ") },
    });
  }
  const afterBuildId = await readBuiltGatewayBuildId(releaseRoot);
  return {
    ...result("ok"),
    // The new release's own verdict; the previous runtime's belongs to failure recovery only.
    recovery: await verifyGitUpdateRecovery({ root: releaseRoot, sha: afterSha }),
    root: slot,
    gitRuntime: await readGitRuntimeArtifactIdentity(releaseRoot),
    after: {
      sha: afterSha,
      version,
      ...(afterBuildId ? { buildId: afterBuildId } : {}),
      ...(opts.devTarget?.mode === "tracked" ? { upstreamRef: opts.devTarget.upstreamRef } : {}),
    },
  };
}
