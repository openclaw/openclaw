import { isReadHttpMethod } from "./control-ui-http-utils.js";

export type ControlUiRequestClassification =
  | { kind: "not-control-ui" }
  | { kind: "not-found" }
  | { kind: "redirect"; location: string }
  | { kind: "serve" };

const ROOT_MOUNTED_GATEWAY_PROBE_PATHS = new Set(["/health", "/healthz", "/ready", "/readyz"]);
const ROOT_MOUNTED_NON_UI_PREFIXES = new Set(["/api", "/plugins"]);

function isRootMountedGatewayReadPath(pathname: string): boolean {
  if (
    pathname === "/v1/models" ||
    pathname.startsWith("/v1/models/") ||
    /^\/sessions\/[^/]+\/history$/.test(pathname)
  ) {
    return true;
  }
  for (const prefix of ROOT_MOUNTED_NON_UI_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

export function classifyControlUiRequest(params: {
  basePath: string;
  pathname: string;
  search: string;
  method: string | undefined;
}): ControlUiRequestClassification {
  const { basePath, pathname, search, method } = params;
  if (!basePath) {
    if (pathname === "/ui" || pathname.startsWith("/ui/")) {
      return { kind: "not-found" };
    }
    // Keep core probe routes outside the root-mounted SPA catch-all so the
    // gateway probe handler can answer them even when the Control UI owns `/`.
    if (ROOT_MOUNTED_GATEWAY_PROBE_PATHS.has(pathname)) {
      return { kind: "not-control-ui" };
    }
    // Keep gateway-owned read routes outside the root-mounted Control UI SPA
    // fallback so the host gate does not block non-UI HTTP surfaces.
    if (isRootMountedGatewayReadPath(pathname)) {
      return { kind: "not-control-ui" };
    }
    if (!isReadHttpMethod(method)) {
      return { kind: "not-control-ui" };
    }
    return { kind: "serve" };
  }

  if (!pathname.startsWith(`${basePath}/`) && pathname !== basePath) {
    return { kind: "not-control-ui" };
  }
  if (!isReadHttpMethod(method)) {
    return { kind: "not-control-ui" };
  }
  if (pathname === basePath) {
    return { kind: "redirect", location: `${basePath}/${search}` };
  }
  return { kind: "serve" };
}
