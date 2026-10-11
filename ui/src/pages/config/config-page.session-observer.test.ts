/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { resetServerUiPrefsSync } from "../../app/server-prefs.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import * as modelCatalogStore from "../../lib/model-catalog-store.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { settleLitElement, settleLitElements } from "../../test-helpers/lit-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { meetingStatus } from "../../test-helpers/transcripts.test-support.ts";
import { ConfigPage, configSelectionFromSearch, type ConfigPageId } from "./config-page.ts";
import { configRouteData, type ConfigRouteData } from "./route-data.ts";
import { pages } from "./route.ts";

describe("ConfigPage navigation", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("localStorage", createStorageMock());
    resetServerUiPrefsSync();
  });

  afterEach(async () => {
    const mounted = document.querySelectorAll<ConfigPage>("openclaw-config-page");
    document.body.replaceChildren();
    await settleLitElements(mounted);
    resetServerUiPrefsSync();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("ConfigPage advanced selection guard", () => {
    it("keeps curated sections off the Advanced page", () => {
      expect(configSelectionFromSearch("advanced", "?section=messages")).toEqual({
        activeSection: null,
        activeSubsection: null,
      });
      expect(configSelectionFromSearch("advanced", "?section=env")).toEqual({
        activeSection: "env",
        activeSubsection: null,
      });
      expect(configSelectionFromSearch("advanced", "?section=mcp")).toEqual({
        activeSection: null,
        activeSubsection: null,
      });
      expect(configSelectionFromSearch("advanced", "?section=tts")).toEqual({
        activeSection: null,
        activeSubsection: null,
      });
      expect(configSelectionFromSearch("advanced", "?section=broadcast")).toEqual({
        activeSection: "broadcast",
        activeSubsection: null,
      });
      expect(configSelectionFromSearch("advanced", "?section=models")).toEqual({
        activeSection: "models",
        activeSubsection: null,
      });
    });
  });

  describe("ConfigPage default selections", () => {
    it.each(["__proto__"])("rejects an unsupported runtime page id: %s", (pageId) => {
      expect(() => configSelectionFromSearch(pageId as ConfigPageId, "")).toThrow(
        "Unknown config page",
      );
    });
  });

  function routeContext(): ApplicationContext {
    const config = { messages: { ackReaction: "!" }, tts: { provider: "synthetic" } };
    const subscribe = () => () => undefined;
    const { gateway } = createApplicationGateway({
      client: null,
      phase: "offline",
      offlineStable: true,
      hello: null,
      canvasPluginSurfaceUrl: null,
      assistantAgentId: "main",
      sessionKey: "main",
      lastError: null,
      lastErrorCode: null,
    });
    return {
      basePath: "",
      gateway,
      settingsAgentSelection: { state: { selectedId: "main" }, subscribe },
      agentSelection: { state: { selectedId: "main" }, subscribe },
      agents: { state: { agentsList: null }, subscribe },
      config: {
        current: { assistantIdentity: { name: "OpenClaw" }, serverVersion: "test" },
        subscribe,
      },
      runtimeConfig: {
        state: {
          connected: false,
          configLoading: false,
          configSchemaLoading: false,
          configSnapshot: { config, runtimeConfig: config, hash: "settings-defaults" },
          configSchema: {
            type: "object",
            properties: {
              messages: { type: "object", properties: { ackReaction: { type: "string" } } },
              tts: { type: "object", properties: { provider: { type: "string" } } },
            },
          },
          configUiHints: {},
          configForm: config,
          configFormOriginal: config,
          configRaw: JSON.stringify(config),
          configRawOriginal: JSON.stringify(config),
          configValid: true,
          configIssues: [],
        },
        ensureLoaded: async () => undefined,
        ensureSchemaLoaded: async () => undefined,
        subscribe,
      },
      theme: { branding: resolveThemeBranding(undefined), serverSelection: null, subscribe },
      overlays: { snapshot: {}, subscribe },
      webPush: { snapshot: undefined, subscribe },
    } as unknown as ApplicationContext;
  }

  describe("ConfigPage route selections", () => {
    it.each([
      { profile: undefined, writes: 1 },
      { profile: "full", writes: 0 },
    ])("Security Full preserves an explicit choice from $profile", async ({ profile, writes }) => {
      const baseContext = routeContext();
      const patchForm = vi.fn();
      const removeFormValue = vi.fn();
      const context: ApplicationContext = {
        ...baseContext,
        gateway: {
          ...baseContext.gateway,
          snapshot: {
            ...baseContext.gateway.snapshot,
            phase: "connected",
            hello: gatewayHelloForMethods(["config.set"]),
          },
        },
        runtimeConfig: {
          ...baseContext.runtimeConfig,
          canSet: true,
          patchForm,
          removeFormValue,
          state: {
            ...baseContext.runtimeConfig.state,
            connected: true,
            configForm: profile ? { tools: { profile } } : {},
          },
        },
      };
      const provider = createApplicationContextProvider(context);
      document.body.append(provider);
      const page = new ConfigPage();
      page.pageId = "security";
      provider.append(page);
      await settleLitElement(page);

      expect(patchForm).not.toHaveBeenCalled();
      expect(removeFormValue).not.toHaveBeenCalled();
      const full = expectDefined(
        page.querySelector<HTMLInputElement>('.settings-segmented__input[value="full"]'),
        "Full tool choice",
      );
      expect(page.querySelectorAll(".settings-segmented__input")).toHaveLength(4);
      expect(page.querySelectorAll(".settings-segmented__btn--active")).toHaveLength(
        profile ? 1 : 0,
      );
      full.click();
      expect(patchForm).toHaveBeenCalledTimes(writes);
      if (writes > 0) {
        expect(patchForm).toHaveBeenCalledWith(["tools", "profile"], "full");
      }
      expect(removeFormValue).not.toHaveBeenCalled();
    });

    it.each([
      ["communications", "?section=tts", "config-section-tts", "config-section-messages"],
      ["notifications", "", "settings-communications-notifications", "config-section-messages"],
    ] as const)(
      "renders the selected section for %s%s",
      async (pageId, search, visibleId, absentId) => {
        const route = expectDefined(
          pages.find((entry) => entry.id === pageId),
          "config route",
        );
        const context = routeContext();
        const location = { pathname: `/settings/${pageId}`, search, hash: "" };
        const data = await route.loader?.(context, {
          location,
          signal: new AbortController().signal,
          shouldRun: () => true,
          revalidating: false,
          deps: expectDefined(route.loaderDeps, "config route dependencies")(context, location),
          cause: "navigation",
        });
        if (!data || typeof data !== "object" || !("section" in data)) {
          throw new Error("Config route did not return section data");
        }
        const module = await route.component();
        const provider = createApplicationContextProvider(context);
        document.body.append(provider);
        render(module.render(data as ConfigRouteData), provider);
        const page = expectDefined(
          provider.querySelector<ConfigPage>("openclaw-config-page"),
          "mounted config page",
        );
        await settleLitElement(page);

        expect(page.querySelector(`#${visibleId}`)).not.toBeNull();
        expect(page.querySelector(`#${absentId}`)).toBeNull();
        if (pageId === "communications") {
          expect(page.querySelector('wa-tab[aria-selected="true"]')?.textContent?.trim()).toBe(
            search ? "Voice" : "Messages",
          );
        }
      },
    );
  });

  describe("ConfigPage pending section navigation", () => {
    it.each(["replacement", "retirement", "disconnect"] as const)(
      "does not scroll to a stale target after %s",
      async (transition) => {
        const provider = createApplicationContextProvider(routeContext());
        document.body.append(provider);
        const page = new ConfigPage();
        page.pageId = "communications";
        page.routeData = configRouteData({
          pathname: "/settings/communications",
          search: "",
          hash: "",
        });
        provider.append(page);
        await settleLitElement(page);
        const frames = new Map<number, FrameRequestCallback>();
        let nextFrameId = 0;
        vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
          const id = ++nextFrameId;
          frames.set(id, callback);
          return id;
        });
        vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
          frames.delete(id);
        });
        const previousTarget = expectDefined(
          page.querySelector<HTMLElement>("#config-section-messages"),
          "rendered Messages section",
        );
        const previousScroll = vi.fn();
        previousTarget.scrollIntoView = previousScroll;
        page.routeData = configRouteData({
          pathname: "/settings/communications",
          search: "",
          hash: "#config-section-messages",
        });
        await settleLitElement(page);
        expect(previousScroll).not.toHaveBeenCalled();
        expect(frames.size).toBe(1);

        if (transition === "disconnect") {
          page.remove();
        } else {
          page.routeData = configRouteData({
            pathname: "/settings/communications",
            search: transition === "replacement" ? "?section=tts" : "",
            hash: transition === "replacement" ? "#config-section-tts" : "",
          });
          await settleLitElement(page);
        }
        const nextScroll = vi.fn();
        if (transition === "replacement") {
          expectDefined(
            page.querySelector<HTMLElement>("#config-section-tts"),
            "rendered Voice section",
          ).scrollIntoView = nextScroll;
          expect(frames.size).toBe(1);
        } else {
          expect(frames.size).toBe(0);
        }
        const pending = [...frames.values()];
        frames.clear();
        for (const frame of pending) {
          frame(0);
        }
        expect(previousScroll).not.toHaveBeenCalled();
        expect(nextScroll).toHaveBeenCalledTimes(transition === "replacement" ? 1 : 0);
      },
    );
  });
});

