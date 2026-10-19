import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  maybeRepairOwnedChromeExtensionNativeHosts,
  noteChromeMcpBrowserReadiness,
} from "./doctor-browser.js";

const loadBundledPluginPublicSurfaceModuleSyncCore = vi.hoisted(() => vi.fn());

vi.mock("../plugin-sdk/facade-loader.js", () => ({
  loadBundledPluginPublicSurfaceModuleSyncCore,
}));

describe("doctor browser facade", () => {
  beforeEach(() => {
    loadBundledPluginPublicSurfaceModuleSyncCore.mockReset();
  });

  it("delegates browser readiness checks to the browser facade surface", async () => {
    const delegate = vi.fn().mockResolvedValue(undefined);
    loadBundledPluginPublicSurfaceModuleSyncCore.mockReturnValue({
      noteChromeMcpBrowserReadiness: delegate,
    });

    const cfg: OpenClawConfig = {
      browser: {
        defaultProfile: "user",
      },
    };
    const noteFn = vi.fn();

    await noteChromeMcpBrowserReadiness(cfg, { noteFn });

    expect(loadBundledPluginPublicSurfaceModuleSyncCore).toHaveBeenCalledWith({
      dirName: "browser",
      artifactBasename: "browser-doctor.js",
    });
    expect(delegate).toHaveBeenCalledWith(cfg, { noteFn });
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("delegates owned Chrome native-host repair to the browser facade surface", async () => {
    const repair = vi.fn().mockResolvedValue({ changes: ["repaired"], warnings: [] });
    loadBundledPluginPublicSurfaceModuleSyncCore.mockReturnValue({
      noteChromeMcpBrowserReadiness: vi.fn(),
      maybeRepairOwnedChromeExtensionNativeHosts: repair,
    });

    await expect(maybeRepairOwnedChromeExtensionNativeHosts()).resolves.toEqual({
      changes: ["repaired"],
      warnings: [],
    });
    expect(repair).toHaveBeenCalledOnce();
  });

  it("warns and no-ops when the browser doctor surface is unavailable", async () => {
    loadBundledPluginPublicSurfaceModuleSyncCore.mockImplementation(() => {
      throw new Error("missing browser doctor facade");
    });

    const noteFn = vi.fn();

    await expect(noteChromeMcpBrowserReadiness({}, { noteFn })).resolves.toBeUndefined();
    expect(noteFn).toHaveBeenCalledExactlyOnceWith(
      "- Browser health check is unavailable: missing browser doctor facade",
      "Browser",
    );
  });
});
