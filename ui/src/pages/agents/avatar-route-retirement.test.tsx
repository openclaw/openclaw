/* @vitest-environment jsdom */

import { createRouter, definePage } from "@openclaw/uirouter";
import { afterEach, expect, it, vi } from "vitest";
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
import * as avatarImage from "./avatar-image.ts";
import type { GeneratedAvatar } from "./avatar-picker.tsx";

afterEach(() => vi.restoreAllMocks());

it("leaves the avatar route before its admitted generation settles", async () => {
  const pending = createDeferred<GeneratedAvatar>();
  const request = vi.fn((method: string) => {
    if (method === "models.list") {
      return { models: [] };
    }
    if (method !== "agents.avatar.generate") {
      throw new Error(`Unexpected request: ${method}`);
    }
    return pending.promise;
  });
  const currentGateway = gateway({
    ...snapshot(createTestGatewayClient(request)),
    hello: gatewayHelloForMethods(["agents.update", "agents.avatar.generate"]),
  });
  const agents = agentsCapability(async () => ({ agentId: "main", workspace: "", files: [] }));
  const baseContext = pageContext(currentGateway, agents);
  completeContext(baseContext);
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
        component: () => ({ renderSolid: () => <section>Avatar destination body</section> }),
      }),
    ],
  });
  const context: ApplicationContext = { ...baseContext, router };
  const convert = vi
    .spyOn(avatarImage, "svgToAvatarDataUrl")
    .mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,YXZhdGFy" });
  const mounted = mountSolid(() => (
    <ApplicationProvider value={context}>
      <button onClick={() => void router.navigate("about", context)}>Leave avatar page</button>
      <RouterOutlet router={router} retryContext={context} />
    </ApplicationProvider>
  ));
  try {
    await router.navigate("agents", context);
    const avatar = await waitForSolid(() => mounted.getByRole("button", { name: "Edit avatar" }));
    avatar.click();
    const generateTab = await waitForSolid(() =>
      mounted.getByRole("button", { name: /^Generate$/ }),
    );
    generateTab.click();
    const prompt = await waitForSolid(() =>
      mounted.getByRole<HTMLTextAreaElement>("textbox", { name: "Describe your blobster..." }),
    );
    prompt.value = "A patient gardener";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    await waitForSolid(() =>
      expect(mounted.getAllByRole("button", { name: /^Generate$/ })).toHaveLength(2),
    );
    const generateButton = mounted.getAllByRole("button", { name: /^Generate$/ })[1];
    if (!generateButton) {
      throw new Error("Avatar generation button is missing");
    }
    generateButton.click();
    const generationCalls = () =>
      request.mock.calls.filter(([method]) => method === "agents.avatar.generate");
    await waitForSolid(() => expect(generationCalls()).toHaveLength(1));
    expect(request).toHaveBeenCalledWith(
      "agents.avatar.generate",
      { agentId: "main", prompt: "A patient gardener" },
      { timeoutMs: 100_000 },
    );
    mounted.getByRole("button", { name: "Leave avatar page" }).click();
    await waitForSolid(() => mounted.getByText("Avatar destination body", { exact: true }));
    expect(mounted.container.querySelector("openclaw-agents-page")).toBeNull();
    expect(mounted.queryByRole("textbox")).toBeNull();
    pending.resolve({ name: "Retired gardener", description: "Late result", svg: "<svg/>" });
    await pending.promise;
    await waitForSolid(() => mounted.getByText("Avatar destination body", { exact: true }));
    expect(convert).not.toHaveBeenCalled();
    expect(mounted.container.querySelector("openclaw-agents-page")).toBeNull();
    expect(mounted.queryByText("Retired gardener")).toBeNull();
    expect(generationCalls()).toHaveLength(1);
    expect(request.mock.calls.some(([method]) => method === "agents.update")).toBe(false);
  } finally {
    mounted.unmount();
    router.stop();
    pending.reject(new Error("Retired synthetic generation"));
    await pending.promise.catch(() => undefined);
  }
});
