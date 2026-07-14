import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { AuthorizedGatewayHttpRequest } from "../http-auth-utils.js";
import type { PluginNodeCapabilitySurface } from "../plugin-node-capability.js";
import type { PluginRoutePathContext } from "./plugins-http/path-context.js";

type PluginDispatchContext = {
  gatewayAuthSatisfied?: boolean;
  gatewayRequestAuth?: AuthorizedGatewayHttpRequest;
  gatewayRequestClientIp?: string;
  gatewayRequestOperatorScopes?: readonly string[];
};

export type PluginHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: PluginDispatchContext,
) => Promise<boolean>;

export type PluginHttpUpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: PluginDispatchContext,
) => Promise<boolean>;

export type ResolvePluginNodeCapabilityRoute = (
  pathContext: PluginRoutePathContext,
) => PluginNodeCapabilitySurface | undefined;

export type WatchNodeHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;
