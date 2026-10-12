/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TabIconPreference } from "../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { recordLobsterVisit } from "../components/lobster-dex.ts";
import { loadUnlockedLobsterFavicon } from "../components/lobster-favicon.ts";
import { resolveAvatarImageUrl, retainAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import { fetchPluginThemeArtworkBlobUrl } from "../pages/plugins/icon-loader.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
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
function setup(preference?: TabIconPreference) {
  const gateway = createGatewayHarness(client(async () => ({})));
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const theme = {
    settings: { tabIcon: preference },
    branding: resolveThemeBranding(undefined),
    subscribe,
  };
  const selection = { state: { selectedId: "main", scopeId: "main" }, subscribe };
  const agents = {
    state: {
      agentsList: {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender" as const,
        agents: [{ id: "main", identity: { avatarUrl: "/avatar/main" } }, { id: "other" }],
      },
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
  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  return { theme, selection, gateway, disconnect, publish, identity };
}
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.mocked(loadUnlockedLobsterFavicon).mockReset();
  vi.mocked(fetchPluginThemeArtworkBlobUrl).mockReset();
});

describe("tab icon artwork lifecycle", () => {
  it("uses theme artwork as fallback, respects personal artwork, and follows theme hot reload", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        naturalWidth = 32;
        naturalHeight = 32;
        decode = async () => {};
      },
    );
    vi.mocked(fetchPluginThemeArtworkBlobUrl)
      .mockResolvedValueOnce(null)
      .mockImplementation(async ({ url }) => `blob:${url}`);
    const fixture = setup();
    fixture.theme.branding = resolveThemeBranding({
      brandIcon: "ship",
      artwork: { icons: { ship: { url: "/__openclaw__/theme-art/ship?v=1" } } },
    });
    fixture.publish();
    await vi.dynamicImportSettled();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(null);
    fixture.publish();
    await vi.dynamicImportSettled();
    expect(fetchPluginThemeArtworkBlobUrl).toHaveBeenCalledTimes(2);
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ src: "blob:/__openclaw__/theme-art/ship?v=1" }),
    );

    fixture.theme.branding.artwork = {
      icons: { ship: { url: "/__openclaw__/theme-art/ship?v=2" } },
    };
    fixture.publish();
    await vi.dynamicImportSettled();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ src: "blob:/__openclaw__/theme-art/ship?v=2" }),
    );

    vi.mocked(resolveAvatarImageUrl).mockReturnValue("blob:personal-avatar");
    fixture.theme.settings.tabIcon = "agent:circle";
    fixture.publish();
    await vi.dynamicImportSettled();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ src: "blob:personal-avatar" }),
      "circle",
    );
    fixture.selection.state.selectedId = "other";
    fixture.publish();
    await vi.dynamicImportSettled();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ src: "blob:/__openclaw__/theme-art/ship?v=2" }),
    );

    const lobster = document.createElement("img");
    vi.mocked(loadUnlockedLobsterFavicon).mockResolvedValue(lobster);
    fixture.theme.settings.tabIcon = "lobster:crimson";
    fixture.publish();
    await vi.dynamicImportSettled();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(lobster);
    fixture.theme.branding.lobsterdex = false;
    fixture.publish();
    await vi.dynamicImportSettled();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ src: "blob:/__openclaw__/theme-art/ship?v=2" }),
    );
    expect(fixture.theme.settings.tabIcon).toBe("lobster:crimson");
    vi.mocked(loadUnlockedLobsterFavicon).mockResolvedValue(null);
    fixture.theme.branding.lobsterdex = true;
    fixture.publish();
    await vi.dynamicImportSettled();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ src: "blob:/__openclaw__/theme-art/ship?v=2" }),
    );
  });

  it.each(["theme", "gateway", "disconnect"] as const)(
    "retires pending custom artwork on %s changes",
    async (retire) => {
      const decoded = createDeferred();
      const decoding = createDeferred();
      vi.stubGlobal(
        "Image",
        class {
          src = "";
          naturalWidth = 32;
          naturalHeight = 32;
          decode = () => {
            decoding.resolve();
            return decoded.promise;
          };
        },
      );
      vi.mocked(fetchPluginThemeArtworkBlobUrl).mockResolvedValue("blob:retired-theme");
      const fixture = setup();
      fixture.theme.branding = resolveThemeBranding({
        brandIcon: "ship",
        artwork: { icons: { ship: { url: "/__openclaw__/theme-art/ship?v=1" } } },
      });
      fixture.publish();
      await decoding.promise;
      if (retire === "theme") {
        fixture.theme.branding = resolveThemeBranding(undefined);
        fixture.publish();
      } else if (retire === "gateway") {
        fixture.gateway.gateway.connectionRevision += 1;
      } else {
        fixture.disconnect();
      }
      decoded.resolve();
      await vi.dynamicImportSettled();
      expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(null);
    },
  );

  it("re-bakes selected lobster artwork on theme and unlock changes, retaining an unavailable choice", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const image = document.createElement("img");
    vi.mocked(loadUnlockedLobsterFavicon).mockResolvedValue(null);
    const fixture = setup("lobster:crimson");
    await vi.dynamicImportSettled();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(null);
    expect(fixture.theme.settings.tabIcon).toBe("lobster:crimson");
    vi.mocked(loadUnlockedLobsterFavicon).mockResolvedValue(image);
    recordLobsterVisit("crimson", { name: "Pinchy" });
    await vi.dynamicImportSettled();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(image);
    const afterUnlock = vi.mocked(loadUnlockedLobsterFavicon).mock.calls.length;
    fixture.publish();
    await vi.dynamicImportSettled();
    expect(loadUnlockedLobsterFavicon).toHaveBeenCalledTimes(afterUnlock + 1);
    fixture.theme.branding.lobsterdex = false;
    fixture.publish();
    await vi.dynamicImportSettled();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(null);
    expect(loadUnlockedLobsterFavicon).toHaveBeenCalledTimes(afterUnlock + 1);
    expect(fixture.theme.settings.tabIcon).toBe("lobster:crimson");
    fixture.theme.branding.lobsterdex = true;
    fixture.publish();
    await vi.dynamicImportSettled();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(image);
    expect(loadUnlockedLobsterFavicon).toHaveBeenCalledTimes(afterUnlock + 2);
    fixture.disconnect();
    recordLobsterVisit("blue");
    fixture.publish();
    await vi.dynamicImportSettled();
    expect(loadUnlockedLobsterFavicon).toHaveBeenCalledTimes(afterUnlock + 2);
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(null);
  });

  it("fences late lobster images after selection, Gateway replacement, and teardown", async () => {
    for (const retire of ["selection", "theme", "gateway", "disconnect"] as const) {
      const pending = createDeferred<HTMLImageElement | null>();
      vi.mocked(loadUnlockedLobsterFavicon).mockReturnValue(pending.promise);
      const fixture = setup("lobster:crimson");
      await vi.dynamicImportSettled();
      if (retire === "selection") {
        fixture.theme.settings.tabIcon = "default";
        fixture.publish();
      } else if (retire === "theme") {
        fixture.theme.branding.lobsterdex = false;
        fixture.publish();
      } else if (retire === "gateway") {
        fixture.gateway.gateway.connectionRevision += 1;
      } else {
        fixture.disconnect();
      }
      pending.resolve(document.createElement("img"));
      await pending.promise;
      await Promise.resolve();
      expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(null);
      fixture.disconnect();
    }
  });

  it("does not load agent artwork for the default choice", () => {
    const fixture = setup();
    fixture.selection.state.selectedId = "other";
    fixture.publish();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(null);
    expect(resolveAvatarImageUrl).not.toHaveBeenCalled();
    expect(fixture.identity.ensure).not.toHaveBeenCalled();
    expect(loadUnlockedLobsterFavicon).not.toHaveBeenCalled();
  });

  it("discards superseded protected-avatar results and stops reacting after disconnect", async () => {
    const pending = createDeferred<string | null>();
    const released = vi.fn();
    vi.mocked(resolveAvatarImageUrl).mockReturnValue(pending.promise);
    vi.mocked(retainAvatarImageUrl).mockReturnValue(released);
    const fixture = setup("agent");
    expect(resolveAvatarImageUrl).toHaveBeenCalledWith("/avatar/main");
    fixture.selection.state.selectedId = "other";
    fixture.publish();
    expect(released).toHaveBeenCalledOnce();
    pending.resolve("blob:late-avatar");
    await pending.promise;
    await Promise.resolve();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(null);
    fixture.disconnect();
    const calls = vi.mocked(applyControlUiFaviconImage).mock.calls.length;
    fixture.selection.state.selectedId = "main";
    fixture.publish();
    expect(applyControlUiFaviconImage).toHaveBeenCalledTimes(calls);
  });

  it.each([
    ["agent", "square"],
    ["agent:rounded", "rounded"],
    ["agent:circle", "circle"],
  ] as const)(
    "hands %s artwork to the compositor and retires it when the source changes",
    async (preference, shape) => {
      const decoded = createDeferred();
      vi.mocked(resolveAvatarImageUrl).mockReturnValue("blob:protected-avatar");
      vi.stubGlobal(
        "Image",
        class {
          src = "";
          naturalWidth = 64;
          naturalHeight = 32;
          decode = () => decoded.promise;
        },
      );
      const fixture = setup(preference);
      await Promise.resolve();
      decoded.resolve();
      await decoded.promise;
      await Promise.resolve();
      expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          src: "blob:protected-avatar",
          naturalWidth: 64,
          naturalHeight: 32,
        }),
        shape,
      );
      fixture.theme.settings.tabIcon = "default";
      fixture.publish();
      expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(null);
    },
  );

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
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(null);
  });
});
