// Settings the OpenClaw ID service derives from config: what a tunnel runtime
// needs and which config changes restart the running owner.
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import type { TunnelRuntimeSettings } from "./tunnel-runtime.js";

/** The settings a tunnel runtime needs, or the config keys still missing. */
export function resolveSettings(
  config: GatewayOpenClawIdConfig,
  stateDir: string,
): TunnelRuntimeSettings | { missing: Array<keyof GatewayOpenClawIdConfig> } {
  if (!config.relayUrl) {
    return { missing: ["relayUrl"] };
  }
  return {
    stateDir,
    relayUrl: config.relayUrl,
    // Browsers reach a linked claw over the HTTPS loader origin.
    forwardedProto: config.loaderDomain ? "https" : "http",
  };
}

/** Whether two tunnel runtimes would run with the same settings. */
export function sameSettings(a: TunnelRuntimeSettings, b: TunnelRuntimeSettings): boolean {
  return (
    a.stateDir === b.stateDir && a.relayUrl === b.relayUrl && a.forwardedProto === b.forwardedProto
  );
}

/** The config the running owner was started with, beyond the tunnel settings: a change restarts it. */
export function appliedConfigKey(config: GatewayOpenClawIdConfig): string {
  return JSON.stringify([
    config.discoveryUrl ?? null,
    config.loaderDomain ?? null,
    config.ownerDeviceInactivityDays ?? null,
    config.memberDeviceInactivityDays ?? null,
  ]);
}
