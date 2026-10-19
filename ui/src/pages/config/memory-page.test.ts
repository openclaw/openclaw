/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { setPluginEnabled, type PluginCatalogItem } from "../../lib/plugins/index.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  mountMemoryPage as mountPage,
  activeEngine,
  createMemoryTestAddon as addon,
  createMemoryTestDeferred as deferred,
  createMemoryTestEngine as engine,
  createMemoryTestMutationResult as committed,
  addonStatus,
  addonSwitch,
  createMemoryPage as buildPage,
  memoryRoute,
  memoryTabRoute,
  selectEngine,
  toggleAddon,
} from "./memory-page.test-support.tsx";
import type { ConfigRouteData } from "./route-data.ts";

type PageOptions = Parameters<typeof buildPage>[0];
function createPage(
  params: Omit<PageOptions, "configObject"> & Partial<Pick<PageOptions, "configObject">> = {},
  mount = true,
) {
  vi.mocked(setPluginEnabled).mockReset();
  const page = buildPage({ configObject: {}, ...params });
  if (mount) {
    mountMemoryPage(page.element);
  }
  return page;
}

vi.mock("../../lib/plugins/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/plugins/index.ts")>();
  return { ...actual, setPluginEnabled: vi.fn() };
});

function mountMemoryPage(element: HTMLElement) {
  onTestFinished(() => element.remove());
  mountPage(element);
}

function waitText(element: HTMLElement, text: string, present = true) {
  return waitForSolid(() => {
    (present ? expect(element.textContent) : expect(element.textContent).not).toContain(text);
  });
}

function waitAddon(element: HTMLElement, label: string, checked: boolean) {
  return waitForSolid(() => expect(addonSwitch(element, label)?.checked).toBe(checked));
}

/** Which tab body is actually mounted, rather than what the tab strip claims. */
function visibleTab(element: HTMLElement): "overview" | "memories" | "dreams" | "settings" | null {
  const panel = element.querySelector('[role="tabpanel"]');
  if (!panel) {
    return null;
  }
  if (panel.querySelector("openclaw-agent-memory-panel")) {
    return "dreams";
  }
  if (panel.querySelector('[data-settings-view="memory/memories"]')) {
    return "memories";
  }
  return panel.querySelector('[data-settings-view="memory/overview"]') ? "overview" : "settings";
}

function pressTab(element: HTMLElement, tab: string, key = "Enter") {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: key !== "ArrowRight",
  });
  element.querySelector(`#memory-tab-${tab}`)?.dispatchEvent(event);
  return event;
}

function dreamingInput(element: HTMLElement) {
  const input = element.querySelector<HTMLInputElement>('input[aria-label="Dreaming frequency"]');
  if (!input) {
    throw new Error("Missing Dreaming frequency");
  }
  return input;
}

it("defaults to the disabled slot owner and offers Enable even when another engine is enabled", async () => {
  const setEnabled = vi.fn(() => Promise.resolve({}));
  const { element } = createPage({
    catalog: [
      engine("memory-lancedb", true, "Memory LanceDB"),
      engine("memory-core", false, "memory-core"),
    ],
    setEnabled,
  });
  await waitForSolid(() => expect(activeEngine(element)).toBe("memory-core"));
  expect(element.textContent).toContain("falls back to its default owner");
  expect(
    [
      ...(element
        .querySelector('.settings-segmented[role="radiogroup"]')
        ?.querySelectorAll(".settings-segmented__btn") ?? []),
    ].map((radio) => radio.textContent?.trim()),
  ).toEqual(["OpenClaw Memory", "Memory LanceDB", "Off"]);
  await waitText(element, "This engine is disabled");
  const enable = [...element.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Enable",
  );
  enable?.click();
  await waitForSolid(() => expect(setEnabled).toHaveBeenCalled());
});

