import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as catalog from "./official-external-plugin-catalog.js";
import { installableEntry } from "./official-external-plugin-catalog.test-support.js";
import {
  resolveExternalPluginRuntimeDependencyRepairHint as dependencyHint,
  resolveMissingOfficialExternalChannelPluginRepairHint as missingChannelHint,
  resolveMissingOfficialExternalChannelPluginRepairHints as missingChannelHints,
  resolveOfficialExternalPluginRepairHint as repairHint,
  tracksPluginDependencyStatus,
} from "./official-external-plugin-repair-hints.js";

const resolvePresence = vi.hoisted(() => vi.fn());

// mock-isolation: Repair cases supply missing or blocked channel owners without a live registry.
vi.mock("./channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPresencePolicy: resolvePresence,
}));

afterEach(() => vi.restoreAllMocks());
beforeEach(() => resolvePresence.mockReset());

function channelHint(channelId: string, effective: boolean, blockedReasons: string[]) {
  resolvePresence.mockReturnValue([{ channelId, effective, blockedReasons }]);
  const settings = channelId === "feishu" ? { appId: "cli_xxx" } : { enabled: true };
  return missingChannelHint({ config: { channels: { [channelId]: settings } }, channelId });
}

it("returns an install hint when a configured official external channel has no owner", () => {
  expect(channelHint("feishu", false, ["no-channel-owner"])).toMatchObject({
    pluginId: "feishu",
    channelId: "feishu",
    installCommand: "openclaw plugins install npm:@openclaw/feishu",
    doctorFixCommand: "openclaw doctor --fix",
  });
});

it.each([
  ["public-npm", "@acme/plugin@1.2.3", "npm:@acme/plugin@1.2.3"],
  ["public-clawhub", "clawhub:@acme/plugin@1.2.3", "clawhub:@acme/plugin@1.2.3"],
])("preserves %s in pinned repair commands", (sourceRef, installSpec, target) => {
  vi.spyOn(catalog, "getOfficialExternalPluginCatalogEntry").mockReturnValue(
    installableEntry("acme-plugin", { sourceRef, package: "@acme/plugin", version: "1.2.3" }),
  );

  expect(repairHint("acme-plugin")).toMatchObject({
    installSpec,
    installCommand: `openclaw plugins install ${target}`,
  });
});

it("returns no repairs for an empty channel list", () => {
  expect(missingChannelHints({ config: {}, channelIds: [] })).toEqual([]);
});

it.each([
  [false, ["not-in-allowlist"]],
  [true, []],
] as const)("does not repair an existing owner (active: %s)", (effective, blockedReasons) => {
  expect(channelHint("whatsapp", effective, [...blockedReasons])).toBeNull();
});
it.each<[string, string, string | undefined, string?, boolean?]>([
  ["bundled", "discord", "openclaw plugins install npm:@openclaw/discord"],
  ["config", "cloudflare", "openclaw plugins install npm:@openclaw/cloudflare"],
  ["bundled", "discord", "reinstall or update the plugin package", "@example/discord-fork"],
  ["bundled", "telegram", undefined],
  ["bundled", "cloudflare", undefined],
  ["config", "cua-computer", "reinstall", "@example/cua-computer", true],
  ["bundled", "cua-computer", undefined, "@openclaw/cua-computer", true],
])(
  "resolves %s %s dependency repair",
  (origin, pluginId, expected, foreignPackage, bundledDist) => {
    const candidate = {
      origin,
      pluginId,
      packageName: foreignPackage ?? `@openclaw/${pluginId}`,
      ...(foreignPackage ? { packageBuild: { bundledDist: bundledDist ?? false } } : {}),
    };
    expect(tracksPluginDependencyStatus(candidate)).toBe(expected !== undefined);
    const hint = dependencyHint(candidate);
    expect(hint).toEqual(expected === undefined ? undefined : expect.stringContaining(expected));
  },
);
