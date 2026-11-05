import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCompiledSdkHost } from "./compiled-sdk-host.test-support.js";
import { pluginFixtureConfig, writeFixtureJson } from "./loader-fixture-builders.test-support.js";
import { publishedSdkBridgeEntrypoints } from "./loader-sdk-bridge-artifacts.test-support.js";
import { loadOpenClawPlugins } from "./loader.js";
import { resetPluginCache } from "./plugin-cache.js";
import { getPluginModuleLoaderStats } from "./plugin-module-loader-cache.js";

const tempDirs = createTempDirTracker();

function writePreSplitSdkBridgeConsumerFixture() {
  const pluginRoot = tempDirs.make("openclaw-plugin-loader-");
  const write = (name: string, content: string) =>
    fs.writeFileSync(path.join(pluginRoot, name), content, "utf-8");
  // Native ESM default imports retain raw CommonJS exports despite transpiler markers.
  write(
    "dependency.cjs",
    "module.exports = { __esModule: true, default: { answer: 17 }, answer: 42 };",
  );
  fs.mkdirSync(path.join(pluginRoot, "dist"));
  writeFixtureJson(pluginRoot, "package.json", {
    name: "@openclaw/sdk-bridge-consumer",
    version: "2026.7.2-beta.7",
    type: "module",
    openclaw: { extensions: ["./dist/index.js"], runtimeExtensions: ["./dist/index.js"] },
  });
  writeFixtureJson(pluginRoot, "openclaw.plugin.json", {
    id: "sdk-bridge-consumer",
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  });
  // Published 2026.7.2-beta.7 imports: private-local doctor and public channel aliases.
  const imports = {
    "runtime-doctor":
      "archiveLegacyStateSource, detectOpenClawStateDatabaseSchemaMigrations, repairOpenClawStateDatabaseSchema, detectPluginInstallPathIssue, formatPluginInstallPathIssue, removePluginFromConfig, createPluginStateSyncKeyedStore",
    "channel-feedback": "shouldAckReactionForWhatsApp",
    "channel-outbound": "resolveChannelProgressDraftRender",
  };
  write(
    "dist/index.js",
    `import assert from "node:assert/strict";
import { createRequire } from "node:module";
import dependency from "../dependency.cjs";
${Object.entries(imports)
  .map(([subpath, names]) => `import { ${names} } from "openclaw/plugin-sdk/${subpath}";`)
  .join("\n")}
export default { id: "sdk-bridge-consumer", register() {
  assert.equal(dependency, createRequire(import.meta.url)("../dependency.cjs"));
  assert.equal(dependency.answer, 42);
  assert.equal(dependency.default.answer, 17);
  const bridged = [${Object.values(imports).join(", ")}];
  if (bridged.some((entry) => typeof entry !== "function")) throw new Error("missing bridge");
} };`,
  );
  return pluginRoot;
}

afterEach(() => {
  resetPluginCache();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

it("loads published pre-split SDK bridge imports (doctor repair, WhatsApp ack, Slack render)", () => {
  const pluginRoot = writePreSplitSdkBridgeConsumerFixture();
  const hostRoot = createCompiledSdkHost(
    publishedSdkBridgeEntrypoints,
    (prefix) => tempDirs.make(prefix),
    { mode: "link" },
  );
  if (hostRoot) {
    vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", hostRoot);
  }
  vi.stubEnv(
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    hostRoot ? path.join(hostRoot, "extensions") : tempDirs.make("openclaw-plugin-loader-"),
  );
  const before = getPluginModuleLoaderStats();

  const registry = loadOpenClawPlugins({
    cache: false,
    pluginSdkResolution: hostRoot ? "dist" : "auto",
    onlyPluginIds: ["sdk-bridge-consumer"],
    config: pluginFixtureConfig({ id: "sdk-bridge-consumer", file: pluginRoot }, { enabled: true }),
  });

  const entry = registry.plugins.find((plugin) => plugin.id === "sdk-bridge-consumer");
  expect(entry?.error ?? null).toBeNull();
  expect(entry?.status).toBe("loaded");
  if (hostRoot) {
    const after = getPluginModuleLoaderStats();
    expect(after.sourceTransformForced).toBe(before.sourceTransformForced);
    expect(after.sourceTransformFallbacks).toBe(before.sourceTransformFallbacks);
  }
});
