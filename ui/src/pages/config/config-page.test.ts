/* @vitest-environment jsdom */

import { render, type ReactiveController } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { loadLocalUserIdentity } from "../../app/settings.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  ConfigPage,
  configSelectionFromSearch,
  supportsQuickAutomation,
  supportsSystemInfo,
} from "./config-page.ts";
import type { ConfigViewState } from "./view.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

let localStorageMock: Storage;

beforeEach(() => {
  localStorageMock = createStorageMock();
  vi.stubGlobal("localStorage", localStorageMock);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConfigPage local user identity", () => {
  it("persists avatar selections while preserving the local display name", () => {
    localStorageMock.setItem(
      "openclaw.control.user.v1",
      JSON.stringify({ name: "Buns", avatar: "old" }),
    );
    const page = new ConfigPage();
    const state = page as unknown as {
      userAvatar: string | null;
      setLocalUserAvatar: (avatar: string | null) => void;
    };

    state.setLocalUserAvatar("🦞");

    expect(state.userAvatar).toBe("🦞");
    expect(loadLocalUserIdentity()).toEqual({ name: "Buns", avatar: "🦞" });
  });
});

describe("configSelectionFromSearch", () => {
  it("opens a valid linked Settings section", () => {
    expect(configSelectionFromSearch("communications", "?section=talk")).toEqual({
      activeSection: "talk",
      activeSubsection: null,
    });
  });

  it("falls back when a linked section does not belong to the page", () => {
    expect(configSelectionFromSearch("communications", "?section=gateway")).toEqual({
      activeSection: "messages",
      activeSubsection: null,
    });
  });
});

describe("supportsSystemInfo", () => {
  it("requires the Gateway to advertise system.info", () => {
    const hello = {
      features: { methods: ["health", "system.info"] },
    } as ApplicationGatewaySnapshot["hello"];
    const unsupportedHello = {
      features: { methods: ["health"] },
    } as ApplicationGatewaySnapshot["hello"];

    expect(supportsSystemInfo(hello)).toBe(true);
    expect(supportsSystemInfo(unsupportedHello)).toBe(false);
    expect(supportsSystemInfo(null)).toBe(false);
  });
});

describe("supportsQuickAutomation", () => {
  it("requires both cron.list and skills.status methods", () => {
    const both = {
      features: { methods: ["cron.list", "skills.status"] },
    } as ApplicationGatewaySnapshot["hello"];
    const partial = {
      features: { methods: ["cron.list"] },
    } as ApplicationGatewaySnapshot["hello"];
    const none = {
      features: { methods: ["health"] },
    } as ApplicationGatewaySnapshot["hello"];

    expect(supportsQuickAutomation(both)).toBe(true);
    expect(supportsQuickAutomation(partial)).toBe(false);
    expect(supportsQuickAutomation(none)).toBe(false);
    expect(supportsQuickAutomation(null)).toBe(false);
  });
});

describe("ConfigPage settings mode control", () => {
  it("uses the shared settings segmented control to switch modes", () => {
    const page = new ConfigPage();
    const state = page as unknown as {
      pageId: string;
      settingsMode: "quick" | "advanced";
      renderSettingsModeToggle: () => unknown;
    };
    state.pageId = "config";
    state.settingsMode = "quick";
    const container = document.createElement("div");
    document.body.append(container);
    render(state.renderSettingsModeToggle(), container);
    const group = container.querySelector<HTMLElement & { value: string }>("wa-radio-group");
    const [quick, advanced] = Array.from(
      container.querySelectorAll<HTMLElement & { checked: boolean }>("wa-radio"),
    );

    expect(group?.classList.contains("settings-segmented")).toBe(true);
    expect(group?.querySelector('[slot="label"]')?.textContent).toBe("Settings view");
    expect(quick?.classList.contains("settings-segmented__btn--active")).toBe(true);
    expect(quick?.checked).toBe(true);
    expect(advanced?.checked).toBe(false);
    if (group) {
      group.value = "advanced";
      group.dispatchEvent(new Event("change", { bubbles: true }));
    }

    expect(state.settingsMode).toBe("advanced");
  });
});

