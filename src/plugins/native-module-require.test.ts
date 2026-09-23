/** Tests native module require behavior for plugin runtime loading. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  isJavaScriptModulePath,
  resolvePluginLoaderTryNative,
  tryNativeRequireJavaScriptModule,
} from "./native-module-require.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type NativeEsmGraphProbe = {
  status: number | null;
  stderr: string;
  stdout: string;
};
let nativeEsmGraphProbe: NativeEsmGraphProbe;

describe("tryNativeRequireJavaScriptModule", () => {
  it("loads native CommonJS modules", () => {
    const dir = tempDirs.make("openclaw-native-require-");
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(modulePath, 'module.exports = { marker: "native" };\n', "utf8");

    const result = tryNativeRequireJavaScriptModule(modulePath);

    expect(result).toEqual({ ok: true, moduleExport: { marker: "native" } });
  });

  it("uses source-transform fallback only when native TLA loading needs it", () => {
    const dir = tempDirs.make("openclaw-native-require-");
    const modulePath = path.join(dir, "plugin.mjs");
    fs.writeFileSync(
      modulePath,
      'await Promise.resolve();\nexport const marker = "esm";\n',
      "utf8",
    );

    const result = tryNativeRequireJavaScriptModule(modulePath);
    if (process.versions.bun) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.moduleExport).toMatchObject({ marker: "esm" });
      }
    } else {
      expect(result).toEqual({ ok: false });
    }
  });

  // Bun does not route module loads through Node's private Module._load hook.
  it.runIf(!process.versions.bun)(
    "declines an in-flight ESM require race for source-transform fallback",
    () => {
      const modulePath = path.join(tempDirs.make("openclaw-native-require-"), "plugin.cjs");
      fs.writeFileSync(modulePath, "module.exports = {};\n", "utf8");
      const error = Object.assign(new Error("ESM is still loading"), {
        code: "ERR_REQUIRE_ESM_RACE_CONDITION",
      });
      type ModuleLoad = (
        request: string,
        parent: NodeJS.Module | undefined,
        isMain: boolean,
      ) => unknown;
      const originalLoad = Reflect.get(Module, "_load") as ModuleLoad;
      Reflect.set(Module, "_load", () => {
        throw error;
      });

      try {
        expect(tryNativeRequireJavaScriptModule(modulePath)).toEqual({
          ok: false,
        });
      } finally {
        Reflect.set(Module, "_load", originalLoad);
      }
    },
  );

  it("declines missing target modules so callers can try source fallback", () => {
    const modulePath = path.join(tempDirs.make("openclaw-native-require-"), "missing.cjs");

    expect(tryNativeRequireJavaScriptModule(modulePath)).toEqual({
      ok: false,
    });
  });

  it("propagates missing dependency errors from existing modules", () => {
    const dir = tempDirs.make("openclaw-native-require-");
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(modulePath, 'require("./missing-dependency.cjs");\n', "utf8");

    expect(() => tryNativeRequireJavaScriptModule(modulePath)).toThrow("missing-dependency.cjs");
  });

  it("does not retry an existing module after a missing dependency error", () => {
    const dir = tempDirs.make("openclaw-native-require-");
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(modulePath, 'require("openclaw/plugin-sdk/core");\n', "utf8");

    expect(() =>
      tryNativeRequireJavaScriptModule(modulePath, {
        fallbackOnMissingDependency: true,
      }),
    ).toThrow("openclaw/plugin-sdk/core");
  });

  beforeAll(() => {
    const dir = tempDirs.make("openclaw-native-require-");
    const sdkPath = path.join(dir, "sdk.js");
    const modulePath = path.join(dir, "plugin.mjs");
    const probePath = path.join(dir, "probe.mjs");
    const nativeRequireModuleUrl = pathToFileURL(
      path.join(process.cwd(), "src", "plugins", "native-module-require.ts"),
    ).href;
    fs.writeFileSync(
      sdkPath,
      'export const defineChannelMessageAdapter = () => "adapter";\n',
      "utf8",
    );
    fs.writeFileSync(
      modulePath,
      'import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";\nexport const marker = defineChannelMessageAdapter();\n',
      "utf8",
    );
    fs.writeFileSync(
      probePath,
      [
        `import { tryNativeRequireJavaScriptModule } from ${JSON.stringify(nativeRequireModuleUrl)};`,
        `const result = tryNativeRequireJavaScriptModule(${JSON.stringify(modulePath)}, {`,
        `  aliasMap: { "openclaw/plugin-sdk/channel-outbound": ${JSON.stringify(sdkPath)} },`,
        "});",
        "if (!result.ok) {",
        '  throw new Error("native require declined ESM graph");',
        "}",
        "console.log(result.moduleExport.marker);",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(process.execPath, ["--import", "tsx", probePath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    nativeEsmGraphProbe = {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  });

  it("loads native ESM graphs with temporary SDK aliases", () => {
    expect(nativeEsmGraphProbe.stderr).toBe("");
    expect(nativeEsmGraphProbe.status).toBe(0);
    expect(nativeEsmGraphProbe.stdout.trim()).toBe("adapter");
  });

  it("uses the configured native loader for JavaScript-to-TypeScript lookup", () => {
    const dir = tempDirs.make("openclaw-native-require-");
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(modulePath, 'module.exports = require("./helper.js");\n', "utf8");
    fs.writeFileSync(path.join(dir, "helper.ts"), "export const loaded = true;\n", "utf8");

    const result = tryNativeRequireJavaScriptModule(modulePath);
    expect(result).toMatchObject({ ok: true, moduleExport: { loaded: true } });
  });

  it("propagates real module evaluation errors instead of falling back", () => {
    const dir = tempDirs.make("openclaw-native-require-");
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(
      modulePath,
      'throw new Error("plugin exploded during native load");\n',
      "utf8",
    );

    expect(() => tryNativeRequireJavaScriptModule(modulePath)).toThrow(
      "plugin exploded during native load",
    );
  });

  it("keeps native path and file-URL modules on the process module graph", async () => {
    const dir = tempDirs.make("openclaw-native-require-");
    const ownerPath = path.join(dir, "native-require.mjs");
    // tsx's CommonJS hook accepts file URLs and masks Node's native contract.
    await build({
      entryPoints: [path.resolve("src/plugins/native-module-require.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: ownerPath,
      logLevel: "silent",
    });
    const modulePath = path.join(dir, "space # percent% plugin.cjs");
    const probePath = path.join(dir, "probe.mjs");
    fs.writeFileSync(
      probePath,
      `import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { tryNativeRequireJavaScriptModule as load } from ${JSON.stringify(pathToFileURL(ownerPath).href)};
const modulePath = ${JSON.stringify(modulePath)};
for (const target of [modulePath, pathToFileURL(modulePath).href]) {
  fs.writeFileSync(modulePath, 'module.exports = { marker: "before" };\\n');
  assert.deepEqual(load(target), { ok: true, moduleExport: { marker: "before" } });
  fs.writeFileSync(modulePath, 'module.exports = { marker: "after" };\\n');
  assert.deepEqual(load(target), { ok: true, moduleExport: { marker: "before" } });
  assert.deepEqual(load(target), { ok: true, moduleExport: { marker: "before" } });
}
assert.deepEqual(load(pathToFileURL(modulePath + ".missing.cjs").href), { ok: false });
fs.writeFileSync(modulePath + ".broken.cjs", 'require("./missing-dependency.cjs");\\n');
assert.throws(() => load(pathToFileURL(modulePath + ".broken.cjs").href), /missing-dependency\\.cjs/);
console.log("native path + file URL process identity; missing target/dependency controls passed");
`,
    );
    const result = spawnSync(process.execPath, [probePath], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: "" },
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "native path + file URL process identity; missing target/dependency controls passed",
    );
  });

  // Bun's public resolver owns aliases; this case exercises Node's private _resolveFilename hook.
  it.runIf(!process.versions.bun)(
    "retains terminal ESM failures across eviction and alias changes until a new path loads",
    async () => {
      const dir = tempDirs.make("openclaw-native-failed-generation-");
      const ownerPath = path.join(dir, "native-require.mjs");
      await build({
        entryPoints: [path.resolve("src/plugins/native-module-require.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: ownerPath,
        logLevel: "silent",
      });
      const probePath = path.join(dir, "probe.mjs");
      fs.writeFileSync(
        probePath,
        `import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { tryNativeRequireJavaScriptModule as load } from ${JSON.stringify(pathToFileURL(ownerPath).href)};
const require = createRequire(import.meta.url);
const dir = ${JSON.stringify(dir)};
const brokenPath = path.join(dir, "broken.mjs");
const missingApi = path.join(dir, "missing-api.mjs");
const currentApi = path.join(dir, "current-api.mjs");
fs.writeFileSync(missingApi, "export const existing = 1;\\n");
fs.writeFileSync(currentApi, "export const required = 2;\\n");
const pluginSource = 'import { required } from "fixture-api"; export const value = required;\\n';
fs.writeFileSync(brokenPath, pluginSource);
const aliasDir = path.join(dir, "alias");
fs.symlinkSync(dir, aliasDir, process.platform === "win32" ? "junction" : "dir");
const options = { aliasMap: { "fixture-api": missingApi } };
let initial;
assert.throws(() => load(brokenPath, options), error => {
  initial = error;
  return error instanceof SyntaxError;
});
for (const target of [brokenPath, pathToFileURL(brokenPath).href, "./broken.mjs", path.join(aliasDir, "broken.mjs")]) {
  delete require.cache[require.resolve(brokenPath)];
  assert.throws(() => load(target, {
    ...options,
    aliasMap: { "fixture-api": currentApi },
  }), error => error === initial);
}
const newPath = path.join(dir, "new-generation.mjs");
fs.writeFileSync(newPath, pluginSource);
const repaired = load(newPath, { ...options, aliasMap: { "fixture-api": currentApi } });
assert.equal(repaired.ok, true);
assert.equal(repaired.moduleExport.value, 2);
const retryPath = path.join(dir, "retry.cjs");
fs.writeFileSync(retryPath, 'if (!globalThis.__pluginDependencyReady) throw new Error("dependency not ready"); module.exports = { ready: true };\\n');
assert.throws(() => load(retryPath), /dependency not ready/);
globalThis.__pluginDependencyReady = true;
const retried = load(path.join(aliasDir, "retry.cjs"));
assert.equal(retried.ok, true);
assert.equal(retried.moduleExport.ready, true);
delete globalThis.__pluginDependencyReady;
delete require.cache[require.resolve(retryPath)];
fs.writeFileSync(retryPath, 'throw Object.assign(new Error("fresh race"), { code: "ERR_REQUIRE_ESM_RACE_CONDITION" });\\n');
assert.deepEqual(load(retryPath), { ok: false });
const aliasRequest = path.join(dir, "alias-request.cjs");
const aliasFirst = path.join(dir, "alias-first.cjs");
const aliasSecond = path.join(dir, "alias-second.cjs");
fs.writeFileSync(aliasFirst, 'module.exports = "first";\\n');
fs.writeFileSync(aliasSecond, 'module.exports = "second";\\n');
assert.deepEqual(load(aliasRequest, {
  aliasMap: { [aliasRequest]: aliasFirst, [aliasFirst]: aliasSecond },
}), { ok: true, moduleExport: "first" });
console.log("terminal error retained; new generation recovered");
`,
      );
      // tsx changes named-import linking, so this contract needs an unhooked Node process.
      const result = spawnSync(process.execPath, [probePath], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_OPTIONS: "" },
        encoding: "utf8",
        timeout: 30_000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("terminal error retained; new generation recovered");
    },
  );
});

describe("isJavaScriptModulePath", () => {
  it("only accepts JavaScript runtime extensions", () => {
    expect(isJavaScriptModulePath("/plugin/index.js")).toBe(true);
    expect(isJavaScriptModulePath("/plugin/index.mjs")).toBe(true);
    expect(isJavaScriptModulePath("/plugin/index.cjs")).toBe(true);
    expect(isJavaScriptModulePath("/plugin/index.ts")).toBe(false);
  });
});

describe("plugin native loading selection", () => {
  it.each([
    ["node", "linux", "dist/plugins/runtime/index.js", false, true],
    ["node", "linux", "extensions/demo/index.ts", false, false],
    ["bun", "linux", "dist/plugins/runtime/index.js", false, true],
    ["bun", "linux", "dist/extensions/demo/index.js", true, true],
    ["node", "win32", "dist/plugins/runtime/index.js", false, true],
    ["node", "win32", "dist/extensions/demo/index.js", true, true],
    ["node", "win32", "dist/extensions/demo/helper.ts", true, false],
    ["node", "linux", "dist/extensions/demo/index.js", true, true],
    ["node", "linux", "dist/extensions/demo/helper.ts", true, false],
  ] as const)(
    "selects native loading for %s on %s with %s (prefer dist=%s): %s",
    (runtime, platform, entry, preferBuiltDist, expected) => {
      const originalPlatform = process.platform;
      const originalVersions = process.versions;
      Object.defineProperty(process, "platform", { configurable: true, value: platform });
      Object.defineProperty(process, "versions", {
        configurable: true,
        value: { ...originalVersions, bun: runtime === "bun" ? "1.2.0" : undefined },
      });
      try {
        const tryNative = resolvePluginLoaderTryNative(path.join("/repo", entry), {
          preferBuiltDist,
        });
        expect(tryNative).toBe(expected);
      } finally {
        Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
        Object.defineProperty(process, "versions", { configurable: true, value: originalVersions });
      }
    },
  );
});
