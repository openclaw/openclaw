import { afterEach, describe, expect, it, vi } from "vitest";
import { hasExpectedPluginUninstallConfigState } from "../../scripts/e2e/lib/plugin-uninstall-assertions.mjs";

describe("plugin uninstall assertions", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts an absent legacy plugin entry but rejects every present falsy residue", () => {
    vi.stubEnv("OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS", "1");

    expect(hasExpectedPluginUninstallConfigState({ plugins: { entries: {} } }, "fixture")).toBe(
      true,
    );
    for (const entry of [null, false, 0, ""]) {
      expect(
        hasExpectedPluginUninstallConfigState(
          { plugins: { entries: { fixture: entry } } },
          "fixture",
        ),
      ).toBe(false);
    }
  });
});
