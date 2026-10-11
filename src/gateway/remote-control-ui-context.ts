import type { IncomingMessage } from "node:http";
import { isRedactedSecretValue } from "../config/redact-sentinel.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { readGatewayIngressTransport } from "./ingress-attribution.js";

/** Core-retained grant authority; browser headers cannot create this context. */
export type RemoteControlUiIngressContext = Readonly<{
  pluginId: string;
  audienceId: string;
  publicOrigin: string;
  sandboxOrigin: string;
  operatorScopeCeiling: readonly ("operator.read" | "operator.write")[];
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
): string | undefined {
  if (cfg.gateway?.roles) {
    return "Remote Control UI ingress does not support gateway.roles. Use a Gateway without role configuration until remote verified-user admission is supported.";
  }
  if (auth.mode !== "token" && auth.mode !== "password") {
    return "Remote Control UI ingress requires gateway.auth.mode token or password. Configure shared Gateway authentication locally; browsers must connect with a paired device token.";
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
  const error = remoteControlUiGatewayAuthError(auth, cfg);
  if (error) {
    throw new Error(error);
  }
}
