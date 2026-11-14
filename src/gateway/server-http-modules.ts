import { createLazyRuntimeModule, createLazyRuntimeNamedExport } from "../shared/lazy-runtime.js";
import { resolveAssistantMediaRoutePath } from "./control-ui-resource-routes.js";

export const getControlUiModule = createLazyRuntimeModule(() => import("./control-ui.js"));
const loadControlUiAssistantMediaHandler = createLazyRuntimeNamedExport(
  () => import("./control-ui-assistant-media-http.js"),
  "handleControlUiAssistantMediaRequest",
);

export function getControlUiAssistantMediaHandler(urlRaw: string | undefined, basePath?: string) {
  // Plugins can rewrite the URL after request stages are selected. Classify before importing.
  const url = urlRaw ? new URL(urlRaw, "http://localhost") : undefined;
  return url?.pathname === resolveAssistantMediaRoutePath(basePath)
    ? loadControlUiAssistantMediaHandler()
    : undefined;
}
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
export const getArtifactDownloadsModule = createLazyRuntimeModule(
  () => import("./artifact-downloads.js"),
);
export const getMcpAppStandaloneModule = createLazyRuntimeModule(
  () => import("./mcp-app-standalone.js"),
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
export const getBrowserPairHttpModule = createLazyRuntimeModule(
  () => import("./browser-pair-http.js"),
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

export const getNativeHookRelayModule = createLazyRuntimeModule(
  () => import("./native-hook-relay-http.js"),
);
