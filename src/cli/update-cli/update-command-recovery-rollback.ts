import { isDeepStrictEqual } from "node:util";
import { ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV } from "../../config/future-version-guard.js";
import {
  verifyGatewayServiceDefinitionBackup,
  restoreGatewayServiceDefinitionBackup,
} from "../../daemon/service-definition-backup.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withUpdateRecoveryWriterAuthority } from "../../infra/update-recovery-writer-guard.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { captureUpdateCommandRecoveryGenerationAuthority } from "./update-command-executor.js";
import { publishOriginalUpdateRecoveryGeneration } from "./update-command-recovery-generation.js";
import { withOriginalUpdateRecoveryGeneration } from "./update-command-recovery-source.js";
import type {
  RollbackFailedUpdateParams,
  RollbackFailedUpdateResult,
} from "./update-command-rollback-types.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import {
  createWindowsTaskAutoStartGuard,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
} from "./update-command-service-maintenance.js";
import { maybeRestartServiceAfterFailedMutableUpdate } from "./update-command-service-recovery.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service.js";

/** Full recovery is selected only by the retained original run/capture/transaction.
 * A serialized legacy recovery request cannot enter this branch. */
export async function rollbackOriginalUpdateGeneration(
  params: RollbackFailedUpdateParams,
): Promise<RollbackFailedUpdateResult> {
  const { opts, packageTransaction: transaction } = params;
  const run = opts.run;
  const executor = run?.executorFence;
  let result = params.result;
  let stopped = params.preManagedServiceStop;
  const serviceNodeRunner = stopped?.serviceNodeRunner ?? params.nodeRunner;
  try {
    if (!run || !executor || !run.recoveryBaseline || !transaction?.reversePublication) {
      throw new Error("Full recovery requires its original captured run and package transaction.");
    }
    const baseline = structuredClone(run.recoveryBaseline);
    const runId = run.runId;
    const assertNative = captureUpdateCommandRecoveryGenerationAuthority(executor, runId);
    const publication = transaction.reversePublication;
    const selectOriginal = publication.selection;
    const selected = structuredClone(selectOriginal.call(publication));
    const assertBindings = () => {
      if (
        opts.run !== run ||
        run.runId !== runId ||
        run.executorFence !== executor ||
        params.packageTransaction !== transaction ||
        transaction.reversePublication !== publication ||
        publication.selection !== selectOriginal ||
        !isDeepStrictEqual(selectOriginal.call(publication), selected) ||
        !isDeepStrictEqual(run.recoveryBaseline, baseline)
      ) {
        throw new Error("Full recovery changed its original caller bindings.");
      }
    };
    const env = params.preManagedServiceStop?.serviceEnv ?? run.env;
    assertNative();
    assertBindings();
    if (params.definitionRecovery.unverified) {
      throw new Error("Service definition recovery is unverified.");
    }
    const backup = params.definitionRecovery.backup;
    const restore = async (assertService: () => void) => {
      const assertCurrent = () => {
        assertBindings();
        assertService();
      };
      // The factory/publisher own the native assertion inside their callback.
      // Service preparation and continuation still validate it here.
      const assertHeld = () => {
        assertNative();
        assertCurrent();
      };
      const command = backup
        ? await resolveGatewayService().readCommand(env, { requireEffective: true })
        : undefined;
      if (backup && !command) {
        throw new Error("Recovery cannot verify the original service definition.");
      }
      const definition =
        backup && command
          ? { env, command, receipt: backup, assertCurrent: assertHeld }
          : undefined;
      if (definition) {
        await verifyGatewayServiceDefinitionBackup(definition);
      }
      assertHeld();
      if (stopped?.stopped) {
        const original = stopped;
        // Only this guarded stop may run under an older parent after a newer stamp.
        const recoveryEnv = { ...env, [ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV]: "1" };
        stopped = await withOwnedManagedUpdateEnv(recoveryEnv, () =>
          maybeStopManagedServiceBeforeMutableUpdate({
            updateRun: run,
            // The task owner retains this after the service-operation lock ends.
            // The stop adapter supplies its own native-operation assertion.
            assertCurrent: () => {
              assertNative();
              assertBindings();
            },
            updateInstallKind: "package",
            root: result.root ?? params.previousRoot,
            shouldRestart: true,
            jsonMode: opts.json === true,
            expectedService: original,
            allowInstallRootChange: true,
            timeoutMs: params.timeoutMs,
          }),
        );
        if (stopped.serviceEnv) {
          stopped.serviceEnv = { ...stopped.serviceEnv };
          delete stopped.serviceEnv[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV];
        }
        stopped.windowsTaskAutoStartRecovery ??= original.windowsTaskAutoStartRecovery;
        assertHeld();
        if (
          stopped.blockMessage ||
          stopped.serviceMutationAllowed === false ||
          (stopped.running && !stopped.stopped)
        ) {
          throw new Error(
            stopped.blockMessage ?? "Recovery could not establish stopped service custody.",
          );
        }
        // Reinspection can observe the service already down without performing
        // another stop. Keep the original restart obligation, not a new authority.
        stopped = {
          ...stopped,
          stopped: true,
          stoppedAtMs: stopped.stoppedAtMs ?? original.stoppedAtMs,
        };
      }
      const completion = await withUpdateRecoveryWriterAuthority(assertNative, () =>
        withOriginalUpdateRecoveryGeneration(
          {
            run,
            env,
            transaction,
            assertCallerBindings: assertCurrent,
            timeoutMs: params.timeoutMs,
          },
          (generation) =>
            publishOriginalUpdateRecoveryGeneration({
              generation,
              baseline,
              assertCallerBindings: assertCurrent,
              transaction,
              executor,
              runId,
              timeoutMs: params.timeoutMs,
            }),
        ),
      );
      assertHeld();
      if (completion.phase !== "rolled-back" || !completion.publishedState) {
        throw new Error("Recovery publication did not provide complete state/package evidence.");
      }
      result = {
        ...result,
        root: completion.installKey,
        after: result.before,
        rollbackOutcome: {
          status: "succeeded",
          reason: "Original package and prepared state generation restored",
        },
        recovery: {
          serviceRestartSafe: false,
          packageRollbackVerified: true,
          reason: "runtime-verification-failed",
        },
      };
      // This is reached only after B/C/T publication AND native reader re-admission.
      // Never run the legacy config overwrite after this point.
      recordUpdateRunStep(
        runId,
        { step: "previous generation restoration", status: "completed", endedAtMs: Date.now() },
        { env: run.env },
      );
      if (definition) {
        await restoreGatewayServiceDefinitionBackup(definition);
      }
      assertHeld();
    };
    if (params.definitionRecovery.backup) {
      await withGatewayServiceOperationLock(env, restore);
    } else {
      await restore(assertBindings);
    }
    if (!stopped?.stopped || params.allowGatewayRestart === false) {
      return { result, rolledBack: false, stoppedForRollback: stopped };
    }
    const previousVersion = result.before?.version;
    const previousBuildId = result.before?.buildId;
    if (!params.previousVerified || !previousVersion) {
      return {
        result,
        rolledBack: false,
        stoppedForRollback: stopped,
        pendingRecoveryReason: "Previous service runtime was not verified.",
      };
    }
    result = {
      ...result,
      recovery: {
        ...result.recovery,
        serviceRestartSafe: true,
        packageRollbackVerified: true,
        version: previousVersion,
        ...(previousBuildId ? { buildId: previousBuildId } : {}),
      },
    };
    const assertRestartCurrent = () => {
      assertNative();
      assertBindings();
    };
    assertRestartCurrent();
    await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(
      stopped,
      true,
      createWindowsTaskAutoStartGuard({
        root: result.root ?? params.previousRoot,
        before: stopped,
        timeoutMs: params.timeoutMs,
      }),
      assertRestartCurrent,
    );
    assertRestartCurrent();
    const service = await maybeRestartServiceAfterFailedMutableUpdate({
      updateRun: run,
      preManagedServiceStop: stopped,
      recovery: result.recovery,
      jsonMode: opts.json === true,
      nodeRunner: serviceNodeRunner,
      timeoutMs: params.timeoutMs,
      invocationCwd: params.invocationCwd,
    });
    assertNative();
    assertBindings();
    return {
      result: {
        ...result,
        recovery: {
          serviceRestartSafe: true,
          packageRollbackVerified: true,
          version: previousVersion,
          ...(previousBuildId ? { buildId: previousBuildId } : {}),
          service: service === "healthy" ? "healthy" : "failed",
        },
      },
      rolledBack: service === "healthy",
      stoppedForRollback: stopped,
    };
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    return {
      result: {
        ...result,
        status: "error",
        recovery: {
          ...result.recovery,
          serviceRestartSafe: false,
          reason: "runtime-verification-failed",
        },
      },
      rolledBack: false,
      stoppedForRollback: stopped,
      pendingRecoveryReason: formatErrorMessage(error),
    };
  }
}
