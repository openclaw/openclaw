/* @vitest-environment jsdom */

import { createRouter, definePage } from "@openclaw/uirouter";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { RouteId } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import { RouterOutlet } from "../../app/router-outlet.tsx";
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

it("leaves Agents through RouterOutlet while an admitted identity save settles later", async () => {
  const pending = createDeferred<object>();
  const request = vi.fn((method: string) => {
    if (method === "models.list") {
      return { models: [] };
    }
    if (method === "agents.update") {
      return pending.promise;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = createTestGatewayClient(request);
  const currentGateway = gateway(snapshot(client));
  const agents = agentsCapability(async () => ({ agentId: "main", workspace: "", files: [] }));
  const baseContext = pageContext(currentGateway, agents);
  completeContext(baseContext);
  const invalidate = vi.fn();
  baseContext.agentIdentity.invalidate = invalidate;
  baseContext.runtimeConfig.runExternalMutation = async (task) => ({
    ok: true as const,
    value: await task(client),
    refresh: { ok: true as const },
  });
  const routeData = {
    ...agentsRouteData(currentGateway, agentsList, "main", baseContext.settingsAgentSelection),
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
        component: () => ({ renderSolid: () => <section>Identity destination body</section> }),
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
    await router.navigate("agents", context);
    const name = await waitForSolid(() =>
      mounted.getByRole<HTMLInputElement>("textbox", { name: "Display name" }),
    );
    name.focus();
    name.value = "Saved after departure";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    name.blur();
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("agents.update", {
        agentId: "main",
        name: "Saved after departure",
      }),
    );
    await waitForSolid(() => mounted.getByText("Saving…", { exact: true }));
    mounted.getByRole("button", { name: "Leave Agents" }).click();
    await waitForSolid(() => mounted.getByText("Identity destination body", { exact: true }));
    expect(mounted.container.querySelector("openclaw-agents-page")).toBeNull();
    expect(mounted.queryByRole("textbox", { name: "Display name" })).toBeNull();
    expect(invalidate).not.toHaveBeenCalled();

    pending.resolve({});
    await waitForSolid(() => expect(invalidate).toHaveBeenCalledWith(["main"]));
    expect(mounted.getByText("Identity destination body", { exact: true })).toBeTruthy();
    expect(mounted.container.querySelector("openclaw-agents-page")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "agents.update")).toHaveLength(1);
  } finally {
    pending.resolve({});
    mounted.unmount();
    router.stop();
  }
});
