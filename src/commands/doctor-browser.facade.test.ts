import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectBrowserReadinessFindings } from "./doctor-browser.js";

const loadBundledPluginPublicSurfaceModuleSyncCore = vi.hoisted(() => vi.fn());

vi.mock("../plugin-sdk/facade-loader.js", () => ({
  loadBundledPluginPublicSurfaceModuleSyncCore,
}));

describe("doctor browser facade", () => {
  beforeEach(() => {
    loadBundledPluginPublicSurfaceModuleSyncCore.mockReset();
  });

  it("delegates browser readiness checks to the browser facade surface", async () => {
    const findings = [
      {
        checkId: "core/doctor/browser",
        severity: "warning",
        category: "recommended",
        message: "Optional setup",
        fixHint: "Inspect setup",
      },
    ] as const;
    const delegate = vi.fn().mockResolvedValue(findings);
    loadBundledPluginPublicSurfaceModuleSyncCore.mockReturnValue({
      collectBrowserReadinessFindings: delegate,
    });

    const cfg: OpenClawConfig = {
      browser: {
        defaultProfile: "user",
      },
    };

    expect(await collectBrowserReadinessFindings(cfg)).toBe(findings);

    expect(loadBundledPluginPublicSurfaceModuleSyncCore).toHaveBeenCalledWith({
      dirName: "browser",
      artifactBasename: "browser-doctor.js",
    });
    expect(delegate).toHaveBeenCalledWith(cfg);
  });

  it("reports an inspection gap when the browser doctor surface is unavailable", async () => {
    loadBundledPluginPublicSurfaceModuleSyncCore.mockImplementation(() => {
      throw new Error("missing browser doctor facade");
    });

    await expect(collectBrowserReadinessFindings({})).resolves.toEqual([
      expect.objectContaining({
        category: "fix-now",
        message: "Doctor could not inspect browser readiness: missing browser doctor facade",
        fixHint: expect.stringContaining("rerun openclaw doctor"),
      }),
    ]);
  });
});
