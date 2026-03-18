import type { GatewayAuthChoice, GatewayBind, TailscaleMode } from "./onboard-types.js";

export type GatewayExposureAuthMode = GatewayAuthChoice | "trusted-proxy";

export function normalizeGatewayExposureSafety(params: {
  bind: GatewayBind;
  authMode: GatewayExposureAuthMode;
  tailscaleMode: TailscaleMode;
  customBindHost?: string;
}): {
  bind: GatewayBind;
  authMode: GatewayExposureAuthMode;
  customBindHost?: string;
  adjustments: {
    bindForcedToLoopback: boolean;
    authForcedToPassword: boolean;
  };
} {
  let bind = params.bind;
  let authMode = params.authMode;
  let customBindHost = params.customBindHost?.trim() || undefined;

  const bindForcedToLoopback = params.tailscaleMode !== "off" && bind !== "loopback";
  if (bindForcedToLoopback) {
    bind = "loopback";
    customBindHost = undefined;
  } else if (bind !== "custom") {
    customBindHost = undefined;
  }

  const authForcedToPassword = params.tailscaleMode === "funnel" && authMode !== "password";
  if (authForcedToPassword) {
    authMode = "password";
  }

  return {
    bind,
    authMode,
    customBindHost,
    adjustments: {
      bindForcedToLoopback,
      authForcedToPassword,
    },
  };
}
