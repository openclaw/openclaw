import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

export type GatewayControlUiIngressHost = {
  controlUiBasePath: string;
  getResolvedAuth: () => ResolvedGatewayAuth;
  getRuntimeConfig: () => OpenClawConfig;
  resolveGatewayContext?: GatewayContextResolver;
  handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>;
  handleSandboxRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  signal: AbortSignal;
};

const hosts = new WeakMap<GatewayContextResolver, GatewayControlUiIngressHost>();

/** The listener owner publishes its adapters before plugin services start. */
export function bindGatewayControlUiIngressHost(
  owner: GatewayContextResolver,
  host: GatewayControlUiIngressHost,
): void {
  hosts.set(owner, host);
}

export function getGatewayControlUiIngressHost(
  owner: GatewayContextResolver,
): GatewayControlUiIngressHost | undefined {
  return hosts.get(owner);
}
