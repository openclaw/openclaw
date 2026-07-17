/** Integration tests for plugin bootstrap through the gateway server. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBundledBrowserPluginFixture } from "../../test/helpers/browser-bundled-plugin-fixture.js";
import type { OpenClawConfig } from "../config/config.js";
import { clearPluginLoaderCache } from "../plugins/loader.test-fixtures.js";
import { loadPluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import {
  listImportedRuntimePluginIds,
  resetPluginRuntimeStateForTest,
} from "../plugins/runtime.js";
import { listSecretProviderIntegrationPresets } from "../secrets/provider-integrations.js";
import { loadGatewayStartupPlugins } from "./server-plugin-bootstrap.js";

const SURFACE_PLUGIN_ENTRY = (declaredId: string, id: string) => `module.exports = {
  id: ${JSON.stringify(declaredId)},
  register(api) {
    api.registerTool({
      name: ${JSON.stringify(`${id}-tool`)},
      description: "Gateway surface fixture tool",
      parameters: { type: "object", properties: {} },
      async execute() { return { content: [], details: {} }; },
    });
    api.registerChannel({
      plugin: {
        id: ${JSON.stringify(`${id}-channel`)},
        meta: {
          id: ${JSON.stringify(`${id}-channel`)},
          label: "Gateway Surface Fixture",
          selectionLabel: "Gateway Surface Fixture",
          docsPath: "/channels/gateway-surface-fixture",
          blurb: "Gateway surface fixture",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });
    api.registerHook("gateway:startup", () => {}, { name: ${JSON.stringify(`${id}-hook`)} });
    api.on("gateway_start", async () => {});
    api.registerService({ id: ${JSON.stringify(`${id}-service`)}, start() {} });
  },
};`;

const DECLARED_FIXTURE_IDS: Readonly<Record<string, string>> = {
  "denied-fixture": "Denied-Fixture",
  "allowed-fixture": "Allowed-Fixture",
};

function createGatewaySurfacePluginFixture(): { rootDir: string; cleanup: () => void } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-plugin-surfaces-"));
  for (const [id, declaredId] of Object.entries(DECLARED_FIXTURE_IDS)) {
    // The directory is named after the declared id so discovery cannot deny the plugin by a
    // lowercase directory name before policy compares the manifest id.
    const pluginDir = path.join(rootDir, declaredId);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: declaredId,
        enabledByDefault: true,
        channels: [`${id}-channel`],
        contracts: { tools: [`${id}-tool`] },
        secretProviderIntegrations: {
          [`${id}-secrets`]: {
            source: "exec",
            command: "${node}",
            args: ["./secret-provider.js"],
            providerAlias: `${id}-secrets`,
          },
        },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      SURFACE_PLUGIN_ENTRY(declaredId, id),
      "utf8",
    );
    fs.writeFileSync(path.join(pluginDir, "secret-provider.js"), "process.stdout.write('{}');\n");
  }
  return {
    rootDir,
    cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }),
  };
}

function resetPluginState() {
  clearPluginLoaderCache();
  resetPluginRuntimeStateForTest();
}

function createTestLog() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

describe("loadGatewayStartupPlugins browser plugin integration", () => {
  let bundledFixture: ReturnType<typeof createBundledBrowserPluginFixture> | null = null;

  beforeEach(() => {
    bundledFixture = createBundledBrowserPluginFixture();
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledFixture.rootDir);
    resetPluginState();
  });

  afterEach(() => {
    resetPluginState();
    vi.unstubAllEnvs();
    bundledFixture?.cleanup();
    bundledFixture = null;
  });

  it("adds browser.request and the browser control service from the bundled plugin", () => {
    const loaded = loadGatewayStartupPlugins({
      cfg: {
        plugins: {
          allow: ["browser"],
        },
      } as OpenClawConfig,
      workspaceDir: process.cwd(),
      log: createTestLog(),
      coreGatewayHandlers: {},
      baseMethods: [],
      pluginIds: ["browser"],
      logDiagnostics: false,
    });

    expect(loaded.gatewayMethods).toContain("browser.request");
    expect(
      loaded.pluginRegistry.services.some(
        (entry) => entry.pluginId === "browser" && entry.service.id === "browser-control",
      ),
    ).toBe(true);
  });

  it("denies a mixed-case plugin every Gateway runtime surface while an allowed one still loads", () => {
    const fixture = createGatewaySurfacePluginFixture();
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", fixture.rootDir);
    resetPluginState();
    try {
      // No allowlist: an allowlist scopes discovery by a lowercased id and would drop the denied
      // plugin before policy compares its manifest id, masking the denylist behavior under test.
      const cfg = {
        plugins: {
          deny: ["denied-fixture"],
        },
      } as OpenClawConfig;
      const pluginLookUpTable = loadPluginLookUpTable({
        config: cfg,
        env: process.env,
        workspaceDir: process.cwd(),
      });
      const loaded = loadGatewayStartupPlugins({
        cfg,
        workspaceDir: process.cwd(),
        log: createTestLog(),
        coreGatewayHandlers: {},
        baseMethods: [],
        pluginIds: Object.values(DECLARED_FIXTURE_IDS),
        pluginLookUpTable,
        logDiagnostics: false,
      });

      const denied = loaded.pluginRegistry.plugins.find((plugin) => plugin.id === "Denied-Fixture");
      const allowed = loaded.pluginRegistry.plugins.find(
        (plugin) => plugin.id === "Allowed-Fixture",
      );
      expect(denied).toMatchObject({
        id: "Denied-Fixture",
        enabled: false,
        activated: false,
        status: "disabled",
        activationReason: "blocked by denylist",
      });
      expect(allowed).toMatchObject({
        id: "Allowed-Fixture",
        enabled: true,
        status: "loaded",
      });
      const runtimeInspection = {
        imported: listImportedRuntimePluginIds(),
        hooks: [...loaded.pluginRegistry.hooks, ...loaded.pluginRegistry.typedHooks].map(
          (entry) => entry.pluginId,
        ),
        tools: loaded.pluginRegistry.tools.map((entry) => entry.pluginId),
        channels: loaded.pluginRegistry.channels.map((entry) => entry.pluginId),
        services: loaded.pluginRegistry.services.map((entry) => entry.pluginId),
        secretIntegrations: listSecretProviderIntegrationPresets({
          manifestRegistry: pluginLookUpTable.manifestRegistry,
          config: cfg,
        }).map((preset) => preset.pluginId),
      };
      expect(runtimeInspection).toEqual({
        imported: ["Allowed-Fixture"],
        hooks: ["Allowed-Fixture", "Allowed-Fixture"],
        tools: ["Allowed-Fixture"],
        channels: ["Allowed-Fixture"],
        services: ["Allowed-Fixture"],
        secretIntegrations: ["Allowed-Fixture"],
      });
    } finally {
      fixture.cleanup();
    }
  });
});
