// Control UI route classifier for base-path and root-mounted SPA serving.
import { isReadHttpMethod } from "./control-ui-http-utils.js";
import { canonicalizePathForSecurity } from "./security-path.js";

type ControlUiRequestClassification =
  | { kind: "not-control-ui" }
  | { kind: "not-found" }
  | { kind: "redirect"; location: string }
  | { kind: "serve" };

const ROOT_MOUNTED_GATEWAY_PROBE_PATHS = new Set(["/health", "/healthz", "/ready", "/readyz"]);
const ROOT_MOUNTED_GATEWAY_ROUTE_PREFIXES = ["/api", "/plugins"] as const;

function matchesCanonicalExactPath(pathname: string, paths: ReadonlySet<string>): boolean {
  const canonical = canonicalizePathForSecurity(pathname);
  if (canonical.candidates.some((candidate) => paths.has(candidate))) {
    return true;
  }
  if (!canonical.malformedEncoding && !canonical.decodePassLimitReached) {
    return false;
  }
  return Array.from(paths).some(
    (path) =>
      canonical.rawNormalizedPath === path || canonical.rawNormalizedPath.startsWith(`${path}%`),
  );
}

function matchesCanonicalPrefixPath(pathname: string, prefixes: readonly string[]): boolean {
  const canonical = canonicalizePathForSecurity(pathname);
  if (
    canonical.candidates.some((candidate) =>
      prefixes.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`)),
    )
  ) {
    return true;
  }
  if (!canonical.malformedEncoding && !canonical.decodePassLimitReached) {
    return false;
  }
  return prefixes.some(
    (prefix) =>
      canonical.rawNormalizedPath === prefix ||
      canonical.rawNormalizedPath.startsWith(`${prefix}/`) ||
      canonical.rawNormalizedPath.startsWith(`${prefix}%`),
  );
}

/** Classify an HTTP request as Control UI serving, redirect, 404, or non-Control-UI. */
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
    if (matchesCanonicalExactPath(pathname, ROOT_MOUNTED_GATEWAY_PROBE_PATHS)) {
      return { kind: "not-control-ui" };
    }
    // Keep plugin-owned HTTP routes outside the root-mounted Control UI SPA
    // fallback so untrusted plugins cannot claim arbitrary UI paths.
    if (matchesCanonicalPrefixPath(pathname, ROOT_MOUNTED_GATEWAY_ROUTE_PREFIXES)) {
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
