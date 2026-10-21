/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createRouter } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { mountRouterOutlet } from "../../app/router-outlet.test-support.tsx";
import { resetServerUiPrefsSync } from "../../app/server-prefs.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import * as modelCatalogStore from "../../lib/model-catalog-store.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { meetingStatus } from "../../test-helpers/transcripts.test-support.ts";
import { createUpdateRunFixture } from "../../test-helpers/update-run.ts";
import { mountAppearanceCatalogPage as mount } from "./config-page-catalog.test-support.ts";
import {
  completeConfigContext,
  mountConfigPage,
  publishConfigSource,
} from "./config-page.test-support.ts";
import type { ConfigPageRouteData } from "./config-page.tsx";
import { configSelectionFromSearch, type ConfigPageId } from "./config-sections.ts";
import { configRouteData } from "./route-data.ts";
import { pages } from "./route.ts";

function query<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  return expectDefined(root.querySelector<T>(selector), selector);
}

function animationFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => frames.delete(id));
  return {
    frames,
    run() {
      const pending = [...frames.values()];
      frames.clear();
      for (const frame of pending) {
        frame(0);
      }
    },
  };
}

const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties });
const fieldSchema = (field: string, type: string) => objectSchema({ [field]: { type } });
const settingsRoute = (pageId: ConfigPageId, search = "", hash = "") =>
  configRouteData({ pathname: `/settings/${pageId}`, search, hash });

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
});
afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  resetServerUiPrefsSync();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ConfigPage navigation", () => {
  it("keeps curated sections off the Advanced page", () => {
    for (const section of ["messages", "env", "mcp", "tts", "broadcast", "models"]) {
      expect(configSelectionFromSearch("advanced", `?section=${section}`)).toEqual({
        activeSection: ["env", "broadcast", "models"].includes(section) ? section : null,
        activeSubsection: null,
      });
    }
  });
  it.each(["__proto__"])("rejects an unsupported runtime page id: %s", (pageId) => {
    expect(() => configSelectionFromSearch(pageId as ConfigPageId, "")).toThrow(
      "Unknown config page",
    );
  });

  function routeContext(): ApplicationContext {
    const config = { messages: { ackReaction: "!" }, tts: { provider: "synthetic" } };
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
    return completeConfigContext({
      gateway,
      config: { current: { assistantIdentity: { name: "OpenClaw" }, serverVersion: "test" } },
      runtimeConfig: {
        state: {
          configSnapshot: { config, runtimeConfig: config, hash: "settings-defaults" },
          configSchema: objectSchema({
            messages: fieldSchema("ackReaction", "string"),
            tts: fieldSchema("provider", "string"),
          }),
          configForm: config,
          configFormOriginal: config,
          configRaw: JSON.stringify(config),
          configRawOriginal: JSON.stringify(config),
        },
      },
    } as unknown as ApplicationContext);
  }

  it.each([
    ["owner administrator", "gateway-owner", "operator.admin", true, true],
    ["named administrator", "other-operator", "operator.admin", true, true],
    ["unidentified administrator", null, "operator.admin", true, false],
    ["owner without administrator scope", "gateway-owner", "operator.write", true, false],
    ["disconnected owner", "gateway-owner", "operator.admin", false, false],
  ] as const)(
    "gates report clicks for %s with a stale method catalog",
    async (_label, profileId, scope, connected, allowed) => {
      const reportUpdateFailure = vi.fn(async () => undefined);
      const run = createUpdateRunFixture({
        phase: "finished",
        status: "failed",
        reason: "build-failed",
        finishedAtMs: 500,
      });
      const context = routeContext();
      context.runtimeConfig.state.connected = true;
      Object.assign(context.gateway.snapshot, {
        client: {},
        phase: connected ? "connected" : "reconnecting",
        selfUser: profileId ? { id: profileId } : null,
        hello: {
          auth: { role: "operator", scopes: [scope] },
          features: { methods: ["update.status"] },
        },
      });
      Object.assign(context.overlays, {
        snapshot: {
          updateRun: run,
          reportableUpdateFailureId: run.runId,
        },
        reportUpdateFailure,
        refreshUpdateStatus: vi.fn(async () => true),
      });
      const { container } = mountConfigPage(context, { pageId: "updates" });
      const report = await waitForSolid(() =>
        expectDefined(
          [...container.querySelectorAll<HTMLButtonElement>("button")].find(
            (button) => button.textContent?.trim() === "Report update failure",
          ),
          "report button",
        ),
      );
      expect(report).toMatchObject({ disabled: !allowed });
      report.click();
      expect(reportUpdateFailure.mock.calls).toEqual(allowed ? [[run.runId]] : []);
    },
  );

  describe("ConfigPage route selections", () => {
    it.each([
      { pageId: "communications", section: "transcripts" },
      { pageId: "ai-agents", section: "session" },
    ] as const)(
      "opens the $section advanced editor for a matching hash",
      async ({ pageId, section }) => {
        const context = routeContext();
        Object.assign(context.runtimeConfig.state, {
          configForm: { [section]: { enabled: true } },
          configSchema: objectSchema({ [section]: fieldSchema("enabled", "boolean") }),
        });
        const routeData = settingsRoute(pageId, `?section=${section}`);
        const view = mountConfigPage(context, { pageId, routeData });
        const editor = view.container.querySelector(`#config-section-${section}`)!;
        const disclosure = editor.closest("details")!;
        expect(disclosure.open).toBe(false);
        view.update({
          routeData: {
            ...routeData,
            hash: `#config-section-${section}`,
            targetBlockId: `config-section-${section}`,
          },
        });
        await waitForSolid(() => expect(disclosure.open).toBe(true));
        expect(view.container.querySelector(`#config-section-${section}`)).toBe(editor);
      },
    );

    it.each([
      { profile: undefined, writes: 1 },
      { profile: "full", writes: 0 },
    ])("Security Full preserves an explicit choice from $profile", async ({ profile, writes }) => {
      const context = routeContext();
      const patchForm = vi.fn();
      const removeFormValue = vi.fn();
      Object.assign(context.gateway.snapshot, {
        phase: "connected",
        hello: gatewayHelloForMethods(["config.set"]),
      });
      Object.assign(context.runtimeConfig, { canSet: true, patchForm, removeFormValue });
      Object.assign(context.runtimeConfig.state, {
        connected: true,
        configForm: profile ? { tools: { profile } } : {},
      });
      const { page } = mountConfigPage(context, { pageId: "security" });
      flush();

      expect(patchForm).not.toHaveBeenCalled();
      expect(removeFormValue).not.toHaveBeenCalled();
      const full = query<HTMLInputElement>(page, '.settings-segmented__input[value="full"]');
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
        expect(data).toMatchObject({ pageId });
        const module = await route.component();
        const provider = createSolidApplicationContextProvider(completeConfigContext(context));
        const render = expectDefined(module.renderSolid, "Solid config route");
        const { container } = mountSolid(
          () =>
            render({ data: data as ConfigPageRouteData, loaderPending: false, presented: true }),
          { wrapper: provider.wrapper },
        );
        const page = query(container, "openclaw-config-page");
        flush();

        await waitForSolid(() => expect(page.querySelector(`#${visibleId}`)).not.toBeNull());
        expect(page.querySelector(`#${absentId}`)).toBeNull();
        if (pageId === "communications") {
          expect(page.querySelector('.hub-tab[aria-selected="true"]')?.textContent?.trim()).toBe(
            search ? "Voice" : "Messages",
          );
        }
      },
    );
  });

  it("keeps the config owner through a pending subpage loader in the real outlet", async () => {
    const context = completeConfigContext(routeContext());
    const configPages = pages.filter((route) => route.id !== "settings" && route.id !== "config");
    const communications = expectDefined(
      configPages.find((route) => route.id === "communications"),
      "communications route",
    );
    const advanced = expectDefined(
      configPages.find((route) => route.id === "advanced"),
      "advanced route",
    );
    const loadAdvanced = expectDefined(advanced.loader, "advanced loader");
    const releaseAdvanced = deferred();
    const provider = createSolidApplicationContextProvider(context);
    const productionModule = await communications.component();
    const render = productionModule.renderSolid;
    expect((await advanced.component()).renderSolid).toBe(render);
    const module = {
      ...productionModule,
      renderSolid: (props: Parameters<typeof render>[0]) =>
        createComponent(provider.wrapper, {
          get children() {
            return createComponent(render, props);
          },
        }),
    };
    const router = createRouter<
      ConfigPageId,
      ApplicationContext,
      typeof module,
      ConfigPageRouteData
    >({
      routes: [
        { ...communications, component: () => module },
        {
          ...advanced,
          component: () => module,
          loader: async (...args: Parameters<typeof loadAdvanced>) => {
            const data = loadAdvanced(...args);
            await releaseAdvanced.promise;
            return data;
          },
        },
      ],
    });
    const mounted = mountRouterOutlet({ router, retryContext: context });
    try {
      await router.navigate(
        "communications",
        context,
        {},
        settingsRoute("communications", "?section=tts"),
      );
      await waitForSolid(() => {
        expect(mounted.querySelector("#config-section-tts")).not.toBeNull();
      });
      const host = expectDefined(mounted.querySelector("openclaw-config-page"), "config host");
      expect(host.querySelector(".content-header--settings .page-title")?.textContent).toBe(
        "Communications",
      );

      const navigation = router.navigate("advanced", context);
      await waitForSolid(() => {
        const pending = router.getState().matches[0];
        expect(pending).toMatchObject({ routeId: "advanced", status: "pending" });
        expect(pending?.module).toBeDefined();
        expect(pending?.data).toBeUndefined();
      });
      expect(mounted.querySelector("openclaw-config-page")).toBe(host);
      expect(host.isConnected).toBe(true);
      expect(host.querySelector(".content-header--settings .page-title")?.textContent).toBe(
        "Communications",
      );
      expect(host.querySelector("#config-section-tts")).not.toBeNull();

      releaseAdvanced.resolve(undefined);
      await navigation;
      await waitForSolid(() => {
        expect(host.querySelector(".content-header--settings .page-title")?.textContent).toBe(
          "Advanced",
        );
      });
      expect(mounted.querySelector("openclaw-config-page")).toBe(host);
      expect(host.isConnected).toBe(true);
    } finally {
      releaseAdvanced.resolve(undefined);
      mounted.dispose();
      router.stop();
    }
  });

  describe("ConfigPage pending section navigation", () => {
    it.each([
      ["appearance", "__appearance__", "settings-appearance-typography"],
      ["appearance", "__appearance__", "settings-accent-status"],
      ["ai-agents", "session", "settings-session-storage"],
      ["communications", "transcripts", "settings-communications-meeting-capture"],
    ] as const)(
      "scrolls to the Settings %s %s #%s anchor after rendering",
      (pageId, section, targetId) => {
        const frames = animationFrames();
        const context = routeContext();
        context.runtimeConfig.state.configSchema = objectSchema({
          session: fieldSchema("enabled", "boolean"),
          transcripts: fieldSchema("enabled", "boolean"),
        });
        const view = mountConfigPage(context, {
          pageId,
          routeData: settingsRoute(pageId, `?section=${section}`, `#${targetId}`),
        });
        const target = query(view.page, `#${targetId}`);
        const scroll = vi.fn();
        target.scrollIntoView = scroll;
        frames.run();
        expect(scroll).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ block: "start" }));
      },
    );

    it("does not scroll to a matching ID outside the Settings host", () => {
      const outside = document.createElement("div");
      outside.id = "external-setting-target";
      const scroll = vi.fn();
      outside.scrollIntoView = scroll;
      document.body.append(outside);
      const frames = animationFrames();
      mountConfigPage(routeContext(), {
        pageId: "communications",
        routeData: settingsRoute("communications", "", "#external-setting-target"),
      });
      frames.run();
      expect(scroll).not.toHaveBeenCalled();
    });

    it.each(["replacement", "retirement", "disconnect"] as const)(
      "does not scroll to a stale target after %s",
      async (transition) => {
        const view = mountConfigPage(routeContext(), {
          pageId: "communications",
          routeData: settingsRoute("communications"),
        });
        const { page } = view;
        flush();
        const { frames, run } = animationFrames();
        const previousTarget = query(page, "#config-section-messages");
        const previousScroll = vi.fn();
        previousTarget.scrollIntoView = previousScroll;
        view.update({
          routeData: settingsRoute("communications", "", "#config-section-messages"),
        });
        flush();
        expect(previousScroll).not.toHaveBeenCalled();
        expect(frames.size).toBe(1);

        if (transition === "disconnect") {
          view.dispose();
        } else {
          view.update({
            routeData: settingsRoute(
              "communications",
              transition === "replacement" ? "?section=tts" : "",
              transition === "replacement" ? "#config-section-tts" : "",
            ),
          });
          flush();
        }
        const nextScroll = vi.fn();
        if (transition === "replacement") {
          query(page, "#config-section-tts").scrollIntoView = nextScroll;
          expect(frames.size).toBe(1);
        } else {
          expect(frames.size).toBe(0);
        }
        run();
        expect(previousScroll).not.toHaveBeenCalled();
        expect(nextScroll).toHaveBeenCalledTimes(transition === "replacement" ? 1 : 0);
      },
    );
  });
});

