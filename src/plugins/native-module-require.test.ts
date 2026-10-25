import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";
import {
  isJavaScriptModulePath,
  resolvePluginLoaderTryNative,
  tryNativeRequireJavaScriptModule,
  useNodeModuleHooks,
} from "./native-module-require.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function writeFile(dir: string, name: string, source: string) {
  const target = path.join(dir, name);
  fs.writeFileSync(target, source, "utf8");
  return target;
}

function expectProbe(
  probePath: string,
  output: string,
  options: { args?: string[]; cwd?: string; native?: boolean } = {},
) {
  const native = options.native ?? true;
  const result = spawnSync(process.execPath, [...(options.args ?? []), probePath], {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    ...(native ? { env: { ...process.env, NODE_OPTIONS: "" }, timeout: 30_000 } : {}),
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(output);
  if (!native) {
    expect(result.stderr).toBe("");
  }
}

async function bundleOwner(dir: string) {
  const outfile = path.join(dir, "native-require.mjs");
  await build({
    entryPoints: [path.resolve("src/plugins/native-module-require.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  return pathToFileURL(outfile).href;
}

it("loads captured external modules without intercepting a compiled Bun entry", async () => {
  const dir = tempDirs.make("openclaw-native-captured-bun-");
  const ownerUrl = await bundleOwner(dir);
  const probePath = writeFile(
    dir,
    "probe.mjs",
    `import assert from "node:assert/strict";
const main = "/$bunfs/root/entry [captured].mjs";
let resolve;
globalThis.Bun = {
  main,
  plugin({ setup }) {
    setup({
      onResolve({ filter, namespace }, callback) {
        assert.equal(namespace, "file");
        // Compiled Bun rejects matching entry filters before calling the resolver.
        if (filter.test(main)) throw new Error("compiled entry cannot be intercepted");
        resolve = (args) => filter.test(args.path) ? callback(args) : undefined;
      },
    });
  },
};
const { registerCapturedPluginModuleResolver } = await import(${JSON.stringify(ownerUrl)});
const dispose = registerCapturedPluginModuleResolver({
  prepare(request) {
    return request === "fixture-package" || request === main + ".external"
      ? "/captured/plugin.cjs" : undefined;
  },
  resolve() {},
});
assert.equal(resolve({ path: main, importer: "" }), undefined);
for (const request of ["fixture-package", main + ".external"]) {
  assert.deepEqual(resolve({ path: request, importer: "/plugin/index.cjs" }), {
    path: "/captured/plugin.cjs", namespace: "file",
  });
}
dispose();
assert.equal(resolve({ path: "fixture-package", importer: "/plugin/index.cjs" }), undefined);
console.log("external capture retained; compiled entry untouched");
`,
  );
  const result = spawnNodeEvalSync(
    `await import(${JSON.stringify(pathToFileURL(probePath).href)});`,
    {
      env: { ...process.env, NODE_OPTIONS: "" },
      timeout: 30_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("external capture retained; compiled entry untouched");
});

it("uses source-transform fallback only when native TLA loading needs it", () => {
  const modulePath = writeFile(
    tempDirs.make("openclaw-native-require-"),
    "plugin.mjs",
    'await Promise.resolve();\nexport const marker = "esm";\n',
  );

  const result = tryNativeRequireJavaScriptModule(modulePath);
  if (process.versions.bun) {
    expect(result).toMatchObject({ ok: true, moduleExport: { marker: "esm" } });
  } else {
    expect(result).toEqual({ ok: false });
  }
});

it("declines an in-flight ESM require race for source-transform fallback", () => {
  const modulePath = writeFile(
    tempDirs.make("openclaw-native-require-"),
    "plugin.cjs",
    'throw Object.assign(new Error("ESM is still loading"), { code: "ERR_REQUIRE_ESM_RACE_CONDITION" });\n',
  );
  expect(tryNativeRequireJavaScriptModule(modulePath)).toEqual({ ok: false });
});

it("loads native ESM graphs with temporary SDK aliases", () => {
  const dir = tempDirs.make("openclaw-native-require-");
  const ownerUrl = pathToFileURL(path.resolve("src/plugins/native-module-require.ts")).href;
  const sdkPath = writeFile(dir, "sdk.js", 'export const adapter = () => "adapter";\n');
  const modulePath = writeFile(
    dir,
    "plugin.mjs",
    'import { adapter } from "openclaw/plugin-sdk/channel-outbound";\nexport const marker = adapter();\n',
  );
  const probePath = writeFile(
    dir,
    "probe.mjs",
    `import { tryNativeRequireJavaScriptModule } from ${JSON.stringify(ownerUrl)};
const result = tryNativeRequireJavaScriptModule(${JSON.stringify(modulePath)}, {
  aliasMap: { "openclaw/plugin-sdk/channel-outbound": ${JSON.stringify(sdkPath)} },
});
if (!result.ok) throw new Error("native require declined ESM graph");
console.log(result.moduleExport.marker);
`,
  );
  expectProbe(probePath, "adapter", { args: ["--import", "tsx"], native: false });
});

it("uses the configured native loader for JavaScript-to-TypeScript lookup", () => {
  const dir = tempDirs.make("openclaw-native-require-");
  const modulePath = writeFile(dir, "plugin.cjs", 'module.exports = require("./helper.js");\n');
  writeFile(dir, "helper.ts", "export const loaded = true;\n");

  const result = tryNativeRequireJavaScriptModule(modulePath);
  expect(result).toMatchObject({ ok: true, moduleExport: { loaded: true } });
});

it("keeps native paths, file URLs, and source SDK aliases on the process module graph", async () => {
  const dir = tempDirs.make("openclaw-native-require-");
  // tsx's CommonJS hook accepts file URLs and masks Node's native contract.
  const ownerUrl = await bundleOwner(dir);
  const modulePath = path.join(dir, "space # percent% plugin.cjs");
  const probePath = path.join(dir, "probe.mjs");
  const tsconfigPath = path.join(dir, "tsconfig.json");
  fs.writeFileSync(tsconfigPath, "{}\n");
  fs.writeFileSync(
    probePath,
    `import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tryNativeRequireJavaScriptModule as load, tryNativeRequireModule as loadSource } from ${JSON.stringify(ownerUrl)};
const modulePath = ${JSON.stringify(modulePath)};
for (const target of [modulePath, pathToFileURL(modulePath).href]) {
  fs.writeFileSync(modulePath, 'module.exports = { marker: "before" };\\n');
  assert.deepEqual(load(target), { ok: true, moduleExport: { marker: "before" } });
  fs.writeFileSync(modulePath, 'module.exports = { marker: "after" };\\n');
  assert.deepEqual(load(target), { ok: true, moduleExport: { marker: "before" } });
}
assert.deepEqual(load(pathToFileURL(modulePath + ".missing.cjs").href), { ok: false });
fs.writeFileSync(modulePath + ".broken.cjs", 'require("./missing-dependency.cjs");\\n');
assert.throws(() => load(pathToFileURL(modulePath + ".broken.cjs").href), /missing-dependency\\.cjs/);
fs.writeFileSync(modulePath + ".missing-peer.cjs", 'require("openclaw/plugin-sdk/core");\\n');
assert.throws(() => load(modulePath + ".missing-peer.cjs", { fallbackOnMissingDependency: true }), /openclaw\\/plugin-sdk\\/core/);
const sdkPath = modulePath + ".sdk.ts";
fs.writeFileSync(modulePath + ".helper.ts", 'export const value = "source";\\n');
fs.writeFileSync(modulePath + ".preferred.js", 'export const value = "javascript";\\n');
fs.writeFileSync(modulePath + ".preferred.ts", 'export const value = "wrong-source";\\n');
fs.writeFileSync(sdkPath, [
  'import { value } from "./' + ${JSON.stringify(encodeURIComponent(path.basename(modulePath)))} + '.helper.js";',
  'import { value as preferred } from "./' + ${JSON.stringify(encodeURIComponent(path.basename(modulePath)))} + '.preferred.js";',
  'export const state = { value, preferred };',
].join("\\n"));
const source = loadSource(sdkPath, { aliasMap: {} });
assert.deepEqual([source.ok, source.moduleExport.state], [true, { value: "source", preferred: "javascript" }]);
assert.equal(source.moduleExport.state, (await import(pathToFileURL(sdkPath).href)).state);
// Jiti alias maps spell Windows targets with forward slashes; "/./" is the portable non-native spelling.
const aliasedSdkPath = modulePath + ".aliased-sdk.cjs";
fs.writeFileSync(aliasedSdkPath, "module.exports = { instance: {} };\\n");
fs.writeFileSync(modulePath + ".aliased.cjs", 'module.exports = require("fixture-sdk");\\n');
const aliased = loadSource(modulePath + ".aliased.cjs", {
  aliasMap: { "fixture-sdk": path.dirname(aliasedSdkPath) + "/./" + path.basename(aliasedSdkPath) },
});
assert.equal(aliased.moduleExport, createRequire(import.meta.url)(aliasedSdkPath));
console.log("native contracts passed");
`,
  );
  expectProbe(probePath, "native contracts passed", {
    cwd: dir,
    args: process.versions.bun ? ["--no-install", "--tsconfig-override", tsconfigPath] : [],
  });
});

// Temporary ESM aliases belong to the selected Node hooks path; Bun owns its native resolver.
it.runIf(useNodeModuleHooks())(
  "retains terminal ESM failures across eviction and alias changes until a new path loads",
  async () => {
    const dir = tempDirs.make("openclaw-native-failed-generation-");
    const ownerUrl = await bundleOwner(dir);
    const probePath = path.join(dir, "probe.mjs");
    fs.writeFileSync(
      probePath,
      `import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { tryNativeRequireJavaScriptModule as load } from ${JSON.stringify(ownerUrl)};
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
assert.deepEqual([repaired.ok, repaired.moduleExport.value], [true, 2]);
const retryPath = path.join(dir, "retry.cjs");
fs.writeFileSync(retryPath, 'if (!globalThis.__pluginDependencyReady) throw new Error("dependency not ready"); module.exports = { ready: true };\\n');
assert.throws(() => load(retryPath), /dependency not ready/);
globalThis.__pluginDependencyReady = true;
const retried = load(path.join(aliasDir, "retry.cjs"));
assert.deepEqual([retried.ok, retried.moduleExport.ready], [true, true]);
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
    expectProbe(probePath, "terminal error retained; new generation recovered");
  },
);
it("isJavaScriptModulePath only accepts JavaScript runtime extensions", () => {
  expect(isJavaScriptModulePath("/plugin/index.js")).toBe(true);
  expect(isJavaScriptModulePath("/plugin/index.mjs")).toBe(true);
  expect(isJavaScriptModulePath("/plugin/index.cjs")).toBe(true);
  expect(isJavaScriptModulePath("/plugin/index.ts")).toBe(false);
});

it.each([
  ["dist/plugins/runtime/index.js", false, true],
  ["extensions/demo/index.ts", false, false],
  ["dist/extensions/demo/index.js", true, true],
  ["dist/extensions/demo/helper.ts", true, false],
] as const)(
  "selects native loading for %s (prefer dist=%s): %s",
  (entry, preferBuiltDist, expected) => {
    const result = resolvePluginLoaderTryNative(path.join("/repo", entry), { preferBuiltDist });
    expect(result).toBe(expected);
  },
);
