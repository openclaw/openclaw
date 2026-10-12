// @vitest-environment node
import type { RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it } from "vitest";
import { resolveAgentsRouteLocation } from "./route-location.ts";

function location(url: string): RouteLocation {
  const parsed = new URL(url, "https://control.test");
  return { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
}

describe("Agents route location", () => {
  it("reads an agent path without rewriting it", () => {
    const [url, requestedAgentId, panel] = [
      "/settings/agents/research",
      "research",
      "overview",
    ] as const;
    expect(resolveAgentsRouteLocation(location(url))).toMatchObject({
      requestedAgentId,
      panel,
      location: location(url),
    });
    expect(resolveAgentsRouteLocation(location(url)).canonicalLocation).toBeUndefined();
  });

  it("normalizes a legacy agent query once and preserves other URL state", () => {
    expect(
      resolveAgentsRouteLocation(location("/settings/agents?agent=team.writer&probe=1#catalog")),
    ).toEqual({
      location: location("/settings/agents?agent=team.writer&probe=1#catalog"),
      requestedAgentId: "team.writer",
      panel: "overview",
      canonicalLocation: location("/settings/agents/team%2Ewriter?probe=1#catalog"),
    });
  });

  it("prefers a canonical path over a stale legacy query", () => {
    expect(
      resolveAgentsRouteLocation(location("/settings/agents/research/tools?agent=main&probe=1")),
    ).toEqual({
      location: location("/settings/agents/research/tools?agent=main&probe=1"),
      requestedAgentId: "research",
      panel: "tools",
      canonicalLocation: location("/settings/agents/research/tools?probe=1"),
    });
  });

  it("normalizes an unknown panel to the agent default panel path", () => {
    expect(
      resolveAgentsRouteLocation(
        location("/ui/settings/agents/research/unknown?probe=1#files"),
        "/ui",
      ),
    ).toEqual({
      location: location("/ui/settings/agents/research/unknown?probe=1#files"),
      requestedAgentId: "research",
      panel: "overview",
      canonicalLocation: location("/ui/settings/agents/research?probe=1#files"),
    });
  });

  it("drops a legacy parent-segment agent id", () => {
    const agentId = "..";
    expect(
      resolveAgentsRouteLocation(location(`/settings/agents?agent=${encodeURIComponent(agentId)}`)),
    ).toEqual({
      location: location(`/settings/agents?agent=${encodeURIComponent(agentId)}`),
      requestedAgentId: null,
      panel: "overview",
      canonicalLocation: location("/settings/agents"),
    });
  });
});
