export type GatewayWsLogStyle = "auto" | "full" | "compact";

let gatewayWsLogStyle: GatewayWsLogStyle = "auto";

/** Overrides the gateway/ws console log style for CLI flags and tests. */
export function setGatewayWsLogStyle(style: GatewayWsLogStyle): void {
  gatewayWsLogStyle = style;
}

/** Returns the current gateway/ws console log style. */
export function getGatewayWsLogStyle(): GatewayWsLogStyle {
  return gatewayWsLogStyle;
}

export const DEFAULT_WS_SLOW_MS = 50;
