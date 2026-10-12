/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorMemoryStatusPayload } from "../../../../src/gateway/server-methods/doctor.ts";
import { setPluginEnabled, type PluginCatalogItem } from "../../lib/plugins/index.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  mountMemoryPage,
  activeEngine,
  createMemoryTestAddon as addon,
  createMemoryTestDeferred as deferred,
  createMemoryTestEngine as engine,
  createMemoryTestMutationResult as committed,
  addonStatus,
  addonSwitch,
  createMemoryPage as createPage,
  memoryRoute,
  memoryTabRoute,
  selectEngine,
  toggleAddon,
} from "./memory-page.test-support.tsx";
import type { ConfigRouteData } from "./route-data.ts";
import "./memory-page.tsx";

vi.mock("../../lib/plugins/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/plugins/index.ts")>();
  return { ...actual, setPluginEnabled: vi.fn() };
});

/** Which tab body is actually mounted, rather than what the tab strip claims. */
function visibleTab(element: HTMLElement): "overview" | "memories" | "dreams" | "settings" | null {
  const panel = element.querySelector('[role="tabpanel"]');
  if (!panel) {
    return null;
  }
  if (panel.querySelector("openclaw-agent-memory-panel")) {
    return "dreams";
  }
  if (panel.querySelector("openclaw-memory-memories")) {
    return "memories";
  }
  return panel.querySelector(".memory-overview") ? "overview" : "settings";
}

function selectTab(element: HTMLElement, tab: string) {
  const target = element.querySelector(`#memory-tab-${tab}`);
  target?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  target?.dispatchEvent(new MouseEvent("click", { detail: 0, bubbles: true }));
  dispatchTabShow(element, tab);
}

function dispatchTabShow(element: HTMLElement, tab: string) {
  element.querySelector("wa-tab-group")?.dispatchEvent(
    new CustomEvent("wa-tab-show", {
      detail: { name: tab },
      bubbles: true,
    }),
  );
}

describe("MemorySettingsPage engine slot", () => {
  it("resolves an unset slot to the slot default even when another engine is enabled", async () => {
    // resolveSlotSelection (src/plugins/slots.ts) makes an unset slot memory-core
    // regardless of catalog enablement, so the page must not report lancedb.
    const { element } = createPage({
      configObject: {},
      catalog: [
        engine("memory-lancedb", true, "Memory LanceDB"),
        engine("memory-core", false, "memory-core"),
      ],
    });
    mountMemoryPage(element);
    try {
      await waitForSolid(() => expect(activeEngine(element)).toBe("memory-core"));
      expect(element.textContent).toContain("falls back to its default owner");
      expect(
        [
          ...(element
            .querySelector('.settings-segmented[role="radiogroup"]')
            ?.querySelectorAll(".settings-segmented__btn") ?? []),
        ].map((radio) => radio.textContent?.trim()),
      ).toEqual(["OpenClaw Memory", "Memory LanceDB", "Off"]);
    } finally {
      element.remove();
    }
  });

  it("offers an enable action when the slot owner is disabled", async () => {
    const setEnabled = vi.fn(() => Promise.resolve({}));
    const { element } = createPage({
      configObject: {},
      catalog: [engine("memory-core", false)],
      setEnabled,
    });
    mountMemoryPage(element);
    try {
      await waitForSolid(() => expect(element.textContent).toContain("This engine is disabled"));

      // The control already shows memory-core selected, so re-picking it fires no
      // change event; without this button the owner could never be re-enabled.
      const enable = [...element.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Enable",
      );
      enable?.click();
      await waitForSolid(() => expect(setEnabled).toHaveBeenCalled());
    } finally {
      element.remove();
    }
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
    mountMemoryPage(element);
    try {
      await waitForSolid(() => expect(activeEngine(element)).toBe("memory-lancedb"));

      selectEngine(element, "");
      // Disabling the plugin would leave the slot pinned; only the explicit
      // sentinel makes Off outlive a reload.
      expect(patchForm).toHaveBeenCalledWith(["plugins", "slots", "memory"], "none");
      expect(setEnabled).not.toHaveBeenCalled();

      // Round-trip: the reloaded config carries the write back into the page.
      element.configObject = { plugins: { slots: { memory: "none" } } };
      flush();
      expect(activeEngine(element)).toBe("");
      expect(element.textContent).toContain("switched off");

      selectEngine(element, "memory-core");
      await waitForSolid(() => expect(runExternalMutation).toHaveBeenCalledOnce());
      expect(setEnabled).not.toHaveBeenCalled();

      pendingWrites.resolve();
      await waitForSolid(() => expect(setEnabled).toHaveBeenCalledOnce());
    } finally {
      element.remove();
    }
  });

  it("reports a rejected engine change instead of silently snapping back", async () => {
    const { element } = createPage({
      configObject: {},
      catalog: [engine("memory-core", true), engine("memory-lancedb", false)],
      setEnabled: () => Promise.reject(new Error("plugin not installed: memory-lancedb")),
    });
    mountMemoryPage(element);
    try {
      await waitForSolid(() => expect(activeEngine(element)).toBe("memory-core"));

      selectEngine(element, "memory-lancedb");
      await waitForSolid(() =>
        expect(element.textContent).toContain("plugin not installed: memory-lancedb"),
      );
      expect(element.textContent).toContain("Could not change the memory engine");
    } finally {
      element.remove();
    }
  });
});

