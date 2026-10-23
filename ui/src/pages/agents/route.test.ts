import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { gateway, settingsSelection, snapshot } from "./agents-page.test-support.ts";
import { page, type AgentsRouteData } from "./route.ts";

const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Main" },
    { id: "ordinary-looking-id", kind: "system", name: "System" },
    { id: "research", name: "Research" },
  ],
};

async function loadRoute(url: string): Promise<AgentsRouteData> {
  const parsed = new URL(url, "https://control.test");
  const request = vi.fn(async () => agentsList);
  const currentGateway = gateway(snapshot({ request } as unknown as GatewayBrowserClient));
  const agents = createAgentCapability(currentGateway);
  const context = {
    basePath: "",
    gateway: currentGateway,
    settingsAgentSelection: settingsSelection(null),
    agents,
  } as unknown as ApplicationContext;
  if (!page.loader) {
    throw new Error("agents route has no loader");
  }
  const result = (await page.loader(context, {
    signal: new AbortController().signal,
    shouldRun: () => true,
    revalidating: false,
    location: {
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
    },
    deps: `${parsed.pathname}\u0000${parsed.search}\u0000${parsed.hash}`,
    cause: "preload",
  } satisfies RouteLoaderOptions)) as AgentsRouteData;
  expect(request).toHaveBeenCalledExactlyOnceWith("agents.list", {
    includeSessionPlacement: true,
  });
  expect(agents.state.agentsList).toBe(agentsList);
  agents.dispose();
  return result;
}

describe("agents route", () => {
  it("keeps a requested agent and panel when the roster loads on a cold deep link", async () => {
    const result = await loadRoute("/settings/agents/research/tools");

    expect(result.requestedAgentId).toBe("research");
    expect(result.panel).toBe("tools");
    expect(result.canonicalLocation).toBeUndefined();
  });
});
