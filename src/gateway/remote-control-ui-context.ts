import type { IncomingMessage } from "node:http";
import { isRedactedSecretValue } from "../config/redact-sentinel.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayIngressPrincipal } from "../plugins/gateway-ingress.types.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { readGatewayIngressTransport } from "./ingress-attribution.js";
import type { RemoteIngressPrincipalSnapshot } from "./remote-ingress-principal.js";

/** Core-retained grant authority; browser headers cannot create this context. */
export type RemoteControlUiIngressContext = Readonly<{
  pluginId: string;
  audienceId: string;
  publicOrigin: string;
  sandboxOrigin: string;
  principal: GatewayIngressPrincipal;
  operatorScopeCeiling: readonly string[];
  resolvePrincipal(): RemoteIngressPrincipalSnapshot;
  frameAncestors: readonly string[];
  signal: AbortSignal;
  assertCurrent(): void;
  trackWork<T>(work: Promise<T>): Promise<T>;
}>;

export function getRemoteControlUiIngressContext(
  req: IncomingMessage,
): RemoteControlUiIngressContext | undefined {
  const transport = readGatewayIngressTransport(req);
  return transport?.kind === "remote-forwarded" ? transport.context : undefined;
}

export function assertRemoteControlUiIngressCurrent(
  context: RemoteControlUiIngressContext | undefined,
): void {
  context?.signal.throwIfAborted();
  context?.assertCurrent();
}

export function hasCurrentRemoteControlUiIngress(
  context: RemoteControlUiIngressContext | undefined,
): boolean {
  try {
    assertRemoteControlUiIngressCurrent(context);
    return true;
  } catch {
    return false;
  }
}

export function remoteControlUiGatewayAuthError(
  auth: ResolvedGatewayAuth,
  cfg: OpenClawConfig,
  principal: GatewayIngressPrincipal = { kind: "owner" },
): string | undefined {
  if (principal.kind === "person") {
    const proxy = auth.trustedProxy;
    if (
      auth.mode !== "trusted-proxy" ||
      !cfg.gateway?.roles ||
      proxy?.userHeader.trim().toLowerCase() !== "cf-access-authenticated-user-email" ||
      !proxy.requiredHeaders?.some(
        (header) => header.trim().toLowerCase() === "cf-access-jwt-assertion",
      )
    ) {
      return "Person ingress requires trusted-proxy authentication with verified Cloudflare Access profiles and gateway.roles. Approve the grant from the person's authenticated Gateway Control UI.";
    }
    return undefined;
  }
  if (cfg.gateway?.roles) {
    return "Owner ingress does not support gateway.roles. Use a person-bound grant approved in the Gateway Control UI.";
  }
  if (auth.mode !== "token" && auth.mode !== "password") {
    return "Owner ingress requires gateway.auth.mode token or password without gateway.roles. Trusted-proxy Gateways require a person-bound grant.";
  }
  if (isRedactedSecretValue(auth[auth.mode])) {
    return "Remote Control UI ingress cannot use a redacted Gateway credential. Replace the configured token or password with its real value locally before opening ingress.";
  }
  return undefined;
}

export function assertRemoteControlUiGatewayAuth(
  context: RemoteControlUiIngressContext | undefined,
  auth: ResolvedGatewayAuth,
  cfg: OpenClawConfig,
): void {
  if (!context) {
    return;
  }
  assertRemoteControlUiIngressCurrent(context);
  const error = remoteControlUiGatewayAuthError(auth, cfg, context.principal);
  if (error) {
    throw new Error(error);
  }
}
