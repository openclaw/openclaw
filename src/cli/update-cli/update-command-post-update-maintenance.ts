import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { retireStandaloneGitWrapper } from "./update-command-git.js";
import { markControlPlaneUpdateRestartSentinelFailureBestEffort } from "./update-command-result.js";
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
