import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("telegram bundled plugin loader", () => {
  it("loads the telegram channel plugin entry without recursive facade overflow", () => {
    const childCode = [
      'const path = require("node:path");',
      'const { createJiti } = require("jiti");',
      'const jiti = createJiti(path.join(process.cwd(), "debug-probe.cjs"));',
      'const { loadBundledPluginPublicSurfaceSync } = jiti("./src/test-utils/bundled-plugin-public-surface.ts");',
      'const mod = loadBundledPluginPublicSurfaceSync({ pluginId: "telegram", artifactBasename: "index.js" });',
      'console.log(mod?.default?.id ?? "missing-id");',
    ].join("\n");

    const result = spawnSync(process.execPath, ["-e", childCode], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Maximum call stack size exceeded");
    expect(result.stdout.trim()).toBe("telegram");
  });
});
