import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
} from "../../plugins/loader.test-fixtures.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { resolveReadOnlyChannelPluginsForConfigAsync } from "./read-only.js";
import { writeBundledSetupChannelPlugin } from "./read-only.test-support.js";

vi.mock("../../plugins/bundled-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/bundled-dir.js")>();
  return {
    ...actual,
    resolveBundledPluginsDir: (env: NodeJS.ProcessEnv = process.env) =>
      env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? actual.resolveBundledPluginsDir(env),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetPluginLoaderTestStateForTest();
  resetPluginRuntimeStateForTest();
});

afterAll(cleanupPluginLoaderFixturesForTest);

describe("resolveReadOnlyChannelPluginsForConfigAsync", () => {
  it("detects saved auth through the async presence export, never the deprecated sync one", async () => {
    const stateDir = makePluginLoaderTempDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const persistedAuthPath = path.join(stateDir, "linked-auth");
    const callsPath = path.join(stateDir, "auth-calls");
    const { channelId, pluginDir } = writeBundledSetupChannelPlugin({ persistedAuthPath });
    const packagePath = path.join(pluginDir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    pkg.openclaw.channel.persistedAuthState.exportNameAsync = "hasAuthAsync";
    fs.writeFileSync(packagePath, JSON.stringify(pkg));
    fs.writeFileSync(
      path.join(pluginDir, "auth-state.cjs"),
      `const fs = require("node:fs");
const record = (kind) => fs.appendFileSync(${JSON.stringify(callsPath)}, kind + "\\n");
exports.hasAuth = () => { record("sync"); return fs.existsSync(${JSON.stringify(persistedAuthPath)}); };
exports.hasAuthAsync = async () => { record("async"); return fs.existsSync(${JSON.stringify(persistedAuthPath)}); };`,
    );
    fs.writeFileSync(persistedAuthPath, "linked");
    const cfg = { plugins: { allow: [channelId], entries: { [channelId]: { enabled: true } } } };
    const metadataSnapshot = resolvePluginMetadataSnapshot({ config: cfg });

    const resolution = await resolveReadOnlyChannelPluginsForConfigAsync(cfg, {
      metadataSnapshot,
      includePersistedAuthState: true,
    });

    expect(resolution.configuredChannelIds).toContain(channelId);
    expect(resolution.plugins.map((plugin) => plugin.id)).toContain(channelId);
    expect(fs.readFileSync(callsPath, "utf8").trim().split("\n")).not.toContain("sync");
  });
});
