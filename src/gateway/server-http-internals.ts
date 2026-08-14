// Shared server-http.ts internals. Kept in their own module so server-http.ts
// stays under the repository max-lines budget; behavior is unchanged (the lazy
// getters defer each import until first use).
import type { IncomingMessage, ServerResponse } from "node:http";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { PluginGatewayDispatchContext } from "./server-http-plugin-auth.js";
import type { PluginRoutePathContext } from "./server/plugins-http/path-context.js";

export const getControlUiModule = createLazyRuntimeModule(() => import("./control-ui.js"));
export const getControlUiPluginAssetsModule = createLazyRuntimeModule(
  () => import("./control-ui-plugin-assets.js"),
);
export const getCanvasServeModule = createLazyRuntimeModule(
  () => import("../canvas/serve.runtime.js"),
);
export const getBoardHttpModule = createLazyRuntimeModule(() => import("./board-http.js"));
export const getEmbeddingsHttpModule = createLazyRuntimeModule(
  () => import("./embeddings-http.js"),
);
export const getManagedMediaAttachmentsModule = createLazyRuntimeModule(
  () => import("./managed-image-attachments.js"),
);
export const getMcpAppStandaloneModule = createLazyRuntimeModule(
  () => import("./mcp-app-standalone.js"),
);
export const getPluginIconHttpModule = createLazyRuntimeModule(
  () => import("./plugin-icon-http.js"),
);
export const getWorkspaceIconHttpModule = createLazyRuntimeModule(
  () => import("./workspace-icon-http.js"),
);
export const getChannelAvatarHttpModule = createLazyRuntimeModule(
  () => import("./channel-avatar-http.js"),
);
export const getModelsHttpModule = createLazyRuntimeModule(() => import("./models-http.js"));
export const getOpenAiHttpModule = createLazyRuntimeModule(() => import("./openai-http.js"));
export const getOpenResponsesHttpModule = createLazyRuntimeModule(
  () => import("./openresponses-http.js"),
);
export const getSessionHistoryHttpModule = createLazyRuntimeModule(
  () => import("./sessions-history-http.js"),
);
export const getSessionKillHttpModule = createLazyRuntimeModule(
  () => import("./session-kill-http.js"),
);
export const getToolsInvokeHttpModule = createLazyRuntimeModule(
  () => import("./tools-invoke-http.js"),
);
export const getUserProfilesHttpModule = createLazyRuntimeModule(
  () => import("./user-profiles-http.js"),
);
export const getDevicePairingJoinHttpModule = createLazyRuntimeModule(
  () => import("./device-pairing-join-http.js"),
);
export const getPluginNodeCapabilityAuthModule = createLazyRuntimeModule(
  () => import("./server/plugin-node-capability-auth.js"),
);
export const getHttpAuthUtilsModule = createLazyRuntimeModule(() => import("./http-auth-utils.js"));
export const getPluginRouteRuntimeScopesModule = createLazyRuntimeModule(
  () => import("./server/plugin-route-runtime-scopes.js"),
);

export type PluginHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: PluginGatewayDispatchContext,
) => Promise<boolean>;
export type WatchNodeHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;
export type McpOAuthCallbackHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;
export type GatewayHttpRequestStage = () => Promise<boolean> | boolean;
