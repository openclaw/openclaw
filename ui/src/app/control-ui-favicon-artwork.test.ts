/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TabIconPreference } from "../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { resolveAvatarImageUrl, retainAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
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
});

describe("tab icon artwork lifecycle", () => {
  it("does not load agent artwork for the default choice", () => {
    const fixture = setup();
    fixture.selection.state.selectedId = "other";
    fixture.publish();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(null);
    expect(resolveAvatarImageUrl).not.toHaveBeenCalled();
    expect(fixture.identity.ensure).not.toHaveBeenCalled();
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

  it("hands the decoded agent image to the compositor and retires it when the source changes", async () => {
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
    const fixture = setup("agent");
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
    );
    fixture.theme.settings.tabIcon = "default";
    fixture.publish();
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(null);
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
    expect(applyControlUiFaviconImage).toHaveBeenLastCalledWith(null);
  });
});
