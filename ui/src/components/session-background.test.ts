/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
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
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { readBackgroundImage } from "./session-background-image.ts";
import { backgroundImageOpacityLimit } from "./session-background-opacity.ts";
import { SessionBackground, backgroundSourceForSurface } from "./session-background.ts";

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

it.each(["Lit provider", "Solid provider"])(
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

it("does not request or render artwork on an initially disabled or hidden surface", async () => {
  const { context } = fixture();
  const background = document.createElement("openclaw-session-background") as SessionBackground;
  background.context = context;
  document.body.append(background);
  await background.updateComplete;
  expect(fetch).not.toHaveBeenCalled();
  expect(background.querySelector(".session-background__image")).toBeNull();
  background.presented = false;
  background.surface = "new-session";
  await background.updateComplete;
  expect(fetch).not.toHaveBeenCalled();
  expect(createObjectUrl).not.toHaveBeenCalled();
  expect(background.querySelector(".session-background__image")).toBeNull();
});

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

it("preserves full bundled Theme strength at the default visibility without canvas or private reads", async () => {
  const { context, settings, notify } = fixture();
  settings.background = selectBackgroundSource({ kind: "theme" });
  const background = mountBackground(context);
  await background.updateComplete;
  const opacity = () =>
    background.querySelector<HTMLElement>(".session-background__image--theme")?.style.opacity;
  expect(opacity()).toBe("1");
  const surface = background.parentElement!;
  expect(surface.hasAttribute("data-background-painted")).toBe(true);
  settings.background = { ...settings.background, visibility: 1 };
  notify();
  await background.updateComplete;
  expect(opacity()).toBe("1");
  settings.background = { ...settings.background, visibility: 0.25 };
  notify();
  await background.updateComplete;
  expect(opacity()).toBe("0.5");
  background.remove();
  await Promise.resolve();
  expect(surface.hasAttribute("data-background-painted")).toBe(false);
  expect(getCanvasContext).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
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

it.each([
  ["ws://remote.example/ws", "http://remote.example"],
  ["wss://remote.example/control", "https://remote.example"],
])("does not infer a remote HTTP mount from %s", async (gatewayUrl, origin) => {
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
});

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

it("retains draft siblings and revokes artwork when the pane hides or preferences select None", async () => {
  const { context, settings, notify } = fixture();
  const wrapper = document.createElement("div");
  wrapper.className = "new-session-page";
  const draft = document.createElement("textarea");
  draft.value = "Unsent draft";
  const background = document.createElement("openclaw-session-background") as SessionBackground;
  background.context = context;
  background.surface = "new-session";
  wrapper.append(background, draft);
  document.body.append(wrapper);
  await waitForSolid(() => expect(background.querySelector("img")).not.toBeNull());
  expect(wrapper.hasAttribute("data-background-custom")).toBe(true);
  background.presented = false;
  await background.updateComplete;
  expect(revokeObjectUrl).toHaveBeenCalledWith("blob:background-a");
  expect(background.querySelector("img")).toBeNull();
  expect(wrapper.hasAttribute("data-background-custom")).toBe(false);
  expect(wrapper.hasAttribute("data-background-painted")).toBe(false);
  settings.background = selectBackgroundSource({ kind: "none" });
  notify();
  background.presented = true;
  await background.updateComplete;
  expect(background.querySelector(".session-background__image")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(wrapper.querySelector("textarea")).toBe(draft);
  expect(draft.value).toBe("Unsent draft");
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

it.each(["new-session", "session", "preview"] as const)(
  "never bypasses the photo contrast bound in Full bleed on %s",
  async (surface) => {
    const { context, settings, notify } = fixture();
    settings.background = {
      ...settings.background,
      presentation: "full-bleed",
      showInSessions: true,
      visibility: 1,
    };
    const background = document.createElement("openclaw-session-background") as SessionBackground;
    background.context = context;
    background.surface = surface;
    document.body.append(background);
    await waitForSolid(() => expect(background.querySelector("img")).not.toBeNull());
    expect(background.querySelector("img")?.style.opacity).toBe("0");
    settings.background = { ...settings.background, visibility: 0.5 };
    notify();
    await background.updateComplete;
    expect(background.querySelector("img")?.style.opacity).toBe("0");
    expect(getCanvasContext).toHaveBeenCalledOnce();
  },
);

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

it("allows a temporary settings preview without changing disabled placements", async () => {
  const { context, settings } = fixture();
  settings.background = { ...settings.background, showOnNewSession: false, showInSessions: false };
  const background = document.createElement("openclaw-session-background") as SessionBackground;
  background.context = context;
  background.surface = "preview";
  background.preferenceOverride = {
    ...settings.background,
    presentation: "full-bleed",
    visibility: 0.8,
  };
  document.body.append(background);
  await waitForSolid(() => expect(background.querySelector("img")).not.toBeNull());
  expect(settings.background.showOnNewSession).toBe(false);
  expect(settings.background.showInSessions).toBe(false);
  background.presented = false;
  await background.updateComplete;
  expect(background.querySelector("img")).toBeNull();
  expect(revokeObjectUrl).toHaveBeenCalledWith("blob:background-a");
});

type RGB = readonly [number, number, number];
type RGBA = readonly [number, number, number, number];

it.each([
  { surface: [16, 20, 28], foreground: [240, 240, 248, 190] },
  { surface: [248, 244, 240], foreground: [12, 16, 24, 210] },
] satisfies Array<{ surface: RGB; foreground: RGBA }>)(
  "protects translucent foregrounds against every extreme image color",
  ({ surface, foreground }) => {
    const opacity = backgroundImageOpacityLimit(surface, [foreground]);
    const luma = (rgb: RGB) => {
      const linear = (value: number) => {
        const n = value / 255;
        return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
      };
      return linear(rgb[0]) * 0.2126 + linear(rgb[1]) * 0.7152 + linear(rgb[2]) * 0.0722;
    };
    for (const red of [0, 255]) {
      for (const green of [0, 255]) {
        for (const blue of [0, 255]) {
          const blendSurface = (channel: 0 | 1 | 2, value: number) =>
            surface[channel] * (1 - opacity) + value * opacity;
          const background: RGB = [
            blendSurface(0, red),
            blendSurface(1, green),
            blendSurface(2, blue),
          ];
          const alpha = foreground[3] / 255;
          const blendText = (channel: 0 | 1 | 2) =>
            foreground[channel] * alpha + background[channel] * (1 - alpha);
          const text: RGB = [blendText(0), blendText(1), blendText(2)];
          expect(
            (Math.max(luma(text), luma(background)) + 0.05) /
              (Math.min(luma(text), luma(background)) + 0.05),
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  },
);
