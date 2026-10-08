import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import type { McpAppDiscoveredServer } from "../../../src/shared/mcp-app-extensions.js";

/** Internal server names and vendor plugin identities are different namespaces. */
export type McpAppRoute = { toolName: string; deepLink: string } & (
  | { kind: "server"; serverName: string }
  | { kind: "plugin"; pluginId: string; marketplace?: string }
);

function validMcpAppDeepLink(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("#") &&
    !value.includes("\\") &&
    !value.includes(" ") &&
    !containsAsciiControlCharacter(value)
  );
}

export function parseMcpAppLink(value: string): McpAppRoute | null {
  const url = URL.parse(value);
  if (!url) {
    return null;
  }
  const native =
    (url.protocol === "codex:" || url.protocol === "chatgpt:" || url.protocol === "openclaw:") &&
    url.hostname === "plugins";
  const web = url.protocol === "https:" && url.hostname === "chatgpt.com";
  if ((!native && !web) || url.hash || url.username || url.password || url.port) {
    return null;
  }
  const match = (native ? url.pathname : url.pathname.replace(/^\/plugins(?=\/)/u, "")).match(
    /^\/([^/]+)\/app\/([^/]+)\/?$/u,
  );
  if (!match?.[1] || !match[2] || (web && !url.pathname.startsWith("/plugins/"))) {
    return null;
  }
  try {
    // Split before decoding: a percent-encoded @ belongs to the plugin id.
    const parts = native ? match[1].split("@") : [match[1]];
    if (parts.length > 2 || !parts[0] || (parts.length === 2 && !parts[1])) {
      return null;
    }
    const pluginId = decodeURIComponent(parts[0]);
    const marketplace = parts[1] ? decodeURIComponent(parts[1]) : undefined;
    const toolName = decodeURIComponent(match[2]);
    const deepLink = url.searchParams.get("path") ?? "/";
    if (!pluginId || !toolName || !validMcpAppDeepLink(deepLink)) {
      return null;
    }
    return {
      kind: "plugin",
      pluginId,
      ...(marketplace ? { marketplace } : {}),
      toolName,
      deepLink,
    };
  } catch {
    return null;
  }
}

export function mcpAppRouteSearch(route: McpAppRoute): string {
  const params = new URLSearchParams({ tool: route.toolName, path: route.deepLink });
  if (route.kind === "server") {
    params.set("server", route.serverName);
  } else {
    params.set("plugin", route.pluginId);
    if (route.marketplace) {
      params.set("marketplace", route.marketplace);
    }
  }
  return `?${params}`;
}

export function mcpAppRouteFromSearch(search: string): McpAppRoute | null {
  const params = new URLSearchParams(search);
  const serverName = params.get("server");
  const pluginId = params.get("plugin");
  const marketplace = params.get("marketplace");
  const toolName = params.get("tool");
  const deepLink = params.get("path") ?? "/";
  if (!toolName || !validMcpAppDeepLink(deepLink) || Boolean(serverName) === Boolean(pluginId)) {
    return null;
  }
  if (serverName) {
    return marketplace ? null : { kind: "server", serverName, toolName, deepLink };
  }
  return pluginId
    ? { kind: "plugin", pluginId, ...(marketplace ? { marketplace } : {}), toolName, deepLink }
    : null;
}

/** Discovery owns this mapping. Ambiguous/missing identities are not guessed. */
export function resolveMcpAppRouteServer(
  servers: readonly McpAppDiscoveredServer[],
  route: McpAppRoute,
  settings = false,
): McpAppDiscoveredServer | undefined {
  const matches = servers.filter((server) => {
    const identityMatches =
      route.kind === "server"
        ? server.serverName === route.serverName
        : server.pluginId === route.pluginId &&
          (server.marketplace ?? undefined) === route.marketplace;
    return (
      identityMatches &&
      (server.entrypoints.some(
        (entry) =>
          entry.toolName === route.toolName &&
          (entry.entrypoint.type === "global" ||
            (settings && entry.entrypoint.type === "settings")),
      ) ||
        (settings && server.settings?.readTool === route.toolName))
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}
