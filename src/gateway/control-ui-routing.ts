import { isReadHttpMethod } from "./control-ui-http-utils.js";

type ControlUiRequestClassification =
  /** Request belongs to another Gateway route. */
  | { kind: "not-control-ui" }
  /** Request targets an explicitly blocked Control UI path. */
  | { kind: "not-found" }
  /** Request should redirect to the canonical slash-terminated UI base path. */
  | { kind: "redirect"; location: string }
  /** Request should be served by the Control UI asset handler. */
  | { kind: "serve" };

const ROOT_MOUNTED_GATEWAY_PROBE_PATHS = new Set(["/health", "/healthz", "/ready", "/readyz"]);

export function classifyControlUiRequest(params: {
  /** Configured Control UI base path; empty means root-mounted SPA. */
  basePath: string;
  /** Parsed request pathname without query string. */
  pathname: string;
  /** Original query string, including leading `?` when present. */
  search: string;
  /** HTTP method used to reject non-read SPA fallback requests. */
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
    // Keep plugin-owned HTTP routes outside the root-mounted Control UI SPA
    // fallback so untrusted plugins cannot claim arbitrary UI paths.
    if (pathname === "/plugins" || pathname.startsWith("/plugins/")) {
      return { kind: "not-control-ui" };
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
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