describe("ConfigPage system info", () => {
  it("clears stale host info when the Gateway disconnects", () => {
    const client = {} as GatewayBrowserClient;
    const snapshot = {
      client,
      connected: false,
      hello: null,
    } as ApplicationGatewaySnapshot;
    const page = new ConfigPage();
    const state = page as unknown as {
      context: { gateway: { snapshot: ApplicationGatewaySnapshot } };
      systemInfo: SystemInfoResult | null;
      systemInfoClient: GatewayBrowserClient | null;
      handleSystemInfoGatewaySnapshot: (snapshot: ApplicationGatewaySnapshot) => void;
    };
    state.context = { gateway: { snapshot } };
    state.systemInfoClient = client;
    state.systemInfo = {} as SystemInfoResult;

    state.handleSystemInfoGatewaySnapshot(snapshot);

    expect(state.systemInfo).toBeNull();
  });

  it("rejects an old Gateway source response when the replacement reuses its client", async () => {
    const firstResponse = deferred<SystemInfoResult>();
    const secondResponse = deferred<SystemInfoResult>();
    const client = {
      request: vi
        .fn()
        .mockImplementationOnce(() => firstResponse.promise)
        .mockImplementationOnce(() => secondResponse.promise),
    } as unknown as GatewayBrowserClient;
    const snapshot = {
      client,
      connected: true,
      hello: { features: { methods: ["system.info"] } },
    } as ApplicationGatewaySnapshot;
    const firstGateway = { snapshot } as ApplicationGateway;
    const secondGateway = { snapshot } as ApplicationGateway;
    const page = new ConfigPage();
    const state = page as unknown as {
      context: ApplicationContext;
      subscriptions: ReactiveController;
      shouldUpdate: () => boolean;
      syncSystemInfoPolling: () => void;
      synchronizeSystemInfoGateway: (gateway: ApplicationGateway) => void;
      loadSystemInfo: () => Promise<void>;
      systemInfo: SystemInfoResult | null;
      systemInfoUnavailable: boolean;
    };
    page.removeController(state.subscriptions);
    state.shouldUpdate = () => false;
    state.syncSystemInfoPolling = () => undefined;
    state.context = { gateway: firstGateway } as ApplicationContext;
    document.body.append(page);
    state.synchronizeSystemInfoGateway(firstGateway);

    const firstLoad = state.loadSystemInfo();
    state.systemInfo = {} as SystemInfoResult;
    state.systemInfoUnavailable = true;
    state.context = { gateway: secondGateway } as ApplicationContext;
    state.synchronizeSystemInfoGateway(secondGateway);
    const secondLoad = state.loadSystemInfo();

    const stale = { platform: "stale" } as unknown as SystemInfoResult;
    firstResponse.resolve(stale);
    await firstLoad;
    expect(state.systemInfo).toBeNull();
    expect(state.systemInfoUnavailable).toBe(false);

    const current = { platform: "current" } as unknown as SystemInfoResult;
    secondResponse.resolve(current);
    await secondLoad;
    expect(state.systemInfo).toBe(current);
    page.remove();
  });
});

