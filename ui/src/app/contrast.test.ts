/* @vitest-environment jsdom */
import fs from "node:fs";
import vm from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { BUILTIN_THEME_IDS } from "../../../packages/gateway-protocol/src/theme-ids.ts";
import { inlineContrastResolver } from "../../config/control-ui-contrast-bootstrap.ts";
import { createImportedCustomThemeFixture } from "../test-helpers/custom-theme.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const html = inlineContrastResolver(fs.readFileSync("ui/index.html", "utf8"));
const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/u)![1]!;
afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.contrast;
  document.head
    .querySelectorAll('[id^="openclaw-theme-palette-"]')
    .forEach((link) => link.remove());
  vi.unstubAllGlobals();
});

it("honors contrast intent before first paint for every built-in, independent of color mode", () => {
  for (const theme of BUILTIN_THEME_IDS) {
    for (const themeMode of ["light", "dark"]) {
      for (const [contrast, systemMore, expected] of [
        ["system", false, "standard"],
        ["system", true, "enhanced"],
        ["standard", false, "standard"],
        ["standard", true, "standard"],
        ["enhanced", false, "enhanced"],
        ["enhanced", true, "enhanced"],
      ] as const) {
        vm.runInNewContext(script, {
          document,
          localStorage: {
            "openclaw.control.settings.v1:test": "",
            getItem: () => JSON.stringify({ theme, themeMode, contrast }),
          },
          window: {
            matchMedia: (query: string) => ({
              matches: query.includes("contrast") ? systemMore : false,
            }),
          },
        });
        expect(
          document.documentElement.dataset.contrast,
          `${theme}/${themeMode}/${contrast}/${systemMore}`,
        ).toBe(expected);
        expect(document.documentElement.dataset.themeMode).toBe(themeMode);
      }
    }
  }
});

it("defaults to the local OS on unavailable storage without claiming an imported palette", () => {
  const window = { matchMedia: () => ({ matches: true }) };
  vm.runInNewContext(script, {
    document,
    window,
    get localStorage() {
      throw new Error("unavailable");
    },
  });
  expect(document.documentElement.dataset.contrast).toBe("enhanced");
  vm.runInNewContext(script, {
    document,
    window,
    localStorage: {
      "openclaw.control.settings.v1:test": "",
      getItem: () => JSON.stringify({ theme: "custom", contrast: "enhanced" }),
    },
  });
  expect(document.documentElement.dataset.contrast).toBe("standard");
});

it("reacts to OS changes only in System, restoring the saved accent without altering typography", () => {
  const contrastMedia = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", (query: string) =>
    query === "(prefers-contrast: more)"
      ? contrastMedia
      : Object.assign(new EventTarget(), { matches: false }),
  );
  patchSettings({
    theme: "claw",
    themeMode: "dark",
    contrast: "system",
    accent: "#123456",
    fontUi: "geist",
    fontChat: "lora",
    textScale: 125,
  });
  const { gateway } = createGatewayStoreTestStore({ settings: loadSettings() });
  const theme = createApplicationTheme(loadSettings(), gateway);
  const root = document.documentElement;
  const before = loadSettings();
  try {
    expect(root.dataset.contrast).toBe("standard");
    expect(root.style.getPropertyValue("--primary")).toBe("#123456");
    contrastMedia.matches = true;
    contrastMedia.dispatchEvent(new Event("change"));
    expect(root.dataset.contrast).toBe("enhanced");
    expect(root.style.getPropertyValue("--primary")).toBe("");
    expect(loadSettings()).toEqual(before);
    patchSettings({ contrast: "standard" });
    expect(root.dataset.contrast).toBe("standard");
    expect(root.style.getPropertyValue("--primary")).toBe("#123456");
    contrastMedia.dispatchEvent(new Event("change"));
    expect(root.dataset.contrast).toBe("standard");
    patchSettings({ contrast: "enhanced" });
    contrastMedia.matches = false;
    contrastMedia.dispatchEvent(new Event("change"));
    expect(root.dataset.contrast).toBe("enhanced");
    expect(loadSettings()).toMatchObject({
      accent: "#123456",
      fontUi: "geist",
      fontChat: "lora",
      textScale: 125,
      theme: "claw",
      themeMode: "dark",
    });
    patchSettings({ theme: "custom", customTheme: createImportedCustomThemeFixture() });
    expect(root.dataset.contrast).toBe("standard");
    expect(loadSettings().contrast).toBe("enhanced");
    expect(root.style.getPropertyValue("--primary")).toBe("#123456");
  } finally {
    theme.dispose();
    gateway.stop();
  }
});
