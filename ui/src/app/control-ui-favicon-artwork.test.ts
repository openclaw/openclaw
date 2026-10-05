/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TabIconPreference } from "../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { resolveAvatarImageUrl, retainAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import { applyControlUiFaviconImage } from "./control-ui-environment-presentation.runtime.ts";
import { connectControlUiFaviconArtwork } from "./control-ui-favicon-artwork.runtime.ts";
import { client, createGatewayHarness } from "./overlays-access.test-support.ts";

// mock-isolation: Exercise source ownership without the process-wide DOM compositor.
vi.mock("./control-ui-environment-presentation.runtime.ts", () => ({
  applyControlUiFaviconImage: vi.fn(),
}));
// mock-isolation: Control protected-image settlement without shared cache or HTTP state.
vi.mock("../lib/identity-avatar-loader.ts", () => ({
  resolveAvatarImageUrl: vi.fn(),
  retainAvatarImageUrl: vi.fn(() => vi.fn()),
}));
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
  const theme = { settings: { tabIcon: preference }, subscribe };
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
    for (const listener of listeners) listener();
  };
  return { theme, selection, gateway, disconnect, publish, identity };
}

afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("tab icon artwork lifecycle", () => {
  it("keeps custom artwork across agent changes and uses default for empty custom or default mode", () => {
    const image = { dataUrl: "data:image/png;base64,custom", fileName: "icon.png" };
    const fixture = setup({ mode: "custom", image });
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(image.dataUrl);
    fixture.selection.state.selectedId = "other";
    fixture.publish();
    expect(applyControlUiFaviconImage).toHaveBeenCalledTimes(1);
    expect(fixture.identity.ensure).not.toHaveBeenCalled();
    fixture.theme.settings.tabIcon = { mode: "default", image };
    fixture.publish();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(null);
    fixture.theme.settings.tabIcon = { mode: "custom" };
    fixture.publish();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(null);
  });

  it("discards pending protected-avatar results after selection changes or teardown", async () => {
    const pending = createDeferred<string | null>();
    const released = vi.fn();
    vi.mocked(resolveAvatarImageUrl).mockReturnValue(pending.promise);
    vi.mocked(retainAvatarImageUrl).mockReturnValue(released);
    const fixture = setup({ mode: "agent" });
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
    fixture.theme.settings.tabIcon = {
      mode: "custom",
      image: { dataUrl: "late", fileName: "late.png" },
    };
    fixture.publish();
    expect(applyControlUiFaviconImage).toHaveBeenCalledTimes(calls);
  });

  it("rasterizes the selected agent through the protected image owner without distorting it", async () => {
    const decode = createDeferred<void>();
    vi.mocked(resolveAvatarImageUrl).mockReturnValue("blob:protected-avatar");
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        naturalWidth = 64;
        naturalHeight = 32;
        decode = () => decode.promise;
      },
    );
    const drawing = { drawImage: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      drawing as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,rendered",
    );
    const fixture = setup({ mode: "agent" });
    await Promise.resolve();
    decode.resolve();
    await decode.promise;
    await Promise.resolve();
    expect(drawing.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 8, 32, 16);
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith("data:image/png;base64,rendered");
    fixture.theme.settings.tabIcon = { mode: "default" };
    fixture.publish();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(null);
  });
});
