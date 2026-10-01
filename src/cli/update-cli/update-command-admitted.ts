import { withGatewayServiceUpdateAuthority } from "../../daemon/service-update-authority.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { createUpdateProgress } from "./progress.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { UpdateCommandExecutorOptions } from "./update-command-executor-options.js";
import {
  captureUpdateCommandExecutorAuthority,
  type UpdateCommandExecutor,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";
import type { InitializedUpdate } from "./update-command-initialization.js";
import { admitUpdateRequesterContinuation } from "./update-command-managed-context.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import {
  admitUpdateCommandRun,
  assertUpdatePackageActivationAdmission,
  resolveUpdateCommandAdmissionRoot,
  withUpdatePreviewSignals,
  type prepareUpdateCommand,
} from "./update-command-run.js";
import { withUpdateInProgressEnv } from "./update-command-service-env.js";
import type { UpdateCommandRecoveryState } from "./update-command-service.js";
import {
  prepareUnexpectedUpdateCommandFailure,
  retainUpdateCommandProgressUntilPublication,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";

type PreparedUpdate = NonNullable<Awaited<ReturnType<typeof prepareUpdateCommand>>>;

export async function runAdmittedUpdate(
  inputOpts: UpdateCommandOptions,
  prepared: PreparedUpdate,
  recoveryState: UpdateCommandRecoveryState,
  invocationCwd: string | undefined,
  executeUpdate: (
    opts: UpdateCommandOptions,
    presentation: ReturnType<typeof createUpdateProgress>,
    executor: UpdateCommandExecutor,
  ) => Promise<void>,
  initialization?: InitializedUpdate,
  executorOptions?: UpdateCommandExecutorOptions,
): Promise<void> {
  const refusal = initialization?.refusal;
  const serviceRoot = initialization
    ? initialization.refusal
      ? initialization.refusal.report.serviceRoot
      : initialization.target.managedServiceRoot
    : prepared.servicePlan?.serviceRoot;
  let initializedFence: UpdateRecoveryFence | undefined;
  let assertInitializationCurrent: (() => void) | undefined;
  if (initialization) {
    const root = initialization.refusal
      ? initialization.refusal.report.root
      : initialization.target.root;
    const fence = await initialization.executor.enter(root, { preflight: true, serviceRoot });
    initializedFence = fence;
    assertInitializationCurrent = () => {
      fence.assertCurrent();
      assertUpdatePackageActivationAdmission(root, { serviceRoot });
    };
  }
  const run = await admitUpdateCommandRun({
    opts: inputOpts,
    root: resolveUpdateCommandAdmissionRoot(prepared),
    serviceRoot,
    invocationCwd,
    initialization,
    assertCurrent: assertInitializationCurrent,
    pkgOwnership: prepared.pkgOwnership,
    expectedForeground:
      prepared.controlPlaneUpdateSentinelMeta?.completionOwner === "gateway-restart" || undefined,
    installKind: prepared.installKind,
  });
  const opts = { ...inputOpts, run };
  prepared.controlPlaneUpdateSentinelMeta = {
    ...prepared.controlPlaneUpdateSentinelMeta,
    runId: run.runId,
  };
  recoveryState.triageTarget.root = prepared.discoveredRoot;
  let disposePresentation: (() => void) | undefined;
  let executionStarted = false;
  try {
    assertInitializationCurrent?.();
    run.executorFence = initializedFence;
    await initialization?.registerRun(run);
    const presentation = createUpdateProgress(!opts.json, run);
    disposePresentation = presentation.dispose;
    const executeWith = (executor: UpdateCommandExecutor) =>
      withUpdatePreviewSignals(opts, async () => {
        if (
          disposePresentation &&
          retainUpdateCommandProgressUntilPublication(run, disposePresentation)
        ) {
          disposePresentation = undefined;
        }
        await admitUpdateRequesterContinuation(
          run,
          executor,
          resolveUpdateCommandAdmissionRoot(prepared),
          serviceRoot,
        );
        const execute = () => {
          executionStarted = true;
          if (refusal) {
            assertInitializationCurrent?.();
            throw refusal;
          }
          return withUpdateCommandRecoveryUnwind(opts, recoveryState, () =>
            executeUpdate(opts, presentation, executor),
          );
        };
        if (inputOpts.dryRun || !prepared.controlPlaneUpdateSentinelMeta?.handoffId) {
          return execute();
        }
        // The admitted helper owns native stop and recovery for this invocation.
        // A handoff tuple alone never grants authority to an ordinary service caller.
        const fence =
          run.executorFence ??
          (await executor.enter(
            prepared.servicePlan?.rootRedirect?.root ?? prepared.discoveredRoot,
            {
              preflight: true,
              serviceRoot: prepared.servicePlan?.serviceRoot,
            },
          ));
        run.executorFence = fence;
        const runId = run.runId;
        const assertCurrent = () => {
          if (opts.run !== run || run.runId !== runId || run.executorFence !== fence) {
            throw new UpdateCommandRecoveryPendingError(
              "Managed updater lost its admitted executor.",
            );
          }
          captureUpdateCommandExecutorAuthority(fence, runId);
        };
        return withGatewayServiceUpdateAuthority(assertCurrent, execute, {
          originalRoot: captureUpdateCommandExecutorAuthority(fence, runId).installKey,
        });
      });
    const execute = initialization
      ? () => executeWith(initialization.executor)
      : () =>
          withUpdateFailureTriage({ ...opts, invocationCwd }, recoveryState.triageTarget, () =>
            withUpdateInProgressEnv(invocationCwd, () =>
              withUpdateCommandTerminalResult((registerRun) => {
                registerRun(run);
                return withUpdateCommandExecutor(run.runId, executeWith, executorOptions);
              }, opts),
            ),
          );
    await execute();
  } catch (error) {
    // Execution owns recovery; only failures before execution starts are terminalized here.
    if (!executionStarted) {
      throw await prepareUnexpectedUpdateCommandFailure(error, opts);
    }
    throw error;
  } finally {
    disposePresentation?.();
  }
}
