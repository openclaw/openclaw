// Covers Gateway startup planning for manifestless files listed in plugins.load.paths.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadGatewayStartupPluginPlan } from "./gateway-startup-plugin-ids.js";
import { getPluginLoaderCacheState } from "./registry-lifecycle.js";

describe("gateway startup plan for standalone plugin files", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    getPluginLoaderCacheState().clear();
    vi.unstubAllEnvs();
  });

  it.each([
    { name: "allowlist", plugins: { allow: ["maintenance-access"] }, starts: true },
    {
      name: "enabled entry",
      plugins: { entries: { "maintenance-access": { enabled: true } } },
      starts: true,
    },
    { name: "load path only", plugins: {}, starts: false },
    {
      name: "disabled entry",
      plugins: {
        allow: ["maintenance-access"],
        entries: { "maintenance-access": { enabled: false } },
      },
      starts: false,
    },
  ])("plans a configured file selected by $name: $starts", ({ plugins, starts }) => {
    const root = tempDirs.make("openclaw-standalone-startup-");
    vi.stubEnv("OPENCLAW_HOME", root);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    const env = { ...process.env };
    const source = path.join(root, "maintenance-access.cjs");
    writeFileSync(source, `module.exports = { id: "maintenance-access", register() {} };`);
    const config = {
      plugins: { ...plugins, load: { paths: [source] }, slots: { memory: "none" } },
    } as OpenClawConfig;

    const plan = loadGatewayStartupPluginPlan({ config, env, workspaceDir: root });

    expect(plan.pluginIds.includes("maintenance-access")).toBe(starts);
  });
});
