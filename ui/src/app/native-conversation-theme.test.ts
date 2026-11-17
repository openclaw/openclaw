/* @vitest-environment jsdom */
import { beforeEach, expect, it, vi } from "vitest";
import { createThemePaletteFixture } from "../../../test/helpers/theme-fixture.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import {
  applyControlUiAccent,
  applyControlUiOperatorSeamColor,
} from "./control-ui-presentation.ts";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
} from "./gateway-store.test-support.ts";
import { backgroundPreferenceStorageKey } from "./settings-background.ts";
import { loadSettings, patchSettings, saveSettings, settingsKeyForGateway } from "./settings.ts";

const appearance = {
  light: createThemePaletteFixture({
    background: "#fafafa",
    accent: "#b73833",
    "font-sans": undefined,
  }),
  dark: createThemePaletteFixture({
    background: "#000000",
    accent: "#ff6b66",
    "font-sans": undefined,
  }),
};
let light: boolean;
let colorScheme: MediaQueryList;
let start: () => ReturnType<typeof createApplicationTheme>;
let reconnect: () => void;
beforeEach(({ onTestFinished }) => {
  const previous = loadSettings();
  const styles = document.documentElement.getAttribute("style");
  const dataset = Object.fromEntries(Object.entries(document.documentElement.dataset));
  const links = new Set(document.querySelectorAll("link"));
  const themes: ReturnType<typeof createApplicationTheme>[] = [];
  light = false;
  colorScheme = Object.assign(new EventTarget(), {
    media: "(prefers-color-scheme: light)",
  }) as MediaQueryList;
  Object.defineProperty(colorScheme, "matches", { get: () => light });
  vi.stubGlobal("matchMedia", (query: string) =>
    query === colorScheme.media
      ? colorScheme
      : { matches: false, addEventListener() {}, removeEventListener() {} },
  );
  vi.stubGlobal("__OPENCLAW_NATIVE_EMBED__", {
    platform: "ios",
    formFactor: "pad",
    surface: "conversation",
    appearance,
  });
  saveSettings({
    ...previous,
    theme: "dash",
    themeMode: "dark",
    fontChat: "lora",
    accent: "#48d6c2",
    background: {
      source: { kind: "theme" },
      showInSessions: true,
      showOnNewSession: true,
      visibility: 0.75,
    },
  });
  applyControlUiAccent();
  applyControlUiOperatorSeamColor("#123456");
  const { gateway, current } = createGatewayStoreTestStore({ settings: loadSettings() });
  reconnect = () => {
    gateway.connect();
    current().testOptions.onHello?.(GATEWAY_STORE_TEST_HELLO);
    expect(gateway.snapshot.phase).toBe("connected");
  };
  start = () => {
    const theme = createApplicationTheme(loadSettings(), gateway);
    document.getElementById("openclaw-theme-palette-dash")?.dispatchEvent(new Event("load"));
    gateway.start();
    themes.push(theme);
    return theme;
  };
  onTestFinished(() => {
    themes.forEach((theme) => theme.dispose());
    gateway.stop();
    applyControlUiAccent();
    applyControlUiOperatorSeamColor(undefined);
    saveSettings(previous);
    document.getElementById("openclaw-custom-theme")?.remove();
    document.querySelectorAll("link").forEach((link) => {
      if (!links.has(link)) {
        link.remove();
      }
    });
    document.documentElement.removeAttribute("style");
    if (styles !== null) {
      document.documentElement.setAttribute("style", styles);
    }
    for (const key of Object.keys(document.documentElement.dataset)) {
      delete document.documentElement.dataset[key];
    }
    Object.assign(document.documentElement.dataset, dataset);
    vi.unstubAllGlobals();
  });
});

