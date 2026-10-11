import type { IncomingMessage } from "node:http";
import { ARTIFACT_DOWNLOAD_PATH } from "../../packages/gateway-protocol/src/artifact-download.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "./control-ui-bootstrap-contract.js";
import { controlUiPluginAssetRoot } from "./control-ui-plugin-assets-contract.js";
import { listControlUiPluginTabAuthGrants } from "./control-ui-plugin-tabs.js";
import {
  parseControlUiResourcePath,
  parseControlUiUserAvatarPath,
  resolveAssistantMediaRoutePath,
} from "./control-ui-resource-routes.js";
import {
  isControlUiRootPublicAsset,
  isControlUiVersionedPublicAsset,
} from "./control-ui-root-assets.js";
import { classifyControlUiRequest, isControlUiPluginManagerRequest } from "./control-ui-routing.js";
import {
  classifyGatewayProbePath,
  classifyMcpAppStandalonePath,
  classifyNodeWorkerBundleTransferPath,
  classifyNodeWorkspaceTransferPath,
  classifyWorkerBootstrapArtifactTransferPath,
  classifyWorkerGatewayPath,
} from "./gateway-http-route-contracts.js";
import { resolvePluginRoutePathContext } from "./server/plugins-http/path-context.js";
import { findRegisteredPluginHttpRoute } from "./server/plugins-http/route-match.js";

export type RemoteControlUiHttpRoute =
  | "document"
  | "resource"
  | "assistant-media"
  | "outgoing-media"
  | "artifact"
  | "board"
  | "native-assets"
  | "plugin-panel"
  | "liveness";

/** Selects the permitted owner, never a permissive prefilter before arbitrary plugin dispatch. */
export function resolveRemoteControlUiHttpRoute(
  req: Pick<IncomingMessage, "url" | "method" | "headers">,
  basePath: string,
  scopes: readonly string[],
): RemoteControlUiHttpRoute | undefined {
  const raw = req.url ?? "";
  const url = URL.parse(raw, "http://openclaw.invalid");
  if (
    req.headers["service-worker"] !== undefined ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("\\") ||
    !url ||
    `${url.pathname}${url.search}` !== raw
  ) {
    return undefined;
  }
  const pathname = url.pathname;
  const pathContext = resolvePluginRoutePathContext(pathname);
  // Decode once at the resource owner; ambiguous security paths never select an owner here.
  if (
    pathContext.malformedEncoding ||
    pathContext.decodePassLimitReached ||
    pathContext.candidates.some((candidate) => /(?:^|\/)\.\.?($|\/)|\\|\0/.test(candidate))
  ) {
    return undefined;
  }
  const relative =
    basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))
      ? pathname.slice(basePath.length) || "/"
      : pathname;
  const read = req.method === "GET" || req.method === "HEAD";
  if (pathname === resolveAssistantMediaRoutePath(basePath)) {
    return read ||
      (req.method === "POST" &&
        url.searchParams.get("meta") === "1" &&
        url.searchParams.get("allow") === "1")
      ? "assistant-media"
      : undefined;
  }
  if (!read) {
    return undefined;
  }
  if (pathname === "/healthz") {
    return "liveness";
  }
  for (const candidate of [pathname, relative, ...pathContext.candidates]) {
    if (
      candidate.includes("/.well-known/") ||
      candidate === "/sw.js" ||
      candidate.endsWith("/sw.js") ||
      classifyGatewayProbePath(candidate) !== "outside" ||
      classifyMcpAppStandalonePath(candidate) !== "outside" ||
      classifyWorkerGatewayPath(candidate) !== "outside" ||
      classifyNodeWorkerBundleTransferPath(candidate) !== "outside" ||
      classifyNodeWorkspaceTransferPath(candidate) !== "outside" ||
      classifyWorkerBootstrapArtifactTransferPath(candidate) !== "outside"
    ) {
      return undefined;
    }
  }
  if (relative.startsWith(ARTIFACT_DOWNLOAD_PATH)) {
    return "artifact";
  }
  if (relative.startsWith("/api/chat/media/outgoing/")) {
    return "outgoing-media";
  }
  if (pathname.startsWith("/__openclaw__/board/")) {
    return "board";
  }
  if (pathname.startsWith(controlUiPluginAssetRoot(basePath))) {
    return "native-assets";
  }
  if (
    parseControlUiUserAvatarPath(pathname, basePath).matched ||
    (
      [
        "agentAvatar",
        "catalogIcon",
        "channelAvatar",
        "linkFavicon",
        "pluginIcon",
        "pluginActivityIcon",
        "pluginThemeArt",
        "workspaceIcon",
      ] as const
    ).some((route) => parseControlUiResourcePath(route, pathname, basePath).matched)
  ) {
    return "resource";
  }
  if (isControlUiPluginManagerRequest({ basePath, pathname, method: req.method })) {
    return "document";
  }
  const registry = getPluginRegistryForContext();
  const pluginRoute = registry ? findRegisteredPluginHttpRoute(registry, pathname) : undefined;
  if (pluginRoute) {
    return listControlUiPluginTabAuthGrants(scopes).some(
      (grant) =>
        grant.pluginId === pluginRoute.pluginId &&
        grant.path === pluginRoute.path &&
        grant.match === pluginRoute.match,
    )
      ? "plugin-panel"
      : undefined;
  }
  const reserved = [
    "/api",
    "/v1",
    "/j",
    "/tools",
    "/sessions",
    "/hooks",
    "/oauth",
    "/browser",
    "/desktop",
    "/__openclaw__",
  ];
  if (
    [
      relative,
      ...pathContext.candidates.map((candidate) =>
        basePath && candidate.startsWith(`${basePath.toLowerCase()}/`)
          ? candidate.slice(basePath.length)
          : candidate,
      ),
    ].some((candidate) =>
      reserved.some((root) => candidate === root || candidate.startsWith(`${root}/`)),
    )
  ) {
    return undefined;
  }
  const asset = relative.slice(1);
  if (
    relative === CONTROL_UI_BOOTSTRAP_CONFIG_PATH ||
    relative.startsWith("/assets/") ||
    isControlUiRootPublicAsset(asset) ||
    isControlUiVersionedPublicAsset(asset)
  ) {
    return "document";
  }
  const classification = classifyControlUiRequest({
    basePath,
    pathname,
    search: url.search,
    method: req.method,
    accept: req.headers.accept,
  });
  return classification.kind === "serve" || classification.kind === "redirect"
    ? "document"
    : undefined;
}