describe("ConfigPage quick automation inventory", () => {
  type QuickAutomationHarness = {
    context: ApplicationContext;
    subscriptions: ReactiveController;
    shouldUpdate: () => boolean;
    pageId: string;
    settingsMode: string;
    syncQuickAutomationLifecycle: () => void;
    synchronizeQuickAutomationGateway: (gateway: ApplicationGateway) => void;
    loadQuickAutomation: (parts: { cron: boolean; skills: boolean }) => Promise<void>;
    quickAutomation: { cronJobCount: number; skillCount: number } | null;
    quickAutomationUnavailable: boolean;
    quickAutomationActive: boolean;
    quickAutomationGatewaySource: ApplicationGateway | null;
  };

  function mountQuickAutomationHarness(
    gateway: ApplicationGateway,
    opts: { autoLifecycle?: boolean } = {},
  ) {
    const page = new ConfigPage();
    const state = page as unknown as QuickAutomationHarness;
    page.removeController(state.subscriptions);
    state.shouldUpdate = () => false;
    state.pageId = "config";
    state.settingsMode = "quick";
    // Direct load tests stub lifecycle so gateway sync does not race a second load.
    if (!opts.autoLifecycle) {
      state.syncQuickAutomationLifecycle = () => undefined;
    }
    state.context = { gateway } as ApplicationContext;
    document.body.append(page);
    return { page, state };
  }

  it("derives counts from cron.list and skills.status", async () => {
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "cron.list") {
          return { jobs: [{}, {}, {}], total: 3 };
        }
        if (method === "skills.status") {
          return { skills: [{}, {}, {}, {}, {}] };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
    } as unknown as GatewayBrowserClient;
    const snapshot = {
      client,
      connected: true,
      hello: { features: { methods: ["cron.list", "skills.status"] } },
    } as ApplicationGatewaySnapshot;
    const gateway = { snapshot } as ApplicationGateway;
    const { page, state } = mountQuickAutomationHarness(gateway);
    state.synchronizeQuickAutomationGateway(gateway);

    await state.loadQuickAutomation({ cron: true, skills: true });

    expect(state.quickAutomation).toEqual({ cronJobCount: 3, skillCount: 5 });
    expect(state.quickAutomationUnavailable).toBe(false);
    expect(client.request).toHaveBeenCalledWith("cron.list", {});
    expect(client.request).toHaveBeenCalledWith("skills.status", {});
    page.remove();
  });

  it("loads both inventories once on Simple-settings entry", async () => {
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "cron.list") {
          return { jobs: [{}, {}], total: 2 };
        }
        if (method === "skills.status") {
          return { skills: [{}, {}, {}] };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
    } as unknown as GatewayBrowserClient;
    const snapshot = {
      client,
      connected: true,
      hello: { features: { methods: ["cron.list", "skills.status"] } },
    } as ApplicationGatewaySnapshot;
    const gateway = {
      snapshot,
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    } as unknown as ApplicationGateway;
    const { page, state } = mountQuickAutomationHarness(gateway, { autoLifecycle: true });

    state.synchronizeQuickAutomationGateway(gateway);
    await vi.waitFor(() => {
      expect(state.quickAutomation).toEqual({ cronJobCount: 2, skillCount: 3 });
    });

    expect(state.quickAutomationActive).toBe(true);
    expect(client.request).toHaveBeenCalledTimes(2);

    // A second lifecycle pass while still visible must not re-poll Skills.
    state.syncQuickAutomationLifecycle();
    await Promise.resolve();
    expect(client.request).toHaveBeenCalledTimes(2);
    page.remove();
  });

  it("refreshes only cron.list on the existing cron change event", async () => {
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "cron.list") {
          return { jobs: [{}, {}, {}, {}], total: 4 };
        }
        if (method === "skills.status") {
          return { skills: [{}, {}] };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
    } as unknown as GatewayBrowserClient;
    const snapshot = {
      client,
      connected: true,
      hello: { features: { methods: ["cron.list", "skills.status"] } },
    } as ApplicationGatewaySnapshot;
    const gateway = { snapshot } as ApplicationGateway;
    const { page, state } = mountQuickAutomationHarness(gateway);
    state.synchronizeQuickAutomationGateway(gateway);
    state.quickAutomation = { cronJobCount: 1, skillCount: 2 };
    state.quickAutomationActive = true;

    await state.loadQuickAutomation({ cron: true, skills: false });

    expect(state.quickAutomation).toEqual({ cronJobCount: 4, skillCount: 2 });
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith("cron.list", {});
    expect(client.request).not.toHaveBeenCalledWith("skills.status", {});
    page.remove();
  });

  it("marks the inventory unavailable when the gateway lacks support", () => {
    const snapshot = {
      client: {} as GatewayBrowserClient,
      connected: true,
      hello: { features: { methods: ["health"] } },
    } as ApplicationGatewaySnapshot;
    const gateway = { snapshot } as ApplicationGateway;
    const { page, state } = mountQuickAutomationHarness(gateway);
    state.synchronizeQuickAutomationGateway(gateway);

    expect(state.quickAutomationUnavailable).toBe(true);
    expect(state.quickAutomation).toBeNull();
    page.remove();
  });
});

describe("ConfigPage runtime config lifecycle", () => {
  it("loads replacement sources and clears sensitive reveal state", async () => {
    const page = new ConfigPage();
    const state = page as unknown as {
      configViewState: ConfigViewState;
      synchronizeRuntimeConfig: (runtimeConfig: ApplicationContext["runtimeConfig"]) => void;
    };
    const createRuntimeConfig = () =>
      ({
        state: {
          configSnapshot: null,
          configLoading: false,
          configSchema: null,
          configSchemaLoading: false,
        },
        ensureLoaded: vi.fn(() => Promise.resolve()),
        ensureSchemaLoaded: vi.fn(() => Promise.resolve()),
      }) as unknown as ApplicationContext["runtimeConfig"];
    const first = createRuntimeConfig();
    const second = createRuntimeConfig();

    state.synchronizeRuntimeConfig(first);
    await Promise.resolve();
    state.configViewState.rawRevealed = true;
    state.configViewState.envRevealed = true;
    state.configViewState.revealedSensitivePaths.add("gateway.auth.token");
    state.synchronizeRuntimeConfig(second);
    await Promise.resolve();

    expect(first.ensureLoaded).toHaveBeenCalledOnce();
    expect(first.ensureSchemaLoaded).toHaveBeenCalledOnce();
    expect(second.ensureLoaded).toHaveBeenCalledOnce();
    expect(second.ensureSchemaLoaded).toHaveBeenCalledOnce();
    expect(state.configViewState.rawRevealed).toBe(false);
    expect(state.configViewState.envRevealed).toBe(false);
    expect(state.configViewState.revealedSensitivePaths.size).toBe(0);
  });
});
