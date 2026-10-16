// Covers repair hints for official external plugin installs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveExternalPluginRuntimeDependencyRepairHint,
  resolveMissingOfficialExternalChannelPluginRepairHint,
  resolveMissingOfficialExternalChannelPluginRepairHints,
  tracksPluginDependencyStatus,
} from "./official-external-plugin-repair-hints.js";

const mocks = vi.hoisted(() => ({
  resolveConfiguredChannelPresencePolicy: vi.fn(),
}));

vi.mock("./channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPresencePolicy: (params: unknown) =>
    mocks.resolveConfiguredChannelPresencePolicy(params),
}));

describe("resolveMissingOfficialExternalChannelPluginRepairHint", () => {
  beforeEach(() => {
    mocks.resolveConfiguredChannelPresencePolicy.mockReset();
  });

  it("returns an install hint when a configured official external channel has no owner", () => {
    mocks.resolveConfiguredChannelPresencePolicy.mockReturnValue([
      {
        channelId: "feishu",
        sources: ["explicit-config"],
        effective: false,
        pluginIds: [],
        blockedReasons: ["no-channel-owner"],
      },
    ]);

    expect(
      resolveMissingOfficialExternalChannelPluginRepairHint({
        config: { channels: { feishu: { appId: "cli_xxx" } } },
        channelId: "feishu",
      }),
    ).toEqual({
      pluginId: "feishu",
      channelId: "feishu",
      label: "Feishu",
      installSpec: "@openclaw/feishu",
      installCommand: "openclaw plugins install @openclaw/feishu",
      doctorFixCommand: "openclaw doctor --fix",
      repairHint:
        "Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
    });
  });

  it("skips presence policy when no channel ids need repair hints", () => {
    expect(
      resolveMissingOfficialExternalChannelPluginRepairHints({
        config: {},
        channelIds: [],
      }),
    ).toEqual([]);
    expect(mocks.resolveConfiguredChannelPresencePolicy).not.toHaveBeenCalled();
  });

  it("does not return install hints for policy-blocked official external channel owners", () => {
    mocks.resolveConfiguredChannelPresencePolicy.mockReturnValue([
      {
        channelId: "whatsapp",
        sources: ["explicit-config"],
        effective: false,
        pluginIds: [],
        blockedReasons: ["not-in-allowlist"],
      },
    ]);

    expect(
      resolveMissingOfficialExternalChannelPluginRepairHint({
        config: { channels: { whatsapp: { enabled: true } } },
        channelId: "whatsapp",
      }),
    ).toBeNull();
  });

  it("does not return install hints for active official external channel owners", () => {
    mocks.resolveConfiguredChannelPresencePolicy.mockReturnValue([
      {
        channelId: "whatsapp",
        sources: ["explicit-config"],
        effective: true,
        pluginIds: ["whatsapp"],
        blockedReasons: [],
      },
    ]);

    expect(
      resolveMissingOfficialExternalChannelPluginRepairHint({
        config: { channels: { whatsapp: { enabled: true } } },
        channelId: "whatsapp",
      }),
    ).toBeNull();
  });
});

describe("resolveExternalPluginRuntimeDependencyRepairHint", () => {
  it.each([
    {
      name: "names the official install command for the package that owns the id",
      candidate: { origin: "bundled", pluginId: "discord", packageName: "@openclaw/discord" },
      expected: "openclaw plugins install @openclaw/discord",
    },
    {
      name: "keeps install repair for a separately installed copy of a core plugin",
      candidate: { origin: "config", pluginId: "cloudflare", packageName: "@openclaw/cloudflare" },
      expected: "openclaw plugins install @openclaw/cloudflare",
    },
    {
      name: "withholds the official install command from a foreign package reusing the id",
      candidate: {
        origin: "bundled",
        pluginId: "discord",
        packageName: "@example/discord-fork",
        packageBuild: { bundledDist: false },
      },
      expected: "reinstall or update the plugin package",
    },
  ])("$name", ({ candidate, expected }) => {
    const hint = resolveExternalPluginRuntimeDependencyRepairHint(candidate);
    expect(hint).toContain("runtime dependencies are missing");
    expect(hint).toContain(expected);
  });

  it.each(["telegram", "cloudflare"])("stays silent for root-packaged %s", (pluginId) => {
    expect(
      resolveExternalPluginRuntimeDependencyRepairHint({
        origin: "bundled",
        pluginId,
        packageName: `@openclaw/${pluginId}`,
      }),
    ).toBeUndefined();
  });
});

describe("tracksPluginDependencyStatus", () => {
  it.each(["config"])(
    "keeps dependency checks for a %s install that claims bundled distribution",
    (origin) => {
      expect(
        tracksPluginDependencyStatus({
          origin,
          pluginId: "cua-computer",
          packageName: "@example/cua-computer",
          packageBuild: { bundledDist: true },
        }),
      ).toBe(true);
    },
  );

  it("keeps staged CUA dependency ownership with the bundled host", () => {
    expect(
      tracksPluginDependencyStatus({
        origin: "bundled",
        pluginId: "cua-computer",
        packageName: "@openclaw/cua-computer",
        packageBuild: { bundledDist: true },
      }),
    ).toBe(false);
  });
});
