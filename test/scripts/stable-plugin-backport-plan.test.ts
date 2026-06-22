import { describe, expect, it } from "vitest";
import checkedInStablePluginSupportManifest from "../../release/stable-plugin-support.json" with { type: "json" };
import {
  generateStablePluginBackportPlan,
  parseAffectedPluginIds,
} from "../../scripts/lib/stable-plugin-backport-plan.ts";
import type { StablePluginSupportManifest } from "../../src/plugins/plugin-version-drift.ts";

const manifest = checkedInStablePluginSupportManifest as StablePluginSupportManifest;

describe("generateStablePluginBackportPlan", () => {
  it("emits plugin-first coordinated backport targets with validation and recovery fields", () => {
    const plan = generateStablePluginBackportPlan({
      sourcePr: "https://github.com/openclaw/openclaw/pull/123",
      sourceSha: "abc123",
      stableLine: "2026.6.33",
      eligibilityReason: "security fix for stable-covered Slack channel",
      affectedPluginIds: ["slack"],
      manifest,
      manifestPath: "release/stable-plugin-support.json",
    });

    expect(plan.dryRun).toBe(true);
    expect(plan.stableBranch).toBe("stable/2026.6.33");
    expect(plan.affectedPluginIds).toEqual(["slack"]);
    expect(plan.targets.map((target) => target.packageName)).toEqual([
      "@openclaw/slack",
      "openclaw",
    ]);
    expect(plan.targets.map((target) => target.publishOrder)).toEqual([1, 2]);
    expect(plan.targets[0]).toMatchObject({
      targetType: "plugin",
      targetRepository: "openclaw/openclaw",
      targetBranch: "stable/2026.6.33",
      pluginId: "slack",
      packageDir: "extensions/slack",
      targetNpmSpec: "@openclaw/slack@2026.6.33",
      branchProtectionStatus: "not_checked_dry_run",
      changeKind: "coordinated",
    });
    expect(plan.targets[0]?.validationPlan.map((step) => step.name)).toEqual([
      "stable-plugin-drift-dry-run",
      "package-acceptance-stable-plugin",
      "plugin-publish-proof",
    ]);
    expect(plan.targets[0]?.rollback.partialFailureState).toBe("partial_plugin_publish");
    expect(plan.targets[1]?.rollback.partialFailureState).toBe("core_published_plugin_missing");
    expect(plan.partialFailureStates.map((state) => state.state)).toEqual([
      "planned",
      "plugin_published_core_pending",
      "core_published_plugin_missing",
      "partial_plugin_publish",
      "activation_blocked",
    ]);
  });

  it("emits a core-only target when no covered plugin ids are affected", () => {
    const plan = generateStablePluginBackportPlan({
      sourceSha: "abc123",
      stableLine: "2026.6.33",
      eligibilityReason: "reliability fix in core",
      affectedPluginIds: [],
      manifest,
    });

    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]).toMatchObject({
      targetType: "core",
      packageName: "openclaw",
      changeKind: "core_only",
      publishOrder: 1,
    });
  });

  it("rejects affected plugin ids outside the stable support manifest", () => {
    expect(() =>
      generateStablePluginBackportPlan({
        sourceSha: "abc123",
        stableLine: "2026.6.33",
        eligibilityReason: "security fix",
        affectedPluginIds: ["matrix"],
        manifest,
      }),
    ).toThrow("not covered by the stable support manifest");
  });

  it("parses comma and whitespace separated affected plugin ids", () => {
    expect(parseAffectedPluginIds("slack,codex discord")).toEqual(["codex", "discord", "slack"]);
  });
});
