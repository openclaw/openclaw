import { describe, expect, it } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveImmutableInstallIdentity } from "./candidate-install-owner.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

const installed: PluginInstallRecord = {
  source: "npm",
  installPath: "/state/extensions/fixture",
  resolvedSpec: "fixture@1.0.0",
  integrity: "sha512-fixture",
  installedAt: "2026-10-20T00:00:00.000Z",
};

describe("immutable installation code identity", () => {
  it("excludes editable sources, missing integrity, and unowned candidates", () => {
    for (const origin of ["bundled", "workspace", "config"] satisfies PluginOrigin[]) {
      expect(
        resolveImmutableInstallIdentity(origin, "fixture", { fixture: installed }),
      ).toBeUndefined();
    }
    for (const source of [
      "archive",
      "path",
      "git",
      "clawhub",
      "marketplace",
    ] satisfies PluginInstallRecord["source"][]) {
      expect(
        resolveImmutableInstallIdentity("global", "fixture", {
          fixture: { ...installed, source },
        }),
      ).toBeUndefined();
    }
    expect(
      resolveImmutableInstallIdentity("global", undefined, { fixture: installed }),
    ).toBeUndefined();
    expect(resolveImmutableInstallIdentity("global", "fixture", {})).toBeUndefined();
    expect(
      resolveImmutableInstallIdentity("global", "fixture", {
        fixture: { ...installed, integrity: undefined },
      }),
    ).toBeUndefined();
  });

  it("changes identity on install replacement, path, package, or owner changes", () => {
    const identity = resolveImmutableInstallIdentity("global", "fixture", { fixture: installed });
    expect(identity).toBeDefined();
    expect(
      resolveImmutableInstallIdentity("global", "fixture", { fixture: { ...installed } }),
    ).toBe(identity);
    const replacements: PluginInstallRecord[] = [
      { ...installed, integrity: "sha512-replacement" },
      { ...installed, installedAt: "2026-10-20T01:00:00.000Z" },
      { ...installed, resolvedSpec: "fixture@2.0.0" },
      { ...installed, installPath: "/other/extensions/fixture" },
    ];
    for (const replacement of replacements) {
      expect(
        resolveImmutableInstallIdentity("global", "fixture", { fixture: replacement }),
      ).not.toBe(identity);
    }
    expect(resolveImmutableInstallIdentity("global", "other", { other: installed })).not.toBe(
      identity,
    );
  });
});
