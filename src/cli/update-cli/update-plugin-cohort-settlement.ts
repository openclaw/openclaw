import { randomUUID } from "node:crypto";
import fs from "node:fs";
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
import { resolveUpdateInstallKind } from "../../infra/update-check.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { captureManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-database.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "../../infra/update-managed-service-handoff-lease.js";
import type { PluginCohortRecoveryPair } from "../../infra/update-plugin-cohort-schema.js";
import { inspectUpdateRunAbandonment } from "../../infra/update-run-activity.js";
import { findUpdateGatewayStop } from "../../infra/update-run-gateway-stop.js";
import { getUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import {
  assertUpdateRecoveryAdmission,
  inspectPluginCohortRecoveryAdmission,
} from "../../infra/update-run-recovery-admission.js";
import {
  assertPluginCohortRecoveryContinuation,
  UpdateRecoveryRequiredError,
} from "../../infra/update-run-recovery.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
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
 * with repair's settlement when repair would have nothing left to finish and no
 * operator judgement is needed: update history shows a command-line update whose
 * driver exited without leaving the Gateway stopped, the update lease store still
 * holds that driver's lease, so claiming the installation proves its processes
 * and their children gone, and the outcome is a rollback onto the original core
 * or the commit of a candidate that was verified serving. Inspect before package
 * settlement, whose own claim retires that lease, and run the returned settlement
 * after it. The settlement throws for recovery this update leaves to repair;
 * recovery that repair cannot settle either stays with admission's refusal.
 */
export async function inspectInterruptedUpdateRecovery(
  root: string,
  opts: Pick<UpdateCommandOptions, "dryRun" | "run" | "recovery" | "timeout">,
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
    /** What the installation and update history say; read again under the claim. */
    const inspectHistory = () => {
      if (installKind !== "package") {
        // A checkout can hold the new sources under the old version and build identity,
        // so nothing here shows whether that update had replaced the installed core.
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
      // An update that finds its core already current would leave that Gateway stopped.
      return findUpdateGatewayStop([run])?.started === false
        ? refuse(
            "That update stopped the Gateway and did not start it again.",
            `Run ${repair} to settle it and restart the Gateway, then retry ${update}.`,
          )
        : run;
    };
    const history = inspectHistory();
    if (history instanceof Error) {
      return { pair, refuse, inspectHistory, refused: history };
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
    return {
      pair,
      refuse,
      inspectHistory,
      store,
      refused: recorded
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
  const { pair, refuse, inspectHistory, refused, store } = inspected;
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
    const action = await withEngine(() =>
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
        if (claimed !== installKey || !isDeepStrictEqual(claimedStore, store)) {
          throw refuse("The update lease store changed while this update was starting.");
        }
        if (!(await pendingRecovery())) {
          // Another command settled it between the inspection and this claim.
          return "settled" as const;
        }
        const history = inspectHistory();
        if (history instanceof Error) {
          throw history;
        }
        let unfinished: Error | undefined;
        return await settleInterruptedUpdatePluginCohort({
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
            // Repair also finishes the installed candidate; an update that finds it
            // already current would not, so a rollback over it leaves it half updated.
            // That includes a commit the cohort owner would turn back into a rollback.
            const why =
              outcome === "rollback" && !originalCore
                ? `That update replaced OpenClaw ${pair.reservation.from.version} and was not confirmed finished.`
                : outcome === "commit" && rollbackStarted
                  ? "That update had begun rolling its plugin changes back on the version it installed."
                  : undefined;
            if (why) {
              unfinished = refuse(why, `Run ${repair} to finish it, then retry ${update}.`);
              throw unfinished;
            }
          },
        }).catch((cause: unknown) => {
          throw (
            unfinished ??
            refuse(`It could not be settled (${formatErrorMessage(cause)}).`, undefined, cause)
          );
        });
      }),
    );
    if (!action || action === "settled") {
      return;
    }
    const note = `Settled interrupted update ${pair.cohort.runId}: its plugin and configuration changes were ${
      action === "commit"
        ? "kept, because its Gateway was verified on the installed version"
        : "rolled back, because the previous version is still installed"
    }; update can proceed past recovery admission.`;
    defaultRuntime.error(note);
    steps.push({
      name: "interrupted-update-recovery",
      command: "settle interrupted update",
      cwd: root,
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      warnings: [note],
    });
  };
}
