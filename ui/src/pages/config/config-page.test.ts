/* @vitest-environment jsdom */

import type { ReactiveController } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { ConfigPage, configSelectionFromSearch, supportsSystemInfo } from "./config-page.ts";
import { renderQuickSettings } from "./quick.ts";
import type { ConfigViewState } from "./view.ts";

vi.mock("./quick.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  renderQuickSettings: vi.fn().mockReturnValue(document.createComment("")),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
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

describe("ConfigPage Quick Config keys", () => {
  it("reads thinkingDefault from agents.defaults", () => {
    vi.mocked(renderQuickSettings).mockClear();
    const page = new ConfigPage();
    const state = page as unknown as {
      context: ApplicationContext;
    };
    const patchForm = vi.fn();
    state.context = {
      runtimeConfig: {
        state: {
          connected: true,
          configSnapshot: { hash: "abc" },
          configFormDirty: false,
          configSaving: false,
          configApplying: false,
        },
        patchForm,
        resetDraft: vi.fn(),
        save: vi.fn(),
        apply: vi.fn(),
      },
      config: {
        current: {
          assistantIdentity: { name: "Test" },
          serverVersion: "1.0.0",
        },
      },
      gateway: {
        connection: { gatewayUrl: "http://localhost:20128" },
        snapshot: { hello: { server: { version: "1.0.0" } } },
      },
    } as unknown as ApplicationContext;

    const configObject: Record<string, unknown> = {
      agents: {
        defaults: {
          thinkingDefault: "high",
          fastMode: true,
          model: "gpt-4o",
        },
      },
    };

    (
      page as unknown as {
        renderQuickConfig: (c: Record<string, unknown>) => ReturnType<typeof renderQuickSettings>;
      }
    ).renderQuickConfig(configObject);

    expect(renderQuickSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        thinkingLevel: "high",
      }),
    );
  });

  it("reads thinkingDefault as 'off' when absent from config", () => {
    vi.mocked(renderQuickSettings).mockClear();
    const page = new ConfigPage();
    const state = page as unknown as {
      context: ApplicationContext;
    };
    state.context = {
      runtimeConfig: {
        state: {
          connected: true,
          configSnapshot: null,
          configFormDirty: false,
          configSaving: false,
          configApplying: false,
        },
        patchForm: vi.fn(),
        resetDraft: vi.fn(),
        save: vi.fn(),
        apply: vi.fn(),
      },
      config: {
        current: {
          assistantIdentity: { name: "Test" },
          serverVersion: "1.0.0",
        },
      },
      gateway: {
        connection: { gatewayUrl: "http://localhost:20128" },
        snapshot: { hello: { server: { version: "1.0.0" } } },
      },
    } as unknown as ApplicationContext;

    const configObject: Record<string, unknown> = {
      agents: {
        defaults: {
          model: "gpt-4o",
        },
      },
    };

    (
      page as unknown as {
        renderQuickConfig: (c: Record<string, unknown>) => ReturnType<typeof renderQuickSettings>;
      }
    ).renderQuickConfig(configObject);

    expect(renderQuickSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        thinkingLevel: "off",
      }),
    );
  });

  it("patches agents.defaults.thinkingDefault on change", () => {
    vi.mocked(renderQuickSettings).mockClear();
    const page = new ConfigPage();
    const state = page as unknown as {
      context: ApplicationContext;
    };
    const patchForm = vi.fn();
    state.context = {
      runtimeConfig: {
        state: {
          connected: true,
          configSnapshot: { hash: "abc" },
          configFormDirty: false,
          configSaving: false,
          configApplying: false,
        },
        patchForm,
        resetDraft: vi.fn(),
        save: vi.fn(),
        apply: vi.fn(),
      },
      config: {
        current: {
          assistantIdentity: { name: "Test" },
          serverVersion: "1.0.0",
        },
      },
      gateway: {
        connection: { gatewayUrl: "http://localhost:20128" },
        snapshot: { hello: { server: { version: "1.0.0" } } },
      },
    } as unknown as ApplicationContext;

    (
      page as unknown as {
        renderQuickConfig: (c: Record<string, unknown>) => ReturnType<typeof renderQuickSettings>;
      }
    ).renderQuickConfig({
      agents: { defaults: { model: "gpt-4o" } },
    });

    const { onThinkingChange } = vi.mocked(renderQuickSettings).mock.lastCall?.[0] ?? {};

    onThinkingChange?.("medium");
    expect(patchForm).toHaveBeenCalledWith(["agents", "defaults", "thinkingDefault"], "medium");
  });
});
