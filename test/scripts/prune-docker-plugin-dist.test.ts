// Prune Docker Plugin Dist tests cover prune docker plugin dist script behavior.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pruneDockerPluginDist } from "../../scripts/prune-docker-plugin-dist.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("pruneDockerPluginDist", () => {
  it("keeps the staged host SDK alias while pruning omitted plugins", () => {
    const rootDir = createTempDir("openclaw-prune-docker-dist-alias-");
    const writeJson = (relativePath: string, value: unknown) => {
      const absolutePath = path.join(rootDir, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, `${JSON.stringify(value)}\n`);
    };
    const writeFile = (relativePath: string, contents: string) => {
      const absolutePath = path.join(rootDir, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, contents);
    };
    writeJson("package.json", {
      name: "openclaw",
      files: [
        "!dist/extensions/node_modules/**",
        "!dist/extensions/codex/**",
        "!dist/extensions/omitted/**",
      ],
    });
    writeJson("extensions/codex/package.json", { name: "@openclaw/codex" });
    writeJson("extensions/omitted/package.json", { name: "@openclaw/omitted" });
    writeJson("dist/extensions/node_modules/openclaw/package.json", {
      name: "openclaw",
      type: "module",
    });
    writeFile(
      "dist/extensions/node_modules/openclaw/plugin-sdk/process-runtime.js",
      "export {};\n",
    );
    writeFile("dist/extensions/codex/index.js", "export {};\n");
    writeFile("dist/extensions/omitted/index.js", "export {};\n");
    writeFile("dist-runtime/extensions/omitted/index.js", "export {};\n");

    const removed = pruneDockerPluginDist({
      cwd: rootDir,
      env: { OPENCLAW_EXTENSIONS: "codex", OPENCLAW_BUNDLED_PLUGIN_DIR: "extensions" },
    });

    expect(removed).toContain("dist/extensions/omitted");
    expect(removed.some((entry) => entry.includes("node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, "dist/extensions/node_modules/openclaw"))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, "dist/extensions/codex"))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, "dist/extensions/omitted"))).toBe(false);
  });

  it("refuses to prune plugin trees through a symlinked dist root", () => {
    const rootDir = createTempDir("openclaw-prune-docker-dist-symlink-");
    const targetDir = path.join(rootDir, "gateway-dist");
    const pluginFile = path.join(targetDir, "extensions", "telegram", "index.js");
    fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
    fs.writeFileSync(pluginFile, "export {};\n");
    const distLink = path.join(rootDir, "dist");
    fs.symlinkSync(targetDir, distLink, "dir");

    expect(() => pruneDockerPluginDist({ cwd: rootDir, env: {} })).toThrow(/symbolic link/u);

    expect(fs.readlinkSync(distLink)).toBe(targetDir);
    expect(fs.readFileSync(pluginFile, "utf8")).toBe("export {};\n");
  });
});
