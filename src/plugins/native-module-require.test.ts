import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isJavaScriptModulePath,
  tryNativeRequireJavaScriptModule,
  withNativeRequireAliases,
} from "./native-module-require.js";

const tempDirs: string[] = [];
const testRequire = createRequire(import.meta.url);

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-native-require-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("tryNativeRequireJavaScriptModule", () => {
  it("loads native CommonJS modules", () => {
    const dir = makeTempDir();
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(modulePath, 'module.exports = { marker: "native" };\n', "utf8");

    const result = tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true });

    expect(result).toEqual({ ok: true, moduleExport: { marker: "native" } });
  });

  it("declines modules that need source-transform fallback", () => {
    const dir = makeTempDir();
    const modulePath = path.join(dir, "plugin.mjs");
    fs.writeFileSync(
      modulePath,
      'await Promise.resolve();\nexport const marker = "esm";\n',
      "utf8",
    );

    expect(tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true })).toEqual({
      ok: false,
    });
  });

  it("declines missing target modules so callers can try source fallback", () => {
    const modulePath = path.join(makeTempDir(), "missing.cjs");

    expect(tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true })).toEqual({
      ok: false,
    });
  });

  it("propagates missing dependency errors from existing modules", () => {
    const dir = makeTempDir();
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(modulePath, 'require("./missing-dependency.cjs");\n', "utf8");

    expect(() => tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true })).toThrow(
      "missing-dependency.cjs",
    );
  });

  it("declines missing dependency errors when source-transform fallback is available", () => {
    const dir = makeTempDir();
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(modulePath, 'require("openclaw/plugin-sdk");\n', "utf8");

    expect(
      tryNativeRequireJavaScriptModule(modulePath, {
        allowWindows: true,
        fallbackOnMissingDependency: true,
      }),
    ).toEqual({ ok: false });
  });

  it("declines missing dependency errors when the caller can use source transform fallback", () => {
    const dir = makeTempDir();
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(modulePath, 'require("./helper.js");\n', "utf8");
    fs.writeFileSync(path.join(dir, "helper.ts"), "export const loaded = true;\n", "utf8");

    expect(
      tryNativeRequireJavaScriptModule(modulePath, {
        allowWindows: true,
        fallbackOnNativeError: true,
      }),
    ).toEqual({ ok: false });
  });

  it("propagates real module evaluation errors instead of falling back", () => {
    const dir = makeTempDir();
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(
      modulePath,
      'throw new Error("plugin exploded during native load");\n',
      "utf8",
    );

    expect(() => tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true })).toThrow(
      "plugin exploded during native load",
    );
  });

  it("declines real module evaluation errors when the caller can use source transform fallback", () => {
    const dir = makeTempDir();
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(
      modulePath,
      'throw new Error("plugin exploded during native load");\n',
      "utf8",
    );

    expect(
      tryNativeRequireJavaScriptModule(modulePath, {
        allowWindows: true,
        fallbackOnNativeError: true,
      }),
    ).toEqual({ ok: false });
  });

  it("resolves alias subpaths relative to file-valued alias targets", () => {
    const dir = makeTempDir();
    const pluginSdkDir = path.join(dir, "plugin-sdk");
    fs.mkdirSync(pluginSdkDir, { recursive: true });
    const modulePath = path.join(dir, "plugin.cjs");
    const rootAliasPath = path.join(pluginSdkDir, "root-alias.cjs");
    fs.writeFileSync(rootAliasPath, "module.exports = {};\n", "utf8");
    fs.writeFileSync(
      path.join(pluginSdkDir, "agent-harness-task-runtime.js"),
      'module.exports = { marker: "task-runtime" };\n',
      "utf8",
    );
    fs.writeFileSync(
      modulePath,
      'module.exports = require("openclaw/plugin-sdk/agent-harness-task-runtime");\n',
      "utf8",
    );

    const result = tryNativeRequireJavaScriptModule(modulePath, {
      allowWindows: true,
      aliasMap: {
        "openclaw/plugin-sdk": rootAliasPath,
      },
    });

    expect(result).toEqual({ ok: true, moduleExport: { marker: "task-runtime" } });
  });

  it("uses the longest alias prefix when resolving native require subpaths", () => {
    const dir = makeTempDir();
    const shortAliasDir = path.join(dir, "short");
    const longAliasDir = path.join(dir, "long");
    fs.mkdirSync(path.join(shortAliasDir, "nested"), { recursive: true });
    fs.mkdirSync(longAliasDir, { recursive: true });
    fs.writeFileSync(
      path.join(shortAliasDir, "nested", "runtime.js"),
      'module.exports = { marker: "short" };\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(longAliasDir, "runtime.js"),
      'module.exports = { marker: "long" };\n',
      "utf8",
    );

    const loaded = withNativeRequireAliases(
      {
        "openclaw/plugin-sdk": shortAliasDir,
        "openclaw/plugin-sdk/nested": longAliasDir,
      },
      () => testRequire("openclaw/plugin-sdk/nested/runtime"),
    );

    expect(loaded).toEqual({ marker: "long" });
  });

  it("falls back to the original resolver when a prefix alias cannot resolve the subpath", () => {
    const dir = makeTempDir();
    const pluginSdkDir = path.join(dir, "plugin-sdk");
    fs.mkdirSync(pluginSdkDir, { recursive: true });
    const modulePath = path.join(dir, "plugin.cjs");
    const rootAliasPath = path.join(pluginSdkDir, "root-alias.cjs");
    fs.writeFileSync(rootAliasPath, "module.exports = {};\n", "utf8");
    fs.writeFileSync(
      modulePath,
      'module.exports = require("openclaw/plugin-sdk/missing-runtime");\n',
      "utf8",
    );

    expect(
      tryNativeRequireJavaScriptModule(modulePath, {
        allowWindows: true,
        aliasMap: {
          "openclaw/plugin-sdk": rootAliasPath,
        },
        fallbackOnMissingDependency: true,
      }),
    ).toEqual({ ok: false });
  });
});

describe("isJavaScriptModulePath", () => {
  it("only accepts JavaScript runtime extensions", () => {
    expect(isJavaScriptModulePath("/plugin/index.js")).toBe(true);
    expect(isJavaScriptModulePath("/plugin/index.mjs")).toBe(true);
    expect(isJavaScriptModulePath("/plugin/index.cjs")).toBe(true);
    expect(isJavaScriptModulePath("/plugin/index.ts")).toBe(false);
  });
});
