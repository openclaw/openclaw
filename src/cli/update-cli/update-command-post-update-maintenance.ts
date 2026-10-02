import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { retireStandaloneGitWrapper } from "./update-command-git.js";
import { markControlPlaneUpdateRestartSentinelFailureBestEffort } from "./update-command-result.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import { createWindowsTaskAutoStartGuard } from "./update-command-service-maintenance.js";
import { tryInstallShellCompletion } from "./update-command-service.js";

/** Shell integration changes follow settled restart and health recovery. */
export async function completePostUpdateMaintenance(
  params: FinishUpdateParams,
  result: UpdateRunResult,
  assertCurrent: () => void,
  context: {
    root: string;
    sentinel: Omit<
      Parameters<typeof markControlPlaneUpdateRestartSentinelFailureBestEffort>[0],
      "reason"
    >;
  },
): Promise<{ result: UpdateRunResult; detail: string } | undefined> {
  await tryInstallShellCompletion({
    root: context.root,
    jsonMode: Boolean(params.opts.json),
    skipPrompt: Boolean(params.opts.yes),
  });
  if (!params.installKindChanged || result.mode === "git") {
    return undefined;
  }
  const retirement = await retireStandaloneGitWrapper({
    previousRoot: params.previousInstallRoot ?? params.root,
    assertCurrent,
  });
  if (!retirement.error) {
    return undefined;
  }
  defaultRuntime.error(retirement.error);
  await markControlPlaneUpdateRestartSentinelFailureBestEffort({
    ...context.sentinel,
    reason: "wrapper-retirement-failed",
  });
  return {
    result: { ...result, status: "error", reason: "wrapper-retirement-failed" },
    detail: retirement.error,
  };
}

export async function resumePostUpdateWindowsAutoStart(
  params: Pick<FinishUpdateParams, "root" | "updateStepTimeoutMs">,
  result: UpdateRunResult,
  readStopped: () => PreManagedServiceStop | undefined,
  callbacks?: {
    beforeAttempt: () => void;
    onFailure: (cause: unknown) => Promise<unknown>;
  },
): Promise<void> {
  try {
    if (callbacks && readStopped()?.windowsTaskAutoStartRecovery) {
      callbacks.beforeAttempt();
    }
    const stopped = readStopped();
    await stopped?.windowsTaskAutoStartRecovery?.restore(
      true,
      createWindowsTaskAutoStartGuard({
        root:
          result.recovery?.packageRollbackVerified && stopped.serviceUpdateVerdict?.kind === "owned"
            ? stopped.serviceUpdateVerdict.root
            : (result.root ?? params.root),
        before: stopped,
        timeoutMs: params.updateStepTimeoutMs,
      }),
    );
  } catch (cause) {
    if (!callbacks) {
      throw cause;
    }
    // The attempted restore already failed; reporting must not attempt it again.
    await callbacks.onFailure(cause);
  }
}
