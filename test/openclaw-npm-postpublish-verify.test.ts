import { describe, expect, it } from "vitest";
import {
  buildPublishedInstallScenarios,
  collectInstalledPackageErrors,
} from "../scripts/openclaw-npm-postpublish-verify.ts";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "../src/plugins/public-artifacts.ts";

describe("buildPublishedInstallScenarios", () => {
  it("uses a single fresh scenario for plain stable releases", () => {
    expect(buildPublishedInstallScenarios("2026.3.23")).toEqual([
      {
        name: "fresh-exact",
        installSpecs: ["openclaw@2026.3.23"],
        expectedVersion: "2026.3.23",
      },
    ]);
  });

  it("adds a stable-to-correction upgrade scenario for correction releases", () => {
    expect(buildPublishedInstallScenarios("2026.3.23-2")).toEqual([
      {
        name: "fresh-exact",
        installSpecs: ["openclaw@2026.3.23-2"],
        expectedVersion: "2026.3.23-2",
      },
      {
        name: "upgrade-from-base-stable",
        installSpecs: ["openclaw@2026.3.23", "openclaw@2026.3.23-2"],
        expectedVersion: "2026.3.23-2",
      },
    ]);
  });
});

describe("collectInstalledPackageErrors", () => {
  it("flags version mismatches and missing runtime sidecars", () => {
    const errors = collectInstalledPackageErrors({
      expectedVersion: "2026.3.23-2",
      installedVersion: "2026.3.23",
      packageRoot: "/tmp/empty-openclaw",
    });

    expect(errors[0]).toBe(
      "installed package version mismatch: expected 2026.3.23-2, found 2026.3.23.",
    );
    expect(errors).toEqual(
      expect.arrayContaining(
        BUNDLED_RUNTIME_SIDECAR_PATHS.map(
          (relativePath) =>
            `installed package is missing required bundled runtime sidecar: ${relativePath}`,
        ),
      ),
    );
    expect(errors.length).toBeGreaterThanOrEqual(1 + BUNDLED_RUNTIME_SIDECAR_PATHS.length);
  });
});