it.each([false, true])(
  "uses the native palette at initial mount (light=%s), not the selected Dash theme",
  (isLight) => {
    light = isLight;
    const key = settingsKeyForGateway(loadSettings().gatewayUrl);
    const stored = localStorage.getItem(key);
    const backgroundKey = backgroundPreferenceStorageKey(loadSettings().gatewayUrl)!;
    const storedBackground = localStorage.getItem(backgroundKey);
    const theme = start();
    const root = document.documentElement;
    expect([root.dataset.themeId, root.dataset.themeMode]).toEqual([
      "custom",
      isLight ? "light" : "dark",
    ]);
    expect(getComputedStyle(root).getPropertyValue("--bg").trim()).toBe(
      isLight ? "#fafafa" : "#000000",
    );
    expect(getComputedStyle(root).getPropertyValue("--bg-content").trim()).toBe(
      isLight ? "#fafafa" : "#000000",
    );
    expect(getComputedStyle(root).getPropertyValue("--accent").trim()).toBe(
      isLight ? "#b73833" : "#ff6b66",
    );
    applyControlUiOperatorSeamColor("#abcdef");
    expect(getComputedStyle(root).getPropertyValue("--accent").trim()).toBe(
      isLight ? "#b73833" : "#ff6b66",
    );
    expect(root.style.getPropertyValue("--font-chat")).toBe("");
    expect(getComputedStyle(root).getPropertyValue("--font-body")).toContain('"Inter"');
    expect(root.style.getPropertyValue("--app-background-image")).toBe("none");
    expect(theme.settings.background?.source.kind).toBe("none");
    expect(localStorage.getItem(key)).toBe(stored);
    expect(localStorage.getItem(backgroundKey)).toBe(storedBackground);
    expect(loadSettings()).toMatchObject({
      theme: "dash",
      themeMode: "dark",
      fontChat: "lora",
      accent: "#48d6c2",
      background: { source: { kind: "theme" }, visibility: 0.75 },
    });
    light = !isLight;
    colorScheme.dispatchEvent(new Event("change"));
    expect(root.dataset.themeMode).toBe(isLight ? "dark" : "light");
    expect(theme.resolvedMode).toBe(isLight ? "dark" : "light");
    patchSettings({ theme: "tide", themeMode: "light", fontChat: "fraunces" });
    theme.refresh({ notify: true });
    reconnect();
    expect(getComputedStyle(root).getPropertyValue("--bg").trim()).toBe(
      isLight ? "#000000" : "#fafafa",
    );
    theme.dispose();
    start();
    expect(root.dataset.themeId).toBe("custom");
    expect(loadSettings()).toMatchObject({
      theme: "tide",
      themeMode: "light",
      fontChat: "fraunces",
    });
  },
);

it.each([
  {},
  { platform: "ios", formFactor: "phone", surface: "conversation", appearance },
  { platform: "android", formFactor: "pad", surface: "conversation", appearance },
  { platform: "ios", formFactor: "pad", appearance },
  { platform: "macos", formFactor: "desktop", surface: "conversation", appearance },
  { platform: "ios", formFactor: "pad", surface: "conversation", appearance: { light: {} } },
  {
    platform: "ios",
    formFactor: "pad",
    surface: "conversation",
    appearance: {
      ...appearance,
      dark: { ...appearance.dark, background: "url(https://invalid.test/pixel)" },
    },
  },
])(
  "keeps web theme ownership without a complete supported native palette ($platform/$formFactor/$surface)",
  (host) => {
    vi.stubGlobal("__OPENCLAW_NATIVE_EMBED__", host);
    patchSettings({ accent: undefined });
    const stored = localStorage.getItem(settingsKeyForGateway(loadSettings().gatewayUrl));
    const theme = start();
    expect(theme.settings.theme).toBe("dash");
    expect(document.documentElement.dataset.themeId).toBe("dash");
    expect(document.documentElement.dataset.themeMode).toBe("dark");
    expect(getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()).toBe(
      "#123456",
    );
    applyControlUiOperatorSeamColor("#abcdef");
    expect(getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()).toBe(
      "#abcdef",
    );
    expect(localStorage.getItem(settingsKeyForGateway(loadSettings().gatewayUrl))).toBe(stored);
  },
);
