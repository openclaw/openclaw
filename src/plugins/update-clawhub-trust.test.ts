import { afterEach, expect, it, vi } from "vitest";
import { singleInstallConfig, withPluginState } from "./update-authority.test-support.js";
import { updateNpmInstalledPlugins } from "./update-installed.js";

const install = vi.hoisted(() => vi.fn());
vi.mock("./clawhub.js", async (original) => ({
  ...(await original<typeof import("./clawhub.js")>()),
  installPluginFromClawHub: install,
}));
afterEach(() => {
  vi.clearAllMocks();
});

it.each([
  ["blocked downgrade", "clawhub_download_blocked", "1.2.3", "1.2.2", false, "skipped"],
  ["blocked absent target", "clawhub_download_blocked", "1.2.3", undefined, false, "error"],
  ["blocked empty target", "clawhub_download_blocked", "1.2.3", "", false, "error"],
  ["blocked absent install", "clawhub_download_blocked", undefined, "1.2.4", false, "error"],
  [
    "unavailable absent install",
    "clawhub_security_unavailable",
    undefined,
    undefined,
    false,
    "error",
  ],
  ["unavailable empty install", "clawhub_security_unavailable", "", undefined, false, "error"],
  ["dry-run unavailable", "clawhub_security_unavailable", "1.2.3", undefined, true, "skipped"],
] as const)(
  "preserves installed ClawHub trust boundaries: %s",
  async (_scenario, code, currentVersion, version, dryRun, status) => {
    await withPluginState("clawhub-update-trust", async (state) => {
      await state.writeJson("extensions/demo/package.json", {
        name: "demo",
        version: currentVersion,
      });
      const config = singleInstallConfig("demo", {
        source: "clawhub",
        spec: "clawhub:demo",
        installPath: state.statePath("extensions", "demo"),
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
      });
      install.mockResolvedValue({ ok: false, code, error: "release trust check failed", version });

      const result = await updateNpmInstalledPlugins({ config, pluginIds: ["demo"], dryRun });

      expect(install).toHaveBeenCalledOnce();
      expect(result.changed).toBe(false);
      expect(result.config).toBe(config);
      expect(result.outcomes).toEqual([
        expect.objectContaining({ pluginId: "demo", status, code }),
      ]);
      if (dryRun) {
        expect(result.outcomes[0]?.message).toBe(
          "Skipped demo ClawHub check: release trust check failed Existing installed plugin left unchanged.",
        );
      }
    });
  },
);
