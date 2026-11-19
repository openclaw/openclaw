/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
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

const [DARK, OTHER, LIGHT] = ["/dark.svg", "/other.svg", "/light.svg"] as const;
const root = document.documentElement;
const image = () => root.style.getPropertyValue("--app-background-image");
const fetchArtwork = vi.mocked(fetchPluginThemeArtworkBlobUrl);
const branding = (backgrounds?: ThemeArtwork["backgrounds"]) => ({
  ...resolveThemeBranding(undefined),
  ...(backgrounds ? { artwork: { backgrounds } } : {}),
});
const darkTheme = branding({ dark: { url: DARK } });
const sync = syncThemeBackgroundArtwork.bind(null, root);
function checkImage(source?: string, percent = "70") {
  const scrim = `color-mix(in srgb, var(--bg-content, var(--bg)) ${percent}%, transparent)`;
  expect([image(), root.dataset.themeBackground]).toEqual([
    source ? `linear-gradient(${scrim}, ${scrim}), url("${source}")` : "",
    source ? "plugin" : undefined,
  ]);
}
const waitImage = (src: string, pct?: string) => vi.waitFor(() => checkImage(src, pct));
afterEach(() => {
  sync(branding(), "dark");
  root.removeAttribute("style");
  fetchArtwork.mockReset();
});

it("dims light artwork at 65% of dark-mode strength", async () => {
  fetchArtwork.mockImplementation(async ({ url }) => (url === LIGHT ? "blob:day" : "blob:night"));
  const theme = branding({ dark: { url: DARK }, light: { url: LIGHT } });
  sync(theme, "dark");
  await waitImage("blob:night");
  sync(theme, "light");
  await waitImage("blob:day", "80.5");
});

it("lifts the scrim toward the shared cap without refetching", async () => {
  fetchArtwork.mockResolvedValue("blob:night");
  sync(darkTheme, "dark", 0.25);
  await waitImage("blob:night");
  sync(darkTheme, "dark", 0.75);
  checkImage("blob:night", "69");
  sync(darkTheme, "dark", 1);
  checkImage("blob:night", "68");
  sync(darkTheme, "dark");
  checkImage("blob:night");
  expect(fetchArtwork).toHaveBeenCalledOnce();
});

it("ignores a slower superseded image", async () => {
  const slow = createDeferred<string | null>();
  fetchArtwork.mockImplementation(async ({ url }) =>
    url === DARK ? slow.promise : "blob:current",
  );
  sync(darkTheme, "dark");
  // Serialize mocked dynamic imports; concurrent imports can resolve to the real module in Vitest.
  await vi.waitFor(() =>
    expect(fetchArtwork).toHaveBeenCalledExactlyOnceWith({ url: DARK, background: true }),
  );
  sync(branding({ dark: { url: OTHER } }), "dark");
  await waitImage("blob:current");
  slow.resolve("blob:stale");
  await slow.promise;
  await Promise.resolve();
  checkImage("blob:current");
  sync(darkTheme, "light");
  checkImage();
});

it("keeps neutral artwork after a failed load and retries on the next presentation", async () => {
  fetchArtwork.mockResolvedValueOnce(null).mockResolvedValue("blob:recovered");
  sync(darkTheme, "dark");
  await vi.waitFor(() => expect(fetchArtwork).toHaveBeenCalledOnce());
  await Promise.resolve();
  checkImage();
  await vi.waitFor(() => {
    sync(darkTheme, "dark");
    expect(fetchArtwork).toHaveBeenCalledTimes(2);
  });
  await waitImage("blob:recovered");
});