describe("ConfigPage model catalog lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const mountedPages = document.querySelectorAll<ConfigPage>("openclaw-config-page");
    document.body.replaceChildren();
    await settleLitElements(mountedPages);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function mount(
    client: GatewayBrowserClient,
    scopes: readonly string[] = ["operator.admin"],
  ) {
    const source = createApplicationGateway({
      client,
      phase: "connected",
      hello: gatewayHelloForMethods(["system.info"], scopes),
    } as ApplicationGatewaySnapshot);
    const subscribe = () => () => undefined;
    const context = {
      gateway: source.gateway,
      settingsAgentSelection: { state: { selectedId: "main" }, subscribe },
      agentSelection: { state: { selectedId: "main" }, subscribe },
      agents: { state: { agentsList: null }, subscribe },
      agentIdentity: { ensure: async () => undefined, subscribe },
      runtimeConfig: { state: { configSnapshot: {}, configSchema: {} }, subscribe },
      theme: { branding: resolveThemeBranding(undefined), serverSelection: null, subscribe },
      overlays: { snapshot: {}, subscribe },
      config: { subscribe },
      webPush: { subscribe },
    } as unknown as ApplicationContext;
    const page = new ConfigPage();
    page.pageId = "appearance";
    // Exercise the actual host, subscriptions and Tasks; browser recovery tests own the picker UI.
    vi.spyOn(page, "render").mockReturnValue(html``);
    const provider = createApplicationContextProvider(context);
    provider.append(page);
    document.body.append(provider);
    await settleLitElement(page);
    const state = page as unknown as {
      sessionObserverModels: ModelCatalogEntry[];
      sessionObserverModelsUnavailable: boolean;
      sessionObserverModelsTask: {
        taskComplete: Promise<unknown>;
      };
    };
    return { page, state, source, provider, context };
  }

  describe("ConfigPage session observer models", () => {
    it("keeps session-only Appearance usable without polling host details or models", async () => {
      const request = vi.fn().mockResolvedValue({});
      const { page, state, source } = await mount({ request } as unknown as GatewayBrowserClient, [
        "operator.sessions.read",
      ]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(request).not.toHaveBeenCalled();
      expect(state.sessionObserverModels).toEqual([]);
      source.publish({
        ...source.gateway.snapshot,
        hello: gatewayHelloForMethods(["system.info"]),
      });
      await settleLitElement(page);
      expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(1);
      source.publish({
        ...source.gateway.snapshot,
        hello: gatewayHelloForMethods(["system.info"], ["operator.sessions.read"]),
      });
      await settleLitElement(page);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(1);
      expect(state.sessionObserverModels).toEqual([]);
    });

    it("pauses hidden status reads and resumes one ten-second poll when visible", async () => {
      let visibility: DocumentVisibilityState = "hidden";
      vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
      const request = vi.fn((method: string) =>
        Promise.resolve(method === "models.list" ? { models: [] } : {}),
      );
      const { page } = await mount({ request } as unknown as GatewayBrowserClient);
      const statusReads = () => request.mock.calls.filter(([method]) => method === "system.info");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(statusReads()).toHaveLength(0);

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      globalThis.dispatchEvent(new Event("focus"));
      await settleLitElement(page);
      expect(statusReads()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(statusReads()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(statusReads()).toHaveLength(2);

      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(statusReads()).toHaveLength(2);
      page.remove();
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(statusReads()).toHaveLength(2);
    });

    it.each(["client", "source"] as const)(
      "fences a pending catalog after Gateway %s replacement",
      async (replacement) => {
        const first = deferred<ModelCatalogResult>();
        const second = deferred<ModelCatalogResult>();
        vi.spyOn(modelCatalogStore, "loadModelCatalog")
          .mockReturnValueOnce(first.promise)
          .mockReturnValueOnce(second.promise);
        const firstClient = {
          request: vi.fn().mockResolvedValue({}),
        } as unknown as GatewayBrowserClient;
        const secondClient =
          replacement === "client"
            ? ({ request: vi.fn().mockResolvedValue({}) } as unknown as GatewayBrowserClient)
            : firstClient;
        const { page, state, source, provider, context } = await mount(firstClient);
        const snapshot = { ...source.gateway.snapshot, client: secondClient };
        if (replacement === "source") {
          provider.setContext({ ...context, gateway: createApplicationGateway(snapshot).gateway });
        } else {
          source.publish(snapshot);
        }
        await settleLitElement(page);
        const secondLoad = state.sessionObserverModelsTask.taskComplete;
        const currentModels = [{ id: "small", name: "Small", provider: "openai" }];
        second.resolve({ models: currentModels });
        await secondLoad;
        expect(state.sessionObserverModels).toEqual(currentModels);

        first.resolve({ models: [{ id: "stale", name: "Stale", provider: "old" }] });
        await first.promise;
        await settleLitElement(page);
        expect(state.sessionObserverModels).toEqual(currentModels);
        expect(modelCatalogStore.loadModelCatalog).toHaveBeenCalledTimes(2);
        expect(modelCatalogStore.loadModelCatalog).toHaveBeenNthCalledWith(1, firstClient, {
          agentId: "main",
          preparedOnly: true,
          signal: expect.any(AbortSignal),
        });
        expect(modelCatalogStore.loadModelCatalog).toHaveBeenNthCalledWith(2, secondClient, {
          agentId: "main",
          preparedOnly: true,
          signal: expect.any(AbortSignal),
        });
      },
    );

    it("keeps same-client agent switches from restoring stale observer models", async () => {
      const firstMain = deferred<ModelCatalogResult>();
      const writer = deferred<ModelCatalogResult>();
      const secondMain = deferred<ModelCatalogResult>();
      let mainRequests = 0;
      const request = vi.fn((method: string, params: unknown) => {
        if (method === "system.info") {
          return Promise.resolve({});
        }
        const agentId = (params as { agentId?: string }).agentId;
        if (agentId === "writer") {
          return writer.promise;
        }
        mainRequests += 1;
        return mainRequests === 1 ? firstMain.promise : secondMain.promise;
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const { page, state, context } = await mount(client);
      const selection = context.settingsAgentSelection.state as { selectedId: string | null };
      selection.selectedId = "writer";
      page.requestUpdate();
      await settleLitElement(page);
      const writerLoad = state.sessionObserverModelsTask.taskComplete;
      const writerModels = [{ id: "writer-model", name: "Writer Model", provider: "openai" }];
      writer.resolve({ models: writerModels });
      await writerLoad;
      expect(state.sessionObserverModels).toEqual(writerModels);

      selection.selectedId = "main";
      page.requestUpdate();
      await settleLitElement(page);
      const secondMainLoad = state.sessionObserverModelsTask.taskComplete;
      const currentMainModels = [{ id: "current-main", name: "Current Main", provider: "openai" }];
      expect(mainRequests).toBe(2);
      expect(state.sessionObserverModels).toEqual([]);
      firstMain.resolve({ models: [{ id: "stale-main", name: "Stale Main", provider: "openai" }] });
      await settleLitElement(page);
      expect(mainRequests).toBe(2);
      expect(state.sessionObserverModels).toEqual([]);
      secondMain.resolve({ models: currentMainModels });
      await secondMainLoad;
      await settleLitElement(page);
      expect(state.sessionObserverModels).toEqual(currentMainModels);
      expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual(
        ["main", "writer", "main"].map((agentId) => [
          "models.list",
          { agentId, preparedOnly: true, view: "configured" },
        ]),
      );

      selection.selectedId = null;
      page.requestUpdate();
      await settleLitElement(page);
      expect(state.sessionObserverModels).toEqual([]);
      expect(state.sessionObserverModelsUnavailable).toBe(true);
      expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(3);
    });

    it("keeps a slow refresh through status polls and retires its page reader on detach", async () => {
      const stale = deferred<ModelCatalogResult>();
      const original = [{ id: "original", name: "Original", provider: "openai" }];
      const fresh = [{ id: "fresh", name: "Fresh", provider: "openai" }];
      let catalogReads = 0;
      const request = vi.fn((method: string) => {
        if (method === "system.info") {
          return Promise.resolve({});
        }
        catalogReads += 1;
        if (catalogReads !== 2) {
          return Promise.resolve({ models: catalogReads === 1 ? original : fresh });
        }
        return stale.promise;
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const { page, state, provider } = await mount(client);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(catalogReads).toBe(1);

      // The application retires catalogs on publication; the next status poll reads that generation.
      invalidateChatMetadataStore(client);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(state.sessionObserverModels).toEqual(original);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(6);
      expect(catalogReads).toBe(2);
      page.remove();
      expect(state.sessionObserverModels).toEqual([]);
      await settleLitElement(page);

      provider.append(page);
      await settleLitElement(page);
      expect(catalogReads).toBe(3);
      stale.resolve({ models: original });
      await settleLitElement(page);
      expect(state.sessionObserverModels).toEqual(fresh);
      expect(catalogReads).toBe(3);
    });

    it("stops status polling outside Appearance while the page remains mounted", async () => {
      const request = vi.fn((method: string) =>
        Promise.resolve(method === "models.list" ? { models: [] } : {}),
      );
      const { page } = await mount({ request } as unknown as GatewayBrowserClient);
      expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(1);
      page.pageId = "advanced";
      await settleLitElement(page);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(page.isConnected).toBe(true);
      expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(1);
      page.pageId = "appearance";
      await settleLitElement(page);
      expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(2);
    });
  });
});

describe("ConfigPage meeting capture", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("keeps Messages default and opens capture with a collapsed schema editor inside the section panel", async () => {
    const config = { messages: { ackReaction: "ok" }, transcripts: { enabled: true } };
    const request = vi.fn(async (method: string) => {
      if (method === "transcripts.status") {
        return meetingStatus;
      }
      if (method === "config.schema") {
        return {
          schema: {
            type: "object",
            properties: {
              messages: { type: "object", properties: { ackReaction: { type: "string" } } },
              tts: { type: "object", properties: { enabled: { type: "boolean" } } },
              transcripts: { type: "object", properties: { enabled: { type: "boolean" } } },
            },
          },
          uiHints: {},
        };
      }
      return {
        config,
        hash: "one",
        appliedConfigHash: "one",
        raw: JSON.stringify(config),
        valid: true,
        issues: [],
      };
    });
    const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    const container = document.createElement("div");
    try {
      await runtimeConfig.ensureLoaded();
      await runtimeConfig.ensureSchemaLoaded();
      const context = {
        basePath: "",
        gateway: { ...gateway, connection: { gatewayUrl: "ws://transcripts.test" } },
        runtimeConfig,
        agentSelection: { state: { selectedId: "main" } },
        agents: { state: { agentsList: null } },
        theme: { branding: resolveThemeBranding(undefined) },
        navigate: vi.fn(),
        config: { current: { assistantIdentity: { name: "OpenClaw" } } },
        overlays: { snapshot: { updateRunning: false, updateReconciliationPending: false } },
        webPush: { snapshot: {} },
      } as unknown as ApplicationContext;
      const page = new ConfigPage();
      (page as unknown as { context: ApplicationContext }).context = context;
      page.pageId = "communications";
      render(page.render(), container);
      expect(container.querySelector("openclaw-meeting-capture-settings")).toBeNull();
      const captureTab = container.querySelector<HTMLElement>('wa-tab[panel="transcripts"]')!;
      expect(captureTab.textContent?.trim()).toBe("Meeting capture");
      const tabs = captureTab.closest("wa-tab-group") as HTMLElement & { active: string };
      expect(tabs.active).toBe("messages");
      captureTab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      render(page.render(), container);
      const capture = container.querySelector(
        "openclaw-meeting-capture-settings",
      ) as HTMLElement & {
        context: ApplicationContext;
        updateComplete: Promise<boolean>;
      };
      expect(container.querySelector("#config-section-panel")?.contains(capture)).toBe(true);
      capture.context = context;
      document.body.append(container);
      await capture.updateComplete;
      const advanced = capture.querySelector<HTMLDetailsElement>("details")!;
      expect(advanced).not.toBeNull();
      expect(advanced.open).toBe(false);
      expect(advanced.querySelector("#config-section-transcripts")).not.toBeNull();
      const toggle = capture.querySelector<HTMLInputElement>(".settings-toggle__input")!;
      toggle.checked = false;
      toggle.dispatchEvent(new Event("change"));
      expect(runtimeConfig.state.configForm).toMatchObject({ transcripts: { enabled: false } });
      expect(
        [...capture.querySelectorAll("button")].some(
          (button) => button.textContent?.trim() === "Save",
        ),
      ).toBe(false);
      const advancedToggled = new Promise<void>((resolve) => {
        advanced.addEventListener("toggle", () => resolve(), { once: true });
      });
      page.routeData = {
        pathname: "/settings/communications",
        search: "?section=transcripts&advanced=1",
        hash: "#config-section-transcripts",
        section: "transcripts",
        advanced: true,
        tab: null,
        targetBlockId: "config-section-transcripts",
      };
      page.willUpdate(new Map([["routeData", null]]));
      render(page.render(), container);
      await capture.updateComplete;
      expect(advanced.open).toBe(true);
      await advancedToggled;
      const messagesTab = container.querySelector<HTMLElement>('wa-tab[panel="messages"]')!;
      messagesTab.focus();
      messagesTab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      render(page.render(), container);
      expect(container.querySelector("openclaw-meeting-capture-settings")).toBeNull();
      // Join the queued keyboard focus handoff before fixture cleanup.
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
      });
      expect(document.activeElement).toBe(messagesTab);
    } finally {
      container.remove();
      runtimeConfig.dispose();
    }
  });
});
