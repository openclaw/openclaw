/** Tests manifest owner availability policy for bundled, workspace, and installed plugins. */
import { describe, expect, it } from "vitest";
import { normalizePluginsConfig } from "./config-state.js";
import {
  hasExplicitManifestOwnerTrust,
  isActivatedManifestOwner,
  isBundledManifestOwner,
  passesManifestOwnerBasePolicy,
  resolveManifestOwnerBasePolicyBlock,
} from "./manifest-owner-policy.js";

describe("manifest owner policy", () => {
  it("treats bundled owners as bundled and others as non-bundled", () => {
    expect(isBundledManifestOwner({ origin: "bundled" })).toBe(true);
    expect(isBundledManifestOwner({ origin: "workspace" })).toBe(false);
  });

  it("respects enabled, denylist, explicit disable, and allowlist bounds", () => {
    const normalizedConfig = normalizePluginsConfig({
      enabled: true,
      allow: ["demo"],
      deny: ["blocked"],
      entries: {
        disabled: { enabled: false },
        enabled: { enabled: true },
      },
    });

    const passes = (id: string) =>
      passesManifestOwnerBasePolicy({ plugin: { id }, normalizedConfig });
    expect(passes("demo")).toBe(true);
    expect(passes("blocked")).toBe(false);
    expect(passes("disabled")).toBe(false);

    const explicitlyTrustedDisabledConfig = normalizePluginsConfig({
      enabled: true,
      allow: ["disabled"],
      entries: { disabled: { enabled: false } },
    });
    expect(
      passesManifestOwnerBasePolicy({
        plugin: { id: "disabled" },
        normalizedConfig: explicitlyTrustedDisabledConfig,
      }),
    ).toBe(false);
    expect(passes("other")).toBe(false);
  });

  it("reports base policy block reasons and supports explicit allowlist bypasses", () => {
    const normalizedConfig = normalizePluginsConfig({
      enabled: true,
      allow: ["allowed"],
      deny: ["blocked"],
      entries: { disabled: { enabled: false } },
    });

    const block = (id: string, allowRestrictiveAllowlistBypass = false) =>
      resolveManifestOwnerBasePolicyBlock({
        plugin: { id },
        normalizedConfig,
        allowRestrictiveAllowlistBypass,
      });
    expect(block("other")).toBe("not-in-allowlist");
    expect(block("other", true)).toBeNull();
    expect(block("blocked", true)).toBe("blocked-by-denylist");
    expect(block("disabled", true)).toBe("plugin-disabled");
  });

  it("detects explicit manifest owner trust from allowlist or explicit enablement", () => {
    const trusted = (config: Parameters<typeof normalizePluginsConfig>[0]) =>
      hasExplicitManifestOwnerTrust({
        plugin: { id: "demo" },
        normalizedConfig: normalizePluginsConfig(config),
      });
    expect(trusted({ allow: ["demo"] })).toBe(true);
    expect(trusted({ entries: { demo: { enabled: true } } })).toBe(true);
    expect(trusted({})).toBe(false);
  });

  it("uses effective activation state for activated manifest owners", () => {
    const plugin = { id: "demo", origin: "bundled" as const, enabledByDefault: true };
    expect(isActivatedManifestOwner({ plugin, normalizedConfig: normalizePluginsConfig({}) })).toBe(
      true,
    );
    expect(
      isActivatedManifestOwner({
        plugin,
        normalizedConfig: normalizePluginsConfig({ enabled: false }),
      }),
    ).toBe(false);
  });
});
