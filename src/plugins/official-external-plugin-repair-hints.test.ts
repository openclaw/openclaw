import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as catalog from "./official-external-plugin-catalog.js";
import { installableEntry } from "./official-external-plugin-catalog.test-support.js";
import {
  resolveExternalPluginRuntimeDependencyRepairHint,
  resolveMissingOfficialExternalChannelPluginRepairHint,
  resolveMissingOfficialExternalChannelPluginRepairHints,
  resolveOfficialExternalPluginRepairHint,
  tracksPluginDependencyStatus,
} from "./official-external-plugin-repair-hints.js";

const resolvePresence = vi.hoisted(() => vi.fn());

// mock-isolation: Repair cases supply missing or blocked channel owners without a live registry.
vi.mock("./channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPresencePolicy: resolvePresence,
}));

afterEach(() => vi.restoreAllMocks());

function channelHint(channelId: string, effective: boolean, blockedReasons: string[]) {
  resolvePresence.mockReturnValue([
    {
      channelId,
      sources: ["explicit-config"],
      effective,
      pluginIds: effective ? [channelId] : [],
      blockedReasons,
    },
  ]);
  return resolveMissingOfficialExternalChannelPluginRepairHint({
    config: {
      channels: { [channelId]: channelId === "feishu" ? { appId: "cli_xxx" } : { enabled: true } },
    },
    channelId,
  });
}

describe("resolveMissingOfficialExternalChannelPluginRepairHint", () => {
  beforeEach(() => resolvePresence.mockReset());

  it("returns an install hint when a configured official external channel has no owner", () => {
    expect(channelHint("feishu", false, ["no-channel-owner"])).toEqual({
      pluginId: "feishu",
      channelId: "feishu",
      label: "Feishu",
      installSpec: "@openclaw/feishu",
      installCommand: "openclaw plugins install npm:@openclaw/feishu",
      doctorFixCommand: "openclaw doctor --fix",
      repairHint:
        "Install the official external plugin with: openclaw plugins install npm:@openclaw/feishu, or run: openclaw doctor --fix.",
    });
  });

  it.each([
    ["public-npm", "@acme/plugin@1.2.3", "npm:@acme/plugin@1.2.3"],
    ["public-clawhub", "clawhub:@acme/plugin@1.2.3", "clawhub:@acme/plugin@1.2.3"],
  ])(
    "preserves the %s registry in a pinned catalog repair command",
    (sourceRef, installSpec, target) => {
      vi.spyOn(catalog, "getOfficialExternalPluginCatalogEntry").mockReturnValue(
        installableEntry("acme-plugin", { sourceRef, package: "@acme/plugin", version: "1.2.3" }),
      );

      expect(resolveOfficialExternalPluginRepairHint("acme-plugin")).toMatchObject({
        installSpec,
        installCommand: `openclaw plugins install ${target}`,
      });
    },
  );

  it("skips presence policy when no channel ids need repair hints", () => {
    expect(
      resolveMissingOfficialExternalChannelPluginRepairHints({
        config: {},
        channelIds: [],
      }),
    ).toEqual([]);
    expect(resolvePresence).not.toHaveBeenCalled();
  });

  it("does not return install hints for policy-blocked official external channel owners", () => {
    expect(channelHint("whatsapp", false, ["not-in-allowlist"])).toBeNull();
  });

  it("does not return install hints for active official external channel owners", () => {
    expect(channelHint("whatsapp", true, [])).toBeNull();
  });
});

describe("resolveExternalPluginRuntimeDependencyRepairHint", () => {
  it.each([
    ["bundled", "discord", "@openclaw/discord", "openclaw plugins install npm:@openclaw/discord"],
    [
      "config",
      "cloudflare",
      "@openclaw/cloudflare",
      "openclaw plugins install npm:@openclaw/cloudflare",
    ],
    ["bundled", "discord", "@example/discord-fork", "reinstall or update the plugin package"],
  ])("repairs %s %s from %s with %s", (origin, pluginId, packageName, expected) => {
    const hint = resolveExternalPluginRuntimeDependencyRepairHint({
      origin,
      pluginId,
      packageName,
      ...(packageName === "@example/discord-fork" ? { packageBuild: { bundledDist: false } } : {}),
    });
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
  it.each([
    ["config", "@example/cua-computer", true],
    ["bundled", "@openclaw/cua-computer", false],
  ] as const)("tracks %s CUA dependency ownership: %s → %s", (origin, packageName, expected) => {
    expect(
      tracksPluginDependencyStatus({
        origin,
        pluginId: "cua-computer",
        packageName,
        packageBuild: { bundledDist: true },
      }),
    ).toBe(expected);
  });
});
