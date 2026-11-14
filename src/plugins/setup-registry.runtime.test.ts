import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  clearBundledDiscoveryModeMemo,
  prepareBundledDiscoveryMode,
} from "./bundled-discovery-state.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  projectPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

type Fixture = NonNullable<Parameters<typeof createPluginMetadataSnapshotFixture>[0]>;

// Selection is real; these runtime lookups must never fall back to discovery.
vi.mock("./plugin-registry-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-registry-snapshot.js")>()),
  loadPluginRegistrySnapshotWithMetadata: () => {
    throw new Error("Runtime CLI classification must not rediscover plugins");
  },
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    clearPluginMetadataLifecycleCaches();
    resetPluginRuntimeStateForTest();
    vi.restoreAllMocks();
    for (const stateDir of tempDirs.dirs) {
      await closeOpenClawStateDatabaseByPathAsync(
        resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
      );
    }
    cleanup();
  }),
);

function metadata(...plugins: Fixture["plugins"]) {
  return createPluginMetadataSnapshotFixture({ plugins });
}

function scoped<T extends { restore(): void }>(resource: T) {
  return Object.assign(resource, { [Symbol.dispose]: () => resource.restore() });
}

const { isCliProvider, prepareCliProviderClassifier } =
  await import("../agents/model-selection-cli.js");
const inSnapshot = <T>(snapshot: PluginMetadataSnapshot, run: () => T) =>
  withPluginMetadataSnapshotScope(snapshot, run, { trustConfigIdentity: true });

function currentSnapshot(hash: string, backend: string, workspaceDir?: string) {
  const snapshot = metadata({
    id: "openai",
    rootDir: `/tmp/openai-${hash}`,
    cliBackends: [backend],
  });
  snapshot.index.policyHash = snapshot.policyHash = resolveInstalledPluginIndexPolicyHash({});
  return Object.assign(snapshot, { configFingerprint: hash, workspaceDir });
}

it("keeps prepared CLI activation in the caller's machine-state root", async () => {
  const compatRoot = tempDirs.make("openclaw-cli-compat-");
  const strictRoot = tempDirs.make("openclaw-cli-strict-");
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  try {
    await using cache = createPluginCache();
    setTestEnvValue("OPENCLAW_STATE_DIR", strictRoot);
    const compatEnv = { ...process.env, OPENCLAW_STATE_DIR: compatRoot };
    const strictEnv = { ...process.env, OPENCLAW_STATE_DIR: strictRoot };
    writeConfigMachineState("plugins.bundledDiscovery", "compat", { env: compatEnv });
    writeConfigMachineState("plugins.bundledDiscovery", "allowlist", { env: strictEnv });
    clearBundledDiscoveryModeMemo();
    await withPluginCache(cache, async () => {
      const snapshot = metadata({
        id: "bundled-cli-owner",
        providers: ["fixture-provider"],
        cliBackends: ["scope-cli"],
      });
      snapshot.index.plugins[0]!.contributions = {
        channels: [],
        channelConfigs: [],
        providers: snapshot.plugins[0]!.providers,
        modelCatalogProviders: [],
        modelSupportPrefixes: [],
        modelSupportPatterns: [],
        autoEnableProviderIds: [],
        commandAliases: [],
        contracts: {},
      };
      const config = { plugins: { allow: ["other-owner"] } };
      await prepareBundledDiscoveryMode(compatEnv);
      await prepareBundledDiscoveryMode(strictEnv);
      using sql = scoped(observeMainThreadSql());
      sql.calibrate();
      for (const env of [compatEnv, strictEnv, compatEnv]) {
        setTestEnvValue("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
        const enabled = env === compatEnv;
        expect(isCliProvider("scope-cli", config, snapshot)).toBe(enabled);
        inSnapshot(snapshot, () =>
          expect(prepareCliProviderClassifier(config)("scope-cli")).toBe(enabled),
        );
      }
      sql.expectIdle();
    });
  } finally {
    envSnapshot.restore();
  }
});

it("classifies case-equivalent owners and enabled setup contributions", async () => {
  const snapshot = metadata(
    { id: "first-owner", cliBackends: ["Shared-CLI", "disabled-cli"] },
    {
      id: "second-owner",
      cliBackends: ["shared-cli"],
      setup: { cliBackends: ["shared-cli", "SHARED-CLI", "setup-cli"] },
    },
    { id: "third-owner", cliBackends: ["Shared-CLI"] },
  );
  const config = { plugins: { entries: { "first-owner": { enabled: false } } } };
  inSnapshot(snapshot, () => {
    const classify = prepareCliProviderClassifier(config);
    for (const backend of ["SHARED-CLI", "SETUP-CLI"]) {
      expect(isCliProvider(backend, config)).toBe(true);
      expect(classify(backend)).toBe(true);
    }
    expect(isCliProvider("disabled-cli", config)).toBe(false);
    expect(classify("disabled-cli")).toBe(false);
  });
});

it("keeps descriptors inside a narrower scoped view of the same metadata generation", async () => {
  const snapshot = currentSnapshot("scoped", "Scoped-CLI");
  const narrowed = projectPluginMetadataSnapshot(snapshot, []);
  const resolve = (view: PluginMetadataSnapshot) =>
    inSnapshot(view, () => isCliProvider("scoped-cli"));

  expect(resolve(snapshot)).toBe(true);
  expect(resolve(narrowed)).toBe(false);
  expect(resolve(snapshot)).toBe(true);
});

it("uses workspace-scoped current metadata through the active plugin runtime", async () => {
  setActivePluginRegistry(
    createEmptyPluginRegistry(),
    "workspace-a",
    "gateway-bindable",
    "/workspace/a",
  );
  for (const [manifestHash, backend, missing] of [
    ["alpha", "Workspace-Alpha-CLI", "workspace-bravo-cli"],
    ["bravo", "Workspace-Bravo-CLI", "workspace-alpha-cli"],
  ] as const) {
    setCurrentPluginMetadataSnapshot(currentSnapshot(manifestHash, backend, "/workspace/a"), {
      config: {},
      env: process.env,
    });
    expect(isCliProvider(backend.toLowerCase(), {})).toBe(true);
    expect(isCliProvider(missing, {})).toBe(false);
  }
});
