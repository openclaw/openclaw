/* @vitest-environment jsdom */

import { createRouter, definePage } from "@openclaw/uirouter";
import { afterEach, expect, it, vi } from "vitest";
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
import * as avatarImage from "./avatar-image.ts";
import type { GeneratedAvatar } from "./avatar-picker.tsx";
import type { AgentsRouteData } from "./route.ts";

afterEach(() => vi.restoreAllMocks());

function mountAgentsRoute(
  baseContext: ApplicationContext,
  routeData: AgentsRouteData,
  destination: string,
  leaveLabel = "Leave Agents",
) {
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
        component: () => ({ renderSolid: () => <section>{destination}</section> }),
      }),
    ],
  });
  const context: ApplicationContext = { ...baseContext, router };
  const mounted = mountSolid(() => (
    <ApplicationProvider value={context}>
      <button onClick={() => void router.navigate("about", context)}>{leaveLabel}</button>
      <RouterOutlet router={router} retryContext={context} />
    </ApplicationProvider>
  ));
  return { router, context, mounted };
}

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
  const { router, context, mounted } = mountAgentsRoute(
    baseContext,
    routeData,
    "Identity destination body",
  );
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
    const { router, context, mounted } = mountAgentsRoute(
      baseContext,
      routeData,
      "Config destination body",
    );
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
  const { router, context, mounted } = mountAgentsRoute(
    baseContext,
    routeData,
    "Default destination body",
  );
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
  const { router, context, mounted } = mountAgentsRoute(
    baseContext,
    routeData,
    "File destination body",
  );
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
  const convert = vi
    .spyOn(avatarImage, "svgToAvatarDataUrl")
    .mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,YXZhdGFy" });
  const { router, context, mounted } = mountAgentsRoute(
    baseContext,
    routeData,
    "Avatar destination body",
    "Leave avatar page",
  );
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
