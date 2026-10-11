import type { IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import type { TlsOptions } from "node:tls";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { GatewayHttpRequestLifetime } from "./http-request-authority.js";
import type {
  GatewayIngressTransport,
  GatewayUnattributableProxyReporter,
} from "./ingress-attribution.js";
import type { ControlUiRootState } from "./server-control-ui-root.js";
import type { ResolvePluginNodeCapabilityRoute } from "./server-http-plugin-auth.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { HooksRequestHandler } from "./server/hooks-request-handler.js";
import type { PluginHttpRequestHandler } from "./server/plugins-http.js";
import type { PluginRoutePathContext } from "./server/plugins-http/path-context.js";
import type { ReadinessChecker, StartupChecker } from "./server/readiness.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import type { ArtifactTransferHttpCallback } from "./worker-environments/artifact-transfer-http.js";
import type { NodeWorkspaceTransferHttpCallback } from "./worker-environments/node-workspace-transfer-http.js";

type GatewayHttpEndpointHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type GatewayHttpServerOptions = {
  /** Pre-bound listener supplied by the internal test transport. */
  testListener?: HttpServer;
  clients: Set<GatewayWsClient>;
  controlUiEnabled?: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  openAiChatCompletionsEnabled?: boolean;
  openResponsesEnabled?: boolean;
  handleHooksRequest: HooksRequestHandler;
  handleMcpOAuthCallbackRequest?: GatewayHttpEndpointHandler;
  handleWatchNodeRequest?: GatewayHttpEndpointHandler;
  handlePluginRequest?: PluginHttpRequestHandler;
  shouldEnforcePluginGatewayAuth?: (pathContext: PluginRoutePathContext) => boolean;
  isPluginAuthenticatedRoute?: (pathContext: PluginRoutePathContext) => boolean;
  resolvePluginNodeCapabilityRoute?: ResolvePluginNodeCapabilityRoute;
  resolvedAuth: ResolvedGatewayAuth;
  getResolvedAuth?: () => ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  /** Strict limiter for the public join-code exchange, including loopback. */
  joinRateLimiter?: AuthRateLimiter;
  /** Authenticator/dispatcher for the reserved node worker bundle namespace. */
  handleNodeWorkerBundleTransferRequest?: ArtifactTransferHttpCallback;
  handleWorkerBootstrapArtifactTransferRequest?: ArtifactTransferHttpCallback;
  /** Authenticator/dispatcher for the reserved node workspace transfer namespace. */
  handleNodeWorkspaceTransferRequest?: NodeWorkspaceTransferHttpCallback;
  getReadiness?: ReadinessChecker;
  getStartup?: StartupChecker;
  getRuntimeConfig?: () => OpenClawConfig;
  getGatewayRequestContext?: () => GatewayRequestContext | undefined;
  httpRequestLifetime?: GatewayHttpRequestLifetime;
  isStartupPluginRuntimeReady?: () => boolean;
  isTerminalEnabled?: () => boolean;
  tlsOptions?: TlsOptions;
  ingressTransport?: GatewayIngressTransport;
  reportUnattributableProxy?: GatewayUnattributableProxyReporter;
};

export type GatewayHttpRequestHandler = ((
  req: IncomingMessage,
  res: ServerResponse,
  expectation?: "continue" | "reject",
) => Promise<void>) & { dispose(): void };
