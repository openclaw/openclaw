/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createRouter } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { mountRouterOutlet } from "../../app/router-outlet.test-support.tsx";
import { resetServerUiPrefsSync } from "../../app/server-prefs.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { configSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import * as modelCatalogStore from "../../lib/model-catalog-store.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { meetingStatus } from "../../test-helpers/transcripts.test-support.ts";
import { mountAppearanceCatalogPage as mount } from "./config-page-catalog.test-support.ts";
import {
  completeConfigContext,
  createConfigRouteContext as routeContext,
  mountConfigPage,
  mountConfigPageState,
  publishConfigSource,
} from "./config-page.test-support.ts";
import { preloadConfigPage, type ConfigPageRouteData } from "./config-page.tsx";
import { configSelectionFromSearch, type ConfigPageId } from "./config-sections.ts";
import { configRouteData } from "./route-data.ts";
import { pages } from "./route.ts";

beforeAll(() =>
  Promise.all([
    preloadConfigPage("advanced"),
    preloadConfigPage("communications", "transcripts"),
    preloadConfigPage("ai-agents", "session"),
  ]),
);

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  resetServerUiPrefsSync();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function element(root: ParentNode, selector: string): HTMLElement {
  return expectDefined(root.querySelector<HTMLElement>(selector), selector);
}

function sectionRoute(pageId: ConfigPageId, search = "", hash = "") {
  return configRouteData({ pathname: `/settings/${pageId}`, search, hash });
}

function mountRoute(context: ApplicationContext, pageId: ConfigPageId, search = "", hash = "") {
  return mountConfigPage(context, { pageId, routeData: sectionRoute(pageId, search, hash) });
}

function updateRoute(
  view: ReturnType<typeof mountConfigPage>,
  pageId: ConfigPageId,
  search = "",
  hash = "",
) {
  view.update({ routeData: sectionRoute(pageId, search, hash) });
}

function animationFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => frames.delete(frame));
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

