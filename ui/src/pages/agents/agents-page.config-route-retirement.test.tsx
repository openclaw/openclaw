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
