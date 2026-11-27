import path from "node:path";
import { afterAll } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { withIsolatedTestHome } from "../../../../test/test-env.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db-cache.js";

type PluginFixture = { id: string; npmSpec: string; label?: string };
type ChannelFixture = PluginFixture & { trustedSourceLinkedOfficialInstall?: boolean };
type InstallRecords = Record<string, Record<string, unknown>>;

export function configuredPlugin(id: string): OpenClawConfig {
  return { plugins: { entries: { [id]: { enabled: true } } } };
}

export function setupPluginInstallTestState() {
  const testHome = withIsolatedTestHome({ mode: "hermetic" });
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      // Reuse lease storage between cases and drain it before removing its files.
      await closeOpenClawStateDatabaseAsync();
      cleanup();
      testHome.cleanup();
    }),
  );
  const testEnv: NodeJS.ProcessEnv = {
    HOME: testHome.tempHome,
    OPENCLAW_HOME: testHome.tempHome,
    OPENCLAW_STATE_DIR: path.join(testHome.tempHome, ".openclaw"),
  };
  return { testEnv, tempDirs };
}

export function officialPluginEntry(
  params: PluginFixture & {
    manifest?: Record<string, unknown>;
    overrides?: Record<string, unknown>;
  },
) {
  const { id, npmSpec, label = id, manifest, overrides } = params;
  return {
    id,
    label,
    install: { npmSpec, defaultChoice: "npm" },
    ...(manifest ? { openclaw: { plugin: { id, label }, ...manifest } } : {}),
    ...overrides,
  };
}

export function officialWebSearchPluginEntry(
  params: PluginFixture & {
    envVar: string;
    providerLabel?: string;
    credentialPath?: string;
    includeManifestInstall?: boolean;
  },
) {
  const label = params.label ?? params.id;
  const providerLabel = params.providerLabel ?? label;
  const install = { npmSpec: params.npmSpec, defaultChoice: "npm" };
  const provider = {
    id: params.id,
    label: providerLabel,
    hint: providerLabel,
    envVars: [params.envVar],
    placeholder: `${params.id}-key`,
    signupUrl: `https://example.test/${params.id}`,
    ...(params.credentialPath ? { credentialPath: params.credentialPath } : {}),
  };
  return officialPluginEntry({
    ...params,
    label,
    manifest: {
      webSearchProviders: [provider],
      ...(params.includeManifestInstall ? { install } : {}),
    },
  });
}

export function channelPluginEntry(params: ChannelFixture) {
  const { id, npmSpec, label = id, trustedSourceLinkedOfficialInstall } = params;
  return {
    id,
    pluginId: id,
    meta: { label },
    install: { npmSpec, defaultChoice: "npm" },
    ...(trustedSourceLinkedOfficialInstall === undefined
      ? {}
      : { trustedSourceLinkedOfficialInstall }),
  };
}

export function installedRecords(
  pluginId: string,
  overrides: Record<string, unknown>,
): InstallRecords {
  return { [pluginId]: { source: "npm", ...overrides } };
}

export function successfulInstall(params: {
  pluginId: string;
  npmSpec: string;
  version?: string;
  targetDir?: string;
  resolution?: Record<string, unknown>;
}) {
  const version = params.version ?? "2026.6.8";
  return {
    ok: true as const,
    pluginId: params.pluginId,
    targetDir: params.targetDir ?? `/tmp/openclaw-plugins/${params.pluginId}`,
    version,
    npmResolution: {
      name: params.npmSpec,
      version,
      resolvedSpec: `${params.npmSpec}@${version}`,
      integrity: `sha512-${params.pluginId}`,
      resolvedAt: "2026-05-01T00:00:00.000Z",
      ...params.resolution,
    },
  };
}

export function successfulUpdate(pluginId: string, installs: InstallRecords) {
  return {
    changed: true,
    config: { plugins: { installs } },
    outcomes: [{ pluginId, status: "updated", message: `Updated ${pluginId}.` }],
  };
}

export function brokenPluginSnapshot(
  pluginId: string,
  source: string,
  expectedEntry = "./dist/index.js",
) {
  const message = `installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ${expectedEntry}.`;
  return { plugins: [], diagnostics: [{ level: "error", pluginId, source, message }] };
}
