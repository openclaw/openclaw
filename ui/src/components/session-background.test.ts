/* @vitest-environment jsdom */
import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { selectBackgroundSource } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGatewaySnapshot,
  ApplicationTheme,
} from "../app/context.ts";
import { loadSettings } from "../app/settings.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../test-helpers/application-context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { readBackgroundImage } from "./session-background-image.ts";
import { backgroundImageOpacityLimit } from "./session-background-opacity.ts";
import { SessionBackgroundView } from "./session-background-view.tsx";
import { SessionBackground, backgroundSourceForSurface } from "./session-background.tsx";

const profilePreferences = vi.hoisted(() => ({ ready: true }));
// mock-isolation: Drive readiness without hydrating the process-wide profile preference cache.
vi.mock("../app/server-prefs-profile.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/server-prefs-profile.ts")>()),
  resolveProfileAppearancePrefs: () => (profilePreferences.ready ? {} : null),
}));

function fixture(resourceBasePath = "/control") {
  const state: ApplicationGatewaySnapshot = {
    client: {} as GatewayBrowserClient,
    phase: "connected",
    offlineStable: false,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
    selfUser: { id: "profile-a" },
  };
  const gateway = createApplicationGateway(state);
  gateway.gateway.connection.gatewayUrl = `${location.origin.replace(/^http/u, "ws")}/ws`;
  gateway.gateway.connection.token = "test-credential";
  const listeners = new Set<() => void>();
  const settings = {
    ...loadSettings(),
    background: selectBackgroundSource({ kind: "custom", assetId: "asset-a" }),
  };
  const theme: ApplicationTheme = {
    settings,
    branding: resolveThemeBranding(undefined),
    mode: "dark",
    resolvedMode: "dark",
    serverSelection: null,
    appliedPalette: null,
    recordServerSelection: () => undefined,
    setMode: () => undefined,
    refresh: () => listeners.forEach((notify) => notify()),
    subscribe: (notify: () => void) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
  };
  const context = { resourceBasePath, gateway: gateway.gateway, theme } as ApplicationContext;
  return {
    context,
    settings,
    gateway,
    state,
    notify: () => listeners.forEach((notify) => notify()),
  };
}

function mountBackground(context: ApplicationContext) {
  const background = document.createElement("openclaw-session-background") as SessionBackground;
  background.context = context;
  background.surface = "new-session";
  const surface = document.createElement("div");
  surface.className = "new-session-page";
  surface.append(background);
  document.body.append(surface);
  mountSolid(() => background, { container: surface });
  return background;
}

const imageResponse = () =>
  new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });

const createObjectUrl = vi.fn<typeof URL.createObjectURL>();
const revokeObjectUrl = vi.fn<typeof URL.revokeObjectURL>();
const getCanvasContext = vi.fn<typeof HTMLCanvasElement.prototype.getContext>();

beforeEach(() => {
  profilePreferences.ready = true;
  createObjectUrl.mockReset().mockReturnValue("blob:background-a");
  revokeObjectUrl.mockReset();
  getCanvasContext.mockReset().mockReturnValue(null);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => imageResponse());
  vi.spyOn(URL, "createObjectURL").mockImplementation(createObjectUrl);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeObjectUrl);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(getCanvasContext);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the fade centered on the composer after resizing and releases its observer", async () => {
  const observe = vi.fn();
  const disconnect = vi.fn();
  let resize = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  const source = fixture();
  source.settings.background = selectBackgroundSource({ kind: "none" });
  const background = mountBackground(source.context);
  const composer = document.createElement("div");
  composer.className = "agent-chat__input";
  const scroll = document.createElement("div");
  scroll.className = "new-session-page__scroll";
  scroll.scrollTop = 30;
  background.parentElement!.append(composer, scroll);
  vi.spyOn(background, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ y: 20, height: 1000 }),
  );
  const composerRect = vi.spyOn(composer, "getBoundingClientRect");
  composerRect.mockReturnValue(DOMRect.fromRect({ y: 100, height: 40 }));
  source.settings.background = selectBackgroundSource({ kind: "theme" });
  source.notify();
  await waitForSolid(() => {
    expect(background.style.getPropertyValue("--session-background-fade-end")).toBe("130px");
  });
  expect(observe).toHaveBeenCalledWith(composer);
  composerRect.mockReturnValue(DOMRect.fromRect({ y: 150, height: 60 }));
  resize();
  expect(background.style.getPropertyValue("--session-background-fade-end")).toBe("190px");
  disconnect.mockClear();
  background.remove();
  await waitForSolid(() => expect(disconnect).toHaveBeenCalledOnce());
});

