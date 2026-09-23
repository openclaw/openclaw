/** Resolve setup runtime intent without turning automatic choices into persistent pins. */
import { readDaemonRuntimePinForInstall } from "../daemon/runtime-pin-state.js";
import {
  resolveManagedGatewayServiceCommand,
  type GatewayServiceCommandConfig,
} from "../daemon/service-types.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME, type GatewayDaemonRuntime } from "./daemon-runtime.js";

export async function resolveGatewaySetupRuntime(params: {
  env: NodeJS.ProcessEnv;
  existingCommand: GatewayServiceCommandConfig | null;
  runtime?: GatewayDaemonRuntime;
  selectRuntime?: () => Promise<GatewayDaemonRuntime>;
}) {
  const expected = readDaemonRuntimePinForInstall(
    { kind: "gateway", env: params.env },
    params.existingCommand,
    params.runtime !== undefined,
  );
  const pin = params.runtime === undefined ? expected.pin : undefined;
  const runtime =
    params.runtime ??
    pin?.runtime ??
    (await params.selectRuntime?.()) ??
    DEFAULT_GATEWAY_DAEMON_RUNTIME;
  const existing = resolveManagedGatewayServiceCommand(params.existingCommand);
  return {
    runtime,
    pinnedRuntimePath: pin?.path,
    runtimePinUpdate: { expected, pin },
    env: {
      ...params.env,
      OPENCLAW_WRAPPER: params.env.OPENCLAW_WRAPPER ?? existing?.environment?.OPENCLAW_WRAPPER,
    },
  };
}
