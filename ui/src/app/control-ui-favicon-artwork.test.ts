/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { TabIconPreference } from "../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { recordLobsterVisit } from "../components/lobster-dex.ts";
import { loadUnlockedLobsterFavicon } from "../components/lobster-favicon.ts";
import { resolveAvatarImageUrl, retainAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import { fetchPluginThemeArtworkBlobUrl } from "../pages/plugins/icon-loader.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { makeBootRoster } from "./bootstrap.test-support.ts";
import { applyControlUiFaviconImage } from "./control-ui-environment-presentation.runtime.ts";
import { connectControlUiFaviconArtwork } from "./control-ui-favicon-artwork.runtime.ts";
import { client, createGatewayHarness } from "./overlays-access.test-support.ts";

// mock-isolation: Test source lifetime independently of the DOM compositor.
vi.mock("./control-ui-environment-presentation.runtime.ts", () => ({
  applyControlUiFaviconImage: vi.fn(),
}));
// mock-isolation: Control protected-image settlement without shared HTTP/cache state.
vi.mock("../lib/identity-avatar-loader.ts", () => ({
  resolveAvatarImageUrl: vi.fn(),
  retainAvatarImageUrl: vi.fn(() => vi.fn()),
}));
// mock-isolation: Pixel decoding is covered at the real browser boundary; this owner fences asynchronous results.
vi.mock("../components/lobster-favicon.ts", () => ({ loadUnlockedLobsterFavicon: vi.fn() }));
// mock-isolation: The validated loader owns HTTP admission; this owner fences decoding and publication.
vi.mock("../pages/plugins/icon-loader.ts", () => ({ fetchPluginThemeArtworkBlobUrl: vi.fn() }));
const cleanups: Array<() => void> = [];
function expectArtwork(image: HTMLImageElement | string | null, ...shape: string[]) {
  expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(
    typeof image === "string" ? expect.objectContaining({ src: image }) : image,
    ...shape,
  );
}
function mockImage(decode: () => Promise<void> = async () => {}) {
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      naturalWidth = 32;
      naturalHeight = 32;
      decode = decode;
    },
  );
}
function shipBranding(version = 1) {
  return resolveThemeBranding({
    brandIcon: "ship",
    artwork: { icons: { ship: { url: `/__openclaw__/theme-art/ship?v=${version}` } } },
  });
}
function setup(preference?: TabIconPreference) {
  const gateway = createGatewayHarness(client(async () => ({})));
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const theme = {
    settings: { tabIcon: preference },
    branding: resolveThemeBranding(undefined),
    subscribe,
  };
  const selection = { state: { selectedId: "main", scopeId: "main" }, subscribe };
  const agents = {
    state: {
      agentsList: makeBootRoster({
        agents: [{ id: "main", identity: { avatarUrl: "/avatar/main" } }, { id: "other" }],
      }),
    },
    subscribe,
  };
  const identity = { get: () => null, ensure: vi.fn(async () => {}), subscribe };
  const disconnect = connectControlUiFaviconArtwork({
    gateway: gateway.gateway,
    theme,
    agentSelection: selection,
    agents,
    agentIdentity: identity,
  });
  cleanups.push(disconnect);
  const publish = () => listeners.forEach((listener) => listener());
  return { theme, selection, gateway, disconnect, publish };
}
function retireSource(
  fixture: ReturnType<typeof setup>,
  cause: "theme" | "selection" | "gateway" | "disconnect",
  theme: ReturnType<typeof setup>["theme"]["branding"] = resolveThemeBranding(undefined),
) {
  const actions = {
    gateway: () => {
      fixture.gateway.gateway.connectionRevision += 1;
    },
    disconnect: fixture.disconnect,
    selection: () => {
      fixture.theme.settings.tabIcon = "default";
    },
    theme: () => {
      fixture.theme.branding = theme;
    },
  };
  actions[cause]();
  if (cause === "selection" || cause === "theme") {
    fixture.publish();
  }
}

async function settle(
  fixture: ReturnType<typeof setup>,
  image: HTMLImageElement | string | null,
  ...shape: string[]
) {
  fixture.publish();
  await vi.dynamicImportSettled();
  expectArtwork(image, ...shape);
}

afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.mocked(loadUnlockedLobsterFavicon).mockReset();
  vi.mocked(fetchPluginThemeArtworkBlobUrl).mockReset();
});

