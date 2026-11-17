/* @vitest-environment jsdom */
import { beforeEach, expect, it, vi } from "vitest";
import type { ThemesListResult } from "../../../packages/gateway-protocol/src/schema/themes.ts";
import type { ThemeDescriptor } from "../../../packages/gateway-protocol/src/theme.ts";
import {
  createThemeDefinitionFixture,
  createThemePaletteFixture,
} from "../../../test/helpers/theme-fixture.ts";
import { createImportedCustomThemeFixture } from "../test-helpers/custom-theme.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import {
  applyControlUiAccent,
  applyControlUiOperatorSeamColor,
} from "./control-ui-presentation.ts";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
} from "./gateway-store.test-support.ts";
import { readNativeConversationTheme } from "./native-conversation-theme.ts";
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
let store: ReturnType<typeof createGatewayStoreTestStore>;
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
  store = createGatewayStoreTestStore({ settings: loadSettings() });
  const { gateway, current } = store;
  reconnect = () => {
    gateway.connect();
    current().testOptions.onHello?.(GATEWAY_STORE_TEST_HELLO);
    expect(gateway.snapshot.phase).toBe("connected");
  };
  start = () => {
    const theme = createApplicationTheme(loadSettings(), gateway, readNativeConversationTheme());
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
    patchSettings({ theme: "tide", themeMode: "light", fontChat: "fraunces", textScale: 125 });
    theme.refresh({ notify: true });
    reconnect();
    expect(getComputedStyle(root).getPropertyValue("--bg").trim()).toBe(
      isLight ? "#000000" : "#fafafa",
    );
    expect(theme.settings.textScale).toBe(125);
    expect(root.style.getPropertyValue("--control-ui-text-scale")).toBe("1.25");
    theme.dispose();
    expect(root.style.getPropertyValue("--app-background-image")).toBe("");
    const remounted = start();
    expect(root.dataset.themeId).toBe("custom");
    remounted.dispose();
    vi.stubGlobal("__OPENCLAW_NATIVE_EMBED__", undefined);
    const web = start();
    document.getElementById("openclaw-theme-palette-tide")?.dispatchEvent(new Event("load"));
    expect(web.settings).toMatchObject({ theme: "tide", themeMode: "light", fontChat: "fraunces" });
    expect(root.dataset.themeId).toBe("tide");
    expect(root.style.getPropertyValue("--app-background-image")).toBe("");
    expect(document.getElementById("openclaw-custom-theme")).toBeNull();
    light = !light;
    colorScheme.dispatchEvent(new Event("change"));
    expect(root.dataset.themeMode).toBe("light");
    expect(root.style.getPropertyValue("--control-ui-text-scale")).toBe("1.25");
    expect(loadSettings()).toMatchObject({
      theme: "tide",
      themeMode: "light",
      fontChat: "fraunces",
    });
  },
);

it("keeps native presentation private after a selected single-mode plugin catalog loads and preferences refresh", async () => {
  const descriptor: ThemeDescriptor = {
    id: "native-test/conspicuous",
    name: "Conspicuous plugin",
    description: "Dark-only plugin must not own native presentation",
    source: "plugin",
    pluginId: "native-test",
    modes: ["dark"],
  };
  const response: ThemesListResult = {
    themes: [descriptor],
    theme: descriptor,
    definition: createThemeDefinitionFixture({
      name: descriptor.name,
      mascot: "none",
      brandName: "Plugin Brand",
      brandIcon: "mark",
      avatarHat: "crown",
      dark: createThemePaletteFixture({ background: "#220044", accent: "#00ff00" }),
    }),
    current: {
      id: descriptor.id,
      mode: "dark",
      scope: "profile",
      overrides: { id: descriptor.id, mode: "dark" },
    },
  };
  const imported = {
    ...createImportedCustomThemeFixture(),
    importedAt: "2026-01-01T00:00:00.000Z",
  };
  patchSettings({ theme: descriptor.id, themeMode: "light", customTheme: imported });
  const key = settingsKeyForGateway(loadSettings().gatewayUrl);
  const stored = localStorage.getItem(key);
  const backgroundKey = backgroundPreferenceStorageKey(loadSettings().gatewayUrl)!;
  const storedBackground = localStorage.getItem(backgroundKey);
  light = true;
  const theme = start();
  store.current().request.mockImplementation(async (method) => {
    if (method === "themes.list" || method === "themes.get") {
      return response;
    }
    throw new Error(`Unexpected request ${method}`);
  });
  store.current().testOptions.onHello?.(GATEWAY_STORE_TEST_HELLO);
  expect(store.gateway.snapshot.phase).toBe("connected");
  // Consume the real connection-scoped catalog, not a mocked theme resolver.
  await vi.waitFor(() =>
    expect(theme.catalog?.palettes?.get(descriptor.id)?.dark.bg).toBe("#220044"),
  );
  expect(theme.catalog?.error).toBeNull();
  expect(theme.catalog?.themes).toContainEqual(descriptor);
  const root = document.documentElement;
  const assertNative = (mode: "light" | "dark", background: string) => {
    expect(theme.branding).toMatchObject({
      mascot: "claw",
      brandName: "OpenClaw",
      brandIcon: "claw",
      avatarHat: undefined,
    });
    expect(theme.mode).toBe("system");
    expect(theme.resolvedMode).toBe(mode);
    expect(root.dataset.themeMode).toBe(mode);
    expect(getComputedStyle(root).getPropertyValue("--bg").trim()).toBe(background);
    expect(theme.settings.customTheme).toBeUndefined();
    expect(loadSettings().customTheme).toEqual(imported);
    expect(localStorage.getItem(backgroundKey)).toBe(storedBackground);
    expect(root.style.getPropertyValue("--app-background-image")).toBe("none");
  };
  assertNative("light", "#fafafa");
  expect(localStorage.getItem(key)).toBe(stored);
  patchSettings({ textScale: 125 });
  const updatedStored = localStorage.getItem(key);
  theme.refresh({ notify: true });
  assertNative("light", "#fafafa");
  expect(theme.settings.textScale).toBe(125);
  expect(root.style.getPropertyValue("--control-ui-text-scale")).toBe("1.25");
  expect(localStorage.getItem(key)).toBe(updatedStored);
  light = false;
  colorScheme.dispatchEvent(new Event("change"));
  assertNative("dark", "#000000");
  light = true;
  colorScheme.dispatchEvent(new Event("change"));
  assertNative("light", "#fafafa");
  expect(localStorage.getItem(key)).toBe(updatedStored);
});

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