it("tracks late and replaced theme owners without recreating the lazy background slot", async () => {
  const source = fixture();
  source.settings.background = selectBackgroundSource({ kind: "none" });
  const [context, setContext] = createSignal<ApplicationContext | undefined>(undefined);
  const view = mountSolid(() =>
    createComponent(SessionBackgroundView, {
      get context() {
        return context();
      },
      surface: "new-session",
    }),
  );
  const slot = view.container.querySelector<HTMLElement>("openclaw-session-background")!;
  expect(slot.hidden).toBe(true);

  setContext(source.context);
  flush();
  source.settings.background = selectBackgroundSource({ kind: "theme" });
  source.notify();
  await waitForSolid(() => {
    expect(view.container.querySelector("openclaw-session-background")).toBe(slot);
    expect(slot.hidden).toBe(false);
    expect(slot.querySelector(".session-background__image--theme")).not.toBeNull();
  });

  const replacement = fixture();
  replacement.settings.background = selectBackgroundSource({ kind: "none" });
  setContext(replacement.context);
  await waitForSolid(() => expect(slot.hidden).toBe(true));
  source.notify();
  flush();
  expect(slot.hidden).toBe(true);

  replacement.settings.background = selectBackgroundSource({ kind: "theme" });
  replacement.notify();
  await waitForSolid(() => expect(slot.hidden).toBe(false));
  setContext(undefined);
  await waitForSolid(() => expect(slot.hidden).toBe(true));
  replacement.notify();
  flush();
  expect(slot.hidden).toBe(true);
  expect(view.container.querySelector("openclaw-session-background")).toBe(slot);
});

it("keeps absent preferences distinct from None and independent disabled surfaces", () => {
  expect(backgroundSourceForSurface(undefined, "session")).toBeUndefined();
  const background = selectBackgroundSource({ kind: "custom", assetId: "asset-a" });
  expect(backgroundSourceForSurface(background, "new-session")).toEqual(background.source);
  expect(backgroundSourceForSurface(background, "session")).toEqual({ kind: "none" });
  expect(
    backgroundSourceForSurface({ ...background, source: { kind: "none" } }, "new-session"),
  ).toEqual({ kind: "none" });
  expect(backgroundSourceForSurface({ ...background, visibility: 0 }, "new-session")).toEqual({
    kind: "none",
  });
});