it("persists Off and drains its autosave before re-enabling memory", async () => {
  const pendingWrites = deferred<void>();
  const patchForm = vi.fn();
  const setEnabled = vi.fn(() => Promise.resolve({}));
  const { element, runExternalMutation } = createPage({
    configObject: { plugins: { slots: { memory: "memory-lancedb" } } },
    catalog: [engine("memory-core", false), engine("memory-lancedb", true)],
    patchForm,
    waitForPendingWrites: () => pendingWrites.promise,
    setEnabled,
  });
  await waitForSolid(() => expect(activeEngine(element)).toBe("memory-lancedb"));

  selectEngine(element, "");
  // Disabling the plugin would leave the slot pinned; only the explicit
  // sentinel makes Off outlive a reload.
  expect(patchForm).toHaveBeenCalledWith(["plugins", "slots", "memory"], "none");
  expect(setEnabled).not.toHaveBeenCalled();

  element.configObject = { plugins: { slots: { memory: "none" } } };
  flush();
  expect(activeEngine(element)).toBe("");
  expect(element.textContent).toContain("switched off");

  selectEngine(element, "memory-core");
  await waitForSolid(() => expect(runExternalMutation).toHaveBeenCalledOnce());
  expect(setEnabled).not.toHaveBeenCalled();

  pendingWrites.resolve();
  await waitForSolid(() => expect(setEnabled).toHaveBeenCalledOnce());
});

it("reports a rejected engine change instead of silently snapping back", async () => {
  const { element } = createPage({
    catalog: [engine("memory-core", true), engine("memory-lancedb", false)],
    setEnabled: () => Promise.reject(new Error("plugin not installed: memory-lancedb")),
  });
  await waitForSolid(() => expect(activeEngine(element)).toBe("memory-core"));

  selectEngine(element, "memory-lancedb");
  await waitText(element, "plugin not installed: memory-lancedb");
  expect(element.textContent).toContain("Could not change the memory engine");
});

it.each(["connection", "plugin publication"])(
  "drops a catalog completion superseded by %s",
  async (change) => {
    const first = deferred<{ plugins: readonly PluginCatalogItem[] }>();
    const second = deferred<{ plugins: readonly PluginCatalogItem[] }>();
    const { element, setPhase, publishPluginGeneration } = createPage({
      listCatalog: (call) => (call === 0 ? first.promise : second.promise),
    });
    if (change === "connection") {
      setPhase("disconnected");
      setPhase("connected");
    } else {
      publishPluginGeneration(1);
    }
    await waitForSolid(() => expect(addonStatus(element, "Active memory")).toBe("Loading…"));

    second.resolve({ plugins: [addon("active-memory", true)] });
    await waitAddon(element, "Active memory", true);

    first.resolve({ plugins: [addon("active-memory", false)] });
    await first.promise;
    flush();
    expect(addonSwitch(element, "Active memory")?.checked).toBe(true);
  },
);

it("falls back to read-only add-on status rows without operator.admin", async () => {
  const { element } = createPage({
    catalog: [addon("active-memory", true), addon("memory-wiki", false)],
    scopes: ["operator.read"],
  });
  await waitForSolid(() => expect(addonStatus(element, "Active memory")).toBe("Enabled"));
  expect(addonStatus(element, "Memory wiki")).toBe("Disabled");
  expect(addonSwitch(element, "Active memory")).toBeNull();
  expect(addonSwitch(element, "Memory wiki")).toBeNull();
  expect(element.querySelector("a.memory-page__link")?.textContent).toContain("Open Plugins");
});

it("ignores an older catalog reload from a parallel add-on mutation", async () => {
  const firstReload = deferred<{ plugins: readonly PluginCatalogItem[] }>();
  const secondReload = deferred<{ plugins: readonly PluginCatalogItem[] }>();
  const initial = [addon("active-memory", true), addon("memory-wiki", false)];
  const { element, request } = createPage({
    listCatalog: (call) => {
      if (call === 0) {
        return Promise.resolve({ plugins: initial });
      }
      return call === 1 ? firstReload.promise : secondReload.promise;
    },
  });
  await waitAddon(element, "Active memory", true);
  toggleAddon(element, "Active memory", false);
  toggleAddon(element, "Memory wiki", true);
  await waitForSolid(() =>
    expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(3),
  );

  secondReload.resolve({
    plugins: [addon("active-memory", false), addon("memory-wiki", true)],
  });
  await waitAddon(element, "Memory wiki", true);

  firstReload.resolve({
    plugins: [addon("active-memory", false), addon("memory-wiki", false)],
  });
  await firstReload.promise;
  flush();
  expect(addonSwitch(element, "Memory wiki")?.checked).toBe(true);
});

