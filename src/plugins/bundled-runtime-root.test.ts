import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __testing } from "./bundled-runtime-root.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-runtime-root-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("bundled runtime root plugin-sdk alias", () => {
  it("refreshes aliases without deleting the shared alias directory", () => {
    const distRoot = makeTempDir();
    const pluginSdkDir = path.join(distRoot, "plugin-sdk");
    const aliasDir = path.join(distRoot, "extensions", "node_modules", "openclaw", "plugin-sdk");
    fs.mkdirSync(pluginSdkDir, { recursive: true });
    fs.mkdirSync(aliasDir, { recursive: true });
    fs.writeFileSync(path.join(pluginSdkDir, "index.js"), "export const value = 1;\n", "utf8");
    fs.writeFileSync(path.join(pluginSdkDir, "core.js"), "export const core = 1;\n", "utf8");
    fs.writeFileSync(path.join(aliasDir, "sentinel.txt"), "keep\n", "utf8");

    __testing.ensureOpenClawPluginSdkAlias(distRoot);
    fs.writeFileSync(path.join(pluginSdkDir, "core.js"), "export const core = 2;\n", "utf8");
    __testing.ensureOpenClawPluginSdkAlias(distRoot);

    expect(fs.existsSync(path.join(aliasDir, "sentinel.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(aliasDir, "core.js"), "utf8")).toContain("core.js");
  });

  it("replaces a non-directory alias path before writing wrappers", () => {
    const distRoot = makeTempDir();
    const pluginSdkDir = path.join(distRoot, "plugin-sdk");
    const aliasDir = path.join(distRoot, "extensions", "node_modules", "openclaw", "plugin-sdk");
    fs.mkdirSync(pluginSdkDir, { recursive: true });
    fs.mkdirSync(path.dirname(aliasDir), { recursive: true });
    fs.writeFileSync(path.join(pluginSdkDir, "index.js"), "export const value = 1;\n", "utf8");
    fs.writeFileSync(aliasDir, "not a directory\n", "utf8");

    __testing.ensureOpenClawPluginSdkAlias(distRoot);

    expect(fs.statSync(aliasDir).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(aliasDir, "index.js"), "utf8")).toContain("index.js");
  });
});
