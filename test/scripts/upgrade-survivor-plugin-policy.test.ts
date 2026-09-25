import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  assertInactivePluginRuntimes,
  assertSolePluginPolicy,
} from "../../scripts/e2e/lib/upgrade-survivor/legacy-operator-plugin-policy.mjs";

const hooks = { enabled: true, path: "/survivor-hooks", token: "synthetic-survivor-hook-token" };
const specimen = { hooks };

describe("sole-plugin upgrade acceptance", () => {
  it.each(["2026.9.3", "2026.9.4"])(
    "leaves the %s historical migration cell with its existing owner",
    (baseline) => {
      const result = spawnSync(
        "bash",
        [
          "-c",
          'set -euo pipefail; source scripts/e2e/lib/upgrade-survivor/legacy-operator-plugin-policy.sh; ARTIFACT_ROOT=unused; RUNTIME_ROOT=unused; npm_config_prefix=unused; baseline_version="$1"; node() { return 97; }; legacy_operator_plugin_policy verify',
          "policy-cell",
          baseline,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
  );

  it("requires the global disable decision after the sole allowed plugin retires", () => {
    expect(() =>
      assertSolePluginPolicy({ plugins: { enabled: false }, hooks }, specimen),
    ).not.toThrow();
    for (const enabled of [true, undefined]) {
      expect(() =>
        assertSolePluginPolicy({ plugins: { enabled, allow: [] }, hooks }, specimen),
      ).toThrow("retiring the sole allowed plugin enabled other plugins");
    }
  });

  it("rejects a retained retired reference or a changed core-hook configuration", () => {
    for (const retained of [
      { entries: { webhooks: { enabled: true } } },
      { allow: ["webhooks"] },
      { deny: ["webhooks"] },
    ]) {
      expect(() =>
        assertSolePluginPolicy({ plugins: { enabled: false, ...retained }, hooks }, specimen),
      ).toThrow("retired");
    }
    expect(() =>
      assertSolePluginPolicy(
        { plugins: { enabled: false }, hooks: { ...hooks, enabled: false } },
        specimen,
      ),
    ).toThrow("ordinary hooks changed");
  });

  it("requires real surviving runtime inventory and rejects activated plugins", () => {
    const disabled = { id: "device-pair", runtime: { state: "disabled" } };
    expect(() => assertInactivePluginRuntimes({ plugins: [disabled] })).not.toThrow();
    expect(() => assertInactivePluginRuntimes({ plugins: [] })).toThrow("lacks surviving plugin");
    for (const state of ["active", "service-failed", undefined]) {
      expect(() =>
        assertInactivePluginRuntimes({ plugins: [{ ...disabled, runtime: { state } }] }),
      ).toThrow("candidate activated plugin");
    }
    expect(() =>
      assertInactivePluginRuntimes({
        plugins: [disabled, { id: "webhooks", runtime: { state: "disabled" } }],
      }),
    ).toThrow("still discovers Webhooks");
  });
});
