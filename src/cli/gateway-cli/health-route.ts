import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";

/** Run the successful JSON path without loading text presentation modules. */
export async function runGatewayHealthJsonRoute(
  args: {
    rpc: Parameters<typeof import("../gateway-rpc.js").callGatewayFromCliWithTransport>[1];
    localPortOverride?: number;
  },
  runtime: RuntimeEnv,
): Promise<void> {
  let rpc = args.rpc;
  if (args.localPortOverride !== undefined) {
    const { readNonObservingHealthConfig } = await import("../../commands/health.js");
    const config = await readNonObservingHealthConfig();
    rpc = {
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
  try {
    const { callGatewayFromCliWithTransport } = await import("../gateway-rpc.js");
    writeRuntimeJson(
      runtime,
      await callGatewayFromCliWithTransport("health", rpc, undefined, {
        defaultTimeoutMs: 10_000,
        sharedStateMode: "read-only",
      }),
    );
  } catch (error) {
    const {
      emitReachableGatewayAuthDiagnostic,
      emitGatewayHealthErrorJson,
      readNonObservingHealthConfig,
    } = await import("../../commands/health.js");
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
    if (emitGatewayHealthErrorJson(error, runtime)) {
      return;
    }
    throw error;
  }
}
