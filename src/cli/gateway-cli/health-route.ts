import { isAbortError } from "../../infra/abort-signal.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";

/** Run the successful JSON path without loading text presentation modules. */
export async function runGatewayHealthJsonRoute(
  args: {
    rpc: Parameters<typeof import("../gateway-rpc.js").callGatewayFromCliWithTransport>[1];
    localPortOverride?: number;
    signal?: AbortSignal;
  },
  runtime: RuntimeEnv,
): Promise<void> {
  if (args.signal?.aborted) {
    return;
  }
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
    const result = await callGatewayFromCliWithTransport("health", rpc, undefined, {
      defaultTimeoutMs: 10_000,
      sharedStateMode: "read-only",
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (!args.signal?.aborted) {
      writeRuntimeJson(runtime, result);
    }
  } catch (error) {
    if (args.signal?.aborted && (error === args.signal.reason || isAbortError(error))) {
      return;
    }
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
      ...(args.signal ? { signal: args.signal } : {}),
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
