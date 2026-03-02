import { A2UI_PATH, CANVAS_HOST_PATH, CANVAS_WS_PATH } from "../../canvas-host/a2ui.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../control-ui-contract.js";
import { canonicalizePathVariant, isPathProtectedByPrefixes } from "../security-path.js";

const CORE_EXACT_PATHS = new Set(
  [
    "/",
    "/agents",
    "/channels",
    "/chat",
    "/config",
    "/cron",
    "/debug",
    "/health",
    "/healthz",
    "/instances",
    "/logs",
    "/nodes",
    "/overview",
    "/ready",
    "/readyz",
    "/sessions",
    "/skills",
    "/tools/invoke",
    "/usage",
    "/v1/chat/completions",
    "/v1/responses",
    A2UI_PATH,
    CANVAS_HOST_PATH,
    CANVAS_WS_PATH,
    CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  ].map((path) => canonicalizePathVariant(path)),
);

const CORE_PREFIXES = [
  "/api",
  "/assets",
  "/avatar",
  "/plugins",
  "/ui",
  A2UI_PATH,
  CANVAS_HOST_PATH,
] as const;

export function isCoreOwnedHttpPath(pathname: string): boolean {
  const canonicalPath = canonicalizePathVariant(pathname);
  return (
    CORE_EXACT_PATHS.has(canonicalPath) || isPathProtectedByPrefixes(canonicalPath, CORE_PREFIXES)
  );
}

export function canPluginWebhookRouteBypassControlUi(pathname: string): boolean {
  return !isCoreOwnedHttpPath(pathname);
}
