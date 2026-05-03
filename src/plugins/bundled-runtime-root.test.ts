import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { __testing, prepareBundledPluginRuntimeRoot } from "./bundled-runtime-root.js";

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

describe("bundled runtime root dist-runtime staging", () => {
  it("keeps dist-runtime wrappers outside the canonical dist mirror", async () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    const distPluginRoot = path.join(packageRoot, "dist", "extensions", "telegram");
    const distRuntimePluginRoot = path.join(packageRoot, "dist-runtime", "extensions", "telegram");
    fs.mkdirSync(distPluginRoot, { recursive: true });
    fs.mkdirSync(distRuntimePluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw", version: "2026.4.24", type: "module" }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(distPluginRoot, "package.json"),
      `${JSON.stringify({ name: "@openclaw/telegram", version: "1.0.0", type: "module" }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(distPluginRoot, "runtime-setter-api.js"),
      [
        `export const setTelegramRuntime = () => "ok";`,
        `export default { setTelegramRuntime };`,
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(distRuntimePluginRoot, "package.json"),
      `${JSON.stringify({ name: "@openclaw/telegram", version: "1.0.0", type: "module" }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(distRuntimePluginRoot, "runtime-setter-api.js"),
      [
        `export * from "../../../dist/extensions/telegram/runtime-setter-api.js";`,
        `import defaultModule from "../../../dist/extensions/telegram/runtime-setter-api.js";`,
        `export default defaultModule;`,
        "",
      ].join("\n"),
      "utf8",
    );

    const prepared = prepareBundledPluginRuntimeRoot({
      pluginId: "telegram",
      pluginRoot: distRuntimePluginRoot,
      modulePath: path.join(distRuntimePluginRoot, "runtime-setter-api.js"),
      env: { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
    });

    expect(prepared.pluginRoot).toContain(`${path.sep}dist-runtime${path.sep}extensions`);
    const canonicalMirrorModule = path.join(
      stageDir,
      fs.readdirSync(stageDir)[0] ?? "",
      "dist",
      "extensions",
      "telegram",
      "runtime-setter-api.js",
    );
    expect(fs.readFileSync(canonicalMirrorModule, "utf8")).toContain(
      `setTelegramRuntime = () => "ok"`,
    );

    const imported = (await import(
      `${pathToFileURL(prepared.modulePath).href}?t=${Date.now()}`
    )) as { setTelegramRuntime: () => string };
    expect(imported.setTelegramRuntime()).toBe("ok");
  });
});
