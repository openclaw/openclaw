/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings, patchSettings, type UiSettings } from "../../app/settings.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ConfigPage } from "./config-page.ts";
import * as tabIconImage from "./tab-icon-image.ts";
import type { TabIconSettingsController } from "./tab-icon-settings-controller.ts";

const IMAGE = {
  dataUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
  fileName: "icon.png",
};
const upload = vi.fn<typeof tabIconImage.fileToTabIconImage>();
type TestPage = {
  context: ApplicationContext;
  settings: UiSettings;
  pageId: string;
  tabIconSettings: TabIconSettingsController;
  resetConfigViewState: () => void;
};
function createPage() {
  patchSettings({ tabIcon: { mode: "custom" } });
  const page = new ConfigPage();
  const state = page as unknown as TestPage;
  const connected = vi.spyOn(page, "isConnected", "get").mockReturnValue(true);
  const gateway = {
    connection: { gatewayUrl: "ws://gateway.test" },
    snapshot: { phase: "connected", client: {}, selfUser: { id: "alice" } },
  };
  const selection = { intentRevision: 0 };
  const baseConfig = createApplicationConfigCapability({ resourceBasePath: "" });
  const config = { ...baseConfig, current: { ...baseConfig.current } };
  const refresh = vi.fn();
  state.context = {
    gateway,
    settingsAgentSelection: selection,
    config,
    theme: { refresh },
  } as unknown as ApplicationContext;
  state.settings = loadSettings();
  state.pageId = "appearance";
  return { page, state, gateway, selection, config, refresh, connected };
}
const picked = () => new File(["image"], "icon.png", { type: "image/png" });

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  upload.mockReset();
  vi.spyOn(tabIconImage, "fileToTabIconImage").mockImplementation(upload);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConfigPage tab icon upload intent", () => {
  it("does not read files when uploads are disabled", async () => {
    const { state, config } = createPage();
    config.current.uploadsEnabled = false;
    await state.tabIconSettings.upload(picked());
    expect(upload).not.toHaveBeenCalled();
    expect(state.tabIconSettings.props.tabIconError).toBeTruthy();
    expect(state.tabIconSettings.props.tabIconBusy).toBe(false);
  });
  it("applies a current processed upload and preserves it across source changes", async () => {
    upload.mockResolvedValue({ ok: true, image: IMAGE });
    const { state, refresh } = createPage();
    await state.tabIconSettings.upload(picked());
    expect(loadSettings().tabIcon).toEqual({ mode: "custom", image: IMAGE });
    state.tabIconSettings.props.setTabIconMode("agent");
    expect(loadSettings().tabIcon).toEqual({ mode: "agent", image: IMAGE });
    state.tabIconSettings.props.setTabIconMode("default");
    expect(loadSettings().tabIcon).toEqual({ mode: "default", image: IMAGE });
    state.tabIconSettings.props.onRemoveTabIconImage();
    expect(loadSettings().tabIcon).toEqual({ mode: "custom" });
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(state.tabIconSettings.props.tabIconBusy).toBe(false);
  });

  it.each([
    "mode",
    "remove",
    "reset",
    "profile",
    "gateway",
    "client",
    "selection",
    "policy",
    "unmount",
    "page",
    "preference",
  ])("does not apply a late upload after %s changes", async (change) => {
    const pending = createDeferred<tabIconImage.TabIconImageResult>();
    upload.mockReturnValue(pending.promise);
    const { state, gateway, selection, config, refresh, connected } = createPage();
    const work = state.tabIconSettings.upload(picked());
    switch (change) {
      case "mode":
        state.tabIconSettings.props.setTabIconMode("default");
        break;
      case "reset":
        state.resetConfigViewState();
        break;
      case "remove":
        state.tabIconSettings.props.onRemoveTabIconImage();
        break;
      case "profile":
        gateway.snapshot.selfUser.id = "bob";
        break;
      case "gateway":
        gateway.connection.gatewayUrl = "ws://other.test";
        break;
      case "client":
        gateway.snapshot.client = {};
        break;
      case "selection":
        selection.intentRevision++;
        break;
      case "policy":
        config.current.uploadsEnabled = false;
        break;
      case "unmount":
        connected.mockReturnValue(false);
        break;
      case "page":
        state.pageId = "advanced";
        break;
      case "preference":
        patchSettings({ tabIcon: { mode: "agent" } });
        break;
    }
    pending.resolve({ ok: true, image: IMAGE });
    await work;
    expect(loadSettings().tabIcon?.image).toBeUndefined();
    expect(state.tabIconSettings.props.tabIconBusy).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(change === "mode" || change === "remove" ? 1 : 0);
  });

  it("keeps newer selection busy when a superseded upload completes", async () => {
    const first = createDeferred<tabIconImage.TabIconImageResult>();
    const second = createDeferred<tabIconImage.TabIconImageResult>();
    upload.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { state } = createPage();
    const oldWork = state.tabIconSettings.upload(picked());
    const newWork = state.tabIconSettings.upload(picked());
    first.resolve({ ok: true, image: IMAGE });
    await oldWork;
    expect(state.tabIconSettings.props.tabIconBusy).toBe(true);
    expect(loadSettings().tabIcon?.image).toBeUndefined();
    second.resolve({ ok: true, image: { ...IMAGE, fileName: "latest.png" } });
    await newWork;
    expect(state.tabIconSettings.props.tabIconBusy).toBe(false);
    expect(loadSettings().tabIcon?.image?.fileName).toBe("latest.png");
  });

  it("aborts pending work through the registered host-disconnect hook", async () => {
    const pending = createDeferred<tabIconImage.TabIconImageResult>();
    upload.mockReturnValue(pending.promise);
    const { page, state, refresh } = createPage();
    const disconnected = vi.spyOn(state.tabIconSettings, "hostDisconnected");
    const work = state.tabIconSettings.upload(picked());
    const signal = upload.mock.calls[0]?.[2];
    expect(signal?.aborted).toBe(false);

    page.disconnectedCallback();
    expect(disconnected).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
    expect(state.tabIconSettings.props.tabIconBusy).toBe(false);

    pending.resolve({ ok: true, image: IMAGE });
    await work;
    expect(loadSettings().tabIcon?.image).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows a recoverable processing error without discarding the previous image", async () => {
    const { state } = createPage();
    state.settings = patchSettings({ tabIcon: { mode: "custom", image: IMAGE } });
    upload.mockResolvedValue({ ok: false, reason: "unusable" });
    await state.tabIconSettings.upload(picked());
    expect(loadSettings().tabIcon?.image).toEqual(IMAGE);
    expect(state.tabIconSettings.props.tabIconError).toContain("Choose a PNG, JPG or WebP image");
    upload.mockResolvedValue({ ok: true, image: IMAGE });
    await state.tabIconSettings.upload(picked());
    expect(state.tabIconSettings.props.tabIconError).toBeNull();
  });
});
