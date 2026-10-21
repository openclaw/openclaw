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
  it("distinguishes bundled owners", () => {
    expect(isBundledManifestOwner({ origin: "bundled" })).toBe(true);
    expect(isBundledManifestOwner({ origin: "workspace" })).toBe(false);
  });

  const policies: Array<
    [string, boolean, string[], ReturnType<typeof resolveManifestOwnerBasePolicyBlock>]
  > = [
    ["demo", false, ["demo"], null],
    ["blocked", false, ["demo"], "blocked-by-denylist"],
    ["disabled", false, ["demo"], "plugin-disabled"],
    ["disabled", false, ["disabled"], "plugin-disabled"],
    ["other", false, ["demo"], "not-in-allowlist"],
    ["other", true, ["demo"], null],
    ["blocked", true, ["demo"], "blocked-by-denylist"],
    ["disabled", true, ["demo"], "plugin-disabled"],
  ];
  it("keeps base-policy decisions and block reasons consistent, including allowlist bypasses", () => {
    for (const [id, bypass, allow, reason] of policies) {
      const params = {
        plugin: { id },
        normalizedConfig: normalizePluginsConfig({
          enabled: true,
          allow,
          deny: ["blocked"],
          entries: { disabled: { enabled: false } },
        }),
        allowRestrictiveAllowlistBypass: bypass,
      };
      expect(resolveManifestOwnerBasePolicyBlock(params)).toBe(reason);
      expect(passesManifestOwnerBasePolicy(params)).toBe(reason === null);
    }
  });

  it("detects explicit trust", () => {
    const trusted = (config: Parameters<typeof normalizePluginsConfig>[0]) =>
      hasExplicitManifestOwnerTrust({
        plugin: { id: "demo" },
        normalizedConfig: normalizePluginsConfig(config),
      });
    expect(trusted({ allow: ["demo"] })).toBe(true);
    expect(trusted({ entries: { demo: { enabled: true } } })).toBe(true);
    expect(trusted({})).toBe(false);
  });

  it.each([true, false])("resolves bundled default activation when enabled=%s", (enabled) => {
    expect(
      isActivatedManifestOwner({
        plugin: { id: "demo", origin: "bundled", enabledByDefault: true },
        normalizedConfig: normalizePluginsConfig(enabled ? {} : { enabled: false }),
      }),
    ).toBe(enabled);
  });
});
