import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  operatorMcpOAuthIdentity,
  requesterMcpOAuthIdentity,
} from "../agents/mcp-oauth-identity.js";
import { readMcpOAuthStore } from "../agents/mcp-oauth-store.js";
import {
  seedMcpOAuthStoreForTest,
  withMcpOAuthTestLease,
} from "../agents/mcp-oauth.test-support.js";
import { registerManagedRuntimeConfigWriteOwner } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolvePluginInstallDir } from "./install-paths.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { uninstallManagedPlugin, uninstallPluginWithPolicy } from "./management-uninstall.js";
import { clearRemovedPluginMcpOAuth } from "./mcp-auth-status.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import { mkdirSafeDir } from "./test-helpers/fs-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const docsUrl = "https://docs.example.test/mcp";
const signedIn = { tokens: { access_token: "fixture-access", token_type: "Bearer" } };

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

async function installMcpPlugin(params: { enabled: boolean; servers?: OpenClawConfig["mcp"] }) {
  const root = tempDirs.make("managed-uninstall-mcp-oauth-");
  const configPath = path.join(root, "openclaw.json");
  const stateDir = path.join(root, "state");
  const pluginRoot = resolvePluginInstallDir("docs-plugin", path.join(stateDir, "extensions"));
  mkdirSafeDir(pluginRoot);
  const fixture = createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId: "docs-plugin",
    manifest: {
      providers: [],
      channels: [],
      channelConfigs: {},
      providerAuthChoices: [],
      mcpServers: { docs: { url: docsUrl, transport: "streamable-http", auth: "oauth" } },
    },
  });
  const config: OpenClawConfig = {
    plugins: {
      entries: { [fixture.pluginId]: { enabled: params.enabled } },
      load: { paths: [pluginRoot] },
    },
    ...(params.servers ? { mcp: params.servers } : {}),
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  vi.stubEnv("OPENCLAW_HOME", path.join(root, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  onTestFinished(registerManagedRuntimeConfigWriteOwner(configPath));
  await writePersistedInstalledPluginIndex(
    loadInstalledPluginIndex({
      config,
      env: process.env,
      installRecords: {
        [fixture.pluginId]: {
          source: "path",
          sourcePath: path.join(root, "source"),
          installPath: pluginRoot,
        },
      },
    }),
  );
  return fixture.pluginId;
}

const operator = operatorMcpOAuthIdentity("docs", docsUrl);
const requester = requesterMcpOAuthIdentity("docs", docsUrl, { requesterSenderId: "alice" });
const unrelated = operatorMcpOAuthIdentity("calendar", "https://calendar.example.test/mcp");

it.each([
  { caller: "management", enabled: true },
  { caller: "management", enabled: false },
  { caller: "cli", enabled: true },
] as const)(
  "removes the plugin's saved MCP sign-ins on $caller uninstall (enabled: $enabled)",
  async ({ caller, enabled }) => {
    const pluginId = await installMcpPlugin({ enabled });
    for (const identity of [operator, requester, unrelated]) {
      seedMcpOAuthStoreForTest(identity.storeKey, signedIn);
    }

    if (caller === "cli") {
      expect((await uninstallPluginWithPolicy({ pluginId, caller })).ok).toBe(true);
    } else {
      await uninstallManagedPlugin({ pluginId });
    }

    // A reinstall resolves the same store key, so a retained row would reconnect silently.
    expect((await readMcpOAuthStore(operator.storeKey)).tokens).toBeUndefined();
    expect((await readMcpOAuthStore(requester.storeKey)).tokens).toBeUndefined();
    expect((await readMcpOAuthStore(unrelated.storeKey)).tokens).toEqual(signedIn.tokens);
  },
);

it("keeps sign-ins when uninstall authority ends while cleanup waits for the credential", async () => {
  await installMcpPlugin({ enabled: true });
  seedMcpOAuthStoreForTest(operator.storeKey, signedIn);
  let revoked = false;
  const assertCurrent = () => {
    if (revoked) {
      throw new Error("uninstall authority ended");
    }
  };
  const held = createDeferred();
  const released = createDeferred();
  const holder = withMcpOAuthTestLease(operator.storeKey, async () => {
    held.resolve();
    await released.promise;
  });
  await held.promise;
  const cleanup = clearRemovedPluginMcpOAuth({
    endpoints: [{ serverName: "docs", url: docsUrl }],
    config: {},
    assertCurrent,
  });
  const rejected = expect(cleanup).rejects.toThrow("uninstall authority ended");
  revoked = true;
  released.resolve();
  await holder;

  await rejected;
  expect((await readMcpOAuthStore(operator.storeKey)).tokens).toEqual(signedIn.tokens);
});

it("keeps sign-ins that a configured server with the same endpoint still uses", async () => {
  const pluginId = await installMcpPlugin({
    enabled: true,
    servers: { servers: { docs: { url: docsUrl, transport: "streamable-http", auth: "oauth" } } },
  });
  seedMcpOAuthStoreForTest(operator.storeKey, signedIn);

  await uninstallManagedPlugin({ pluginId });

  expect((await readMcpOAuthStore(operator.storeKey)).tokens).toEqual(signedIn.tokens);
});