it("does not let a stale mutation supersede a reconnect catalog reload", async () => {
  const mutation = deferred<unknown>();
  const mutationReload = deferred<{ plugins: readonly PluginCatalogItem[] }>();
  const initial = [addon("active-memory", true), addon("memory-wiki", false)];
  const { element, request, setPhase } = createPage({
    listCatalog: (call) =>
      call < 2 ? Promise.resolve({ plugins: initial }) : mutationReload.promise,
    setEnabled: () => mutation.promise,
  });
  await waitAddon(element, "Active memory", true);
  toggleAddon(element, "Active memory", false);
  await waitForSolid(() => expect(setPluginEnabled).toHaveBeenCalledOnce());

  setPhase("disconnected");
  setPhase("connected");
  await waitForSolid(() =>
    expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(2),
  );

  mutation.resolve(committed("active-memory", false));
  await waitForSolid(() =>
    expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(3),
  );

  mutationReload.resolve({
    plugins: [addon("active-memory", false), addon("memory-wiki", false)],
  });
  await waitAddon(element, "Active memory", false);
});

it("retains runtime warnings through same-boot reconnects and publications, then clears a new boot", async () => {
  const initial = [addon("active-memory", true), addon("memory-wiki", false)];
  const updated = [addon("active-memory", true), addon("memory-wiki", true)];
  const warning = "Review memory-wiki settings.";
  let mutations = 0;
  const { element, request, setPhase, setBootId, publishPluginGeneration } = createPage({
    listCatalog: (call) => Promise.resolve({ plugins: call === 0 ? initial : updated }),
    setEnabled: (pluginId, enabled) =>
      mutations++ === 0
        ? Promise.resolve(committed(pluginId, enabled, [warning]))
        : Promise.reject(new Error("follow-up rejected")),
  });
  await waitAddon(element, "Memory wiki", false);
  toggleAddon(element, "Memory wiki", true);
  await waitText(element, warning);
  expect(element.textContent).toContain("Needs attention");
  await waitAddon(element, "Memory wiki", true);

  await waitForSolid(() =>
    expect(addonSwitch(element, "Memory wiki")?.hasAttribute("disabled")).toBe(false),
  );
  toggleAddon(element, "Memory wiki", false);
  await waitText(element, "follow-up rejected");
  expect(element.textContent).toContain(warning);

  setPhase("disconnected");
  setPhase("connected");
  await waitAddon(element, "Memory wiki", true);
  expect(element.textContent).toContain(warning);
  publishPluginGeneration(2);
  flush();
  expect(element.textContent).toContain(warning);
  expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(0);

  setBootId("memory-boot-b");
  await waitText(element, warning, false);
});

