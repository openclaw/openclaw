import { expect, it } from "vitest";
import {
  parseMcpAppLink,
  mcpAppRouteSearch,
  mcpAppRouteFromSearch,
  resolveMcpAppRouteServer,
  type McpAppRoute,
} from "./mcp-app-route.ts";

const root = { toolName: "cad.library", deepLink: "/" };
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
    ...root,
    kind: "plugin",
    pluginId: "parts",
  });
});
it("keeps internal server routes in their own namespace", () => {
  const route = { ...root, kind: "server" as const, serverName: "parts-runtime" };
  const query = mcpAppRouteSearch(route);
  expect(new URLSearchParams(query).get("server")).toBe("parts-runtime");
  expect(new URLSearchParams(query).has("plugin")).toBe(false);
  expect(mcpAppRouteFromSearch(query)).toEqual(route);
});

it("resolves vendor plugin and marketplace without guessing a server name", () => {
  const entrypoint = { type: "global" as const };
  const entry = { title: "App", toolName: root.toolName, resourceUri: "ui://app", entrypoint };
  const server = (serverName: string, pluginId?: string, marketplace?: string) => ({
    serverName,
    label: serverName,
    pluginId,
    marketplace,
    entrypoints: [entry],
  });
  const servers = [
    server("parts-runtime", "vendor-parts", "team market"),
    server("vendor-parts"),
    server("other-market", "vendor-parts", "other"),
  ];
  const route = parseMcpAppLink(
    "codex://plugins/vendor-parts@team%20market/app/cad.library?path=%2Fparts%3Ftag%3Dbolt",
  );
  const expected = {
    ...root,
    kind: "plugin" as const,
    pluginId: "vendor-parts",
    marketplace: "team market",
    deepLink: "/parts?tag=bolt",
  };
  expect(route).toEqual(expected);
  expect(mcpAppRouteFromSearch(mcpAppRouteSearch(route!))).toEqual(route);
  const resolve = (target: McpAppRoute, candidates = servers) =>
    resolveMcpAppRouteServer(candidates, target)?.serverName;
  expect(resolve(route!)).toBe("parts-runtime");
  expect(resolve({ ...expected, marketplace: undefined, deepLink: "/" })).toBeUndefined();
  const ambiguous = [...servers, { ...servers[0]!, serverName: "ambiguous" }];
  expect(resolve(route!, ambiguous)).toBeUndefined();
  expect(resolve({ ...root, kind: "server", serverName: "vendor-parts" })).toBe("vendor-parts");
  for (const query of ["plugin=vendor-parts", "marketplace=team"]) {
    expect(mcpAppRouteFromSearch(`?server=parts-runtime&${query}&tool=cad.library`)).toBeNull();
  }
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