it("uses theme artwork as fallback, respects personal artwork, and follows theme hot reload", async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  mockImage();
  vi.mocked(fetchPluginThemeArtworkBlobUrl)
    .mockResolvedValueOnce(null)
    .mockImplementation(async ({ url }) => `blob:${url}`);
  const fixture = setup();
  fixture.theme.branding = shipBranding();
  await settle(fixture, null);
  await settle(fixture, "blob:/__openclaw__/theme-art/ship?v=1");

  fixture.theme.branding.artwork = shipBranding(2).artwork;
  await settle(fixture, "blob:/__openclaw__/theme-art/ship?v=2");

  vi.mocked(resolveAvatarImageUrl).mockReturnValue("blob:personal-avatar");
  fixture.theme.settings.tabIcon = "agent:circle";
  await settle(fixture, "blob:personal-avatar", "circle");
  fixture.selection.state.selectedId = "other";
  await settle(fixture, "blob:/__openclaw__/theme-art/ship?v=2");

  const lobster = document.createElement("img");
  vi.mocked(loadUnlockedLobsterFavicon).mockResolvedValue(lobster);
  fixture.theme.settings.tabIcon = "lobster:crimson";
  await settle(fixture, lobster);
  fixture.theme.branding.lobsterdex = false;
  await settle(fixture, "blob:/__openclaw__/theme-art/ship?v=2");
  expect(fixture.theme.settings.tabIcon).toBe("lobster:crimson");
  vi.mocked(loadUnlockedLobsterFavicon).mockResolvedValue(null);
  fixture.theme.branding.lobsterdex = true;
  await settle(fixture, "blob:/__openclaw__/theme-art/ship?v=2");
});

it.each(["theme", "gateway", "disconnect"] as const)(
  "retires pending custom artwork on %s changes",
  async (retire) => {
    const decoded = createDeferred();
    const decoding = createDeferred();
    mockImage(() => {
      decoding.resolve();
      return decoded.promise;
    });
    vi.mocked(fetchPluginThemeArtworkBlobUrl).mockResolvedValue("blob:retired-theme");
    const fixture = setup();
    fixture.theme.branding = shipBranding();
    fixture.publish();
    await decoding.promise;
    retireSource(fixture, retire);
    decoded.resolve();
    await vi.dynamicImportSettled();
    expectArtwork(null);
  },
);

it("re-bakes selected lobster artwork on unlock and theme changes, stopping after disconnect", async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  const image = document.createElement("img");
  vi.mocked(loadUnlockedLobsterFavicon).mockResolvedValue(null);
  const fixture = setup("lobster:crimson");
  await vi.dynamicImportSettled();
  expectArtwork(null);
  vi.mocked(loadUnlockedLobsterFavicon).mockResolvedValue(image);
  recordLobsterVisit("crimson", { name: "Pinchy" });
  await vi.dynamicImportSettled();
  expectArtwork(image);
  const rebaked = document.createElement("img");
  vi.mocked(loadUnlockedLobsterFavicon).mockResolvedValue(rebaked);
  await settle(fixture, rebaked);
  fixture.disconnect();
  const calls = vi.mocked(loadUnlockedLobsterFavicon).mock.calls.length;
  recordLobsterVisit("blue");
  await settle(fixture, null);
  expect(loadUnlockedLobsterFavicon).toHaveBeenCalledTimes(calls);
});

it("fences late lobster images after selection, Gateway replacement, and teardown", async () => {
  for (const retire of ["selection", "theme", "gateway", "disconnect"] as const) {
    const pending = createDeferred<HTMLImageElement | null>();
    vi.mocked(loadUnlockedLobsterFavicon).mockReturnValue(pending.promise);
    const fixture = setup("lobster:crimson");
    await vi.dynamicImportSettled();
    retireSource(fixture, retire, { ...fixture.theme.branding, lobsterdex: false });
    pending.resolve(document.createElement("img"));
    await pending.promise;
    await Promise.resolve();
    expectArtwork(null);
    fixture.disconnect();
  }
});

it("discards superseded protected-avatar results and stops reacting after disconnect", async () => {
  const pending = createDeferred<string | null>();
  const released = vi.fn();
  vi.mocked(resolveAvatarImageUrl).mockReturnValue(pending.promise);
  vi.mocked(retainAvatarImageUrl).mockReturnValue(released);
  const fixture = setup("agent");
  fixture.selection.state.selectedId = "other";
  fixture.publish();
  expect(released).toHaveBeenCalledOnce();
  pending.resolve("blob:late-avatar");
  await pending.promise;
  await Promise.resolve();
  expectArtwork(null);
  fixture.disconnect();
  const calls = vi.mocked(applyControlUiFaviconImage).mock.calls.length;
  fixture.selection.state.selectedId = "main";
  fixture.publish();
  expect(applyControlUiFaviconImage).toHaveBeenCalledTimes(calls);
});

it("retries the same source after a failed protected-avatar load", async () => {
  const missing = createDeferred<string | null>();
  const retry = createDeferred<string | null>();
  const released = createDeferred();
  const release = vi.fn(() => released.resolve());
  vi.mocked(resolveAvatarImageUrl)
    .mockReturnValueOnce(missing.promise)
    .mockReturnValue(retry.promise);
  vi.mocked(retainAvatarImageUrl).mockReturnValue(release);
  const fixture = setup("agent");
  missing.resolve(null);
  await released.promise;
  expect(release).toHaveBeenCalledOnce();
  fixture.publish();
  expect(resolveAvatarImageUrl).toHaveBeenCalledTimes(2);
  fixture.disconnect();
  retry.resolve("blob:retired-retry");
  await retry.promise;
  expectArtwork(null);
});