it("renders and clears mutation errors on only the affected add-on", async () => {
  const retry = deferred<unknown>();
  let attempts = 0;
  const { element } = createPage({
    catalog: [addon("active-memory", true), addon("memory-wiki", false)],
    setEnabled: () =>
      attempts++ === 0 ? Promise.reject(new Error("enablement rejected")) : retry.promise,
  });
  await waitForSolid(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
  toggleAddon(element, "Active memory", false);
  await waitText(element, "enablement rejected");
  expect(addonSwitch(element, "Active memory")?.checked).toBe(true);
  expect(element.textContent).toContain("Could not update Active memory");
  expect(element.textContent).not.toContain("Could not update Memory wiki");

  toggleAddon(element, "Active memory", false);
  await waitText(element, "enablement rejected", false);
  retry.resolve(committed("active-memory", false));
});

it("renders every canonical tab path and honors browser history restoration", async () => {
  const navigate = vi.fn();
  const { element } = createPage({ catalog: [], navigate });
  expect(visibleTab(element)).toBe("settings");

  pressTab(element, "overview");
  expect(navigate).toHaveBeenCalledWith("memory", { pathname: "/settings/memory" });
  element.routeData = memoryTabRoute("overview");
  flush();
  await waitForSolid(() => expect(visibleTab(element)).toBe("overview"));

  element.routeData = memoryTabRoute("settings");
  flush();
  expect(visibleTab(element)).toBe("settings");

  element.routeData = memoryTabRoute("memories");
  flush();
  await waitForSolid(() => expect(visibleTab(element)).toBe("memories"));

  element.routeData = memoryTabRoute("dreams");
  flush();
  expect(visibleTab(element)).toBe("dreams");
  expect(element.querySelector("openclaw-agent-select")).toBeNull();
  expect(element.textContent).not.toContain("Dreaming frequency");
});

it("keeps Dreams empty when no configured agent is available", async () => {
  const { element, settingsAgentSelection } = createPage({
    agents: [],
    routeData: memoryTabRoute("dreams"),
  });
  expect(settingsAgentSelection.state.selectedId).toBeNull();
  expect(element.querySelector("openclaw-agent-memory-panel")).toBeNull();
  expect(element.querySelector("openclaw-agent-select")).toBeNull();
  expect(element.textContent).not.toContain("Dreaming frequency");
});

it("handles Space directly so the browser cannot synthesize a second navigation", async () => {
  const navigate = vi.fn();
  const { element } = createPage({
    catalog: [],
    navigate,
    routeData: memoryTabRoute("overview"),
  });
  const space = pressTab(element, "dreams", " ");

  expect(space.defaultPrevented).toBe(true);
  expect(navigate).toHaveBeenCalledExactlyOnceWith("memory", {
    pathname: "/settings/memory/dreams",
  });
});

it.each([
  ["/settings/memory?tab=dreaming", "/settings/memory/dreams"],
  ["/settings/memory?tab=search", "/settings/memory/settings"],
  ["/settings/memory?section=memory", "/settings/memory/settings"],
  ["/settings/memory#config-section-memory", "/settings/memory/settings#config-section-memory"],
] as const)(
  "performs at most one replace for %s and never oscillates back to a query tab",
  async (sourceUrl, expectedUrl) => {
    const replace = vi.fn();
    const navigate = vi.fn();
    const { element } = createPage({
      catalog: [],
      replace,
      navigate,
      routeData: memoryRoute(sourceUrl),
    });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      element.routeData = { ...element.routeData } as ConfigRouteData;
      flush();
    }
    pressTab(element, "overview", "ArrowRight");
    pressTab(element, "dreams", "ArrowRight");

    expect(navigate).not.toHaveBeenCalled();
    const canonical = memoryRoute(expectedUrl);
    const { pathname, search, hash } = canonical;
    expect(replace).toHaveBeenCalledExactlyOnceWith("memory", { pathname, search, hash });

    element.routeData = canonical;
    flush();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      element.routeData = { ...element.routeData } as ConfigRouteData;
      flush();
    }
    expect(replace).toHaveBeenCalledOnce();
  },
);

it("mounts the presentation for the Settings agent and keeps it through a same-client reconnect", async () => {
  const page = createPage({
    agents: [{ id: "main" }, { id: "research" }],
    selectedAgentId: "research",
    routeData: memoryTabRoute("overview"),
  });
  const { element, settingsViews, setPhase, settingsAgentSelection } = page;
  await waitForSolid(() => expect(settingsViews.at(-1)?.snapshot.agentId).toBe("research"));
  const first = settingsViews.at(-1)!;
  expect(element.querySelectorAll("openclaw-agent-select")).toHaveLength(0);
  settingsAgentSelection.set("main");
  await waitForSolid(() => expect(settingsViews.at(-1)?.snapshot.agentId).toBe("main"));
  expect(first.context.signal.aborted).toBe(true);
  const current = settingsViews.at(-1)!;
  settingsAgentSelection.setScope(null);
  flush();
  expect(settingsViews.at(-1)).toBe(current);
  const epoch = current.snapshot.connectionEpoch;
  setPhase("disconnected");
  flush();
  expect(current.snapshot.connected).toBe(false);
  setPhase("connected");
  await waitForSolid(() => expect(current.snapshot.connected).toBe(true));
  expect(current.snapshot.connectionEpoch).toBeGreaterThan(epoch);
  expect(current.context.signal.aborted).toBe(false);
  expect(settingsViews.at(-1)).toBe(current);
  page.replaceClient();
  expect(current.context.signal.aborted).toBe(true);
  await waitForSolid(() => expect(settingsViews.at(-1)).not.toBe(current));
});

it("passes a replaced pinned engine to a new presentation", async () => {
  const { element, settingsViews } = createPage({
    configObject: { plugins: { slots: { memory: "engine-a" } } },
    catalog: [engine("engine-a", true), engine("engine-b", true)],
    routeData: memoryTabRoute("overview"),
  });
  await waitForSolid(() => expect(settingsViews.at(-1)?.snapshot.engine.id).toBe("engine-a"));
  const first = settingsViews.at(-1)!;
  element.configObject = { plugins: { slots: { memory: "engine-b" } } };
  await waitForSolid(() => expect(settingsViews.at(-1)?.snapshot.engine.id).toBe("engine-b"));
  expect(first.context.signal.aborted).toBe(true);
});

