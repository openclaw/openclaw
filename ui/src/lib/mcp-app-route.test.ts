import { describe, expect, it } from "vitest";
import {
  parseMcpAppLink,
  mcpAppRouteSearch,
  mcpAppRouteFromSearch,
  resolveMcpAppRouteServer,
} from "./mcp-app-route.ts";

describe("MCP app deep links", () => {
  it("preserves opaque plugin/tool identity and the complete app-relative query", () => {
    const route = {
      kind: "plugin" as const,
      pluginId: "parts@work",
      toolName: "cad/library",
      deepLink: "/parts?tag=bolt&sort=asc",
    };
    expect(
      parseMcpAppLink(
        "codex://plugins/parts%40work/app/cad%2Flibrary?path=%2Fparts%3Ftag%3Dbolt%26sort%3Dasc",
      ),
    ).toEqual(route);
    expect(mcpAppRouteFromSearch(mcpAppRouteSearch(route))).toEqual(route);
    expect(parseMcpAppLink("https://chatgpt.com/plugins/parts/app/cad.library")).toEqual({
      kind: "plugin",
      pluginId: "parts",
      toolName: "cad.library",
      deepLink: "/",
    });
  });
  it("keeps internal server routes in their own namespace", () => {
    const route = {
      kind: "server" as const,
      serverName: "parts-runtime",
      toolName: "cad.library",
      deepLink: "/",
    };
    const query = mcpAppRouteSearch(route);
    expect(new URLSearchParams(query).get("server")).toBe("parts-runtime");
    expect(new URLSearchParams(query).has("plugin")).toBe(false);
    expect(mcpAppRouteFromSearch(query)).toEqual(route);
  });

  it("resolves vendor plugin and marketplace without guessing a server name", () => {
    const entrypoints = [
      {
        title: "Library",
        toolName: "cad.library",
        resourceUri: "ui://parts/library",
        entrypoint: { type: "global" as const },
      },
    ];
    const servers = [
      {
        serverName: "parts-runtime",
        label: "Parts",
        pluginId: "vendor-parts",
        marketplace: "team market",
        entrypoints,
      },
      { serverName: "vendor-parts", label: "Unrelated server", entrypoints },
      {
        serverName: "other-market",
        label: "Other marketplace",
        pluginId: "vendor-parts",
        marketplace: "other",
        entrypoints,
      },
    ];
    const route = parseMcpAppLink(
      "codex://plugins/vendor-parts@team%20market/app/cad.library?path=%2Fparts%3Ftag%3Dbolt",
    );
    expect(route).toEqual({
      kind: "plugin",
      pluginId: "vendor-parts",
      marketplace: "team market",
      toolName: "cad.library",
      deepLink: "/parts?tag=bolt",
    });
    expect(mcpAppRouteFromSearch(mcpAppRouteSearch(route!))).toEqual(route);
    expect(resolveMcpAppRouteServer(servers, route!)?.serverName).toBe("parts-runtime");
    expect(
      resolveMcpAppRouteServer(servers, {
        kind: "plugin",
        pluginId: "vendor-parts",
        toolName: "cad.library",
        deepLink: "/",
      }),
    ).toBeUndefined();
    expect(
      resolveMcpAppRouteServer([...servers, { ...servers[0]!, serverName: "ambiguous" }], route!),
    ).toBeUndefined();
    expect(
      resolveMcpAppRouteServer(servers, {
        kind: "server",
        serverName: "vendor-parts",
        toolName: "cad.library",
        deepLink: "/",
      })?.serverName,
    ).toBe("vendor-parts");
    expect(
      mcpAppRouteFromSearch("?server=parts-runtime&plugin=vendor-parts&tool=cad.library"),
    ).toBeNull();
    expect(
      mcpAppRouteFromSearch("?server=parts-runtime&marketplace=team&tool=cad.library"),
    ).toBeNull();
  });

  it.each([
    "https://evil.example/plugins/parts/app/library",
    "https://chatgpt.com/parts/app/library",
    "codex://plugins/parts/app/library?path=https%3A%2F%2Fevil.example",
    "codex://plugins/parts/app/library?path=%2F%2Fevil.example",
    "codex://plugins/parts/app/library?path=%2Fok%23fragment",
    "codex://plugins/parts/app/library#fragment",
    "codex://plugins/%zz/app/library",
    "codex://plugins/parts/app/library?path=%2F%5Cevil.example",
  ])("rejects non-app or unsafe navigation: %s", (url) => expect(parseMcpAppLink(url)).toBeNull());
});
