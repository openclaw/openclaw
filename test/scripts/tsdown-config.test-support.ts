export const QA_RUNTIME_PRODUCTION_PROBE = `
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, isBuiltin, registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, repository] = process.argv.slice(1);
const manifestPath = path.join(repository, "package.json");
const pluginManifestPath = path.join(repository, "extensions/qa-lab/package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const pluginManifest = JSON.parse(fs.readFileSync(pluginManifestPath, "utf8"));
const production = new Set(Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }));
const pluginProduction = new Set(Object.keys({ ...pluginManifest.dependencies, ...pluginManifest.optionalDependencies }));
const outputUrl = pathToFileURL(path.join(root, "dist") + path.sep).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (isBuiltin(specifier) || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:"))
    return nextResolve(specifier, context);
  const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
  if (context.parentURL?.startsWith(outputUrl)) {
    assert(production.has(name) || pluginProduction.has(name), "Non-production dependency in QA runtime: " + specifier);
    const sourceManifest = name === "@openclaw/ai"
      ? path.join(root, "node_modules/@openclaw/ai/package.json")
      : production.has(name) ? manifestPath : pluginManifestPath;
    if (context.conditions.includes("require")) {
      return { url: pathToFileURL(createRequire(sourceManifest).resolve(specifier)).href, shortCircuit: true };
    }
    return nextResolve(specifier, { ...context, parentURL: pathToFileURL(sourceManifest).href });
  }
  return nextResolve(specifier, context);
} });
const { buildQaRuntimeEnv } = await import(pathToFileURL(path.join(root, "dist/qa-child-env.js")).href);
const stateDir = path.join(root, "state");
const env = buildQaRuntimeEnv({
  baseEnv: { OPENCLAW_PROFILE: "operator", OPENCLAW_SUPERVISOR_MODE: "external" },
  configPath: path.join(stateDir, "openclaw.json"), gatewayToken: "synthetic-qa-token",
  homeDir: root, stateDir, tempRoot: root,
  xdgConfigHome: path.join(root, "config"), xdgDataHome: path.join(root, "data"),
  xdgCacheHome: path.join(root, "cache"), developmentSourceRoot: null,
});
assert.equal(env.OPENCLAW_STATE_DIR, stateDir);
assert.equal(env.OPENCLAW_SUPERVISOR_MODE, undefined);
assert.match(env.OPENCLAW_PROFILE, /^qa-[a-f0-9]{24}$/);
assert.equal(env.OPENCLAW_BUILD_PRIVATE_QA, "1");
assert.equal(env.OPENCLAW_ENABLE_PRIVATE_QA_CLI, "1");
const runtime = await import(pathToFileURL(path.join(root, "dist/qa-runtime.js")).href);
assert.equal(typeof runtime.createQaLiveLaneGateway, "function");
const lane = runtime.createQaLiveLaneGateway();
assert.equal(typeof lane.start, "function");
assert.deepEqual(await lane.stop(), { process: "never-spawned", errors: [] });
console.log("QA child environment loads without development dependencies");
`;

export const FS_SAFE_CALLER_PROBE = `
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, isBuiltin, registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [entry, observer, rootDir, mode, outcome, sealed] = process.argv.slice(1);
if (sealed) registerHooks({ resolve(specifier, context, next) {
  if (!isBuiltin(specifier) && specifier !== pathToFileURL(entry).href)
    throw new Error("sealed dependency escaped: " + specifier);
  return next(specifier, context);
}});
const { root, parseJsonWithJson5Fallback, resolvePreferredOpenClawTmpDir, resolveRuntimeProcessEntrypointUrl } = await import(pathToFileURL(entry).href);
if (sealed) {
  assert.deepEqual(parseJsonWithJson5Fallback("{value:'bundled',}"), {value:"bundled"});
  assert.equal(resolvePreferredOpenClawTmpDir({preferredDir:rootDir, tmpdir:()=>rootDir, platform:"linux"}), rootDir);
  assert.equal(resolveRuntimeProcessEntrypointUrl("githubExec").href, new URL("./github-exec-launcher.mjs", pathToFileURL(entry)).href);
  assert.equal(resolveRuntimeProcessEntrypointUrl("serviceChildRelay").href, new URL("./service-child-relay.mjs", pathToFileURL(entry)).href);
}
const { configureFsSafeNative, getFsSafeNativeConfig, FsSafeError } = await import(pathToFileURL(observer).href);
assert.equal(getFsSafeNativeConfig().mode, mode === "configured" ? "off" : mode);
if (mode === "configured") configureFsSafeNative({ mode: "require" });
const scoped = await root(rootDir);
if (outcome === "missing") {
  await assert.rejects(scoped.write("proof.txt", "native proof"), (error) => {
    assert(error instanceof FsSafeError);
    assert.equal(error.code, "helper-unavailable");
    assert.equal(error.cause?.code, "MODULE_NOT_FOUND");
    return true;
  });
  assert.deepEqual(fs.readdirSync(rootDir), []);
} else {
  await scoped.write("proof.txt", "native proof");
  await scoped.create("created.txt", "create proof");
  assert.equal(fs.readFileSync(path.join(rootDir, "proof.txt"), "utf8"), "native proof");
  assert.equal(fs.readFileSync(path.join(rootDir, "created.txt"), "utf8"), "create proof");
}
const loaded = Object.keys(createRequire(import.meta.url).cache).filter((file) => file.endsWith("fs-safe-native.node"));
assert.equal(loaded.length, outcome === "native" ? 1 : 0);
if (loaded.length) assert(loaded[0].startsWith(path.dirname(rootDir) + path.sep));
`;
