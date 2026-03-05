import { isReadHttpMethod } from "./control-ui-http-utils.js";

export type ControlUiRequestClassification =
  | { kind: "not-control-ui" }
  | { kind: "not-found" }
  | { kind: "redirect"; location: string }
  | { kind: "serve" };

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
