// Gateway auth bypass tests cover channel plugin paths allowed to skip gateway auth.
import { describe, expect, it, vi } from "vitest";

const { tryLoadActivatedBundledPluginPublicSurfaceModuleSyncMock } = vi.hoisted(() => ({
  tryLoadActivatedBundledPluginPublicSurfaceModuleSyncMock: vi.fn(
    ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
      if (dirName === "mattermost" && artifactBasename === "gateway-auth-api.js") {
        return {
          resolveGatewayAuthBypassPaths: () => [
            " /api/channels/mattermost/command ",
            "",
            null,
            "/api/channels/mattermost/work",
          ],
        };
      }
      if (dirName === "disabledchannel") {
        // Activation-gated loads return null for disabled/denied plugins.
        return null;
      }
      if (dirName === "broken" && artifactBasename === "gateway-auth-api.js") {
        throw new Error("broken gateway auth artifact");
      }
      throw new Error(
        `Unable to resolve bundled plugin public surface ${dirName}/${artifactBasename}`,
      );
    },
  ),
}));

vi.mock("../../plugin-sdk/facade-runtime.js", () => ({
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync:
    tryLoadActivatedBundledPluginPublicSurfaceModuleSyncMock,
}));

import { resolveBundledChannelGatewayAuthBypassPaths } from "./gateway-auth-bypass.js";

describe("channel gateway auth bypass fast path", () => {
  it("loads the narrow gateway auth artifact for configured channels", () => {
    const paths = resolveBundledChannelGatewayAuthBypassPaths({
      channelId: "mattermost",
      cfg: { channels: { mattermost: {} } },
    });

    expect(paths).toEqual(["/api/channels/mattermost/command", "/api/channels/mattermost/work"]);
    expect(tryLoadActivatedBundledPluginPublicSurfaceModuleSyncMock).toHaveBeenCalledWith({
      dirName: "mattermost",
      artifactBasename: "gateway-auth-api.js",
    });
  });

  it("treats missing gateway auth artifacts as no bypass paths", () => {
    expect(
      resolveBundledChannelGatewayAuthBypassPaths({
        channelId: "discord",
        cfg: { channels: { discord: {} } },
      }),
    ).toStrictEqual([]);
  });

  it("returns no bypass paths when plugin activation blocks the artifact", () => {
    expect(
      resolveBundledChannelGatewayAuthBypassPaths({
        channelId: "disabledchannel",
        cfg: { channels: { disabledchannel: {} } },
      }),
    ).toStrictEqual([]);
  });

  it("surfaces errors from present gateway auth artifacts", () => {
    expect(() =>
      resolveBundledChannelGatewayAuthBypassPaths({
        channelId: "broken",
        cfg: { channels: { broken: {} } },
      }),
    ).toThrow("broken gateway auth artifact");
  });
});
