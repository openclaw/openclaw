import { resolveStateDir } from "../../config/paths.js";
import { checkActivatedGatewayStartup } from "../../infra/update-activated-gateway-check.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";

/** A restarted service is verified by its own readiness check; otherwise boot once here. */
export async function checkActivatedRelease(
  params: MutableUpdateExecutionParams,
  result: UpdateRunResult,
  managedEnv: NodeJS.ProcessEnv | undefined,
  assertCurrent: () => void,
): Promise<UpdateRunResult> {
  const unchanged = result.before?.sha != null && result.before.sha === result.after?.sha;
  if (params.shouldRestart || unchanged) {
    return result;
  }
  const env = managedEnv ?? params.opts.run?.env ?? process.env;
  return await checkActivatedGatewayStartup({
    result,
    env,
    stateDir: resolveStateDir(env),
    nodeRunner: params.packageUpdateNodeRunner,
    assertCurrent,
  });
}
