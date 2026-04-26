import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginDiscoveryCache } from "../plugins/discovery.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import { refreshPluginRegistry } from "../plugins/plugin-registry.js";
import { buildAuthChoiceOptions, formatAuthChoiceChoicesForCli } from "./auth-choice-options.js";
import { listManifestInstalledChannelIds } from "./channel-setup/discovery.js";
import { resolveProviderCatalogPluginIdsForFilter } from "./models/list.provider-catalog.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-command-cold-imports-"));
  tempDirs.push(dir);
  return dir;
}

function hermeticEnv(
  homeDir: string,
  options: { disablePersistedRegistry?: boolean } = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_HOME: path.join(homeDir, "home"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY:
      options.disablePersistedRegistry === false ? undefined : "1",
    OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
    OPENCLAW_VERSION: "2026.4.25",
    VITEST: "true",
  };
}

function createColdControlPlanePlugin() {
  const rootDir = makeTempDir();
  const runtimeMarker = path.join(rootDir, "runtime-loaded.txt");
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify(
      {
        name: "@example/openclaw-cold-control-plane",
        version: "1.0.0",
        openclaw: { extensions: ["./index.cjs"] },
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: "cold-control-plane",
        name: "Cold Control Plane",
        configSchema: { type: "object" },
        providers: ["cold-model-provider"],
        channels: ["cold-channel"],
        channelConfigs: {
          "cold-channel": {
            schema: { type: "object" },
          },
        },
        providerAuthChoices: [
          {
            provider: "cold-model-provider",
            method: "api-key",
            choiceId: "cold-provider-api-key",
            choiceLabel: "Cold Provider API key",
            groupId: "cold-model-provider",
            groupLabel: "Cold Provider",
            optionKey: "coldProviderApiKey",
            cliFlag: "--cold-provider-api-key",
            cliOption: "--cold-provider-api-key <key>",
            onboardingScopes: ["text-inference"],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "index.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(runtimeMarker)}, "loaded", "utf8");\nthrow new Error("runtime entry should not load for command control-plane discovery");\n`,
    "utf8",
  );
  return { rootDir, runtimeMarker };
}

function createColdConfig(pluginDir: string): OpenClawConfig {
  return {
    plugins: {
      load: { paths: [pluginDir] },
      entries: {
        "cold-control-plane": { enabled: true },
      },
    },
  };
}

afterEach(() => {
  clearPluginDiscoveryCache();
  clearPluginManifestRegistryCache();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("command control-plane plugin discovery", () => {
  it("resolves channel setup metadata without importing plugin runtime", () => {
    const plugin = createColdControlPlanePlugin();
    const workspaceDir = makeTempDir();
    const cfg = createColdConfig(plugin.rootDir);
    const env = hermeticEnv(workspaceDir);

    expect(
      listManifestInstalledChannelIds({
        cfg,
        workspaceDir,
        env,
      }),
    ).toContain("cold-channel");
    expect(fs.existsSync(plugin.runtimeMarker)).toBe(false);
  });

  it("builds onboarding auth choices from manifest metadata without importing plugin runtime", () => {
    const plugin = createColdControlPlanePlugin();
    const workspaceDir = makeTempDir();
    const cfg = createColdConfig(plugin.rootDir);
    const env = hermeticEnv(workspaceDir);

    expect(
      buildAuthChoiceOptions({
        store: {} as never,
        includeSkip: false,
        config: cfg,
        workspaceDir,
        env,
      }),
    ).toContainEqual(
      expect.objectContaining({
        value: "cold-provider-api-key",
        label: "Cold Provider API key",
        groupId: "cold-model-provider",
      }),
    );
    expect(
      formatAuthChoiceChoicesForCli({
        config: cfg,
        workspaceDir,
        env,
      }).split("|"),
    ).toContain("cold-provider-api-key");
    expect(fs.existsSync(plugin.runtimeMarker)).toBe(false);
  });

  it("resolves models-list provider ownership without importing plugin runtime", async () => {
    const plugin = createColdControlPlanePlugin();
    const workspaceDir = makeTempDir();
    const cfg = createColdConfig(plugin.rootDir);
    const env = hermeticEnv(workspaceDir, { disablePersistedRegistry: false });

    await refreshPluginRegistry({
      config: cfg,
      workspaceDir,
      env,
      reason: "manual",
    });
    expect(fs.existsSync(plugin.runtimeMarker)).toBe(false);

    await expect(
      resolveProviderCatalogPluginIdsForFilter({
        cfg,
        env,
        providerFilter: "cold-model-provider",
      }),
    ).resolves.toEqual(["cold-control-plane"]);
    expect(fs.existsSync(plugin.runtimeMarker)).toBe(false);
  });
});
