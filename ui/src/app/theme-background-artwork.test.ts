/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveThemeBranding,
  type ThemeArtwork,
} from "../../../packages/gateway-protocol/src/theme.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { fetchPluginThemeArtworkBlobUrl } from "../pages/plugins/icon-loader.ts";
import { syncThemeBackgroundArtwork } from "./theme-background-artwork.ts";

// mock-isolation: The validated loader owns authenticated HTTP admission; this owner fences publication.
vi.mock("../pages/plugins/icon-loader.ts", () => ({ fetchPluginThemeArtworkBlobUrl: vi.fn() }));
// mock-isolation: jsdom has no canvas; the contrast bound has its own palette tests.
vi.mock("../components/session-background-contrast.ts", () => ({
  readBackgroundOpacityLimit: () => 0.6,
}));

const DARK = "/__openclaw__/plugin-theme-art/ghost/claw/background/dark?v=aaaaaaaaaaaa";
const OTHER = "/__openclaw__/plugin-theme-art/ghost/claw/background/dark?v=bbbbbbbbbbbb";
const root = document.documentElement;
const image = () => root.style.getPropertyValue("--app-background-image");
const LIGHT = "/__openclaw__/plugin-theme-art/ghost/claw/background/light?v=cccccccccccc";
// Opacity limit 0.6 (mocked) × default visibility 0.5 = 30% image under a 70% scrim.
const scrim = (percent: string) =>
  `color-mix(in srgb, var(--bg-content, var(--bg)) ${percent}%, transparent)`;
const dimmed = (source: string, percent: string) =>
  `linear-gradient(${scrim(percent)}, ${scrim(percent)}), url("${source}")`;
const painted = (source: string) => dimmed(source, "70");
const branding = (backgrounds?: ThemeArtwork["backgrounds"]) => ({
  ...resolveThemeBranding(undefined),
  ...(backgrounds ? { artwork: { backgrounds } } : {}),
});

afterEach(() => {
  syncThemeBackgroundArtwork(root, branding(), "dark");
  root.removeAttribute("style");
  vi.mocked(fetchPluginThemeArtworkBlobUrl).mockReset();
});

describe("plugin theme background artwork", () => {
  it("publishes the loaded mode image once and clears it for modes without artwork", async () => {
    vi.mocked(fetchPluginThemeArtworkBlobUrl).mockResolvedValue("blob:night");
    const theme = branding({ dark: { url: DARK } });
    syncThemeBackgroundArtwork(root, theme, "dark");
    await vi.waitFor(() => expect(image()).toBe(painted("blob:night")));
    expect(fetchPluginThemeArtworkBlobUrl).toHaveBeenCalledExactlyOnceWith({
      url: DARK,
      background: true,
    });

    syncThemeBackgroundArtwork(root, theme, "dark");
    expect(image()).toBe(painted("blob:night"));
    expect(fetchPluginThemeArtworkBlobUrl).toHaveBeenCalledOnce();

    expect(root.dataset.themeBackground).toBe("plugin");

    syncThemeBackgroundArtwork(root, theme, "light");
    expect(image()).toBe("");
    expect(root.dataset.themeBackground).toBeUndefined();
  });

  it("dims plugin artwork like a default-strength custom upload", async () => {
    vi.mocked(fetchPluginThemeArtworkBlobUrl).mockImplementation(async ({ url }) =>
      url === LIGHT ? "blob:day" : "blob:night",
    );
    const theme = branding({ dark: { url: DARK }, light: { url: LIGHT } });
    syncThemeBackgroundArtwork(root, theme, "dark");
    await vi.waitFor(() => expect(image()).toBe(dimmed("blob:night", "70")));
    // Uploads paint light mode at 65% of the dark-mode strength: 0.3 × 0.65 = 19.5%.
    syncThemeBackgroundArtwork(root, theme, "light");
    await vi.waitFor(() => expect(image()).toBe(dimmed("blob:day", "80.5")));
  });

  it("ignores a slower superseded image", async () => {
    const slow = createDeferred<string | null>();
    vi.mocked(fetchPluginThemeArtworkBlobUrl).mockImplementation(async ({ url }) =>
      url === DARK ? slow.promise : "blob:current",
    );
    syncThemeBackgroundArtwork(root, branding({ dark: { url: DARK } }), "dark");
    // Vitest can resolve concurrent dynamic imports of a mocked module to the real one.
    await vi.waitFor(() => expect(fetchPluginThemeArtworkBlobUrl).toHaveBeenCalledOnce());
    syncThemeBackgroundArtwork(root, branding({ dark: { url: OTHER } }), "dark");
    await vi.waitFor(() => expect(image()).toBe(painted("blob:current")));
    slow.resolve("blob:stale");
    await slow.promise;
    await Promise.resolve();
    expect(image()).toBe(painted("blob:current"));

    syncThemeBackgroundArtwork(root, branding(), "dark");
    expect(image()).toBe("");
  });

  it("keeps neutral artwork after a failed load and retries on the next presentation", async () => {
    let attempts = 0;
    vi.mocked(fetchPluginThemeArtworkBlobUrl).mockImplementation(async () =>
      ++attempts === 1 ? null : "blob:recovered",
    );
    const theme = branding({ dark: { url: DARK } });
    syncThemeBackgroundArtwork(root, theme, "dark");
    await vi.waitFor(() => expect(fetchPluginThemeArtworkBlobUrl).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(image()).toBe("");
    await vi.waitFor(() => {
      syncThemeBackgroundArtwork(root, theme, "dark");
      expect(fetchPluginThemeArtworkBlobUrl).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => expect(image()).toBe(painted("blob:recovered")));
  });
});
