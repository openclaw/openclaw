import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { syncPluginVersions } from "../../scripts/sync-plugin-versions.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { shouldSkipIncompatiblePackagePluginApi } from "../plugins/discovery-availability.js";
import { validateOpenClawPackageInstallCompatibility } from "../plugins/install-shared.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../plugins/install-types.js";
import type { PluginDiagnostic } from "../plugins/manifest-types.js";
import { checkMinHostVersion } from "../plugins/min-host-version.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("release-aligns the actual Nextcloud manifest before plugin-first publication", () => {
  const root = tempDirs.make("nextcloud-release-compat-");
  const packageDir = path.join(root, "extensions/nextcloud-talk");
  fs.mkdirSync(packageDir, { recursive: true });
  const original = JSON.parse(
    fs.readFileSync(
      new URL("../../extensions/nextcloud-talk/package.json", import.meta.url),
      "utf8",
    ),
  );
  // Synthetic versions exercise release ordering, not a promised publication version.
  const releaseVersion = "9999.1.2";
  const oldHostVersion = "9999.1.1";
  const packagePath = path.join(packageDir, "package.json");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: releaseVersion }),
  );
  fs.writeFileSync(packagePath, JSON.stringify(original));
  expect(syncPluginVersions(root).updated).toContain("@openclaw/nextcloud-talk");
  const aligned = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  expect(aligned.openclaw.install.minHostVersion).toBe(original.openclaw.install.minHostVersion);
  expect(aligned.openclaw.compat.pluginApi).toBe(`>=${releaseVersion}`);
  expect(aligned.openclaw.build.openclawVersion).toBe(releaseVersion);

  for (const hostVersion of [oldHostVersion, releaseVersion]) {
    const compatible = hostVersion === releaseVersion;
    const result = validateOpenClawPackageInstallCompatibility({
      runtime: { checkMinHostVersion, resolveCompatibilityHostVersion: () => hostVersion },
      pluginId: "nextcloud-talk",
      packageMetadata: aligned.openclaw,
    });
    if (compatible) {
      expect(result).toBeNull();
    } else {
      expect(result).toMatchObject({
        ok: false,
        code: PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API,
      });
    }
    const diagnostics: PluginDiagnostic[] = [];
    expect(
      shouldSkipIncompatiblePackagePluginApi({
        origin: "global",
        packageManifest: aligned.openclaw,
        pluginId: "nextcloud-talk",
        packageDir,
        env: { OPENCLAW_COMPATIBILITY_HOST_VERSION: hostVersion },
        diagnostics,
      }),
    ).toBe(!compatible);
    if (compatible) {
      expect(diagnostics).toEqual([]);
    } else {
      expect(diagnostics).toEqual([
        expect.objectContaining({
          pluginId: "nextcloud-talk",
          configDisposition: "preserve",
          message: expect.stringContaining("skipping discovery"),
        }),
      ]);
    }
  }
});
