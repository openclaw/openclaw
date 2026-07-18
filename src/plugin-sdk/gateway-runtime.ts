// Public gateway/client helpers for plugins that talk to the host gateway surface.

import { startGatewayClientWhenEventLoopReady as startHostGatewayClientWhenEventLoopReady } from "../gateway/client-start-readiness.js";
import { GatewayClient as HostGatewayClient } from "../gateway/client.js";

export * from "../gateway/channel-status-patches.js";
export { addGatewayClientOptions, callGatewayFromCli } from "../cli/gateway-rpc.js";
export type { GatewayRpcOpts } from "../cli/gateway-rpc.js";
export { isLoopbackHost } from "../gateway/net.js";
export async function resolveAdvertisedLanHost(): Promise<string | null> {
  const runtime = await import("../infra/advertised-lan-host.js");
  return await runtime.resolveAdvertisedLanHost();
}
export { resolveHostedPluginSurfaceUrl } from "../gateway/hosted-plugin-surface-url.js";
export type { HostedPluginSurfaceUrlParams } from "../gateway/hosted-plugin-surface-url.js";
export {
  buildPluginNodeCapabilityScopedHostUrl,
  DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS,
  mintPluginNodeCapabilityToken,
  normalizePluginNodeCapabilityScopedUrl,
  PLUGIN_NODE_CAPABILITY_PATH_PREFIX,
} from "../gateway/plugin-node-capability.js";
export type {
  NormalizedPluginNodeCapabilityUrl,
  PluginNodeCapabilitySurface,
} from "../gateway/plugin-node-capability.js";
export {
  isNodeCommandAllowed,
  resolveNodeCommandAllowlist,
} from "../gateway/node-command-policy.js";
export { resolveNodeFromNodeList, resolveNodeIdFromNodeList } from "../shared/node-resolve.js";
export type { NodeMatchCandidate } from "../shared/node-match.js";
export {
  respondUnavailableOnNodeInvokeError,
  safeParseJson,
} from "../gateway/server-methods/nodes.helpers.js";
export type { GatewayRequestHandlers } from "../gateway/server-methods/types.js";
export { ensureGatewayStartupAuth } from "../gateway/startup-auth.js";
export { resolveGatewayAuth } from "../gateway/auth.js";
export { rawDataToString } from "../infra/ws.js";
export {
  createOperatorApprovalsGatewayClient,
  withOperatorApprovalsGatewayClient,
} from "../gateway/operator-approvals-client.js";
export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";

export { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
export type {
  ErrorCode as GatewayRuntimeErrorCode,
  ErrorShape as GatewayRuntimeErrorShape,
} from "../../packages/gateway-protocol/src/index.js";

export type NodeSession = {
  nodeId: string;
  connId: string;
  client: unknown;
  clientId?: string;
  clientMode?: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  remoteIp?: string;
  declaredCaps: string[];
  sessionCapsCeiling?: string[];
  caps: string[];
  declaredCommands: string[];
  sessionCommandsCeiling?: string[];
  commands: string[];
  declaredPermissions?: Record<string, boolean>;
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  connectedAtMs: number;
};

export type GatewayEventFrameStateVersion = {
  presence: number;
  health: number;
};

export type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: GatewayEventFrameStateVersion;
};

export type GatewayClientRequestOptions = {
  expectFinal?: boolean;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  onAccepted?: (payload: unknown) => void;
};

export type GatewayClientOptions = {
  url?: string;
  origin?: string;
  connectChallengeTimeoutMs?: number;
  connectDelayMs?: number;
  preauthHandshakeTimeoutMs?: number;
  tickWatchMinIntervalMs?: number;
  tickWatchTimeoutMs?: number;
  requestTimeoutMs?: number;
  token?: string;
  bootstrapToken?: string;
  deviceToken?: string;
  password?: string;
  approvalRuntimeToken?: string;
  agentRuntimeIdentityToken?: string;
  instanceId?: string;
  clientName?: string;
  clientDisplayName?: string;
  clientVersion?: string;
  platform?: string;
  deviceFamily?: string;
  mode?: string;
  role?: string;
  scopes?: string[];
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  env?: NodeJS.ProcessEnv;
  deviceIdentity?: unknown;
  hostDeps?: unknown;
  minProtocol?: number;
  maxProtocol?: number;
  tlsFingerprint?: string;
  onEvent?: (evt: EventFrame) => void;
  onHelloOk?: (hello: unknown) => void;
  onConnectError?: (err: Error) => void;
  onReconnectPaused?: (info: { code: number; reason: string; detailCode: string | null }) => void;
  onClose?: (code: number, reason: string, info?: unknown) => void;
  onGap?: (info: { expected: number; received: number }) => void;
};

export type GatewayClientConnectionMetadata = {
  clientName?: string;
  hasDeviceIdentity: boolean;
  mode?: string;
  preauthHandshakeTimeoutMs?: number;
};

export type GatewayClient = {
  start(): void;
  stop(): void;
  stopAndWait(opts?: { timeoutMs?: number }): Promise<void>;
  request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: GatewayClientRequestOptions,
  ): Promise<T>;
  getConnectionMetadata(): GatewayClientConnectionMetadata;
};

export const GatewayClient = HostGatewayClient as new (opts: GatewayClientOptions) => GatewayClient;

export type GatewayClientStartable = {
  start(): void;
};

export type GatewayClientStartReadinessOptions = {
  timeoutMs?: number;
  clientOptions?: Pick<
    GatewayClientOptions,
    "connectChallengeTimeoutMs" | "connectDelayMs" | "env" | "preauthHandshakeTimeoutMs"
  >;
  signal?: AbortSignal;
};

export type EventLoopReadyResult = {
  ready: boolean;
  elapsedMs: number;
  maxDriftMs: number;
  checks: number;
  aborted: boolean;
};

export function startGatewayClientWhenEventLoopReady(
  client: GatewayClientStartable,
  options: GatewayClientStartReadinessOptions = {},
): Promise<EventLoopReadyResult> {
  return startHostGatewayClientWhenEventLoopReady(client, options);
}
