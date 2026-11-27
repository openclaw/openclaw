import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { updateNpmInstalledPlugins } from "./update-installed.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: vi.fn(async () => ({
    code: 1,
    stdout: "",
    stderr: "E404 No matching version",
  })),
}));

it.each([
  { processVersion: "2026.9.2", coreVersion: "2026.9.4", retained: true },
  { processVersion: "2026.9.4", coreVersion: "2026.9.2", retained: false },
])(
  "checks legacy retention against target $coreVersion rather than process $processVersion",
  async ({ processVersion, coreVersion, retained }) => {
    vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", processVersion);
    const installPath = tempDirs.make("plugin-compat-retention-");
    const entry = "export default function register() {}\n";
    fs.writeFileSync(path.join(installPath, "index.js"), entry);
    fs.writeFileSync(
      path.join(installPath, "package.json"),
      JSON.stringify({
        name: "@acme/demo",
        version: "1.0.0",
        openclaw: {
          extensions: ["./index.js"],
          install: { minHostVersion: "2026.9.3" },
          compat: { pluginApi: ">=2026.9.3" },
        },
      }),
    );
    const config: OpenClawConfig = {
      plugins: {
        installs: {
          demo: {
            source: "npm",
            spec: "@acme/demo@2.0.0",
            installPath,
            version: "1.0.0",
          },
        },
        allow: ["demo"],
        entries: { demo: { enabled: true, config: { preserved: true } } },
      },
    };
    const warn = vi.fn();

    const result = await updateNpmInstalledPlugins({
      config,
      pluginIds: ["demo"],
      retainOnUnavailable: true,
      syncOfficialPluginInstalls: true,
      updateChannel: "stable",
      coreVersion,
      logger: { warn },
    });

    expect(result.outcomes).toEqual([
      expect.objectContaining({
        pluginId: "demo",
        status: retained ? "unchanged" : "error",
        code: retained ? "plugin-target-unavailable" : "npm_package_not_found",
      }),
    ]);
    if (retained) {
      expect(result.outcomes[0]?.message).toContain(coreVersion);
      expect(result.outcomes[0]?.message).toContain("openclaw plugins update demo");
      expect(warn).toHaveBeenCalledWith(result.outcomes[0]?.message);
    }
    expect(result.config).toBe(config);
    expect(result.changed).toBe(false);
    expect(fs.readFileSync(path.join(installPath, "index.js"), "utf8")).toBe(entry);
  },
);
