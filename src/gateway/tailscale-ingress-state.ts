export type GatewayTailscaleIngressMode = "off" | "serve" | "funnel";

const effectiveModesByPort = new Map<number, GatewayTailscaleIngressMode>();

/** Record the process-stable Tailscale route that actually owns a Gateway port. */
export function setGatewayTailscaleIngressMode(
  port: number,
  mode: Exclude<GatewayTailscaleIngressMode, "off">,
): void {
  effectiveModesByPort.set(port, mode);
}

export function clearGatewayTailscaleIngressMode(port: number): void {
  effectiveModesByPort.delete(port);
}

export function readGatewayTailscaleIngressMode(
  port: number | undefined,
): GatewayTailscaleIngressMode {
  return port === undefined ? "off" : (effectiveModesByPort.get(port) ?? "off");
}
