import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage } from "../../infra/errors.js";
import { readPackageVersion } from "../../infra/package-json.js";
import {
  assertPackageActivationLayout,
  isPackageActivationComplete,
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  resolvePackageActivationJournalPath,
} from "../../infra/package-update-activation-journal.js";
import { readReleasedPackageActivationReceipt } from "../../infra/package-update-activation-status.js";
import { tryProcessCwd } from "../../infra/safe-cwd.js";
import {
  captureNamespacedStateLeaseProcessOwner,
  ranInEarlierHostBoot,
} from "../../infra/state-lease-process-owner.js";
import { resolveUpdateInstallKind } from "../../infra/update-check.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import {
  readBuiltGatewayBuildId,
  verifyGitUpdateRecovery,
} from "../../infra/update-git-runtime.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { captureManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-database.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "../../infra/update-managed-service-handoff-lease.js";
import type { PluginCohortRecoveryPair } from "../../infra/update-plugin-cohort-schema.js";
import {
  hasUnrecordedUpdateRunDriver,
  inspectUpdateRunAbandonment,
  inspectNewerRecoveryHistory,
  updateRunLastActivity,
} from "../../infra/update-run-activity.js";
import { findUpdateGatewayStop } from "../../infra/update-run-gateway-stop.js";
import { getUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import {
  isAbandonedUpdateRun,
  isAcknowledgedAbandonedUpdateRun,
  type UpdateRunRecord,
} from "../../infra/update-run-record.js";
import {
  assertUpdateRecoveryAdmission,
  inspectPluginCohortRecoveryAdmission,
} from "../../infra/update-run-recovery-admission.js";
import {
  assertPluginCohortRecoveryContinuation,
  UpdateRecoveryRequiredError,
} from "../../infra/update-run-recovery.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { gitCleanCheckArgs } from "../../infra/update-runner-git-commands.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { formatCliCommand } from "../command-format.js";
import { parseUpdateTimeoutMs, type UpdateCommandOptions } from "./shared.js";
import {
  assertUpdateRequesterContinuationOwner,
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";
import { resolveServiceRefreshEnv } from "./update-command-service-env.js";

/**
 * Only an absent or completed package activation has given up restoring the
 * original core. Dry-run admission also passes unfinished ones whose candidate is
 * installed, so it is not evidence here; unreadable records keep authority.
 */
function hasPackageRecoveryAuthority(installKey: string): boolean {
  try {
    if (readReleasedPackageActivationReceipt(installKey)) {
      return true;
    }
    const anchor = resolvePackageActivationAnchor(installKey);
    assertPackageActivationLayout(anchor);
    if (!fs.lstatSync(resolvePackageActivationJournalPath(anchor), { throwIfNoEntry: false })) {
      return [anchor, resolvePackageActivationControl(anchor)].some(
        (file) => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined,
      );
    }
    const record = openPackageActivationJournal(anchor, { readOnly: true }).read();
    return !isPackageActivationComplete(anchor, record);
  } catch {
    return true;
  }
}

/**
 * A checkout's version cannot show whether a killed update had replaced its build,
 * so its cohort settles like a package's only while the checkout still holds exactly
 * the build that update recorded activating: that commit, no local changes, and a
 * build made from it with that build ID. Returns why not, or undefined.
 */
async function inspectGitActivation(
  root: string,
  run: UpdateRunRecord,
  { from, to }: PluginCohortRecoveryPair["reservation"],
  timeoutMs: number,
): Promise<string | undefined> {
  const activation = run.origin.gitActivation;
  if (!activation) {
    return " that did not record which build it activated";
  }
  if (activation.buildId !== to.buildId || activation.previousBuildId !== from.buildId) {
    return " whose recorded build does not match its plugin recovery";
  }
  // Settlement tells the two cores apart by version and build ID alone.
  if (from.version === to.version && from.buildId === to.buildId) {
    return " whose build has the same version and build ID as the build it replaced";
  }
  // Read-only probes must not refresh the checkout's index or fetch a partial clone's
  // objects. Older Git ignores GIT_NO_LAZY_FETCH, so every transport is denied too.
  const { gitReadOnlyEnvironment } = await import("../../infra/git-exec.js");
  const git = (argv: string[]) =>
    runCommandWithTimeout(argv, {
      cwd: root,
      timeoutMs,
      env: gitReadOnlyEnvironment(argv.slice(1), {
        GIT_OPTIONAL_LOCKS: "0",
        GIT_ALLOW_PROTOCOL: "",
      }),
    });
  const head = await git(["git", "-C", root, "rev-parse", "HEAD"]);
  if (head.code !== 0 || head.stdout.trim() !== activation.sha) {
    return ", and the checkout is no longer at the commit that update activated";
  }
  // The updater's own clean check, showing untracked files whatever the local config says.
  const clean = gitCleanCheckArgs(root);
  clean.splice(clean.indexOf("--porcelain") + 1, 0, "--untracked-files=normal");
  const status = await git(clean);
  if (status.code !== 0 || status.stdout.trim()) {
    return ", and the checkout has local changes";
  }
  // The check the updater itself trusts before restarting a checkout's Gateway.
  const build = await verifyGitUpdateRecovery({ root, sha: activation.sha });
  if (!build.serviceRestartSafe) {
    return ", and its build is missing, incomplete or not built from the checked-out commit";
  }
  return build.buildId === activation.buildId
    ? undefined
    : ", and its build is not the one that update activated";
}

/**
 * Every process the run recorded as its driver ran on this host in an earlier boot,
 * so none of them and none of their children survive. A run that lost a driver's
 * identity, or that a managed helper adopted, keeps the lease store's proof. Its
 * history must also have gone quiet before this boot began: a clone sharing the host
 * name, machine identity and state directory boots on its own, and its live updater
 * keeps writing.
 */
function ranBeforeRestart(run: UpdateRunRecord): boolean {
  const drivers = [run.origin.driver, ...(run.origin.previousDrivers ?? [])];
  if (
    !drivers[0] ||
    run.origin.managedHandoff ||
    hasUnrecordedUpdateRunDriver(run) ||
    updateRunLastActivity(run) >= Date.now() - os.uptime() * 1000
  ) {
    return false;
  }
  const current = captureNamespacedStateLeaseProcessOwner().namespace;
  return drivers.every((driver) => driver !== undefined && ranInEarlierHostBoot(driver, current));
}

/**
 * Settle an interrupted run's saved plugin cohort under the caller's installation
 * ownership. Unless its candidate verified serving and the original core is gone,
 * a pending cohort rolls back; finalization then converges plugins to whichever core
 * is installed. A recorded commit requires its candidate.
 */
export async function settleInterruptedUpdatePluginCohort(params: {
  expected: PluginCohortRecoveryPair;
  root: string;
  options: OpenClawStateDatabaseOptions & { env: NodeJS.ProcessEnv };
  assertCurrent: () => void;
  /** Throws to refuse the selected outcome before anything is restored or released. */
  admit?: (plan: {
    action: "commit" | "rollback";
    originalCore: boolean;
    /** The cohort owner finishes a recorded rollback that restored anything, whatever `action` says. */
    rollbackStarted: boolean;
  }) => void;
}): Promise<"commit" | "rollback"> {
  const { expected, options, assertCurrent } = params;
  assertCurrent();
  const current = await inspectPluginCohortRecoveryAdmission(options, expected.cohort.runId);
  assertCurrent();
  if (
    !current ||
    current.cohort.transactionId !== expected.cohort.transactionId ||
    current.cohort.installKey !== expected.cohort.installKey
  ) {
    throw new Error("Plugin cohort recovery changed before repair acquired ownership.");
  }
  const [version, buildId] = await Promise.all([
    readPackageVersion(params.root),
    readBuiltGatewayBuildId(params.root),
  ]);
  assertCurrent();
  const installed = (core: { version: string; buildId: string | null }) =>
    version === core.version && (buildId ?? null) === core.buildId;
  const { from, to } = current.reservation;
  if (current.cohort.disposition === "commit" && !installed(to)) {
    throw new Error(
      "Plugin cohort commit does not match the installed candidate version and build.",
    );
  }
  // Rollback restores plugin state for the original core. Once the candidate has
  // verified serving and the original core is no longer installed, rollback would
  // only be converged forward again, and it refuses obligations a later Doctor
  // decided. Package recovery that can restore the original core keeps rollback.
  // This is a precheck: the cohort owner continues a rollback that already restored
  // anything, including migration rows restored before any publication was counted.
  const verification = getUpdateRun(current.cohort.runId, options)?.verification;
  const forward =
    current.cohort.disposition !== "commit" &&
    current.cohort.settledPublications === 0 &&
    // Only a readable, different version or build proves the original core is gone.
    version !== null &&
    (version !== from.version || (buildId !== null && buildId !== from.buildId)) &&
    !hasPackageRecoveryAuthority(current.cohort.installKey) &&
    verification?.serviceRunning === true &&
    verification.versionMatch === true &&
    verification.runningVersion === to.version &&
    (to.buildId === null || verification.runningBuildId === to.buildId);
  const { settleUpdatePluginCohort } = await import("../../plugins/update-cohort-recovery.js");
  assertCurrent();
  const action = current.cohort.disposition === "commit" || forward ? "commit" : "rollback";
  params.admit?.({
    action,
    originalCore: installed(from),
    rollbackStarted: current.cohort.disposition === "rollback",
  });
  await settleUpdatePluginCohort({
    runId: current.cohort.runId,
    action,
    ...(forward ? { supersedeUnsettledRollback: true as const } : {}),
    env: options.env,
    fence: { assertCurrent },
    onLaterDecisionsKept: (warning) => defaultRuntime.error(`Warning: ${warning}`),
  });
  assertCurrent();
  // The plugin reservation is gone before ordinary history reconciliation.
  await assertUpdateRecoveryAdmission(options);
  assertCurrent();
  return action;
}

/**
 * The managed handoff helper finalizes its own run after the updater died. Its
 * borrowed executor is that run's live owner, so it settles the run's saved
 * plugin cohort as repair would. Other pending recovery still refuses.
 */
export async function settleManagedHandoffPluginCohort(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const runId = env[UPDATE_RUN_ID_ENV]?.trim();
  if (env.OPENCLAW_UPDATE_RUN_HANDOFF !== "1" || !runId) {
    return;
  }
  let pair: PluginCohortRecoveryPair | undefined;
  try {
    await assertUpdateRecoveryAdmission({ env });
    return;
  } catch (error) {
    pair = await inspectPluginCohortRecoveryAdmission({ env }, runId);
    if (!pair) {
      throw error;
    }
  }
  const expected = pair;
  await withUpdateCommandExecutor(runId, async (executor) => {
    const fence = await executor.enter(expected.cohort.installKey);
    assertUpdateRequesterContinuationOwner(fence, runId);
    assertPluginCohortRecoveryContinuation(expected, { runId, fence }, { env });
    await settleInterruptedUpdatePluginCohort({
      expected,
      root: expected.cohort.installKey,
      options: { env },
      assertCurrent: fence.assertCurrent,
    });
  });
}

/**
 * A killed `openclaw update` leaves its plugin cohort reserved, and recovery
 * admission then refuses every later update. A fresh update settles that cohort
 * with repair's settlement when no operator judgement is needed: update history
 * shows a command-line update whose driver exited, and the update lease store still
 * holds that driver's lease, so claiming the installation proves its processes and
 * their children gone. When a restart emptied that store, a recorded earlier boot of
 * this host proves the same. When that update had replaced the installed version without
 * confirming it, had begun rolling back on it, or left the Gateway stopped, this
 * update then finishes it as repair does before deciding anything about its own
 * core; a stopped Gateway only when this update would restart it anyway. Inspect
 * before package settlement, whose own claim retires that lease, and run the
 * returned settlement after it. The settlement throws for recovery this update
 * leaves to repair; recovery that repair cannot settle stays with admission's refusal.
 */
export async function inspectInterruptedUpdateRecovery(
  root: string,
  opts: Pick<
    UpdateCommandOptions,
    "dryRun" | "run" | "recovery" | "timeout" | "restart" | "json" | "yes" | "fullIntegrityCheck"
  >,
  /** The steps this update hands its run for what admission settled. */
  steps: UpdateStepResult[],
): Promise<
  | ((
      resolveAdmissionEnv: (invocationCwd: string | undefined) => Promise<NodeJS.ProcessEnv>,
    ) => Promise<void>)
  | undefined
> {
  if (
    opts.run ||
    opts.recovery ||
    process.env[UPDATE_RUN_ID_ENV]?.trim() ||
    process.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1"
  ) {
    return undefined;
  }
  const invocationCwd = tryProcessCwd();
  const env = resolveServiceRefreshEnv(process.env, invocationCwd);
  const { withUpdateDatabaseEngine } = await import("./update-command-database-engine.js");
  // Unreadable config is the update's own refusal to report, not this inspection's.
  const withEngine = <T>(read: () => Promise<T>) =>
    withUpdateDatabaseEngine(env, async (readable) => (readable ? await read() : undefined), {
      dryRun: true,
    });
  const options = {
    env,
    busyTimeoutMs: parseUpdateTimeoutMs(opts.timeout) ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
  };
  const installKey = resolveUpdateInstallRoot(root);
  const repair = formatCliCommand("openclaw update repair", env);
  const update = formatCliCommand("openclaw update", env);
  const pendingRecovery = () =>
    assertUpdateRecoveryAdmission({ env }).then(
      () => undefined,
      (error: unknown) => (error instanceof UpdateRecoveryRequiredError ? error : undefined),
    );
  const inspect = async () => {
    const pending = await pendingRecovery();
    const pair = pending
      ? await inspectPluginCohortRecoveryAdmission({ env }).catch(() => undefined)
      : undefined;
    if (!pending || !pair) {
      return undefined;
    }
    const installKind = await resolveUpdateInstallKind(root);
    const refuse = (
      why: string,
      next = `Run ${repair}, then retry ${update}.`,
      cause: unknown = pending,
    ) => new Error([pending.message, why, next].filter(Boolean).join(" "), { cause });
    /**
     * The stage finishes only the killed run. Repair would also finish any other run
     * the history still owes recovery, including another update's pending Gateway stop.
     */
    const refuseOtherRecovery = () => {
      const history = listUpdateRuns({ limit: 100 }, options);
      const since = getUpdateRun(pair.cohort.runId, options)?.createdAtMs ?? 0;
      const stop = findUpdateGatewayStop(history);
      // Repair's own rule: post-core work since the killed run, unproven past a page that ends after it.
      const { postCoreRuns, incomplete } = inspectNewerRecoveryHistory(since, history);
      const others = new Set(
        [
          ...history.filter(
            (run) =>
              run.status === "running" ||
              (isAbandonedUpdateRun(run) && !isAcknowledgedAbandonedUpdateRun(run)),
          ),
          ...postCoreRuns,
        ].map((run) => run.runId),
      );
      if (stop?.started === false) {
        others.add(stop.runId);
      }
      others.delete(pair.cohort.runId);
      return others.size || incomplete
        ? refuse(
            `Other update history also needs repair${others.size ? ` (${[...others].join(", ")})` : ""}.`,
          )
        : undefined;
    };
    /** What the installation and update history say; read again under the claim. */
    const inspectHistory = async () => {
      if (installKind !== "package" && installKind !== "git") {
        return refuse("It was left by an update of a source checkout.");
      }
      if (resolveUpdateInstallRoot(pair.cohort.installKey) !== installKey) {
        return refuse(
          `It belongs to the installation at ${pair.cohort.installKey}.`,
          `Run ${repair} from that installation.`,
        );
      }
      const run = getUpdateRun(pair.cohort.runId, options);
      if (run?.status !== "running" || run.trigger !== "cli" || run.origin.managedHandoff) {
        return refuse(
          "It was not left by a killed openclaw update command, so this update does not settle it.",
          `If the Gateway is still finishing that update, wait for it; otherwise run ${repair}, then retry ${update}.`,
        );
      }
      // Recorded driver death needs no operator; an unobserved driver is repair's judgement.
      const exited = listUpdateRuns({ active: true, limit: 100 }, options).every(
        (active) => inspectUpdateRunAbandonment(active) !== undefined,
      );
      if (!exited) {
        return refuse(
          "An update is still recorded as running, and its process is not known to have exited.",
          `Wait for it to finish; if it has stopped, run ${repair}, then retry ${update}.`,
        );
      }
      const checkout =
        installKind === "git"
          ? await inspectGitActivation(root, run, pair.reservation, options.busyTimeoutMs)
          : undefined;
      if (checkout) {
        return refuse(`It was left by an update of a source checkout${checkout}.`);
      }
      if (findUpdateGatewayStop([run])?.started !== false) {
        return run;
      }
      // History cannot tell that update's stop from an operator's deliberate one.
      return opts.restart === false
        ? refuse(
            "That update stopped the Gateway and did not start it again, and this update was asked not to restart it.",
            `Run ${repair} to settle it and restart the Gateway, then retry ${update}.`,
          )
        : (refuseOtherRecovery() ?? run);
    };
    const history = await inspectHistory();
    if (history instanceof Error) {
      return { pair, refuse, inspectHistory, refuseOtherRecovery, refused: history };
    }
    // Claiming the installation shows the dead updater's children gone only in the
    // store that recorded them: the one still holding the lease of that very process.
    const databasePath = resolveManagedUpdateLeaseDatabasePath();
    const store = fs.existsSync(databasePath)
      ? captureManagedUpdateLeaseDatabaseIdentity(databasePath)
      : undefined;
    const held = createManagedHandoffLeaseStore().read(pair.cohort.installKey);
    const driver = history.origin.driver;
    const holder = held.kind === "current" && held.lease.version === 2 && held.lease.executor;
    const recorded =
      store !== undefined &&
      driver !== undefined &&
      holder !== false &&
      holder.pid === driver.pid &&
      holder.startIdentity === driver.startIdentity;
    // A restart empties the temporary lease store, but also ends every process of the boot.
    const rebooted = !recorded && held.kind === "absent" && ranBeforeRestart(history);
    return {
      pair,
      refuse,
      inspectHistory,
      refuseOtherRecovery,
      databasePath,
      store,
      rebooted,
      refused:
        recorded || rebooted
          ? undefined
          : refuse(
              "The update lease store no longer holds that update's lease, so this update cannot show that its processes are gone.",
            ),
    };
  };
  // A failed inspection changes nothing: admission then reports what it finds itself.
  const inspected = await withEngine(inspect).catch(() => undefined);
  if (!inspected) {
    return undefined;
  }
  const { pair, refuse, inspectHistory, refuseOtherRecovery, refused, databasePath, store } =
    inspected;
  const rebooted = inspected.rebooted === true;
  return async (resolveAdmissionEnv) => {
    // Admission can follow a managed service to another state directory: not this recovery.
    const admitted = resolveOpenClawStateSqlitePath(await resolveAdmissionEnv(invocationCwd));
    if (admitted !== resolveOpenClawStateSqlitePath(env)) {
      return;
    }
    if (refused) {
      throw refused;
    }
    if (opts.dryRun) {
      throw refuse("A dry run changes nothing.", `Run ${update} to settle it and update.`);
    }
    const startedAt = Date.now();
    const settled = await withEngine(() =>
      withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const ownership = await executor.enter(pair.cohort.installKey).catch((cause: unknown) => {
          // The executor's own refusal usually names what to wait for and run.
          const message = formatErrorMessage(cause);
          throw refuse(message, message.includes("update repair") ? "" : undefined, cause);
        });
        const {
          installKey: claimed,
          owner: _owner,
          ...claimedStore
        } = captureUpdateCommandExecutorAuthority(ownership);
        // After a restart the claim's store is a new one at the same place; the earlier
        // boot is the proof.
        const sameStore = rebooted
          ? databasePath !== undefined &&
            claimedStore.databasePath === fs.realpathSync(databasePath)
          : isDeepStrictEqual(claimedStore, store);
        if (claimed !== installKey || !sameStore) {
          throw refuse("The update lease store changed while this update was starting.");
        }
        if (!(await pendingRecovery())) {
          // Another command settled it between the inspection and this claim.
          return "settled" as const;
        }
        const history = await inspectHistory();
        if (history instanceof Error) {
          throw history;
        }
        if (rebooted && !ranBeforeRestart(history)) {
          throw refuse("The update's recorded processes changed while this update was starting.");
        }
        // What repair's finalization finishes and an already-current update would not.
        const gatewayStopped = findUpdateGatewayStop([history])?.started === false;
        const unfinished = gatewayStopped
          ? ["That update stopped the Gateway and did not start it again."]
          : [];
        let blocked: Error | undefined;
        const action = await settleInterruptedUpdatePluginCohort({
          expected: pair,
          root,
          options,
          assertCurrent: () => {
            ownership.assertCurrent();
            if (resolveUpdateInstallRoot(root) !== installKey) {
              throw new Error("Plugin cohort recovery installation changed during settlement.");
            }
          },
          admit: ({ action: outcome, originalCore, rollbackStarted }) => {
            // A rollback over the installed candidate leaves it half updated, including
            // a commit the cohort owner turns back into a rollback.
            if (outcome === "rollback" && !originalCore) {
              unfinished.push(
                `That update replaced OpenClaw ${pair.reservation.from.version} and was not confirmed finished.`,
              );
            } else if (outcome === "commit" && rollbackStarted) {
              unfinished.push(
                "That update had begun rolling its plugin changes back on the version it installed.",
              );
            }
            // Refuse before anything is restored when finishing would leave other history.
            blocked = unfinished.length ? refuseOtherRecovery() : undefined;
            if (blocked) {
              throw blocked;
            }
          },
        }).catch((cause: unknown) => {
          throw (
            blocked ??
            refuse(`It could not be settled (${formatErrorMessage(cause)}).`, undefined, cause)
          );
        });
        return { action, unfinished, gatewayStopped };
      }),
    );
    if (!settled || settled === "settled") {
      return;
    }
    const { action, unfinished, gatewayStopped } = settled;
    const runId = pair.cohort.runId;
    const note = unfinished.length
      ? `Settled interrupted update ${runId}: ${unfinished.join(" ")} Its plugin and configuration changes were settled as ${repair} settles them, and this update finishes the installed version the same way before it continues.`
      : `Settled interrupted update ${runId}: its plugin and configuration changes were ${
          action === "commit"
            ? "kept, because its Gateway was verified on the installed version"
            : "rolled back, because the previous version is still installed"
        }; update can proceed past recovery admission.`;
    defaultRuntime.error(note);
    const settledAt = Date.now();
    const step = (name: string, command: string, sinceMs: number, warning: string) =>
      steps.push({
        name,
        command,
        cwd: root,
        durationMs: Date.now() - sinceMs,
        exitCode: 0,
        warnings: [warning],
      });
    step("interrupted-update-recovery", "settle interrupted update", startedAt, note);
    if (!unfinished.length) {
      return;
    }
    // Repair's own stage, after the settlement claim is released as in repair. It
    // re-admits recovery, Doctor re-admits the recorded drivers, and Gateway
    // restoration claims the installation again; Doctor and plugin convergence run
    // without that claim, as in repair. Its record is its own run: this update's does
    // not exist until target resolution, which must read the config this stage rewrites.
    // Capabilities this update was allowed to accept were not consented for that version.
    const failed = (detail: string, cause?: unknown) =>
      new Error(
        `Interrupted update ${runId} was settled, but finishing its installed version as ${repair} does failed: ${detail} Run ${repair}, then retry ${update}.`,
        { cause },
      );
    const { finishInterruptedUpdate } = await import("./update-command-finalize.js");
    const finished = await finishInterruptedUpdate(
      {
        json: opts.json,
        yes: opts.yes,
        timeout: opts.timeout,
        fullIntegrityCheck: opts.fullIntegrityCheck,
      },
      [runId],
    ).catch((cause: unknown) => {
      throw failed(formatErrorMessage(cause), cause);
    });
    // Repair can finish with a warning that leaves the Gateway stopped; this update would not start it.
    const stillStopped = async () =>
      findUpdateGatewayStop(listUpdateRuns({ limit: 100 }, options))?.started === false;
    if (gatewayStopped && (await withEngine(stillStopped)) !== false) {
      throw failed(
        `the Gateway that update stopped is still not running (update run ${finished.runId}, ${finished.status}).`,
      );
    }
    const pointer = `Finished interrupted update ${runId} as ${repair} does (Doctor, plugin convergence and Gateway restoration); recorded as update run ${finished.runId} (${finished.status}).`;
    defaultRuntime.error(pointer);
    step("interrupted-update-finalization", "finish interrupted update", settledAt, pointer);
  };
}