describe("ConfigPage navigation", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("localStorage", createStorageMock());
    resetServerUiPrefsSync();
  });

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

  it.each([
    { pageId: "communications", section: "transcripts" },
    { pageId: "ai-agents", section: "session" },
  ] as const)(
    "opens the $section advanced editor for a matching hash",
    async ({ pageId, section }) => {
      const base = routeContext();
      const config = { [section]: { enabled: true } };
      Object.assign(base.runtimeConfig.state, {
        configForm: config,
        configSchema: {
          type: "object",
          properties: {
            [section]: { type: "object", properties: { enabled: { type: "boolean" } } },
          },
        },
      });
      const view = mountRoute(base, pageId, `?section=${section}`);
      const editor = view.container.querySelector(`#config-section-${section}`)!;
      const disclosure = editor.closest("details")!;
      expect(disclosure.open).toBe(false);
      updateRoute(view, pageId, `?section=${section}`, `#config-section-${section}`);
      await waitForSolid(() => expect(disclosure.open).toBe(true));
      expect(view.container.querySelector(`#config-section-${section}`)).toBe(editor);
    },
  );

  it.each([
    { profile: undefined, writes: 1 },
    { profile: "full", writes: 0 },
  ])("Security Full preserves an explicit choice from $profile", async ({ profile, writes }) => {
    const baseContext = routeContext();
    const patchForm = vi.fn();
    const removeFormValue = vi.fn();
    Object.assign(baseContext.gateway.snapshot, {
      phase: "connected",
      hello: gatewayHelloForMethods(["config.set"]),
    });
    Object.assign(baseContext.runtimeConfig, { canSet: true, patchForm, removeFormValue });
    Object.assign(baseContext.runtimeConfig.state, {
      connected: true,
      configForm: profile ? { tools: { profile } } : {},
    });
    const { page } = mountConfigPage(baseContext, { pageId: "security" });

    expect(patchForm).not.toHaveBeenCalled();
    expect(removeFormValue).not.toHaveBeenCalled();
    const full = element(page, '.settings-segmented__input[value="full"]');
    expect(page.querySelectorAll(".settings-segmented__input")).toHaveLength(4);
    expect(page.querySelectorAll(".settings-segmented__btn--active")).toHaveLength(profile ? 1 : 0);
    full.click();
    expect(patchForm).toHaveBeenCalledTimes(writes);
    if (writes > 0) {
      expect(patchForm).toHaveBeenCalledWith(["tools", "profile"], "full");
    }
    expect(removeFormValue).not.toHaveBeenCalled();
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
        sectionRoute("communications", "?section=tts"),
      );
      await waitForSolid(() => expect(mounted.querySelector("#config-section-tts")).not.toBeNull());
      const host = expectDefined(mounted.querySelector("openclaw-config-page"), "config host");
      const title = () => host.querySelector(".content-header--settings .page-title")?.textContent;
      expect(host.querySelector("#config-section-messages")).toBeNull();
      expect(host.querySelector('.hub-tab[aria-selected="true"]')?.textContent?.trim()).toBe(
        "Voice",
      );
      expect(title()).toBe("Communications");

      const navigation = router.navigate("advanced", context);
      await waitForSolid(() => {
        const pending = router.getState().matches[0];
        expect(pending).toMatchObject({ routeId: "advanced", status: "pending" });
        expect(pending?.module).toBeDefined();
        expect(pending?.data).toBeUndefined();
      });
      expect(mounted.querySelector("openclaw-config-page")).toBe(host);
      expect(host.isConnected).toBe(true);
      expect(title()).toBe("Communications");
      expect(host.querySelector("#config-section-tts")).not.toBeNull();

      releaseAdvanced.resolve(undefined);
      await navigation;
      await waitForSolid(() => expect(title()).toBe("Advanced"));
      expect(mounted.querySelector("openclaw-config-page")).toBe(host);
      expect(host.isConnected).toBe(true);
    } finally {
      releaseAdvanced.resolve(undefined);
      mounted.dispose();
      router.stop();
    }
  });

  it.each([false, true])(
    "keeps Open pending when Raw is reselected (retained draft: %s)",
    async (retainedDraft) => {
      const context = routeContext();
      if (retainedDraft) {
        Object.assign(context.runtimeConfig.state, {
          configFormMode: "raw",
          configFormDirty: true,
        });
      }
      const pending = deferred();
      const openFile = vi.fn(() => pending.promise);
      Object.assign(context.runtimeConfig, { openFile, canOpenFile: true });
      const view = mountConfigPage(context);
      const button = (label: string) =>
        expectDefined(
          [...view.container.querySelectorAll("button")].find(
            (candidate) => candidate.textContent?.trim() === label,
          ),
          label,
        );
      try {
        if (!retainedDraft) {
          button("Raw").click();
        }
        await waitForSolid(() => expect(button("Raw").getAttribute("aria-pressed")).toBe("true"));
        const open = button("Open");
        open.click();
        await waitForSolid(() => expect(open.disabled, "Open is pending").toBe(true));
        button("Raw").click();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        await waitForSolid(() =>
          expect(open.disabled, "Raw reselection keeps Open pending").toBe(true),
        );
        open.click();
        expect(openFile).toHaveBeenCalledOnce();
        pending.resolve();
        await waitForSolid(() => expect(open.disabled).toBe(false));
      } finally {
        pending.resolve();
        view.dispose();
      }
    },
  );

  it("retires command presentation synchronously when the router changes location", async () => {
    const context = completeConfigContext(routeContext());
    const router = createRouter({
      routes: [{ id: "destination", path: "/destination", component: () => ({}) }],
    });
    Object.assign(context, { router });
    const view = mountConfigPageState(context);
    const original = view.state.configProps().presentationRetired();
    const retired = vi.fn();
    void original.then(retired);
    try {
      const navigation = router.navigate("destination", context);
      await original;
      expect(retired).toHaveBeenCalledOnce();
      expect(view.state.configProps().presentationRetired()).not.toBe(original);
      await navigation;
    } finally {
      view.dispose();
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
      "scrolls on %s (%s) to the Settings %s anchor after rendering",
      (pageId, section, targetId) => {
        const frames = animationFrames();
        const context = routeContext();
        context.runtimeConfig.state.configSchema = {
          type: "object",
          properties: {
            session: { type: "object", properties: { enabled: { type: "boolean" } } },
            transcripts: { type: "object", properties: { enabled: { type: "boolean" } } },
          },
        };
        const view = mountRoute(context, pageId, `?section=${section}`, `#${targetId}`);
        const target = element(view.page, `#${targetId}`);
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
      mountRoute(routeContext(), "communications", "", "#external-setting-target");
      frames.run();
      expect(scroll).not.toHaveBeenCalled();
    });

    it.each(["replacement", "retirement", "disconnect"] as const)(
      "does not scroll to a stale target after %s",
      async (transition) => {
        const view = mountRoute(routeContext(), "communications");
        const { page } = view;
        const animation = animationFrames();
        const { frames } = animation;
        const run = () => animation.run();
        const previousTarget = element(page, "#config-section-messages");
        const previousScroll = vi.fn();
        previousTarget.scrollIntoView = previousScroll;
        updateRoute(view, "communications", "", "#config-section-messages");
        expect(previousScroll).not.toHaveBeenCalled();
        expect(frames.size).toBe(1);

        if (transition === "disconnect") {
          view.dispose();
        } else {
          updateRoute(
            view,
            "communications",
            transition === "replacement" ? "?section=tts" : "",
            transition === "replacement" ? "#config-section-tts" : "",
          );
        }
        const nextScroll = vi.fn();
        if (transition === "replacement") {
          element(page, "#config-section-tts").scrollIntoView = nextScroll;
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
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.useFakeTimers();
  });

  function observerModels(view: ReturnType<typeof mountConfigPage>) {
    const picker = expectDefined(
      view.page.querySelector<
        HTMLElement & {
          params: { options: Array<{ value: string; label: string }> };
        }
      >("#settings-appearance-sidebar openclaw-select-picker"),
      "observer model picker",
    );
    return picker.params.options.slice(2).map(({ value, label }) => ({ value, label }));
  }

  function expectedModels(models: ModelCatalogEntry[]) {
    return models.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name }));
  }

  function expectModels(view: ReturnType<typeof mountConfigPage>, models: ModelCatalogEntry[]) {
    return waitForSolid(() => expect(observerModels(view)).toEqual(expectedModels(models)));
  }

  function catalogRequest(read: (params: unknown) => Promise<ModelCatalogResult>) {
    return vi.fn((method: string, params: unknown) =>
      method === "system.info" ? Promise.resolve({}) : read(params),
    );
  }

  it("keeps session-only Appearance usable without polling host details or models", async () => {
    const request = vi.fn().mockResolvedValue({});
    const { view, source } = await mount({ request } as unknown as GatewayBrowserClient, [
      "operator.sessions.read",
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).not.toHaveBeenCalled();
    await waitForSolid(() => expect(observerModels(view)).toEqual([]));
    source.publish({
      ...source.gateway.snapshot,
      hello: gatewayHelloForMethods(["system.info"]),
    });
    flush();
    await waitForSolid(() =>
      expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(1),
    );
    source.publish({
      ...source.gateway.snapshot,
      hello: gatewayHelloForMethods(["system.info"], ["operator.sessions.read"]),
    });
    flush();
    await vi.advanceTimersByTimeAsync(30_000);
    await waitForSolid(() =>
      expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(1),
    );
    await waitForSolid(() => expect(observerModels(view)).toEqual([]));
  });

  it.each(["visibility", "page"] as const)(
    "pauses status reads when %s is inactive",
    async (scope) => {
      let visibility: DocumentVisibilityState = scope === "visibility" ? "hidden" : "visible";
      vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
      const request = vi.fn((method: string) =>
        Promise.resolve(method === "models.list" ? { models: [] } : {}),
      );
      const { view } = await mount({ request } as unknown as GatewayBrowserClient);
      const statusReads = () => request.mock.calls.filter(([method]) => method === "system.info");
      const activate = (active: boolean) => {
        if (scope === "visibility") {
          visibility = active ? "visible" : "hidden";
          document.dispatchEvent(new Event("visibilitychange"));
          if (active) {
            globalThis.dispatchEvent(new Event("focus"));
          }
        } else {
          view.update({ pageId: active ? "appearance" : "advanced" });
        }
        flush();
      };
      const initialReads = scope === "visibility" ? 0 : 1;
      await waitForSolid(() => expect(statusReads()).toHaveLength(initialReads));
      activate(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(statusReads()).toHaveLength(initialReads);
      expect(view.page.isConnected).toBe(true);
      activate(true);
      await waitForSolid(() => expect(statusReads()).toHaveLength(initialReads + 1));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(statusReads()).toHaveLength(initialReads + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(statusReads()).toHaveLength(initialReads + 2);
      activate(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(statusReads()).toHaveLength(initialReads + 2);
      view.dispose();
      if (scope === "visibility") {
        activate(true);
      }
      await vi.advanceTimersByTimeAsync(10_000);
      expect(statusReads()).toHaveLength(initialReads + 2);
    },
  );

  it.each(["client", "source"] as const)(
    "fences a pending catalog after Gateway %s replacement",
    async (replacement) => {
      const first = deferred<ModelCatalogResult>();
      const second = deferred<ModelCatalogResult>();
      vi.spyOn(modelCatalogStore, "loadModelCatalog")
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const firstClient = createTestGatewayClient(vi.fn().mockResolvedValue({}));
      const secondClient =
        replacement === "client"
          ? createTestGatewayClient(vi.fn().mockResolvedValue({}))
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
    const reads = vi
      .fn(() => secondMain.promise)
      .mockReturnValueOnce(firstMain.promise)
      .mockReturnValueOnce(writer.promise);
    const request = catalogRequest(reads);
    const client = { request } as unknown as GatewayBrowserClient;
    const { view, context } = await mount(client);
    await waitForSolid(() => expect(reads).toHaveBeenCalledTimes(1));
    const selection = context.settingsAgentSelection.state as { selectedId: string | null };
    selection.selectedId = "writer";
    publishConfigSource(context.settingsAgentSelection);
    const writerModels = [{ id: "writer-model", name: "Writer Model", provider: "openai" }];
    writer.resolve({ models: writerModels });
    flush();
    await expectModels(view, writerModels);

    selection.selectedId = "main";
    publishConfigSource(context.settingsAgentSelection);
    const currentMainModels = [{ id: "current-main", name: "Current Main", provider: "openai" }];
    await waitForSolid(() => expect(reads).toHaveBeenCalledTimes(3));
    await waitForSolid(() => expect(observerModels(view)).toEqual([]));
    firstMain.resolve({ models: [{ id: "stale-main", name: "Stale Main", provider: "openai" }] });
    flush();
    expect(reads).toHaveBeenCalledTimes(3);
    await waitForSolid(() => expect(observerModels(view)).toEqual([]));
    secondMain.resolve({ models: currentMainModels });
    flush();
    await expectModels(view, currentMainModels);
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual(
      ["main", "writer", "main"].map((agentId) => [
        "models.list",
        { agentId, preparedOnly: true, view: "configured" },
      ]),
    );

    selection.selectedId = null;
    publishConfigSource(context.settingsAgentSelection);
    await waitForSolid(() => expect(observerModels(view)).toEqual([]));
    await waitForSolid(() =>
      expect(view.page.textContent).toContain("Explicit model catalog unavailable"),
    );
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(3);
  });

  it("keeps a slow refresh through status polls and retires its page reader on detach", async () => {
    const stale = deferred<ModelCatalogResult>();
    const original = [{ id: "original", name: "Original", provider: "openai" }];
    const fresh = [{ id: "fresh", name: "Fresh", provider: "openai" }];
    const reads = vi
      .fn<() => Promise<ModelCatalogResult>>(async () => ({ models: fresh }))
      .mockResolvedValueOnce({ models: original })
      .mockReturnValueOnce(stale.promise);
    const request = catalogRequest(reads);
    const client = { request } as unknown as GatewayBrowserClient;
    const { view, context } = await mount(client);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toHaveBeenCalledTimes(1);

    // The application retires catalogs on publication; the next status poll reads that generation.
    invalidateChatMetadataStore(client);
    await vi.advanceTimersByTimeAsync(10_000);
    await expectModels(view, original);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(6);
    expect(reads).toHaveBeenCalledTimes(2);
    view.dispose();
    flush();

    const remounted = mountConfigPage(context, { pageId: "appearance" });
    await waitForSolid(() => expect(reads).toHaveBeenCalledTimes(3));
    await expectModels(remounted, fresh);
    stale.resolve({ models: original });
    flush();
    await expectModels(remounted, fresh);
    expect(reads).toHaveBeenCalledTimes(3);
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
    const toggle = element(view.page, "#settings-appearance-sidebar input");
    failed.reject(new Error("catalog temporarily unavailable"));
    await waitForSolid(() =>
      expect(view.page.textContent).toContain("Explicit model catalog unavailable"),
    );
    expect(observerModels(view)).toEqual([]);
    expect(view.page.querySelector("#settings-appearance-sidebar input")).toBe(toggle);

    await vi.advanceTimersByTimeAsync(10_000);
    await expectModels(view, models);
    expect(view.page.textContent).not.toContain("Explicit model catalog unavailable");
    expect(view.page.querySelector("#settings-appearance-sidebar input")).toBe(toggle);
    expect(load).toHaveBeenCalledTimes(2);
  });
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
    return { ...configSnapshot(config, "one"), appliedConfigHash: "one" };
  });
  const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  try {
    await runtimeConfig.ensureLoaded();
    await runtimeConfig.ensureSchemaLoaded();
    const context = {
      ...routeContext(),
      gateway: { ...gateway, connection: { gatewayUrl: "ws://transcripts.test" } },
      runtimeConfig,
    } as unknown as ApplicationContext;
    const view = mountConfigPage(context, { pageId: "communications" });
    const container = view.container;
    expect(container.querySelector("openclaw-meeting-capture-settings")).toBeNull();
    const captureTab = container.querySelector<HTMLElement>(
      '.hub-tab[data-tab-value="transcripts"]',
    )!;
    expect(captureTab.textContent?.trim()).toBe("Meeting capture");
    const tabs = captureTab.closest(".hub-tabs")!;
    expect(tabs.querySelector("[active]")?.getAttribute("data-tab-value")).toBe("messages");
    captureTab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const capture = await waitForSolid(() => {
      const panel = element(container, "openclaw-meeting-capture-settings");
      expect(container.querySelector("#config-section-panel")?.contains(panel)).toBe(true);
      return panel;
    });
    flush();
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
    updateRoute(
      view,
      "communications",
      "?section=transcripts&advanced=1",
      "#config-section-transcripts",
    );
    await waitForSolid(() => expect(advanced.open).toBe(true));
    expect(container.querySelector("openclaw-meeting-capture-settings")).toBe(capture);
    expect(capture.querySelector("details")).toBe(advanced);
    await advancedToggled;
    const messagesTab = container.querySelector<HTMLElement>(
      '.hub-tab[data-tab-value="messages"]',
    )!;
    messagesTab.focus();
    messagesTab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flush();
    expect(container.querySelector("openclaw-meeting-capture-settings")).toBeNull();
    expect(document.activeElement).toBe(messagesTab);
  } finally {
    cleanupSolid();
    runtimeConfig.dispose();
  }
});
