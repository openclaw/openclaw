/* @vitest-environment jsdom */

import { createRouter, definePage } from "@openclaw/uirouter";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { RouteId } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import { RouterOutlet } from "../../app/router-outlet.tsx";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
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

it("keeps Tools Save active through the real owner's roster refresh", async () => {
  const write = createDeferred();
  const roster = createDeferred<typeof agentsList>();
  let listCalls = 0;
  const config = { agents: { entries: { main: { tools: { profile: "full" } } } } };
  const request = vi.fn(async (method: string) => {
    if (method === "agents.list") {
      return ++listCalls === 1 ? agentsList : roster.promise;
    }
    if (method === "config.get") {
      return {
        config,
        sourceConfig: config,
        runtimeConfig: config,
        hash: "synthetic-one",
        valid: true,
        issues: [],
      };
    }
    if (method === "config.set") {
      await write.promise;
      return { config, hash: "synthetic-two" };
    }
    if (method === "tools.catalog") {
      return { agentId: "main", profiles: [], groups: [] };
    }
    if (method === "tools.effective") {
      return { agentId: "main", profile: "full", groups: [] };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = createTestGatewayClient(request);
  const currentGateway = gateway({
    ...snapshot(client),
    hello: gatewayHelloForMethods([
      "agents.list",
      "config.get",
      "config.set",
      "tools.catalog",
      "tools.effective",
    ]),
  });
  const agents = createAgentCapability(currentGateway);
  const runtimeConfig = createRuntimeConfigCapability(currentGateway);
  await agents.ensureList();
  await runtimeConfig.ensureLoaded();
  const context = { ...pageContext(currentGateway, agents), runtimeConfig };
  completeContext(context);
  const routeData = {
    ...agentsRouteData(currentGateway, agentsList, "main", context.settingsAgentSelection),
    panel: "tools" as const,
  };
  const mounted = mountSolid(() => (
    <ApplicationProvider value={context}>
      <AgentsPage routeData={routeData} />
    </ApplicationProvider>
  ));
  try {
    const save = await waitForSolid(() =>
      mounted.getByRole<HTMLButtonElement>("button", { name: "Save" }),
    );
    runtimeConfig.patchForm(["agents", "entries", "main", "tools", "deny"], ["read"]);
    await waitForSolid(() => expect(save.disabled).toBe(false));
    save.click();
    await waitForSolid(() =>
      expect(request.mock.calls.some(([method]) => method === "config.set")).toBe(true),
    );
    write.resolve();
    await waitForSolid(() => expect(listCalls).toBe(2));
    expect(save.isConnected).toBe(true);
    await waitForSolid(() => expect(save.textContent).toBe("Saving…"));
    expect(save.disabled).toBe(true);
    roster.resolve(agentsList);
    await waitForSolid(() => expect(save.textContent).toBe("Save"));
  } finally {
    write.resolve();
    roster.resolve(agentsList);
    mounted.unmount();
    runtimeConfig.dispose();
    agents.dispose();
  }
});

it.each(["save", "reload"] as const)(
  "leaves Agents through RouterOutlet before a held config %s settles",
  async (operation) => {
    const pending = createDeferred();
    const request = vi.fn((method: string) => {
      if (method === "models.list") {
        return { models: [] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = createTestGatewayClient(request);
    const currentGateway = gateway({
      ...snapshot(client),
      hello: gatewayHelloForMethods(["config.set"]),
    });
    const agents = agentsCapability(async () => ({ agentId: "main", workspace: "", files: [] }));
    const baseContext = pageContext(currentGateway, agents);
    completeContext(baseContext);
    baseContext.runtimeConfig.state.configFormDirty = true;
    const save = vi.fn(() => pending.promise.then(() => true));
    const reload = vi.fn(() => pending.promise);
    baseContext.runtimeConfig.save = save;
    baseContext.runtimeConfig.discardDraft = reload;
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
          component: () => ({ renderSolid: () => <section>Config destination body</section> }),
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
      const saveButton = await waitForSolid(() =>
        mounted.getByRole<HTMLButtonElement>("button", { name: "Save" }),
      );
      const reloadButton = mounted.getByRole<HTMLButtonElement>("button", {
        name: "Reload Config",
      });
      (operation === "save" ? saveButton : reloadButton).click();
      await waitForSolid(() => {
        expect(saveButton.disabled).toBe(true);
        expect(reloadButton.disabled).toBe(true);
      });
      expect(operation === "save" ? save : reload).toHaveBeenCalledOnce();
      if (operation === "reload") {
        expect(reload).toHaveBeenCalledWith({ reloadOnly: true });
      }
      mounted.getByRole("button", { name: "Leave Agents" }).click();
      await waitForSolid(() => mounted.getByText("Config destination body", { exact: true }));
      expect(mounted.container.querySelector("openclaw-agents-page")).toBeNull();
      expect(mounted.queryByRole("button", { name: "Reload Config" })).toBeNull();
      expect(agents.refreshList).not.toHaveBeenCalled();

      if (operation === "save") {
        pending.resolve();
        await waitForSolid(() => expect(agents.refreshList).toHaveBeenCalledOnce());
      } else {
        pending.reject(new Error("Retired config reload unavailable"));
        await pending.promise.catch(() => undefined);
      }
      expect(mounted.getByText("Config destination body", { exact: true })).toBeTruthy();
      expect(mounted.container.querySelector("openclaw-agents-page")).toBeNull();
      expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
      expect(operation === "save" ? save : reload).toHaveBeenCalledOnce();
    } finally {
      pending.resolve();
      mounted.unmount();
      router.stop();
    }
  },
);
