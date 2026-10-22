/* @vitest-environment jsdom */

import { createRouter, definePage } from "@openclaw/uirouter";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { RouteId } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import { RouterOutlet } from "../../app/router-outlet.tsx";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  agentsCapability,
  agentsList,
  agentsRouteData,
  completeContext,
  gateway,
  pageContext,
  snapshot,
} from "./agents-page.test-support.ts";
import { AgentsPage } from "./agents-page.tsx";

it("leaves Agents through RouterOutlet while its admitted default write settles in the config owner", async () => {
  const pending = createDeferred();
  let persisted = {
    agents: {
      defaults: { systemAgent: { agentId: "main" } },
      entries: { main: {}, research: {} },
    },
  };
  let revision = "initial";
  const request = vi.fn((method: string, params?: unknown) => {
    if (method === "models.list") {
      return { models: [] };
    }
    if (method === "config.get") {
      return {
        config: persisted,
        raw: JSON.stringify(persisted),
        hash: revision,
        valid: true,
        issues: [],
      };
    }
    if (method === "config.set") {
      // SAFETY: This is the config.set transport boundary; its public contract requires raw JSON.
      const { raw } = params as { raw: string };
      return pending.promise.then(() => {
        persisted = JSON.parse(raw);
        revision = "saved";
        return { config: persisted, hash: revision };
      });
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = createTestGatewayClient(request);
  const currentGateway = gateway(snapshot(client));
  const runtimeConfig = createRuntimeConfigCapability(currentGateway);
  const roster = {
    ...agentsList,
    agents: [...agentsList.agents, { id: "research", name: "Research" }],
  };
  const agents = agentsCapability(async () => ({ agentId: "research", workspace: "", files: [] }));
  agents.state.agentsList = roster;
  const baseContext: ApplicationContext = { ...pageContext(currentGateway, agents), runtimeConfig };
  completeContext(baseContext);
  const routeData = {
    ...agentsRouteData(currentGateway, roster, "research", baseContext.settingsAgentSelection),
    panel: "overview" as const,
  };
  const router = createRouter<
    RouteId,
    ApplicationContext,
    { renderSolid: (props: SolidRouteProps) => ReturnType<typeof AgentsPage> }
  >({
    routes: [
      definePage({
        id: "agents",
        path: "/settings/agents",
        component: () => ({ renderSolid: () => <AgentsPage routeData={routeData} /> }),
      }),
      definePage({
        id: "about",
        path: "/next",
        component: () => ({ renderSolid: () => <section>Default destination body</section> }),
      }),
    ],
  });
  const context: ApplicationContext = { ...baseContext, router };
  const mounted = mountSolid(() => (
    <ApplicationProvider value={context}>
      <button onClick={() => void router.navigate("about", context)}>Leave Agents</button>
      <RouterOutlet router={router} retryContext={context} />
    </ApplicationProvider>
  ));
  try {
    await runtimeConfig.ensureLoaded();
    await router.navigate("agents", context);
    const control = await waitForSolid(() =>
      mounted.getByRole<HTMLButtonElement>("button", { name: /^Set Default$/ }),
    );
    control.click();
    await waitForSolid(() =>
      expect(request.mock.calls.filter(([method]) => method === "config.set")).toHaveLength(1),
    );
    await waitForSolid(() => expect(control.textContent).toContain("Saving"));
    expect(control.disabled).toBe(true);
    mounted.getByRole("button", { name: "Leave Agents" }).click();
    await waitForSolid(() => mounted.getByText("Default destination body", { exact: true }));
    expect(mounted.container.querySelector("openclaw-agents-page")).toBeNull();
    expect(persisted.agents.defaults.systemAgent.agentId).toBe("main");

    pending.resolve();
    await waitForSolid(() => expect(runtimeConfig.state.configSaving).toBe(false));
    expect(persisted.agents.defaults.systemAgent.agentId).toBe("research");
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("saved");
    expect(mounted.getByText("Default destination body", { exact: true })).toBeTruthy();
    expect(mounted.container.querySelector("openclaw-agents-page")).toBeNull();
  } finally {
    pending.resolve();
    mounted.unmount();
    router.stop();
    runtimeConfig.dispose();
  }
});
