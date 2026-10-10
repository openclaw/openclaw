// Runtime-config drift joined the closed v4 health snapshot after strict v4
// decoders shipped, so it reaches only clients that advertise they decode it.
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";

/** Returns health without `runtimeConfig` unless the client advertised `runtime-config-health`. */
export function omitRuntimeConfigHealthForClient<T extends { runtimeConfig?: unknown }>(
  health: T,
  caps: string[] | null | undefined,
): T {
  if (
    health.runtimeConfig === undefined ||
    hasGatewayClientCap(caps, GATEWAY_CLIENT_CAPS.RUNTIME_CONFIG_HEALTH)
  ) {
    return health;
  }
  const projected = { ...health };
  delete projected.runtimeConfig;
  return projected;
}
