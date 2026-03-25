import { describe, expect, it } from "vitest";

const { normalizeRoute, resolveRoute } =
  (await import("../../scripts/docs-link-audit.mjs")) as unknown as {
    normalizeRoute: (route: string) => string;
    resolveRoute: (
      route: string,
      options?: { redirects?: Map<string, string>; routes?: Set<string> },
    ) => { ok: boolean; terminal: string; loop?: boolean };
  };

describe("docs-link-audit", () => {
  it("normalizes route fragments away", () => {
    expect(normalizeRoute("/plugins/building-plugins#registering-agent-tools")).toBe(
      "/plugins/building-plugins",
    );
    expect(normalizeRoute("/plugins/building-plugins?tab=all")).toBe("/plugins/building-plugins");
  });

  it("resolves redirects that land on anchored sections", () => {
    const redirects = new Map([
      ["/plugins/agent-tools", "/plugins/building-plugins#registering-agent-tools"],
    ]);
    const routes = new Set(["/plugins/building-plugins"]);

    expect(resolveRoute("/plugins/agent-tools", { redirects, routes })).toEqual({
      ok: true,
      terminal: "/plugins/building-plugins",
    });
  });
});
