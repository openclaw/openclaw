import type { OpenClawConfig } from "../config/types.openclaw.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { loadBundledPluginPublicSurfaceModuleSyncCore } from "../plugin-sdk/facade-loader.js";

type BrowserDoctorSurface = {
  collectBrowserReadinessFindings: (cfg: OpenClawConfig) => Promise<readonly HealthFinding[]>;
};

export async function collectBrowserReadinessFindings(
  cfg: OpenClawConfig,
): Promise<readonly HealthFinding[]> {
  try {
    const surface = loadBundledPluginPublicSurfaceModuleSyncCore<BrowserDoctorSurface>({
      dirName: "browser",
      artifactBasename: "browser-doctor.js",
    });
    return await surface.collectBrowserReadinessFindings(cfg);
  } catch (error) {
    return [
      {
        checkId: "core/doctor/browser",
        severity: "warning",
        category: "fix-now",
        message: `Doctor could not inspect browser readiness: ${scrubDoctorErrorMessage(error)}`,
        fixHint:
          "Check that the bundled browser plugin is installed and enabled, then rerun openclaw doctor. This check has not established browser readiness.",
        docsUrl: "https://docs.openclaw.ai/tools/browser/troubleshooting",
      },
    ];
  }
}