it.each([["main"], ["research", "main"]])(
  "keeps newer sidebar intent when a pending Memory link mounts (%j)",
  async (...choices: string[]) => {
    const { element, settingsAgentSelection, settingsViews } = createPage(
      {
        agents: [{ id: "main" }, { id: "research" }],
        routeData: memoryRoute("/settings/memory?agent=research"),
      },
      false,
    );
    for (const agentId of choices) {
      settingsAgentSelection.set(agentId);
    }
    mountMemoryPage(element);
    await waitForSolid(() => expect(settingsViews.at(-1)?.snapshot.agentId).toBe("main"));
    expect(settingsAgentSelection.state.selectedId).toBe("main");
    expect(settingsViews.some((view) => view.snapshot.agentId === "research")).toBe(false);
  },
);

it("honors a fresh explicit Memory navigation after the sidebar changed the same URL's agent", async () => {
  const { element, settingsAgentSelection } = createPage({
    agents: [{ id: "main" }, { id: "research" }],
    routeData: memoryRoute("/settings/memory?agent=research"),
  });
  await waitForSolid(() => expect(settingsAgentSelection.state.selectedId).toBe("research"));
  settingsAgentSelection.set("main");
  element.routeData = {
    ...memoryRoute("/settings/memory?agent=research"),
    agentSelectionIntent: {
      owner: settingsAgentSelection,
      revision: settingsAgentSelection.intentRevision,
    },
  };
  await waitForSolid(() => expect(settingsAgentSelection.state.selectedId).toBe("research"));
});

it.each([
  { tab: "overview", change: "client" },
  { tab: "memories", change: "method catalog" },
  { tab: "memories", change: "agent" },
] as const)(
  "retires $tab callbacks and pending RPCs synchronously after $change changes",
  async ({ tab, change }) => {
    const pending = deferred<unknown>();
    const fixture = createPage({
      routeData: memoryTabRoute(tab),
      agents: [{ id: "main" }, { id: "research" }],
      methods: ["memory.search", "agents.workspace.get"],
      settingsRequest: () => pending.promise,
    });
    const { element, settingsViews, request } = fixture;
    try {
      await waitForSolid(() => expect(settingsViews.length).toBeGreaterThan(0));
      const old = settingsViews.at(-1)!.context;
      expect(old.props.advertisedMethods).toContain("memory.search");
      const result = old.request("settings.test");
      const invalidate = {
        "method catalog": () => fixture.setMethods(["agents.workspace.get"]),
        agent: () => fixture.settingsAgentSelection.set("research"),
        client: () => fixture.replaceClient(),
      };
      invalidate[change]();
      // No flush: authority retires synchronously.
      expect(old.signal.aborted).toBe(true);
      expect(() => old.navigate("settings")).toThrow();
      const dispatches = request.mock.calls.length;
      await expect(old.request("settings.test")).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(dispatches);
      pending.resolve("obsolete");
      await expect(result).rejects.toThrow();
      await waitForSolid(() => expect(settingsViews.at(-1)!.context).not.toBe(old));
    } finally {
      pending.resolve("done");
      element.remove();
    }
  },
);

it.each(["plugin publication", "boot"] as const)(
  "keeps the view after %s but rejects replies to earlier requests",
  async (change) => {
    const pending = deferred<unknown>();
    const settingsRequest = vi
      .fn<(method: string) => Promise<unknown>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue("current");
    const fixture = createPage({
      routeData: memoryTabRoute("memories"),
      methods: ["memory.search", "agents.workspace.get"],
      settingsRequest,
    });
    const { settingsViews } = fixture;
    try {
      await waitForSolid(() => expect(settingsViews.length).toBeGreaterThan(0));
      const view = settingsViews.at(-1)!;
      const result = view.context.request("settings.test");
      if (change === "plugin publication") {
        fixture.publishPluginGeneration(1);
      } else {
        fixture.setBootId("memory-boot-b");
      }
      pending.resolve("obsolete");
      await expect(result).rejects.toThrow("connection changed");
      expect(view.context.signal.aborted).toBe(false);
      expect(settingsViews.at(-1)).toBe(view);
      await expect(view.context.request("settings.test")).resolves.toBe("current");
    } finally {
      pending.resolve("done");
    }
  },
);

it("passes offline state when Overview is activated after disconnecting elsewhere", async () => {
  const { element, settingsViews, setPhase } = createPage();
  setPhase("disconnected");
  element.routeData = memoryTabRoute("overview");
  await waitForSolid(() => expect(settingsViews.at(-1)?.snapshot.connected).toBe(false));
});