describe("ConfigPage model catalog lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());

  function observerModels(view: ReturnType<typeof mountConfigPage>) {
    const picker = query<HTMLElement & { params: { options: { value: string; label: string }[] } }>(
      view.page,
      "#settings-appearance-sidebar openclaw-select-picker",
    );
    return picker.params.options.slice(2).map(({ value, label }) => ({ value, label }));
  }

  function expectModels(
    view: ReturnType<typeof mountConfigPage>,
    models: ModelCatalogEntry[] = [],
  ) {
    return waitForSolid(() =>
      expect(observerModels(view)).toEqual(
        models.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name })),
      ),
    );
  }
  function expectStatusReads(request: { mock: { calls: unknown[][] } }, count: number) {
    return waitForSolid(() =>
      expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(count),
    );
  }

  describe("ConfigPage session observer models", () => {
    it("keeps session-only Appearance usable without polling host details or models", async () => {
      const request = vi.fn().mockResolvedValue({});
      const { view, source } = await mount({ request } as unknown as GatewayBrowserClient, [
        "operator.sessions.read",
      ]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(request).not.toHaveBeenCalled();
      await expectModels(view);
      source.publish({
        ...source.gateway.snapshot,
        hello: gatewayHelloForMethods(["system.info"]),
      });
      flush();
      await expectStatusReads(request, 1);
      source.publish({
        ...source.gateway.snapshot,
        hello: gatewayHelloForMethods(["system.info"], ["operator.sessions.read"]),
      });
      flush();
      await vi.advanceTimersByTimeAsync(30_000);
      await expectStatusReads(request, 1);
      await expectModels(view);
    });

    it("pauses hidden status reads and resumes one ten-second poll when visible", async () => {
      let visibility: DocumentVisibilityState = "hidden";
      vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
      const request = vi.fn((method: string) =>
        Promise.resolve(method === "models.list" ? { models: [] } : {}),
      );
      const { view } = await mount({ request } as unknown as GatewayBrowserClient);
      const statusReads = () => request.mock.calls.filter(([method]) => method === "system.info");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(statusReads()).toHaveLength(0);

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      globalThis.dispatchEvent(new Event("focus"));
      flush();
      expect(statusReads()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(statusReads()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(statusReads()).toHaveLength(2);

      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(statusReads()).toHaveLength(2);
      view.dispose();
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
        const { view, source, context } = await mount(firstClient);
        await waitForSolid(() => expect(modelCatalogStore.loadModelCatalog).toHaveBeenCalledOnce());
        const snapshot = { ...source.gateway.snapshot, client: secondClient };
        if (replacement === "source") {
          view.setContext({ ...context, gateway: createApplicationGateway(snapshot).gateway });
        } else {
          source.publish(snapshot);
        }
        flush();
        const currentModels = [{ id: "small", name: "Small", provider: "openai" }];
        second.resolve({ models: currentModels });
        flush();
        await expectModels(view, currentModels);

        first.resolve({ models: [{ id: "stale", name: "Stale", provider: "old" }] });
        await first.promise;
        flush();
        await expectModels(view, currentModels);
        expect(modelCatalogStore.loadModelCatalog).toHaveBeenCalledTimes(2);
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
      const { view, context } = await mount(client);
      await waitForSolid(() => expect(mainRequests).toBe(1));
      const selection = context.settingsAgentSelection.state as { selectedId: string | null };
      selection.selectedId = "writer";
      publishConfigSource(context.settingsAgentSelection);
      flush();
      const writerModels = [{ id: "writer-model", name: "Writer Model", provider: "openai" }];
      writer.resolve({ models: writerModels });
      flush();
      await expectModels(view, writerModels);

      selection.selectedId = "main";
      publishConfigSource(context.settingsAgentSelection);
      flush();
      const currentMainModels = [{ id: "current-main", name: "Current Main", provider: "openai" }];
      await waitForSolid(() => expect(mainRequests).toBe(2));
      await expectModels(view);
      firstMain.resolve({ models: [{ id: "stale-main", name: "Stale Main", provider: "openai" }] });
      flush();
      expect(mainRequests).toBe(2);
      await expectModels(view);
      secondMain.resolve({ models: currentMainModels });
      flush();
      await expectModels(view, currentMainModels);

      selection.selectedId = null;
      publishConfigSource(context.settingsAgentSelection);
      flush();
      await expectModels(view);
      await waitForSolid(() =>
        expect(view.page.textContent).toContain("Explicit model catalog unavailable"),
      );
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
      const { view, context } = await mount(client);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(catalogReads).toBe(1);

      // The application retires catalogs on publication; the next status poll reads that generation.
      invalidateChatMetadataStore(client);
      await vi.advanceTimersByTimeAsync(10_000);
      await expectModels(view, original);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(6);
      expect(catalogReads).toBe(2);
      view.dispose();
      flush();

      const remounted = mountConfigPage(context, { pageId: "appearance" });
      await waitForSolid(() => expect(catalogReads).toBe(3));
      await expectModels(remounted, fresh);
      stale.resolve({ models: original });
      flush();
      await expectModels(remounted, fresh);
      expect(catalogReads).toBe(3);
    });

    it("recovers a rejected catalog on the next admitted poll without replacing other controls", async () => {
      const failed = deferred<ModelCatalogResult>();
      const models = [{ id: "small", name: "Small", provider: "openai" }];
      const load = vi
        .spyOn(modelCatalogStore, "loadModelCatalog")
        .mockReturnValueOnce(failed.promise)
        .mockResolvedValue({ models });
      const request = vi.fn().mockResolvedValue({});
      const { view } = await mount(createTestGatewayClient(request));
      await waitForSolid(() => expect(load).toHaveBeenCalledOnce());
      const toggle = query<HTMLInputElement>(view.page, "#settings-appearance-sidebar input");
      failed.reject(new Error("catalog temporarily unavailable"));
      await waitForSolid(() =>
        expect(view.page.textContent).toContain("Explicit model catalog unavailable"),
      );
      expect(observerModels(view)).toEqual([]);
      const picker = query<
        HTMLElement & { params: { options: { value: string; disabled?: boolean }[] } }
      >(view.page, "#settings-appearance-sidebar openclaw-select-picker");
      expect(picker.params.options.slice(0, 2).map((option) => option.disabled === true)).toEqual([
        false,
        false,
      ]);
      expect(view.page.querySelector("#settings-appearance-sidebar input")).toBe(toggle);

      await vi.advanceTimersByTimeAsync(10_000);
      await expectModels(view, models);
      expect(view.page.textContent).not.toContain("Explicit model catalog unavailable");
      expect(view.page.querySelector("#settings-appearance-sidebar input")).toBe(toggle);
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("stops status polling outside Appearance while the page remains mounted", async () => {
      const request = vi.fn((method: string) =>
        Promise.resolve(method === "models.list" ? { models: [] } : {}),
      );
      const { view } = await mount({ request } as unknown as GatewayBrowserClient);
      await expectStatusReads(request, 1);
      view.update({ pageId: "advanced" });
      flush();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(view.page.isConnected).toBe(true);
      await expectStatusReads(request, 1);
      view.update({ pageId: "appearance" });
      flush();
      await expectStatusReads(request, 2);
    });
  });
});

describe("ConfigPage meeting capture", () => {
  it("keeps Messages default and opens capture with a collapsed schema editor inside the section panel", async () => {
    const config = { messages: { ackReaction: "ok" }, transcripts: { enabled: true } };
    const request = vi.fn(async (method: string) => {
      if (method === "transcripts.status") {
        return meetingStatus;
      }
      if (method === "config.schema") {
        return {
          schema: objectSchema({
            messages: fieldSchema("ackReaction", "string"),
            tts: fieldSchema("enabled", "boolean"),
            transcripts: fieldSchema("enabled", "boolean"),
          }),
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
    try {
      await runtimeConfig.ensureLoaded();
      await runtimeConfig.ensureSchemaLoaded();
      const context = {
        gateway: { ...gateway, connection: { gatewayUrl: "ws://transcripts.test" } },
        runtimeConfig,
        navigate: vi.fn(),
        overlays: { snapshot: { updateRunning: false, updateReconciliationPending: false } },
      } as unknown as ApplicationContext;
      const view = mountConfigPage(context, { pageId: "communications" });
      const container = view.container;
      flush();
      expect(container.querySelector("openclaw-meeting-capture-settings")).toBeNull();
      const captureTab = query(container, '.hub-tab[data-tab-value="transcripts"]');
      expect(captureTab.textContent?.trim()).toBe("Meeting capture");
      const tabs = captureTab.closest(".hub-tabs")!;
      expect(tabs.querySelector("[active]")?.getAttribute("data-tab-value")).toBe("messages");
      captureTab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      flush();
      const capture = query(container, "openclaw-meeting-capture-settings");
      expect(container.querySelector("#config-section-panel")?.contains(capture)).toBe(true);
      flush();
      const advanced = query<HTMLDetailsElement>(capture, "details");
      expect(advanced.open).toBe(false);
      expect(advanced.querySelector("#config-section-transcripts")).not.toBeNull();
      const toggle = query<HTMLInputElement>(capture, ".settings-toggle__input");
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
      view.update({
        routeData: settingsRoute(
          "communications",
          "?section=transcripts&advanced=1",
          "#config-section-transcripts",
        ),
      });
      await waitForSolid(() => expect(advanced.open).toBe(true));
      expect(container.querySelector("openclaw-meeting-capture-settings")).toBe(capture);
      expect(capture.querySelector("details")).toBe(advanced);
      await advancedToggled;
      const messagesTab = query(container, '.hub-tab[data-tab-value="messages"]');
      messagesTab.focus();
      messagesTab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      flush();
      expect(container.querySelector("openclaw-meeting-capture-settings")).toBeNull();
      flush();
      expect(document.activeElement).toBe(messagesTab);
    } finally {
      cleanupSolid();
      runtimeConfig.dispose();
    }
  });
});
