import type { GatewayService, GatewayServiceState } from "../../daemon/service-types.js";
import { VERSION } from "../../version.js";
import type { CliRuntimeStatus, ServiceRuntimeIntentStatus } from "./status.runtime-intent.js";

type CliStatusSummary = {
  version: string;
  entrypoint?: string;
  runtime?: CliRuntimeStatus;
};

/** Fast status has only process-local identity; deep status admits the runtime inspection graph. */
export async function projectDaemonRuntimeStatus(params: {
  deep?: boolean;
  service: GatewayService;
  state: Pick<GatewayServiceState, "command" | "loadState" | "inspectionReason"> & {
    inspectionFailed?: true;
  };
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
}): Promise<{ cli: CliStatusSummary; runtimeIntent?: ServiceRuntimeIntentStatus }> {
  const entrypoint = (params.argv ?? process.argv)[1]?.trim();
  const cli: CliStatusSummary = {
    version: VERSION,
    ...(entrypoint ? { entrypoint } : {}),
  };
  if (!params.deep) {
    return { cli };
  }
  const { inspectCliRuntime, inspectServiceRuntimeIntent } =
    await import("./status.runtime-intent.js");
  const env = params.env ?? process.env;
  const { command, loadState, inspectionFailed, inspectionReason } = params.state;
  const runtimeIntent = await inspectServiceRuntimeIntent({
    service: params.service,
    command,
    env,
    serviceEnv: { ...env, ...command?.environment },
    inspectionKnown: loadState.status !== "unknown" && !inspectionFailed && !inspectionReason,
  });
  return { cli: { ...cli, runtime: await inspectCliRuntime() }, runtimeIntent };
}
