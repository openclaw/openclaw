import { checkShellCompletionStatus } from "../../commands/doctor-completion.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  readOwedUpdateSteps,
  recordUpdateRunOwedStep,
  settleUpdateRunOwedStep,
} from "../../infra/update-run-ledger.js";
import {
  formatUpdateOwedStep,
  isUpdateOwedStepId,
  type UpdateOwedStep,
  type UpdateOwedStepId,
} from "../../infra/update-run-owed-step.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { CLI_NAME } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  listOwedPluginSteps,
  pluginPhaseConverged,
  type PostCorePluginUpdateResult,
} from "./update-command-plugins-internals.js";
import { recordServiceReconciliationWarning } from "./update-command-result.js";
import {
  inspectManagedGatewayServiceBeforeUpdate,
  readGatewayServiceStateForUpdate,
} from "./update-command-service-plan.js";

type OwedRun = Pick<NonNullable<UpdateCommandOptions["run"]>, "runId" | "env" | "busyTimeoutMs">;
export type OwedStep = { id: UpdateOwedStepId; reason: string };

/** A retry returns why its step is still owed, or nothing once the work is done. */
type OwedStepRetries = Partial<
  Record<UpdateOwedStepId, (step: UpdateOwedStep) => Promise<string | undefined>>
>;

/**
 * Records the step on this run. The newest run that mentions a step decides it, so this run now
 * holds it. An earlier run's row is left as it is: that run owes the step again if this update
 * fails and stops deciding.
 * Best effort: the caller's own warning already reports the failure when history is unavailable.
 */
export function recordOwedUpdateStep(run: OwedRun | undefined, step: OwedStep): boolean {
  if (!run) {
    return false;
  }
  try {
    return recordUpdateRunOwedStep(run.runId, step.id, step.reason, run);
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    return false;
  }
}

/** The update keeps its result; the service definition refresh it could not make is owed. */
export function oweServiceDefinitionRefresh(
  run: OwedRun | undefined,
  result: UpdateRunResult,
  serviceEnv: NodeJS.ProcessEnv,
  assertCurrent: () => void,
  failure?: string,
): void {
  const warning =
    `Gateway service still points outside the updated install ${result.root}. ` +
    (failure ? `Automatic service staging failed: ${failure}. ` : "") +
    `Run \`${formatCliCommand("openclaw gateway install --force", serviceEnv)}\`, then \`${formatCliCommand("openclaw gateway restart", serviceEnv)}\`.`;
  recordServiceReconciliationWarning(result, serviceEnv, warning);
  assertCurrent();
  recordOwedUpdateStep(run, { id: "service-definition", reason: warning });
}

/** Reports an owed step in the command result. A recorded row already carries its warning. */
export function warnOwedUpdateStep(
  result: Pick<UpdateRunResult, "steps" | "root">,
  step: OwedStep,
  recorded: boolean,
): void {
  result.steps.push({
    name: step.id,
    command: "openclaw update repair",
    cwd: result.root ?? "",
    durationMs: 0,
    exitCode: 0,
    advisory: { kind: "recoverable-maintenance", message: formatUpdateOwedStep(step) },
    ...(recorded ? { warnings: [] } : {}),
  });
}

/**
 * Retries what earlier runs still owe and returns what stays owed, now held by this run.
 * A step this command cannot retry stays where it is. Never fails its command: owed steps
 * are optional by definition.
 */
export async function retryOwedUpdateSteps(
  run: OwedRun,
  retries: OwedStepRetries,
): Promise<OwedStep[]> {
  const stillOwed: OwedStep[] = [];
  try {
    const heldByRun = new Map<string, UpdateOwedStep[]>();
    for (const held of readOwedUpdateSteps(run)) {
      heldByRun.set(held.runId, [...(heldByRun.get(held.runId) ?? []), held]);
    }
    // This run's own rows were reported when recorded.
    heldByRun.delete(run.runId);
    for (const held of [...heldByRun.values()].flat()) {
      const retry = isUpdateOwedStepId(held.id) ? retries[held.id] : undefined;
      if (!isUpdateOwedStepId(held.id) || !retry) {
        continue;
      }
      // A retry that could not run proves nothing: the step stays owed for its recorded reason.
      const reason = await retry(held).catch((error: unknown) => {
        if (hasCommandProcessCleanupError(error)) {
          throw error;
        }
        return held.reason;
      });
      if (reason === undefined) {
        settleUpdateRunOwedStep(held.runId, held.id, run);
      } else {
        const step = { id: held.id, reason };
        recordOwedUpdateStep(run, step);
        stillOwed.push(step);
      }
    }
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    defaultRuntime.error(
      `Warning: owed update steps could not be retried: ${formatErrorMessage(error)}`,
    );
  }
  return stillOwed;
}

/**
 * What this command's plugin phase proves about plugin steps an earlier run owes. A phase that
 * did not run proves nothing, and one that owes a step again keeps it owed for the new reason.
 * The Doctor step also needs a full Doctor run from this command.
 */
export function retryOwedPluginSteps(
  plugins: PostCorePluginUpdateResult | undefined,
  doctorCompleted: boolean,
): OwedStepRetries {
  const converged = pluginPhaseConverged(plugins);
  const owedNow = new Map<string, string>(
    listOwedPluginSteps(plugins).map((step) => [step.id, step.reason]),
  );
  return {
    "plugin-convergence": async (step) => (converged ? owedNow.get(step.id) : step.reason),
    "post-plugin-doctor": async (step) =>
      converged && doctorCompleted ? owedNow.get(step.id) : step.reason,
  };
}

/** A refreshed cache does not upgrade a shell profile that still loads completion the slow way. */
export async function shellProfileStillOwes(reason: string): Promise<string | undefined> {
  return (await checkShellCompletionStatus(CLI_NAME)).usesSlowPattern ? reason : undefined;
}

/**
 * Repair does not run the service installer. After its Doctor maintenance, the step is settled
 * only on the updater's own verdict that the definition serves this installation or is gone.
 */
async function serviceDefinitionStillOwes(
  root: string,
  env: NodeJS.ProcessEnv,
  reason: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const state = await readGatewayServiceStateForUpdate(resolveGatewayService(), env, timeoutMs);
  const verdict = await inspectManagedGatewayServiceBeforeUpdate({
    state,
    root,
    allowIncompleteInspection: true,
    allowInstallRootChange: true,
  });
  return verdict.kind === "absent" ||
    (verdict.kind === "owned" && !verdict.requiresInstallRootRefresh)
    ? undefined
    : reason;
}

/**
 * Standalone finalization and repair: full Doctor ran before the plugin phase, and the
 * completion cache was attempted.
 */
export async function settleOwedStepsAfterFinalization(
  run: OwedRun,
  observed: {
    root: string;
    completionFailure?: string;
    plugins: PostCorePluginUpdateResult;
    timeoutMs: number;
  },
): Promise<OwedStep[]> {
  const failed: OwedStep[] = [
    ...listOwedPluginSteps(observed.plugins),
    ...(observed.completionFailure
      ? [{ id: "shell-completion" as const, reason: observed.completionFailure }]
      : []),
  ];
  for (const step of failed) {
    recordOwedUpdateStep(run, step);
  }
  const stillOwed = await retryOwedUpdateSteps(run, {
    ...retryOwedPluginSteps(observed.plugins, true),
    "shell-completion": (step) => shellProfileStillOwes(step.reason),
    "service-definition": (step) =>
      serviceDefinitionStillOwes(observed.root, run.env, step.reason, observed.timeoutMs),
  });
  return [...failed, ...stillOwed];
}