it.each(["Solid provider"])(
  "inherits %s preferences and subscriptions until an explicit context overrides them",
  async (providerKind) => {
    const inherited = fixture();
    let background: SessionBackground;
    if (providerKind === "Lit provider") {
      const provider = createApplicationContextProvider(inherited.context);
      document.body.append(provider);
      background = document.createElement("openclaw-session-background") as SessionBackground;
      background.surface = "new-session";
      mountSolid(() => background, { container: provider });
    } else {
      const provider = createSolidApplicationContextProvider(inherited.context);
      const view = mountSolid(
        () => createComponent(SessionBackground, { surface: "new-session" }),
        { wrapper: provider.wrapper },
      );
      background = view.container.querySelector<SessionBackground>("openclaw-session-background")!;
    }
    await waitForSolid(() =>
      expect(background.querySelector("img")?.getAttribute("src")).toBe("blob:background-a"),
    );
    inherited.settings.background = selectBackgroundSource({ kind: "theme" });
    inherited.notify();
    await waitForSolid(() =>
      expect(background.querySelector(".session-background__image--theme")).not.toBeNull(),
    );
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:background-a");

    const explicit = fixture();
    explicit.settings.background = selectBackgroundSource({ kind: "none" });
    background.context = explicit.context;
    await waitForSolid(() =>
      expect(background.querySelector(".session-background__image")).toBeNull(),
    );
    inherited.settings.background = selectBackgroundSource({ kind: "custom", assetId: "asset-b" });
    inherited.notify();
    await background.updateComplete;
    expect(background.querySelector(".session-background__image")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("does not read custom bytes or render theme URLs when accessibility suppresses artwork", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const { context, settings, notify } = fixture();
  const background = mountBackground(context);
  await background.updateComplete;
  expect(fetch).not.toHaveBeenCalled();
  expect(createObjectUrl).not.toHaveBeenCalled();
  settings.background = selectBackgroundSource({ kind: "theme" });
  notify();
  await background.updateComplete;
  expect(background.querySelector(".session-background__image")).toBeNull();
  expect(getCanvasContext).not.toHaveBeenCalled();
});

it("recomputes custom image contrast only when painted palette tokens change, not slider intent", async () => {
  const { context, settings, notify } = fixture();
  const background = mountBackground(context);
  await waitForSolid(() => expect(getCanvasContext).toHaveBeenCalledTimes(1));
  settings.background = { ...settings.background, visibility: 0.8 };
  notify();
  await background.updateComplete;
  expect(getCanvasContext).toHaveBeenCalledTimes(1);
  background.style.setProperty("--muted", "rgb(140 140 140)");
  notify();
  await background.updateComplete;
  expect(getCanvasContext).toHaveBeenCalledTimes(2);
});

it("reads a same-origin mounted asset using the canonical auth primitive without caching", async () => {
  const { context } = fixture();
  const url = await readBackgroundImage(context, "asset-a", {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  expect(url).toBe("blob:background-a");
  expect(fetch).toHaveBeenCalledWith(
    `${location.origin}/control/__openclaw__/users/background/asset-a`,
    expect.objectContaining({
      headers: { Authorization: "Bearer test-credential" },
      credentials: "include",
      cache: "no-store",
      redirect: "error",
    }),
  );
});

it("does not request bytes before a profile is established or for a URL-shaped asset id", async () => {
  const { context, gateway, state } = fixture();
  gateway.publish({ ...state, selfUser: null });
  const options = { signal: new AbortController().signal, isCurrent: () => true };
  await expect(readBackgroundImage(context, "asset-a", options)).rejects.toMatchObject({
    name: "AbortError",
  });
  gateway.publish(state);
  await expect(
    readBackgroundImage(context, "https://external.invalid/a", options),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
});

it("discards a profile switch during response body reading", async () => {
  const { context, gateway, state } = fixture();
  const body = createDeferred<Blob>();
  const response = imageResponse();
  const readBody = vi.spyOn(response, "blob").mockReturnValue(body.promise);
  vi.mocked(fetch).mockResolvedValue(response);
  const pending = readBackgroundImage(context, "asset-a", {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await waitForSolid(() => expect(readBody).toHaveBeenCalled());
  gateway.publish({ ...state, selfUser: { id: "profile-b" } });
  body.resolve(new Blob(["image"], { type: "image/jpeg" }));
  await rejection;
  expect(createObjectUrl).not.toHaveBeenCalled();
});

it("never retries an old credential after identity changed during a rejected fetch", async () => {
  const { context, gateway, state } = fixture();
  context.gateway.connection.password = "fallback-credential";
  const deferred = createDeferred<Response>();
  vi.mocked(fetch).mockReturnValue(deferred.promise);
  const pending = readBackgroundImage(context, "asset-a", {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  gateway.publish({ ...state, selfUser: { id: "profile-b" } });
  deferred.resolve(new Response(null, { status: 401 }));
  await rejection;
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([["wss://remote.example/control", "https://remote.example"]])(
  "does not infer a remote HTTP mount from %s",
  async (gatewayUrl, origin) => {
    const { context } = fixture();
    context.gateway.connection.gatewayUrl = gatewayUrl;
    await readBackgroundImage(context, "asset-a", {
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    expect(fetch).toHaveBeenCalledWith(
      `${origin}/__openclaw__/users/background/asset-a`,
      expect.anything(),
    );
  },
);

it("preserves the explicit same-origin development proxy mount", async () => {
  const gatewayUrl = "wss://remote.example/control";
  const proxyPath = `/__openclaw_dev_gateway__/${encodeURIComponent(gatewayUrl)}`;
  vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", { gatewayUrl, proxyPath });
  const { context } = fixture(`${proxyPath}/control`);
  context.gateway.connection.gatewayUrl = gatewayUrl;

  await readBackgroundImage(context, "asset-a", {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  expect(fetch).toHaveBeenCalledWith(
    `${location.origin}${proxyPath}/control/__openclaw__/users/background/asset-a`,
    expect.anything(),
  );
});

it("revokes a mounted image immediately on logout and does not restore it on reconnect without identity", async () => {
  const { context, gateway, state } = fixture();
  const background = mountBackground(context);
  await waitForSolid(() =>
    expect(background.querySelector("img")?.getAttribute("src")).toBe("blob:background-a"),
  );
  gateway.publish({ ...state, selfUser: null, phase: "connecting" });
  expect(background.querySelector("img")?.getAttribute("src")).toBeNull();
  expect(revokeObjectUrl).toHaveBeenCalledWith("blob:background-a");
  await background.updateComplete;
  expect(background.querySelector("img")).toBeNull();
  gateway.publish({ ...state, selfUser: null });
  await background.updateComplete;
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("retires the prior client even when the profile and gateway URL are unchanged", async () => {
  const { context, gateway, state } = fixture();
  const background = mountBackground(context);
  await waitForSolid(() => expect(background.querySelector("img")).not.toBeNull());
  createObjectUrl.mockReturnValue("blob:background-new-client");
  gateway.publish({ ...state, client: {} as GatewayBrowserClient });
  expect(revokeObjectUrl).toHaveBeenCalledWith("blob:background-a");
  expect(background.querySelector("img")?.getAttribute("src")).toBeNull();
  await waitForSolid(() =>
    expect(background.querySelector("img")?.getAttribute("src")).toBe("blob:background-new-client"),
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not let an aborted disconnected pane publish a late image", async () => {
  const { context } = fixture();
  const deferred = createDeferred<Response>();
  vi.mocked(fetch).mockReturnValue(deferred.promise);
  const background = mountBackground(context);
  await background.updateComplete;
  background.remove();
  deferred.resolve(imageResponse());
  await Promise.resolve();
  await Promise.resolve();
  expect(createObjectUrl).not.toHaveBeenCalled();
});

it("preserves the Beacon 7:1 contrast target at the brightest possible image pixel", () => {
  const surface = [12, 12, 12];
  const foreground = [180, 180, 180];
  const opacity = backgroundImageOpacityLimit(surface, [foreground], 7);
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const background = 12 * (1 - opacity) + 255 * opacity;
  expect((linear(180) + 0.05) / (linear(background) + 0.05)).toBeGreaterThanOrEqual(7);
  expect(opacity).toBeLessThan(backgroundImageOpacityLimit(surface, [foreground], 4.5));
});

it("bounds opacity from actual text and surface colors instead of assuming dark mode", () => {
  const dark = backgroundImageOpacityLimit(
    [14, 16, 21],
    [
      [188, 188, 192],
      [139, 139, 148],
    ],
  );
  const light = backgroundImageOpacityLimit(
    [250, 250, 250],
    [
      [40, 40, 40],
      [100, 100, 100],
    ],
  );
  expect(dark).toBeGreaterThan(0);
  expect(dark).toBeLessThan(0.2);
  expect(light).toBeGreaterThan(0);
  expect(light).toBeLessThanOrEqual(0.32);
  expect(backgroundImageOpacityLimit([128, 128, 128], [[128, 128, 128]])).toBeLessThanOrEqual(0.32);
  expect(backgroundImageOpacityLimit([20, 20, 20], [[70, 70, 70]])).toBe(0);
});

it("does not restore a private mirror before profile hydration, including unchanged values", async () => {
  profilePreferences.ready = false;
  const { context, notify } = fixture();
  const background = mountBackground(context);
  await background.updateComplete;
  await vi.dynamicImportSettled();
  expect(fetch).not.toHaveBeenCalled();
  expect(background.hasAttribute("data-custom")).toBe(false);
  profilePreferences.ready = true;
  notify();
  await waitForSolid(() => expect(background.querySelector("img")).not.toBeNull());
  profilePreferences.ready = false;
  notify();
  expect(background.querySelector("img")?.getAttribute("src")).toBeNull();
  expect(revokeObjectUrl).toHaveBeenCalledWith("blob:background-a");
});

it("paints pre-dimmed plugin artwork at upload strength in both presentations", async () => {
  const { context, settings, notify } = fixture();
  document.documentElement.dataset.themeBackground = "plugin";
  try {
    settings.background = {
      ...selectBackgroundSource({ kind: "theme" }),
      presentation: "full-bleed",
      visibility: 0.5,
    };
    const background = document.createElement("openclaw-session-background") as SessionBackground;
    background.context = context;
    background.surface = "preview";
    document.body.append(background);
    await background.updateComplete;
    const opacity = () =>
      background.querySelector<HTMLElement>(".session-background__image--theme")?.style.opacity;
    // The token already carries upload dimming; the bundled 0.7 cap would dim it twice.
    expect(opacity()).toBe("1");
    settings.background = { ...settings.background, visibility: 0.25 };
    notify();
    await background.updateComplete;
    expect(opacity()).toBe("0.5");
  } finally {
    delete document.documentElement.dataset.themeBackground;
  }
});

it("also keeps bundled Full bleed artwork beneath the permanent overlay", async () => {
  const { context, settings, notify } = fixture();
  settings.background = {
    ...selectBackgroundSource({ kind: "theme" }),
    presentation: "full-bleed",
    visibility: 1,
  };
  const background = document.createElement("openclaw-session-background") as SessionBackground;
  background.context = context;
  background.surface = "preview";
  document.body.append(background);
  await background.updateComplete;
  expect(
    background.querySelector<HTMLElement>(".session-background__image--theme")?.style.opacity,
  ).toBe("0.7");
  settings.background = { ...settings.background, visibility: 0.5 };
  notify();
  await background.updateComplete;
  expect(
    background.querySelector<HTMLElement>(".session-background__image--theme")?.style.opacity,
  ).toBe("0.35");
});
