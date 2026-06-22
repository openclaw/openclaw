import { describe, expect, it } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  resolveClawHubInstallSpecsForUpdateChannel,
  resolveNpmInstallSpecsForUpdateChannel,
} from "./install-channel-specs.js";
import type { ValidatedStablePluginSupportManifest } from "./stable-plugin-support.js";

describe("stable plugin install channel specs", () => {
  it("rewrites covered default official npm specs to exact stable manifest targets", () => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/slack",
        updateChannel: "stable",
      }),
    ).toMatchObject({
      installSpec: "@openclaw/slack@2026.6.33",
      recordSpec: "@openclaw/slack",
      reason: "covered_stable_target",
      packageName: "@openclaw/slack",
      stableLine: "2026.6",
    });
  });

  it("keeps covered default official specs on daily selectors", () => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/slack@latest",
        updateChannel: "daily",
      }),
    ).toMatchObject({
      installSpec: "@openclaw/slack@latest",
      recordSpec: "@openclaw/slack@latest",
      reason: "covered_daily_target",
      packageName: "@openclaw/slack",
    });
  });

  it("fails closed for ambiguous exact covered official records", () => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/slack@2026.6.8",
        updateChannel: "stable",
        record: {
          source: "npm",
          spec: "@openclaw/slack@2026.6.8",
          resolvedSpec: "@openclaw/slack@2026.6.8",
        },
      }),
    ).toMatchObject({
      installSpec: "@openclaw/slack@2026.6.8",
      reason: "ambiguous_exact_official_install",
      classification: "unknown",
    });
  });

  it("converges prior default-intent system pins to the active stable target", () => {
    const record: PluginInstallRecord = {
      source: "npm",
      spec: "@openclaw/slack",
      resolvedSpec: "@openclaw/slack@2026.6.8",
      installIntentProvenance: "prior_default_intent_system_pin",
    };

    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: record.resolvedSpec ?? record.spec ?? "",
        updateChannel: "stable",
        record,
      }),
    ).toMatchObject({
      installSpec: "@openclaw/slack@2026.6.33",
      recordSpec: "@openclaw/slack",
      reason: "covered_stable_target",
      classification: "prior_default_intent_system_pin",
    });
  });

  it("infers prior default intent from default npm record specs", () => {
    const record: PluginInstallRecord = {
      source: "npm",
      spec: "@openclaw/slack",
      resolvedSpec: "@openclaw/slack@2026.6.8",
    };

    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: record.resolvedSpec ?? "",
        updateChannel: "stable",
        record,
      }),
    ).toMatchObject({
      installSpec: "@openclaw/slack@2026.6.33",
      recordSpec: "@openclaw/slack",
      reason: "covered_stable_target",
      classification: "prior_default_intent_system_pin",
    });
  });

  it("preserves explicit user pins for covered official packages", () => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/slack@2026.6.8",
        updateChannel: "stable",
        record: {
          source: "npm",
          spec: "@openclaw/slack@2026.6.8",
          installIntentProvenance: "explicit_user_pin",
        },
      }),
    ).toMatchObject({
      installSpec: "@openclaw/slack@2026.6.8",
      reason: "preserved_exact_pin",
      classification: "explicit_user_pin",
    });
  });

  it("preserves official packages outside the stable manifest contract", () => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/matrix",
        updateChannel: "stable",
      }),
    ).toMatchObject({
      installSpec: "@openclaw/matrix",
      reason: "outside_stable_contract",
      packageName: "@openclaw/matrix",
    });
  });

  it("preserves ClawHub specs for the first stable contract", () => {
    expect(
      resolveClawHubInstallSpecsForUpdateChannel({
        spec: "clawhub:slack",
        updateChannel: "stable",
      }),
    ).toEqual({
      installSpec: "clawhub:slack",
      recordSpec: "clawhub:slack",
      reason: "outside_stable_contract",
    });
  });

  it("reports a missing target when a covered package has no manifest target", () => {
    const stablePluginSupport = {
      stablePluginSupportSha256: "0".repeat(64),
      targetsByPackageName: new Map(),
    } as ValidatedStablePluginSupportManifest;

    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/slack",
        updateChannel: "stable",
        stablePluginSupport,
      }),
    ).toMatchObject({
      installSpec: "@openclaw/slack",
      reason: "missing_stable_target",
      packageName: "@openclaw/slack",
    });
  });

  it("keeps beta default npm behavior unchanged", () => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/slack",
        updateChannel: "beta",
      }),
    ).toEqual({
      installSpec: "@openclaw/slack@beta",
      recordSpec: "@openclaw/slack",
      fallbackSpec: "@openclaw/slack",
      fallbackLabel: "@openclaw/slack@beta",
    });
  });
});
