/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { resetServerUiPrefsSync } from "../../app/server-prefs.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { settleLitElement, settleLitElements } from "../../test-helpers/lit-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ConfigPage, configSelectionFromSearch, type ConfigPageId } from "./config-page.ts";
import { configRouteData, type ConfigRouteData } from "./route-data.ts";
import { pages } from "./route.ts";

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

describe("configSelectionFromSearch", () => {
  it("falls back when a linked section does not belong to the page", () => {
    expect(configSelectionFromSearch("communications", "?section=gateway")).toEqual({
      activeSection: "messages",
      activeSubsection: null,
    });
  });
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
  it.each([
    ["communications", "messages"],
    ["advanced", null],
  ] as const)("opens %s at its default when no section is selected", (pageId, activeSection) => {
    for (const search of ["", "?section="]) {
      expect(configSelectionFromSearch(pageId, search)).toEqual({
        activeSection,
        activeSubsection: null,
      });
    }
  });

  it.each(["unknown", "__proto__"])("rejects an unsupported runtime page id: %s", (pageId) => {
    expect(() => configSelectionFromSearch(pageId as ConfigPageId, "")).toThrow(
      "Unknown config page",
    );
  });

  it("keeps subsequent defaults independent from a mutated selection", () => {
    const selection = configSelectionFromSearch("communications", "");
    selection.activeSection = "tts";
    selection.activeSubsection = "provider";

    expect(configSelectionFromSearch("communications", "")).toEqual({
      activeSection: "messages",
      activeSubsection: null,
    });
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
    theme: { serverSelection: null, subscribe },
    overlays: { snapshot: {}, subscribe },
    webPush: { snapshot: undefined, subscribe },
  } as unknown as ApplicationContext;
}

describe("ConfigPage route selections", () => {
  it.each([
    { profile: "coding", writes: 1 },
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
      page.querySelector<HTMLElement>('wa-radio[value="full"]'),
      "Full tool choice",
    );
    expect(page.querySelectorAll("wa-radio")).toHaveLength(4);
    expect(page.querySelectorAll(".settings-segmented__btn--active")).toHaveLength(profile ? 1 : 0);
    if (profile !== "full") {
      const group = expectDefined(
        full.closest<HTMLElement & { value: string }>("wa-radio-group"),
        "tool choices",
      );
      group.value = "full";
      group.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      full.click();
    }
    expect(patchForm).toHaveBeenCalledTimes(writes);
    if (writes > 0) {
      expect(patchForm).toHaveBeenCalledWith(["tools", "profile"], "full");
    }
    expect(removeFormValue).not.toHaveBeenCalled();
  });

  it.each([
    ["communications", "", "config-section-messages", "config-section-tts"],
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
