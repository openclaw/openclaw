/** Resolve setup runtime intent without turning automatic choices into persistent pins. */
import { resolveRecordedDaemonRuntime } from "../daemon/runtime-paths.js";
import { readDaemonRuntimePinForInstall } from "../daemon/runtime-pin-state.js";
import {
  resolveManagedGatewayServiceCommand,
  type GatewayServiceCommandConfig,
} from "../daemon/service-types.js";
import { resolveRunningBunFallback } from "./daemon-install-plan.shared.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME, type GatewayDaemonRuntime } from "./daemon-runtime.js";

export async function resolveGatewaySetupRuntime(params: {
  env: NodeJS.ProcessEnv;
  existingCommand: GatewayServiceCommandConfig | null;
  runtime?: GatewayDaemonRuntime;
  selectRuntime?: (suggested: GatewayDaemonRuntime) => Promise<GatewayDaemonRuntime>;
}) {
  const expected = readDaemonRuntimePinForInstall(
    { kind: "gateway", env: params.env },
    params.existingCommand,
    params.runtime !== undefined,
  );
  const pin = params.runtime === undefined ? expected.pin : undefined;
  const existing = resolveManagedGatewayServiceCommand(params.existingCommand);
  const env = {
    ...params.env,
    OPENCLAW_WRAPPER: params.env.OPENCLAW_WRAPPER ?? existing?.environment?.OPENCLAW_WRAPPER,
  };
  const recordedRuntime =
    params.runtime === undefined && !pin && !env.OPENCLAW_WRAPPER?.trim()
      ? await resolveRecordedDaemonRuntime(existing?.programArguments[0], env)
      : undefined;
  const retainedRuntime = recordedRuntime?.status === "supported" ? recordedRuntime : undefined;
  const bunFallbackPath =
    params.selectRuntime &&
    params.runtime === undefined &&
    !pin &&
    !retainedRuntime &&
    !env.OPENCLAW_WRAPPER?.trim()
      ? await resolveRunningBunFallback({ env })
      : undefined;
  const suggestedRuntime =
    retainedRuntime?.runtime ?? (bunFallbackPath ? "bun" : DEFAULT_GATEWAY_DAEMON_RUNTIME);
  const runtime =
    params.runtime ??
    pin?.runtime ??
    (params.selectRuntime ? await params.selectRuntime(suggestedRuntime) : suggestedRuntime);
  return {
    runtime,
    runtimeExplicit:
      params.runtime !== undefined || pin !== undefined || params.selectRuntime !== undefined,
    runtimePath:
      runtime === retainedRuntime?.runtime
        ? retainedRuntime.path
        : runtime === "bun"
          ? bunFallbackPath
          : undefined,
    pinnedRuntimePath: pin?.path,
    runtimePinUpdate: { expected, pin },
    env,
  };
}
