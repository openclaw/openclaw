/** Proves Gateway pre-service plugin metadata preserves diagnostics trust provenance. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { writePersistedInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-records.js";
import { loadOpenClawPlugins } from "./loader.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-gateway-effective-trust", tempDirs);
}

function writeDiagnosticsOtelPlugin(rootDir: string): void {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: "diagnostics-otel",
        configSchema: { type: "object" },
        activation: { onStartup: true },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({ name: "@openclaw/diagnostics-otel", version: "2026.5.28" }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(rootDir, "index.cjs"),
    "module.exports = { id: 'diagnostics-otel', register() {} };\n",
    "utf-8",
  );
}

function createDiagnosticsOtelInstallRecord(installPath: string): PluginInstallRecord {
  return {
    source: "npm",
    spec: "@openclaw/diagnostics-otel",
    installPath,
    resolvedName: "@openclaw/diagnostics-otel",
    resolvedVersion: "2026.5.28",
    resolvedSpec: "@openclaw/diagnostics-otel@2026.5.28",
  };
}

function createDiagnosticsOtelConfig(params: {
  installRecord: PluginInstallRecord;
  pluginRoot: string;
}): OpenClawConfig {
  return {
    plugins: {
      enabled: true,
      allow: ["diagnostics-otel"],
      load: { paths: [params.pluginRoot] },
      entries: { "diagnostics-otel": { enabled: true } },
      installs: { "diagnostics-otel": params.installRecord },
    },
  };
}

function loadGatewayPreServiceDiagnosticsTrust(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir: string;
}): {
  manifestTrustedOfficialInstall: boolean;
  loaderTrustedOfficialInstall: boolean;
  loaderStatus: string | undefined;
} {
  const metadata = resolvePluginMetadataSnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    allowCurrent: false,
    allowWorkspaceScopedCurrent: false,
  });
  const manifestRecord = metadata.manifestRegistry.plugins.find(
    (entry) => entry.id === "diagnostics-otel",
  );
  const registry = loadOpenClawPlugins({
    cache: false,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: ["diagnostics-otel"],
    manifestRegistry: metadata.manifestRegistry,
  });
  const loaderRecord = registry.plugins.find((entry) => entry.id === "diagnostics-otel");
  return {
    manifestTrustedOfficialInstall: manifestRecord?.trustedOfficialInstall === true,
    loaderTrustedOfficialInstall: loaderRecord?.trustedOfficialInstall === true,
    loaderStatus: loaderRecord?.status,
  };
}

describe("Gateway diagnostics-otel effective trust path", () => {
  it("keeps config-authored diagnostics-otel installs untrusted on the precomputed Gateway path", () => {
    const rootDir = makeTempDir();
    const stateDir = path.join(rootDir, "state");
    const workspaceDir = path.join(rootDir, "workspace");
    const pluginRoot = path.join(rootDir, "usr-lib-node-modules", "@openclaw", "diagnostics-otel");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    writeDiagnosticsOtelPlugin(pluginRoot);

    const installRecord = createDiagnosticsOtelInstallRecord(pluginRoot);
    const config = createDiagnosticsOtelConfig({ installRecord, pluginRoot });
    const env = {
      ...process.env,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "true",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.5.28",
      VITEST: "true",
    } as NodeJS.ProcessEnv;

    const result = loadGatewayPreServiceDiagnosticsTrust({ config, env, workspaceDir });

    expect(result.loaderStatus).toBe("loaded");
    expect(result.manifestTrustedOfficialInstall).toBe(false);
    expect(result.loaderTrustedOfficialInstall).toBe(false);
  });

  it("trusts persisted diagnostics-otel installs before Gateway services start", () => {
    const rootDir = makeTempDir();
    const stateDir = path.join(rootDir, "state");
    const workspaceDir = path.join(rootDir, "workspace");
    const pluginRoot = path.join(rootDir, "usr-lib-node-modules", "@openclaw", "diagnostics-otel");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    writeDiagnosticsOtelPlugin(pluginRoot);

    const installRecord = createDiagnosticsOtelInstallRecord(pluginRoot);
    const config = createDiagnosticsOtelConfig({ installRecord, pluginRoot });
    const env = {
      ...process.env,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "true",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.5.28",
      VITEST: "true",
    } as NodeJS.ProcessEnv;
    writePersistedInstalledPluginIndexInstallRecordsSync(
      { "diagnostics-otel": installRecord },
      { stateDir, env },
    );

    const result = loadGatewayPreServiceDiagnosticsTrust({ config, env, workspaceDir });

    expect(result.loaderStatus).toBe("loaded");
    expect(result.manifestTrustedOfficialInstall).toBe(true);
    expect(result.loaderTrustedOfficialInstall).toBe(true);
  });
});