describe("MemorySettingsPage catalog state", () => {
  beforeEach(() => {
    vi.mocked(setPluginEnabled).mockReset();
  });

  it("reports unknown add-on state instead of disabled once the catalog read fails", async () => {
    const { element } = createPage({
      configObject: {},
      listCatalog: () => Promise.reject(new Error("gateway is gone")),
    });
    mountMemoryPage(element);
    try {
      await waitForSolid(() => expect(addonStatus(element, "Active memory")).toBe("Unknown"));
      expect(addonStatus(element, "Active memory")).not.toBe("Disabled");
    } finally {
      element.remove();
    }
  });

  it.each(["connection", "plugin publication"])(
    "drops a catalog completion superseded by %s",
    async (change) => {
      const first = deferred<{ plugins: readonly PluginCatalogItem[] }>();
      const second = deferred<{ plugins: readonly PluginCatalogItem[] }>();
      const { element, setPhase, publishPluginGeneration } = createPage({
        configObject: {},
        listCatalog: (call) => (call === 0 ? first.promise : second.promise),
      });
      mountMemoryPage(element);
      try {
        flush();
        // Same client object survives the drop and the reconnect, so only the
        // per-connection request generation can tell the two loads apart.
        if (change === "connection") {
          setPhase("disconnected");
          setPhase("connected");
        } else {
          publishPluginGeneration(1);
        }
        await waitForSolid(() => expect(addonStatus(element, "Active memory")).toBe("Loading…"));

        second.resolve({ plugins: [addon("active-memory", true)] });
        await waitForSolid(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(true));

        first.resolve({ plugins: [addon("active-memory", false)] });
        await first.promise;
        flush();
        expect(addonSwitch(element, "Active memory")?.checked).toBe(true);
      } finally {
        element.remove();
      }
    },
  );

  it("falls back to read-only add-on status rows without operator.admin", async () => {
    const { element } = createPage({
      configObject: {},
      catalog: [addon("active-memory", true), addon("memory-wiki", false)],
      scopes: ["operator.read"],
    });
    mountMemoryPage(element);
    try {
      await waitForSolid(() => expect(addonStatus(element, "Active memory")).toBe("Enabled"));
      expect(addonStatus(element, "Memory wiki")).toBe("Disabled");
      expect(addonSwitch(element, "Active memory")).toBeNull();
      expect(addonSwitch(element, "Memory wiki")).toBeNull();
      expect(element.querySelector("a.memory-page__link")?.textContent).toContain("Open Plugins");
    } finally {
      element.remove();
    }
  });

  it("ignores an older catalog reload from a parallel add-on mutation", async () => {
    const firstReload = deferred<{ plugins: readonly PluginCatalogItem[] }>();
    const secondReload = deferred<{ plugins: readonly PluginCatalogItem[] }>();
    const initial = [addon("active-memory", true), addon("memory-wiki", false)];
    const { element, request } = createPage({
      configObject: {},
      listCatalog: (call) => {
        if (call === 0) {
          return Promise.resolve({ plugins: initial });
        }
        return call === 1 ? firstReload.promise : secondReload.promise;
      },
    });
    mountMemoryPage(element);
    try {
      await waitForSolid(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(true));
      toggleAddon(element, "Active memory", false);
      toggleAddon(element, "Memory wiki", true);
      await waitForSolid(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(3),
      );

      secondReload.resolve({
        plugins: [addon("active-memory", false), addon("memory-wiki", true)],
      });
      await waitForSolid(() => expect(addonSwitch(element, "Memory wiki")?.checked).toBe(true));

      firstReload.resolve({
        plugins: [addon("active-memory", false), addon("memory-wiki", false)],
      });
      await firstReload.promise;
      flush();
      expect(addonSwitch(element, "Memory wiki")?.checked).toBe(true);
    } finally {
      element.remove();
    }
  });

  it("does not let a stale mutation supersede a reconnect catalog reload", async () => {
    const mutation = deferred<unknown>();
    const mutationReload = deferred<{ plugins: readonly PluginCatalogItem[] }>();
    const initial = [addon("active-memory", true), addon("memory-wiki", false)];
    const { element, request, setPhase } = createPage({
      configObject: {},
      listCatalog: (call) =>
        call < 2 ? Promise.resolve({ plugins: initial }) : mutationReload.promise,
      setEnabled: () => mutation.promise,
    });
    mountMemoryPage(element);
    try {
      await waitForSolid(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(true));
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
      await waitForSolid(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(false));
    } finally {
      element.remove();
    }
  });

  it("keeps a committed add-on change successful while making its failed refresh visible", async () => {
    const refresh = vi.fn(() => Promise.reject(new Error("config refresh failed")));
    const initial = [addon("active-memory", true), addon("memory-wiki", false)];
    const updated = [addon("active-memory", false), addon("memory-wiki", false)];
    const { element } = createPage({
      configObject: {},
      listCatalog: (call) => Promise.resolve({ plugins: call === 0 ? initial : updated }),
      refresh,
    });
    mountMemoryPage(element);
    try {
      await waitForSolid(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(true));
      toggleAddon(element, "Active memory", false);

      await waitForSolid(() => expect(refresh).toHaveBeenCalledOnce());
      await waitForSolid(() => expect(element.textContent).toContain("config refresh failed"));
      await waitForSolid(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(false));
      expect(element.textContent).toContain("Needs attention");
      expect(element.textContent).not.toContain("Could not update Active memory");
    } finally {
      element.remove();
    }
  });

  it("retains runtime warnings through same-boot reconnects and publications, then clears a new boot", async () => {
    const initial = [addon("active-memory", true), addon("memory-wiki", false)];
    const updated = [addon("active-memory", true), addon("memory-wiki", true)];
    const warning = "Review memory-wiki settings.";
    let mutations = 0;
    const { element, request, setPhase, setBootId, publishPluginGeneration } = createPage({
      configObject: {},
      listCatalog: (call) => Promise.resolve({ plugins: call === 0 ? initial : updated }),
      setEnabled: (pluginId, enabled) =>
        mutations++ === 0
          ? Promise.resolve(committed(pluginId, enabled, [warning]))
          : Promise.reject(new Error("follow-up rejected")),
    });
    mountMemoryPage(element);
    try {
      await waitForSolid(() => expect(addonSwitch(element, "Memory wiki")?.checked).toBe(false));
      toggleAddon(element, "Memory wiki", true);
      await waitForSolid(() => expect(element.textContent).toContain(warning));
      expect(element.textContent).toContain("Needs attention");
      await waitForSolid(() => expect(addonSwitch(element, "Memory wiki")?.checked).toBe(true));

      await waitForSolid(() =>
        expect(addonSwitch(element, "Memory wiki")?.hasAttribute("disabled")).toBe(false),
      );
      toggleAddon(element, "Memory wiki", false);
      await waitForSolid(() => expect(element.textContent).toContain("follow-up rejected"));
      expect(element.textContent).toContain(warning);

      setPhase("disconnected");
      setPhase("connected");
      await waitForSolid(() => expect(addonSwitch(element, "Memory wiki")?.checked).toBe(true));
      expect(element.textContent).toContain(warning);
      publishPluginGeneration(2);
      flush();
      expect(element.textContent).toContain(warning);
      expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(0);

      setBootId("memory-boot-b");
      await waitForSolid(() => expect(element.textContent).not.toContain(warning));
    } finally {
      element.remove();
    }
  });

  it("renders and clears mutation errors on only the affected add-on", async () => {
    const retry = deferred<unknown>();
    let attempts = 0;
    const { element } = createPage({
      configObject: {},
      catalog: [addon("active-memory", true), addon("memory-wiki", false)],
      setEnabled: () =>
        attempts++ === 0 ? Promise.reject(new Error("enablement rejected")) : retry.promise,
    });
    mountMemoryPage(element);
    try {
      await waitForSolid(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
      toggleAddon(element, "Active memory", false);
      await waitForSolid(() => expect(element.textContent).toContain("enablement rejected"));
      expect(addonSwitch(element, "Active memory")?.checked).toBe(true);
      expect(element.textContent).toContain("Could not update Active memory");
      expect(element.textContent).not.toContain("Could not update Memory wiki");

      toggleAddon(element, "Active memory", false);
      await waitForSolid(() => expect(element.textContent).not.toContain("enablement rejected"));
      retry.resolve(committed("active-memory", false));
    } finally {
      element.remove();
    }
  });
});

describe("MemorySettingsPage tab routing", () => {
  it("probes embeddings through the guarded overview request and renders the result", async () => {
    const probe = deferred<DoctorMemoryStatusPayload>();
    const initial: DoctorMemoryStatusPayload = {
      agentId: "main",
      provider: "local",
      embedding: { ok: false, checked: false },
    };
    const { element, request } = createPage({
      configObject: {},
      memoryStatus: (_agentId, shouldProbe) =>
        shouldProbe ? probe.promise : Promise.resolve(initial),
    });
    element.routeData = memoryTabRoute("overview");
    mountMemoryPage(element);
    try {
      await waitForSolid(() =>
        expect(
          [...element.querySelectorAll<HTMLButtonElement>("button")].some(
            (button) => button.textContent?.trim() === "Test",
          ),
        ).toBe(true),
      );
      const testButton = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Test",
      );
      testButton?.click();

      await waitForSolid(() =>
        expect(request).toHaveBeenCalledWith("doctor.memory.status", {
          agentId: "main",
          probe: true,
        }),
      );
      await waitForSolid(() =>
        expect(
          [...element.querySelectorAll<HTMLButtonElement>("button")].find(
            (button) => button.textContent?.trim() === "Testing…",
          )?.disabled,
        ).toBe(true),
      );

      probe.resolve({
        agentId: "main",
        provider: "local",
        embedding: { ok: false, checked: true, error: "embedding probe failed" },
      });
      await waitForSolid(() => expect(element.textContent).toContain("embedding probe failed"));
      expect(
        [...element.querySelectorAll<HTMLButtonElement>("button")].some(
          (button) => button.textContent?.trim() === "Test",
        ),
      ).toBe(false);
    } finally {
      element.remove();
    }
  });

  it("renders every canonical tab path and honors browser history restoration", async () => {
    const navigate = vi.fn();
    const { element } = createPage({ configObject: {}, catalog: [], navigate });
    element.routeData = memoryTabRoute("settings");
    mountMemoryPage(element);
    try {
      flush();
      expect(visibleTab(element)).toBe("settings");

      // A manual click rewrites the URL rather than shadowing it with local state.
      selectTab(element, "overview");
      expect(navigate).toHaveBeenCalledWith("memory", { pathname: "/settings/memory" });
      element.routeData = memoryTabRoute("overview");
      flush();
      expect(visibleTab(element)).toBe("overview");

      // The router feeding an older history entry back must restore that tab.
      element.routeData = memoryTabRoute("settings");
      flush();
      expect(visibleTab(element)).toBe("settings");

      element.routeData = memoryTabRoute("memories");
      flush();
      expect(visibleTab(element)).toBe("memories");

      element.routeData = memoryTabRoute("dreams");
      flush();
      expect(visibleTab(element)).toBe("dreams");
      expect(element.querySelector("openclaw-agent-select")).toBeNull();
      expect(element.textContent).not.toContain("Dreaming frequency");
    } finally {
      element.remove();
    }
  });

  it("keeps Dreams empty when no configured agent is available", async () => {
    const { element, settingsAgentSelection } = createPage({
      configObject: {},
      agents: [],
      routeData: memoryTabRoute("dreams"),
    });
    mountMemoryPage(element);
    try {
      flush();
      expect(settingsAgentSelection.state.selectedId).toBeNull();
      expect(element.querySelector("openclaw-agent-memory-panel")).toBeNull();
      expect(element.querySelector("openclaw-agent-select")).toBeNull();
      expect(element.textContent).not.toContain("Dreaming frequency");
    } finally {
      element.remove();
    }
  });

  it("handles Space directly so the browser cannot synthesize a second navigation", async () => {
    const navigate = vi.fn();
    const { element } = createPage({ configObject: {}, catalog: [], navigate });
    element.routeData = memoryTabRoute("overview");
    mountMemoryPage(element);
    try {
      flush();
      const space = new KeyboardEvent("keydown", {
        key: " ",
        bubbles: true,
        cancelable: true,
      });
      element.querySelector("#memory-tab-dreams")?.dispatchEvent(space);

      expect(space.defaultPrevented).toBe(true);
      expect(navigate).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledWith("memory", {
        pathname: "/settings/memory/dreams",
      });
    } finally {
      element.remove();
    }
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
        configObject: {},
        catalog: [],
        replace,
        navigate,
        routeData: memoryRoute(sourceUrl),
      });
      mountMemoryPage(element);
      try {
        flush();
        for (let cycle = 0; cycle < 3; cycle += 1) {
          element.routeData = { ...element.routeData } as ConfigRouteData;
          flush();
        }
        dispatchTabShow(element, "overview");
        dispatchTabShow(element, "dreams");

        expect(replace).toHaveBeenCalledTimes(expectedUrl ? 1 : 0);
        expect(navigate).not.toHaveBeenCalled();
        if (!expectedUrl) {
          return;
        }
        const canonical = memoryRoute(expectedUrl);
        expect(replace).toHaveBeenCalledWith("memory", {
          pathname: canonical.pathname,
          search: canonical.search,
          hash: canonical.hash,
        });

        element.routeData = canonical;
        flush();
        for (let cycle = 0; cycle < 3; cycle += 1) {
          element.routeData = { ...element.routeData } as ConfigRouteData;
          flush();
        }
        expect(replace).toHaveBeenCalledOnce();
      } finally {
        element.remove();
      }
    },
  );

  it("loads Overview status once per activation, Settings agent change, and reconnect", async () => {
    const memoryStatus = vi.fn((agentId: string) =>
      Promise.resolve({ agentId, provider: "none", embedding: { ok: false, checked: false } }),
    );
    const { element, request, setPhase, settingsAgentSelection } = createPage({
      configObject: {},
      agents: [{ id: "main" }, { id: "research" }],
      selectedAgentId: "research",
      memoryStatus,
    });
    element.routeData = memoryTabRoute("overview");
    mountMemoryPage(element);
    try {
      await waitForSolid(() => expect(memoryStatus).toHaveBeenCalledTimes(1));
      expect(memoryStatus).toHaveBeenLastCalledWith("research", false);
      flush();
      expect(
        request.mock.calls.filter(([method]) => method === "doctor.memory.status"),
      ).toHaveLength(1);

      expect(element.querySelectorAll("openclaw-agent-select")).toHaveLength(0);
      expect(element.textContent).not.toContain("Agent view");
      settingsAgentSelection.set("main");
      await waitForSolid(() => expect(memoryStatus).toHaveBeenLastCalledWith("main", false));
      settingsAgentSelection.setScope(null);
      flush();
      expect(memoryStatus).toHaveBeenCalledTimes(2);
      settingsAgentSelection.set("research");
      await waitForSolid(() => expect(memoryStatus).toHaveBeenLastCalledWith("research", false));

      setPhase("disconnected");
      setPhase("connected");
      await waitForSolid(() => expect(memoryStatus).toHaveBeenCalledTimes(4));
    } finally {
      element.remove();
    }
  });

  it("reloads status when one pinned engine replaces another", async () => {
    const memoryStatus = vi.fn((agentId: string) =>
      Promise.resolve({ agentId, provider: "none", embedding: { ok: false, checked: false } }),
    );
    const { element } = createPage({
      configObject: { plugins: { slots: { memory: "engine-a" } } },
      catalog: [engine("engine-a", true), engine("engine-b", true)],
      memoryStatus,
    });
    element.routeData = memoryTabRoute("overview");
    mountMemoryPage(element);
    try {
      await waitForSolid(() => expect(memoryStatus).toHaveBeenCalledTimes(1));

      element.configObject = { plugins: { slots: { memory: "engine-b" } } };
      await waitForSolid(() => expect(memoryStatus).toHaveBeenCalledTimes(2));
      await waitForSolid(() => {
        expect(element.querySelector(".memory-overview__hero h2")?.textContent).toBe(
          "Memory is awake",
        );
        expect(element.textContent).toContain("engine-b");
      });
    } finally {
      element.remove();
    }
  });

  it.each([["main"], ["research", "main"]])(
    "keeps newer sidebar intent when a pending Memory link mounts (%j)",
    async (...choices: string[]) => {
      const { element, settingsAgentSelection, request } = createPage({
        configObject: {},
        agents: [{ id: "main" }, { id: "research" }],
        routeData: memoryRoute("/settings/memory?agent=research"),
      });
      Object.assign(element.routeData!, {
        agentSelectionIntent: {
          owner: settingsAgentSelection,
          revision: settingsAgentSelection.intentRevision,
        },
      });
      for (const agentId of choices) {
        settingsAgentSelection.set(agentId);
      }
      mountMemoryPage(element);
      try {
        await waitForSolid(() =>
          expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "main" }),
        );
        expect(settingsAgentSelection.state.selectedId).toBe("main");
        expect(request).not.toHaveBeenCalledWith("doctor.memory.status", { agentId: "research" });
      } finally {
        element.remove();
      }
    },
  );

  it("honors a fresh explicit Memory navigation after the sidebar changed the same URL's agent", async () => {
    const { element, settingsAgentSelection } = createPage({
      configObject: {},
      agents: [{ id: "main" }, { id: "research" }],
      routeData: memoryRoute("/settings/memory?agent=research"),
    });
    mountMemoryPage(element);
    try {
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
    } finally {
      element.remove();
    }
  });

  it("refreshes the current Overview after a same-connection plugin publication", async () => {
    const first = deferred<DoctorMemoryStatusPayload>();
    const second = deferred<DoctorMemoryStatusPayload>();
    const memoryStatus = vi.fn().mockReturnValueOnce(first.promise).mockReturnValue(second.promise);
    const { element, publishPluginGeneration } = createPage({ configObject: {}, memoryStatus });
    element.routeData = memoryTabRoute("overview");
    mountMemoryPage(element);
    try {
      await waitForSolid(() => expect(memoryStatus).toHaveBeenCalledOnce());
      publishPluginGeneration(1);
      await waitForSolid(() => expect(memoryStatus).toHaveBeenCalledTimes(2));
      second.resolve({
        agentId: "main",
        provider: "local",
        embedding: { ok: false, checked: true, error: "current embedding status" },
      });
      await waitForSolid(() => expect(element.textContent).toContain("current embedding status"));
      first.resolve({
        agentId: "main",
        provider: "local",
        embedding: { ok: false, checked: true, error: "obsolete embedding status" },
      });
      await first.promise;
      flush();
      expect(element.textContent).not.toContain("obsolete embedding status");
      publishPluginGeneration(1);
      flush();
      expect(memoryStatus).toHaveBeenCalledTimes(2);
    } finally {
      first.resolve({
        agentId: "main",
        provider: "none",
        embedding: { ok: false, checked: false },
      });
      second.resolve({
        agentId: "main",
        provider: "none",
        embedding: { ok: false, checked: false },
      });
      element.remove();
    }
  });

  it("shows the offline state when Overview is activated after disconnecting elsewhere", async () => {
    const { element, setPhase } = createPage({ configObject: {} });
    mountMemoryPage(element);
    try {
      flush();
      setPhase("disconnected");
      element.routeData = memoryTabRoute("overview");
      await waitForSolid(() =>
        expect(element.textContent).toContain(
          "The gateway is offline, so memory status is unavailable.",
        ),
      );
    } finally {
      element.remove();
    }
  });
});

describe("MemorySettingsPage dreaming support", () => {
  it.each(["reconnect", "plugin publication"])(
    "re-probes after %s and drops the abandoned capability result",
    async (change) => {
      const first = deferred<unknown>();
      const second = deferred<unknown>();
      const { element, lookupSchemaPath, setPhase, publishPluginGeneration } = createPage({
        configObject: {},
        lookupSchemaPath: (call) => (call === 0 ? first.promise : second.promise),
      });
      mountMemoryPage(element);
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
});
