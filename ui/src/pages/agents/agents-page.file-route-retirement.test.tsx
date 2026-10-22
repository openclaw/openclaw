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

it("leaves Agents through RouterOutlet while its admitted file write settles", async () => {
  const pending = createDeferred();
  let persisted = "Original instructions";
  const file = () => ({
    agentId: "main",
    workspace: "/synthetic/garden",
    file: {
      name: "AGENTS.md",
      path: "/synthetic/garden/AGENTS.md",
      missing: false,
      content: persisted,
      hash: "a".repeat(64),
    },
  });
  const request = vi.fn((method: string, params?: unknown) => {
    if (method === "models.list") {
      return { models: [] };
    }
    if (method === "agents.files.get") {
      return file();
    }
    if (method === "agents.files.set") {
      // SAFETY: This is the agents.files.set transport boundary and its required content field.
      const { content } = params as { content: string };
      return pending.promise.then(() => {
        persisted = content;
        return file();
      });
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = createTestGatewayClient(request);
  const currentGateway = gateway({
    ...snapshot(client),
    hello: gatewayHelloForMethods(["agents.files.set"]),
  });
  const agents = agentsCapability(async () => ({
    agentId: "main",
    workspace: "/synthetic/garden",
    files: [file().file],
  }));
  const baseContext = pageContext(currentGateway, agents);
  completeContext(baseContext);
  const routeData = agentsRouteData(
    currentGateway,
    agentsList,
    "main",
    baseContext.settingsAgentSelection,
  );
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
        component: () => ({ renderSolid: () => <section>File destination body</section> }),
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
    const editor = await waitForSolid(() => {
      const textarea = mounted.container.querySelector<HTMLTextAreaElement>(".agent-file-textarea");
      expect(textarea?.value).toBe(persisted);
      return textarea!;
    });
    editor.value = "Saved after leaving";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    const save = await waitForSolid(() =>
      mounted.getByRole<HTMLButtonElement>("button", { name: /^Save$/ }),
    );
    save.click();
    await waitForSolid(() =>
      expect(request.mock.calls.filter(([method]) => method === "agents.files.set")).toHaveLength(
        1,
      ),
    );
    await waitForSolid(() => expect(save.textContent).toContain("Saving"));
    expect(save.disabled).toBe(true);
    mounted.getByRole("button", { name: "Leave Agents" }).click();
    await waitForSolid(() => mounted.getByText("File destination body", { exact: true }));
    expect(mounted.container.querySelector("openclaw-agents-page")).toBeNull();
    expect(persisted).toBe("Original instructions");

    pending.resolve();
    await waitForSolid(() => expect(persisted).toBe("Saved after leaving"));
    expect(mounted.getByText("File destination body", { exact: true })).toBeTruthy();
    expect(mounted.container.querySelector("openclaw-agents-page")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "agents.files.set")).toHaveLength(1);
  } finally {
    pending.resolve();
    mounted.unmount();
    router.stop();
  }
});
