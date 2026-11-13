import { resolveStateDir } from "../../config/paths.js";
import { checkActivatedGatewayStartup } from "../../infra/update-activated-gateway-check.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import { readUpdateCandidateSource } from "./update-command-managed-context.js";

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
  // An unreadable config is not a release failure; the boot itself reports it.
  const config = await readUpdateCandidateSource(env, params.legacyConfigPlan).then(
    (source) => source.config,
    () => undefined,
  );
  return await checkActivatedGatewayStartup({
    result,
    env,
    gateway: {
      // Only an explicitly local Gateway can start here; unset and remote modes are refused at boot.
      remote: config?.gateway?.mode !== "local",
      tls: config?.gateway?.tls?.enabled === true,
    },
    stateDir: resolveStateDir(env),
    nodeRunner: params.packageUpdateNodeRunner,
    assertCurrent,
  });
}
