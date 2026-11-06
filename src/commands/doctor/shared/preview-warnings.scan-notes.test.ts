import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { collectDoctorPreviewNotes } from "./preview-warnings.js";
import * as staleOAuthProfileShadows from "./stale-oauth-profile-shadows.js";

const staleOAuthShadowState = vi.hoisted(() => ({
  warnings: [] as string[],
  scanWarnings: [] as string[],
}));
const staleAuthOrderState = vi.hoisted(() => ({ warnings: [] as string[] }));

vi.mock("./channel-plugin-blockers.js", () => ({
  scanConfiguredChannelPluginBlockers: () => [],
  collectConfiguredChannelPluginBlockerWarnings: () => [],
  isWarningBlockedByChannelPlugin: () => false,
}));

vi.mock("./stale-plugin-config.js", () => ({
  scanStalePluginConfig: () => [],
  collectStalePluginConfigWarnings: () => [],
  isStalePluginAutoRepairBlocked: () => false,
}));

vi.mock("./codex-route-warnings.js", () => ({
  collectCodexRouteWarnings: () => [],
}));

vi.mock("./codex-native-assets.js", () => ({
  collectCodexNativeAssetInfoNotes: async () => [],
}));

vi.mock("./context-engine-host-compat.js", () => ({
  collectContextEngineHostCompatibilityWarnings: async () => [],
}));

vi.mock("../../../state/user-profiles-owner-migration.js", () => ({
  repairMergedGatewayOwnerProfile: () => ({ repaired: false, changes: [], warnings: [] }),
}));

vi.mock("./bundled-plugin-load-paths.js", () => ({
  scanBundledPluginLoadPathMigrations: (cfg: { plugins?: { load?: { paths?: string[] } } }) =>
    (cfg.plugins?.load?.paths ?? []).map((legacyPath) => ({ legacyPath })),
  collectBundledPluginLoadPathWarnings: ({
    doctorFixCommand,
    hits,
  }: {
    doctorFixCommand: string;
    hits: Array<{ legacyPath: string }>;
  }) =>
    hits.map(
      (hit) =>
        `plugins.load.paths: legacy bundled plugin path "${hit.legacyPath}". Run "${doctorFixCommand}".`,
    ),
}));

// mock-isolation: Script warning output without reading host auth stores.
vi.mock("./stale-oauth-profile-shadows.js", () => ({
  scanStaleOAuthProfileShadows: () => ({
    hits: staleOAuthShadowState.warnings.map((warning, index) => ({
      profileId: String(index),
      warning,
    })),
    warnings: staleOAuthShadowState.scanWarnings,
  }),
  collectStaleOAuthProfileShadowWarnings: ({ hits }: { hits: Array<{ warning: string }> }) =>
    hits.map((hit) => hit.warning),
}));

vi.mock("./stale-auth-order.js", () => ({
  collectStaleConfiguredAuthOrderWarnings: () => staleAuthOrderState.warnings,
}));

afterEach(() => vi.restoreAllMocks());

const unreadableStore = "Cannot read legacy auth profile store /tmp/agent/auth-profiles.json";
const shadowLines = ["shadow one", "shadow two"];
it.each<[string, string[], string[], string[], string[]]>([
  ["groups multiline warnings", shadowLines, [], shadowLines, ["shadow one\nshadow two"]],
  ["skips formatting empty hits", [], [], ["must not render"], []],
  ["surfaces unreadable stores without hits", [], [unreadableStore], [], [unreadableStore]],
])(
  "doctor preview %s without changing family order or config",
  async (_name, shadows, scanWarnings, lines, expectedNotes) => {
    staleOAuthShadowState.warnings = shadows;
    staleOAuthShadowState.scanWarnings = scanWarnings;
    staleAuthOrderState.warnings = ["auth-order warning"];
    const collect = vi
      .spyOn(staleOAuthProfileShadows, "collectStaleOAuthProfileShadowWarnings")
      .mockReturnValue(lines);
    const cfg: OpenClawConfig = { plugins: { load: { paths: ["legacy-one", "legacy-two"] } } };
    const original = structuredClone(cfg);
    const result = await collectDoctorPreviewNotes({
      cfg,
      doctorFixCommand: "openclaw doctor --fix",
      env: {},
    });
    expect(result).toEqual({
      infoNotes: [],
      warningNotes: [
        'plugins.load.paths: legacy bundled plugin path "legacy-one". Run "openclaw doctor --fix".\n' +
          'plugins.load.paths: legacy bundled plugin path "legacy-two". Run "openclaw doctor --fix".',
        ...expectedNotes,
        "auth-order warning",
      ],
    });
    expect(collect).toHaveBeenCalledTimes(shadows.length > 0 ? 1 : 0);
    expect(cfg).toEqual(original);
  },
);
