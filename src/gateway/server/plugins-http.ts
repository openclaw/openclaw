import type { IncomingMessage, ServerResponse } from "node:http";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import {
  PROTECTED_PLUGIN_ROUTE_PREFIXES,
  canonicalizePathForSecurity,
  canonicalizePathVariant,
} from "../security-path.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type PluginRoutePathContext = {
  pathname: string;
  canonicalPath: string;
  candidates: string[];
  malformedEncoding: boolean;
  decodePassLimitReached: boolean;
  rawNormalizedPath: string;
};

export type PluginHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathContext?: PluginRoutePathContext,
) => Promise<boolean>;

type PluginHttpRouteEntry = NonNullable<PluginRegistry["httpRoutes"]>[number];

function normalizeProtectedPrefix(prefix: string): string {
  const collapsed = prefix.toLowerCase().replace(/\/{2,}/g, "/");
  if (collapsed.length <= 1) {
    return collapsed || "/";
  }
  return collapsed.replace(/\/+$/, "");
}

function prefixMatch(pathname: string, prefix: string): boolean {
  return (
    pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}%`)
  );
}

const NORMALIZED_PROTECTED_PLUGIN_ROUTE_PREFIXES =
  PROTECTED_PLUGIN_ROUTE_PREFIXES.map(normalizeProtectedPrefix);

export function isProtectedPluginRoutePathFromContext(context: PluginRoutePathContext): boolean {
  if (
    context.candidates.some((candidate) =>
      NORMALIZED_PROTECTED_PLUGIN_ROUTE_PREFIXES.some((prefix) => prefixMatch(candidate, prefix)),
    )
  ) {
    return true;
  }
  if (!context.malformedEncoding) {
    return false;
  }
  return NORMALIZED_PROTECTED_PLUGIN_ROUTE_PREFIXES.some((prefix) =>
    prefixMatch(context.rawNormalizedPath, prefix),
  );
}

export function resolvePluginRoutePathContext(pathname: string): PluginRoutePathContext {
  const canonical = canonicalizePathForSecurity(pathname);
  return {
    pathname,
    canonicalPath: canonical.canonicalPath,
    candidates: canonical.candidates,
    malformedEncoding: canonical.malformedEncoding,
    decodePassLimitReached: canonical.decodePassLimitReached,
    rawNormalizedPath: canonical.rawNormalizedPath,
  };
}

function doesRouteMatchPath(route: PluginHttpRouteEntry, context: PluginRoutePathContext): boolean {
  const routeCanonicalPath = canonicalizePathVariant(route.path);
  if (route.match === "prefix") {
    return context.candidates.some((candidate) => prefixMatch(candidate, routeCanonicalPath));
  }
  return context.candidates.some((candidate) => candidate === routeCanonicalPath);
}

function findMatchingPluginHttpRoutes(
  registry: PluginRegistry,
  context: PluginRoutePathContext,
): PluginHttpRouteEntry[] {
  const routes = registry.httpRoutes ?? [];
  if (routes.length === 0) {
    return [];
  }
  const exactMatches: PluginHttpRouteEntry[] = [];
  const prefixMatches: PluginHttpRouteEntry[] = [];
  for (const route of routes) {
    if (!doesRouteMatchPath(route, context)) {
      continue;
    }
    if (route.match === "prefix") {
      prefixMatches.push(route);
    } else {
      exactMatches.push(route);
    }
  }
  exactMatches.sort((a, b) => b.path.length - a.path.length);
  prefixMatches.sort((a, b) => b.path.length - a.path.length);
  return [...exactMatches, ...prefixMatches];
}

export function findRegisteredPluginHttpRoute(
  registry: PluginRegistry,
  pathname: string,
): PluginHttpRouteEntry | undefined {
  const pathContext = resolvePluginRoutePathContext(pathname);
  return findMatchingPluginHttpRoutes(registry, pathContext)[0];
}

export function isRegisteredPluginHttpRoutePath(
  registry: PluginRegistry,
  pathname: string,
): boolean {
  return findRegisteredPluginHttpRoute(registry, pathname) !== undefined;
}

export function shouldEnforceGatewayAuthForPluginPath(
  registry: PluginRegistry,
  pathnameOrContext: string | PluginRoutePathContext,
): boolean {
  const pathContext =
    typeof pathnameOrContext === "string"
      ? resolvePluginRoutePathContext(pathnameOrContext)
      : pathnameOrContext;
  if (pathContext.malformedEncoding || pathContext.decodePassLimitReached) {
    return true;
  }
  if (isProtectedPluginRoutePathFromContext(pathContext)) {
    return true;
  }
  const route = findMatchingPluginHttpRoutes(registry, pathContext)[0];
  if (!route) {
    return false;
  }
  return route.auth === "gateway";
}

export function createGatewayPluginRequestHandler(params: {
  registry: PluginRegistry;
  log: SubsystemLogger;
}): PluginHttpRequestHandler {
  const { registry, log } = params;
  return async (req, res, providedPathContext) => {
    const routes = registry.httpRoutes ?? [];
    if (routes.length === 0) {
      return false;
    }

    const pathContext =
      providedPathContext ??
      (() => {
        const url = new URL(req.url ?? "/", "http://localhost");
        return resolvePluginRoutePathContext(url.pathname);
      })();
    const matchedRoutes = findMatchingPluginHttpRoutes(registry, pathContext);
    if (matchedRoutes.length === 0) {
      return false;
    }

    for (const route of matchedRoutes) {
      try {
        const handled = await route.handler(req, res);
        if (handled !== false) {
          return true;
        }
      } catch (err) {
        log.warn(`plugin http route failed (${route.pluginId ?? "unknown"}): ${String(err)}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Internal Server Error");
        }
        return true;
      }
    }
    return false;
  };
}
