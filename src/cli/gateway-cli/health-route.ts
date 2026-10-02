// Route-first machine-readable Gateway health command.
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";

type GatewayHealthRpcOpts = Parameters<
  typeof import("../gateway-rpc.js").callGatewayFromCliWithTransport
>[1];

type GatewayHealthJsonRouteArgs = {
  rpc: GatewayHealthRpcOpts;
  localPortOverride?: number;
};

async function resolveRouteRpcOptions(
  args: GatewayHealthJsonRouteArgs,
): Promise<GatewayHealthRpcOpts> {
  if (args.localPortOverride === undefined) {
    return args.rpc;
  }
  const { readNonObservingHealthConfig } = await import("../../commands/health.js");
  const config = await readNonObservingHealthConfig();
  return {
    ...args.rpc,
    localPortOverride: args.localPortOverride,
    config: {
      ...config,
      gateway: {
        ...config.gateway,
        mode: "local",
        port: args.localPortOverride,
      },
    },
  };
}

/** Run the successful JSON path without loading text presentation modules. */
export async function runGatewayHealthJsonRoute(
  args: GatewayHealthJsonRouteArgs,
  runtime: RuntimeEnv,
): Promise<void> {
  let rpc: GatewayHealthRpcOpts | undefined;
  try {
    rpc = await resolveRouteRpcOptions(args);
    const { callGatewayFromCliWithTransport } = await import("../gateway-rpc.js");
    writeRuntimeJson(
      runtime,
      await callGatewayFromCliWithTransport("health", rpc, undefined, {
        defaultTimeoutMs: 10_000,
        sharedStateMode: "read-only",
      }),
    );
  } catch (error) {
    if (!rpc) {
      throw error;
    }
    const [
      { emitReachableGatewayAuthDiagnostic, readNonObservingHealthConfig },
      {
        formatGatewayAuthErrorJson,
        formatGatewayClientRequestErrorJson,
        formatGatewayTransportErrorJson,
      },
    ] = await Promise.all([import("../../commands/health.js"), import("../../gateway/call.js")]);
    const handled = await emitReachableGatewayAuthDiagnostic({
      error,
      config: rpc.config ?? (await readNonObservingHealthConfig()),
      runtime,
      timeoutMs: Number(rpc.timeout ?? "10000"),
      token: rpc.token,
      password: rpc.password,
      localPortOverride: rpc.localPortOverride,
      json: true,
    });
    if (handled) {
      return;
    }
    const payload =
      formatGatewayAuthErrorJson(error) ??
      formatGatewayClientRequestErrorJson(error) ??
      formatGatewayTransportErrorJson(error);
    if (payload) {
      writeRuntimeJson(runtime, payload);
      runtime.exit(1);
      return;
    }
    throw error;
  }
}