it.each(["reconnect", "plugin publication"])(
  "re-probes after %s and drops the abandoned capability result",
  async (change) => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const { element, lookupSchemaPath, setPhase, publishPluginGeneration } = createPage({
      lookupSchemaPath: (call) => (call === 0 ? first.promise : second.promise),
    });
    try {
      await waitForSolid(() => expect(lookupSchemaPath).toHaveBeenCalledTimes(1));

      if (change === "reconnect") {
        setPhase("disconnected");
        setPhase("connected");
      } else {
        publishPluginGeneration(1);
      }
      await waitForSolid(() => expect(lookupSchemaPath).toHaveBeenCalledTimes(2));

      first.resolve({ type: "object", additionalProperties: false, properties: {} });
      await first.promise;
      flush();
      expect(element.textContent).not.toContain("Not available for this engine");

      second.resolve({ type: "object" });
      await second.promise;
      flush();
      expect(element.textContent).not.toContain("Not available for this engine");
    } finally {
      first.resolve({ type: "object" });
      second.resolve({ type: "object" });
      element.remove();
    }
  },
);

it.each([
  { configOwner: "custom-memory", catalog: "unavailable" },
  { configOwner: "memory-core", catalog: "same-ID override" },
])(
  "keeps the complete presentation available for $configOwner with an unknown schema and $catalog catalog",
  async ({ configOwner, catalog }) => {
    const schema = deferred<unknown>();
    const patchForm = vi.fn();
    const config = { dreaming: { phases: { light: { limit: 0, enabled: false } } } };
    const entries = { [configOwner]: { config } };
    const { element, runtimeConfig } = createPage({
      configObject: { plugins: { slots: { memory: configOwner }, entries } },
      listCatalog: () =>
        catalog === "unavailable"
          ? Promise.reject(new Error("catalog unavailable"))
          : Promise.resolve({
              plugins: [{ ...engine("memory-core", true, "Local Memory"), origin: "local" }],
            }),
      lookupSchemaPath: () => schema.promise,
      patchForm,
    });
    try {
      if (catalog === "unavailable") {
        await waitForSolid(() => expect(addonStatus(element, "Active memory")).toBe("Unknown"));
      }
      const frequency = dreamingInput(element);
      expect(element.textContent).toContain(configOwner);
      expect(element.textContent).toContain("REM phase");
      const limit = element.querySelector<HTMLInputElement>('input[aria-label="Limit"]');
      expect(limit?.value).toBe("0");
      expect(patchForm).not.toHaveBeenCalled();
      const frequencyPath = ["plugins", "entries", configOwner, "config", "dreaming", "frequency"];
      frequency.value = "0 4 * * *";
      frequency.dispatchEvent(new Event("change"));
      expect(patchForm).toHaveBeenLastCalledWith(frequencyPath, "0 4 * * *");
      frequency.value = "";
      frequency.dispatchEvent(new Event("change"));
      expect(runtimeConfig.removeFormValue).toHaveBeenCalledWith(frequencyPath);
      schema.resolve({ schema: { type: "object", additionalProperties: false }, children: [] });
      await waitText(element, "Not available for this engine");
      expect(element.querySelector('input[aria-label="Dreaming frequency"]')).toBeNull();
    } finally {
      schema.resolve({ type: "object" });
      element.remove();
    }
  },
);

it.each(["owner", "disconnect", "read-only", "unmount"] as const)(
  "rejects an already mounted edit after %s changes",
  async (change) => {
    const patchForm = vi.fn();
    const { element, runtimeConfig, setPhase, setScopes } = createPage({ patchForm });
    try {
      const input = await waitForSolid(() => dreamingInput(element));
      const invalidate = {
        owner: () => {
          runtimeConfig.state.configForm = { plugins: { slots: { memory: "custom-memory" } } };
        },
        disconnect: () => setPhase("disconnected"),
        "read-only": () => setScopes(["operator.read"]),
        unmount: () => element.remove(),
      };
      invalidate[change]();
      input.value = "0 5 * * *";
      input.dispatchEvent(new Event("change"));
      expect(patchForm).not.toHaveBeenCalled();
      expect(runtimeConfig.removeFormValue).not.toHaveBeenCalled();
    } finally {
      if (element.isConnected) {
        element.remove();
      }
    }
  },
);
