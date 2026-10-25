/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { configSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  agentsCapability,
  agentsRouteData,
  createAgentsPage,
  gateway,
  pageContext,
  snapshot,
} from "./agents-page.test-support.ts";

it("activates editing from a display-only snapshot before Agents skill and model changes", async () => {
  const config = configSnapshot({
    agents: { entries: { main: { model: "fixture/initial", skills: ["weather"] } } },
  });
  const request = vi.fn(async (method: string) => {
    if (method === "config.get" || method === "config.set") {
      return config;
    }
    if (method === "skills.status") {
      return {
        workspaceDir: "/synthetic/workspace",
        managedSkillsDir: "/synthetic/skills",
        skills: [],
      };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = createTestGatewayClient(request);
  const currentGateway = gateway({
    ...snapshot(client),
    hello: gatewayHelloForMethods(["config.get", "config.set", "skills.status"]),
  });
  const runtimeConfig = createRuntimeConfigCapability(currentGateway);
  let page: ReturnType<typeof createAgentsPage> | undefined;
  try {
    await runtimeConfig.ensureDisplayLoaded();
    expect(runtimeConfig.state.configForm).toBeNull();
    const agents = agentsCapability(async () => ({ agentId: "main", workspace: "", files: [] }));
    const context = { ...pageContext(currentGateway, agents), runtimeConfig };
    page = createAgentsPage(context, {
      ...agentsRouteData(
        currentGateway,
        agents.state.agentsList,
        "main",
        context.settingsAgentSelection,
      ),
      panel: "skills",
    });
    await waitForFast(() => expect(runtimeConfig.state.configLoading).toBe(false));

    page.read().agentSkills.onToggle("main", "weather", false);
    page.read().overview.onModelChange("main", "fixture/selected");

    expect(runtimeConfig.state.configForm).toEqual({
      agents: { entries: { main: { model: "fixture/selected", skills: [] } } },
    });
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(1);
  } finally {
    page?.dispose();
    runtimeConfig.dispose();
  }
});
