/** Tests dynamic provider env-var discovery from plugin metadata. */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeEnvVars } from "../agents/sandbox/sanitize-env-vars.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as pluginConfigState from "../plugins/config-state.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { buildPluginMetadataProviderFacts } from "../plugins/plugin-metadata-provider-facts.js";
import { resolveLocalProviderAuthEvidence } from "./provider-auth-evidence.js";
import {
  getProviderEnvVarsCore,
  listKnownProviderAuthEnvVarNamesCore,
  listKnownSecretEnvVarNames,
  resolveProviderAuthEnvVarCandidatesCore,
  resolveProviderAuthLookupMaps,
} from "./provider-env-vars.js";

type MockManifestPlugin = Pick<PluginManifestRecord, "id" | "origin"> &
  Partial<
    Pick<
      PluginManifestRecord,
      "kind" | "providers" | "providerUsageAuthEnvVars" | "providerAuthAliases" | "setup"
    >
  > & {
    enabled?: boolean;
    enabledByDefault?: boolean;
  };

type MockManifestRegistry = {
  plugins: MockManifestPlugin[];
  diagnostics: unknown[];
};

type MockSetupProvider = NonNullable<NonNullable<MockManifestPlugin["setup"]>["providers"]>[number];
type MockAuthEvidence = NonNullable<MockSetupProvider["authEvidence"]>[number];

const pluginRegistryMocks = vi.hoisted(() => {
  const loadManifestRegistry = vi.fn<(...args: unknown[]) => MockManifestRegistry>(() => ({
    plugins: [],
    diagnostics: [],
  }));
  return {
    getCurrentPluginMetadataSnapshot: vi.fn(),
    loadPluginManifestRegistryForInstalledIndex: loadManifestRegistry,
    loadPluginManifestRegistryForPluginRegistry: loadManifestRegistry,
    loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
    loadPluginMetadataSnapshot: vi.fn((params: unknown) => {
      const registry = loadManifestRegistry(params) ?? { plugins: [], diagnostics: [] };
      return metadataSnapshot(...registry.plugins);
    }),
  };
});

function setupPlugin(
  id: string,
  provider: Omit<MockSetupProvider, "id"> & { id?: string },
  extra: Partial<Omit<MockManifestPlugin, "id" | "setup">> = {},
): MockManifestPlugin {
  return { id, origin: "global", ...extra, setup: { providers: [{ id, ...provider }] } };
}

function metadataSnapshot(...plugins: MockManifestPlugin[]) {
  const records: PluginManifestRecord[] = plugins.map((plugin) => ({
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    rootDir: `/plugins/${plugin.id}`,
    source: `/plugins/${plugin.id}/index.js`,
    manifestPath: `/plugins/${plugin.id}/openclaw.plugin.json`,
    ...plugin,
  }));
  return {
    owners: buildPluginMetadataProviderFacts(records),
    index: {
      plugins: plugins.map((plugin) => ({
        pluginId: plugin.id,
        origin: plugin.origin,
        enabled: plugin.enabled ?? true,
        enabledByDefault: plugin.enabledByDefault ?? true,
      })),
    },
    plugins,
  };
}

const LOAD_PATH_PROVIDER_PLUGIN = setupPlugin("load-path-provider", {
  envVars: ["LOAD_PATH_PROVIDER_API_KEY"],
});

function useInstalledPlugins(...plugins: MockManifestPlugin[]): void {
  pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
    plugins,
    diagnostics: [],
  });
}

function useInstalledSetupPlugin(...params: Parameters<typeof setupPlugin>): void {
  useInstalledPlugins(setupPlugin(...params));
}

const localEvidence = (credentialMarker: string, fileEnvVar: string): MockAuthEvidence[] => [
  { type: "local-file-with-env", credentialMarker, fileEnvVar },
];

function usagePlugin(
  id: string,
  envVar: string,
  origin: MockManifestPlugin["origin"],
): MockManifestPlugin {
  return { id, origin, providerUsageAuthEnvVars: { [id]: [envVar] } };
}

const cloudCredential = {
  credentialMarker: "external-cloud-local-credentials",
  source: "local auth evidence",
};
function cloudEvidence(
  fallbackPaths = [
    "${EXTERNAL_CLOUD_CONFIG}/credentials.json",
    "${HOME}/credentials.json",
    "${APPDATA}/credentials.json",
  ],
  extra: Partial<MockAuthEvidence> = {},
): MockAuthEvidence[] {
  return [
    {
      type: "local-file-with-env",
      credentialMarker: cloudCredential.credentialMarker,
      fallbackPaths,
      ...extra,
    },
  ];
}
const workspaceEvidence = localEvidence(
  "workspace-cloud-local-credentials",
  "WORKSPACE_CLOUD_CREDENTIALS",
);

function mockExistingPaths(...paths: string[]) {
  return vi
    .spyOn(fs, "existsSync")
    .mockImplementation((candidate) => paths.some((path) => path === candidate));
}

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: pluginRegistryMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../plugins/manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex:
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex,
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry:
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry,
  loadPluginRegistrySnapshot: pluginRegistryMocks.loadPluginRegistrySnapshot,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginRegistryMocks.loadPluginMetadataSnapshot,
}));

describe("provider env vars dynamic manifest metadata", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReset();
    useInstalledPlugins();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReset().mockReturnValue({ plugins: [] });
    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockReset().mockReturnValue(undefined);
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockClear();
  });

  it("scrubs provider usage credentials without making them inference auth candidates", () => {
    useInstalledPlugins({
      ...usagePlugin("provider-billing", "PROVIDER_BILLING_CREDENTIAL", "global"),
      providers: ["provider-billing"],
    });

    expect(listKnownProviderAuthEnvVarNamesCore()).toContain("PROVIDER_BILLING_CREDENTIAL");
    expect(listKnownSecretEnvVarNames()).toContain("PROVIDER_BILLING_CREDENTIAL");
    expect(resolveProviderAuthEnvVarCandidatesCore()["provider-billing"]).toBeUndefined();
    expect(getProviderEnvVarsCore("provider-billing")).toStrictEqual([]);
    expect(
      sanitizeEnvVars({ PROVIDER_BILLING_CREDENTIAL: "billing-secret", SAFE_VALUE: "ok" }),
    ).toMatchObject({
      allowed: { SAFE_VALUE: "ok" },
      blocked: ["PROVIDER_BILLING_CREDENTIAL"],
    });
  });

  it("scrubs usage credentials using host metadata rather than the candidate sandbox env", () => {
    const configuredSnapshot = {
      workspaceDir: "/workspace",
      ...metadataSnapshot(
        usagePlugin("configured-billing", "CONFIGURED_BILLING_CREDENTIAL", "workspace"),
        usagePlugin("disabled-workspace", "PATH", "workspace"),
      ),
      owners: buildPluginMetadataProviderFacts([]),
    };
    for (const plugin of configuredSnapshot.index.plugins.slice(1)) {
      Object.assign(plugin, { enabled: false, enabledByDefault: false });
    }
    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockImplementation(
      (params: { env?: NodeJS.ProcessEnv }) =>
        !params.env || params.env === process.env ? configuredSnapshot : undefined,
    );

    expect(
      sanitizeEnvVars({
        CONFIGURED_BILLING_CREDENTIAL: "billing-secret",
        PATH: "/usr/bin",
        SAFE_VALUE: "ok",
      }),
    ).toMatchObject({
      allowed: { PATH: "/usr/bin", SAFE_VALUE: "ok" },
      blocked: ["CONFIGURED_BILLING_CREDENTIAL"],
    });
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("expands provider-owned directory variables in manifest credential evidence", () => {
    useInstalledSetupPlugin("external-cloud", {
      authEvidence: cloudEvidence(
        ["${EXTERNAL_CLOUD_CONFIG}/application_default_credentials.json"],
        {
          requiresAllEnv: ["EXTERNAL_CLOUD_PROJECT"],
          source: "external cloud credentials",
        },
      ),
    });
    const evidence = resolveProviderAuthLookupMaps().authEvidenceMap["external-cloud"];
    const expectedPath = "/fixture/cloud-sdk/application_default_credentials.json";
    const existsSync = mockExistingPaths(expectedPath);

    expect(
      resolveLocalProviderAuthEvidence(evidence, {
        EXTERNAL_CLOUD_CONFIG: "/fixture/cloud-sdk",
        EXTERNAL_CLOUD_PROJECT: "fixture-project",
      }),
    ).toEqual({
      credentialMarker: "external-cloud-local-credentials",
      source: "external cloud credentials",
    });
    expect(existsSync).toHaveBeenCalledWith(expectedPath);
  });

  it("rejects stale home evidence when an explicit provider directory has no credentials", () => {
    useInstalledSetupPlugin("external-cloud", {
      authEvidence: cloudEvidence(),
    });
    const evidence = resolveProviderAuthLookupMaps().authEvidenceMap["external-cloud"];
    const existsSync = mockExistingPaths("/fixture/home/credentials.json");

    expect(
      resolveLocalProviderAuthEvidence(evidence, {
        EXTERNAL_CLOUD_CONFIG: "/fixture/missing-cloud-sdk",
        HOME: "/fixture/home",
        APPDATA: "/fixture/appdata",
      }),
    ).toBeNull();
    expect(existsSync).toHaveBeenCalledOnce();
    expect(existsSync).toHaveBeenCalledWith("/fixture/missing-cloud-sdk/credentials.json");
  });

  it.each<{ name: string; env: NodeJS.ProcessEnv }>([
    { name: "home", env: { HOME: "/fixture/home" } },
    {
      name: "appdata after a blank override",
      env: {
        EXTERNAL_CLOUD_CONFIG: "   ",
        HOME: "/fixture/missing-home",
        APPDATA: "/fixture/appdata",
      },
    },
  ])("preserves $name fallback without an explicit provider directory", ({ env }) => {
    mockExistingPaths("/fixture/home/credentials.json", "/fixture/appdata/credentials.json");
    expect(resolveLocalProviderAuthEvidence(cloudEvidence(), env)).toEqual(cloudCredential);
  });

  it.each([undefined, "/fixture/${literal}"])(
    "expands only manifest placeholders (directory: %s)",
    (directory) => {
      const existsSync = vi.spyOn(fs, "existsSync").mockReturnValue(true);
      expect(
        resolveLocalProviderAuthEvidence(
          cloudEvidence(["${EXTERNAL_CLOUD_CONFIG}/credentials.json"]),
          directory === undefined ? {} : { EXTERNAL_CLOUD_CONFIG: directory },
        ),
      ).toEqual(directory === undefined ? null : cloudCredential);
      if (directory === undefined) {
        expect(existsSync).not.toHaveBeenCalled();
      } else {
        expect(existsSync).toHaveBeenCalledWith("/fixture/${literal}/credentials.json");
      }
    },
  );

  it("does not reuse a load-path current snapshot for default provider env lookups", () => {
    const staleSnapshot = metadataSnapshot(LOAD_PATH_PROVIDER_PLUGIN);
    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockImplementation(
      (params: { config?: unknown; requireDefaultDiscoveryContext?: boolean }) => {
        if (params.config || params.requireDefaultDiscoveryContext) {
          return undefined;
        }
        return staleSnapshot;
      },
    );

    expect(
      resolveProviderAuthEnvVarCandidatesCore({ config: {} })["load-path-provider"],
    ).toBeUndefined();
    expect(pluginRegistryMocks.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
      env: process.env,
      allowWorkspaceScopedSnapshot: true,
      requireDefaultDiscoveryContext: true,
    });
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).toHaveBeenCalled();
  });

  it("reuses lookup maps only for immutable configs", () => {
    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(
      metadataSnapshot(LOAD_PATH_PROVIDER_PLUGIN),
    );
    const frozen: OpenClawConfig = Object.freeze({ plugins: Object.freeze({}) });
    expect(resolveProviderAuthLookupMaps({ config: frozen })).toBe(
      resolveProviderAuthLookupMaps({ config: frozen }),
    );

    // A mutable config can change in place, so every read recomputes its maps.
    const mutable: OpenClawConfig = { plugins: {} };
    expect(resolveProviderAuthLookupMaps({ config: mutable })).not.toBe(
      resolveProviderAuthLookupMaps({ config: mutable }),
    );

    // The live runtime snapshot is mutable, but each publication advances its revision key.
    try {
      setRuntimeConfigSnapshot(mutable);
      const published = resolveProviderAuthLookupMaps({ config: mutable });
      expect(resolveProviderAuthLookupMaps({ config: mutable })).toBe(published);
      mutable.plugins = { allow: ["edited-in-place"] };
      setRuntimeConfigSnapshot(mutable);
      expect(resolveProviderAuthLookupMaps({ config: mutable })).not.toBe(published);
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it.each([false, true])("requires workspace trust for auth evidence (trusted: %s)", (trusted) => {
    useInstalledSetupPlugin(
      "workspace-cloud",
      { authEvidence: workspaceEvidence },
      { origin: "workspace" },
    );

    expect(
      resolveProviderAuthLookupMaps({
        config: { plugins: trusted ? { allow: ["workspace-cloud"] } : {} },
      }).authEvidenceMap["workspace-cloud"],
    ).toEqual(trusted ? workspaceEvidence : undefined);
  });

  it("excludes untrusted workspace plugin env vars when requested", () => {
    useInstalledPlugins({
      id: "workspace-audio",
      origin: "workspace",
      setup: {
        providers: [
          { id: "whisperx", envVars: ["AWS_SECRET_ACCESS_KEY"] },
          { id: "workspace-setup", envVars: ["WORKSPACE_SETUP_SECRET"] },
        ],
      },
    });

    const options = { config: { plugins: {} }, includeUntrustedWorkspacePlugins: false };
    expect(getProviderEnvVarsCore("whisperx", options)).toStrictEqual([]);
    expect(getProviderEnvVarsCore("workspace-setup", options)).toStrictEqual([]);
    expect(listKnownProviderAuthEnvVarNamesCore(options)).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(listKnownProviderAuthEnvVarNamesCore(options)).not.toContain("WORKSPACE_SETUP_SECRET");
  });

  it.each([false, true])(
    "trusts the context-engine slot only for an engine (engine: %s)",
    (engine) => {
      useInstalledSetupPlugin(
        "workspace-engine",
        { id: "whisperx", envVars: [engine ? "WHISPERX_API_KEY" : "AWS_SECRET_ACCESS_KEY"] },
        { origin: "workspace", ...(engine ? { kind: "context-engine" } : {}) },
      );

      expect(
        getProviderEnvVarsCore("whisperx", {
          config: { plugins: { slots: { contextEngine: "workspace-engine" } } },
          includeUntrustedWorkspacePlugins: false,
        }),
      ).toStrictEqual(engine ? ["WHISPERX_API_KEY"] : []);
    },
  );

  it("resolves auth maps with policy work bounded to contributing plugins", () => {
    const fireworksEvidence = localEvidence("fireworks-local-credentials", "FIREWORKS_CREDENTIALS");
    useInstalledPlugins(
      setupPlugin(
        "external-fireworks",
        {
          id: "fireworks",
          envVars: ["FIREWORKS_ALT_API_KEY"],
          authEvidence: fireworksEvidence,
        },
        { origin: "global", providerAuthAliases: { "fireworks-plan": "fireworks" } },
      ),
      {
        id: "legacy-setup-owner",
        origin: "global",
        providers: ["legacy-cloud"],
        providerAuthAliases: { "legacy-cloud-plan": "legacy-cloud" },
      },
      { id: "channel-only", origin: "bundled", providers: [] },
      {
        id: "metadata-only",
        origin: "bundled",
        setup: {
          requiresRuntime: false,
          providers: [{ id: "metadata-only", envVars: ["METADATA_ONLY_API_KEY"] }],
        },
      },
    );

    const policy = vi.spyOn(pluginConfigState, "resolveEffectivePluginActivationState");
    const lookupMaps = resolveProviderAuthLookupMaps({ config: {} });
    expect(policy.mock.calls.length).toBeLessThanOrEqual(2);
    expect(policy.mock.calls.map(([{ id }]) => id)).not.toContain("channel-only");
    expect(policy.mock.calls.map(([{ id }]) => id)).not.toContain("metadata-only");

    expect(lookupMaps.aliasMap["fireworks-plan"]).toBe("fireworks");
    expect(lookupMaps.envCandidateMap["metadata-only"]).toEqual(["METADATA_ONLY_API_KEY"]);
    expect(lookupMaps.envCandidateMap["fireworks-plan"]).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(lookupMaps.authEvidenceMap["fireworks-plan"]).toEqual(fireworksEvidence);
    expect(lookupMaps.setupProviderFallbackRefs).toEqual([
      "fireworks",
      "fireworks-plan",
      "legacy-cloud",
      "legacy-cloud-plan",
    ]);
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).toHaveBeenCalledTimes(1);
  });

  it("updates runtime auth evidence and fallback refs without dropping disabled credential hints", () => {
    const plugin = setupPlugin(
      "disabled-setup-owner",
      {
        id: "disabled-cloud",
        envVars: ["DISABLED_CLOUD_API_KEY"],
        authEvidence: [{ type: "local-file-with-env", credentialMarker: "cloud-local" }],
      },
      {
        enabled: false,
        providers: ["disabled-cloud"],
        providerAuthAliases: { "disabled-cloud-plan": "disabled-cloud" },
      },
    );

    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(metadataSnapshot(plugin));
    const config = { plugins: { entries: { "disabled-setup-owner": { enabled: false } } } };
    for (const enabled of [false, true, false]) {
      config.plugins.entries["disabled-setup-owner"].enabled = enabled;
      const lookupMaps = resolveProviderAuthLookupMaps({ config, workspaceDir: "/workspace" });
      expect(lookupMaps.setupProviderFallbackRefs).toEqual(
        enabled ? ["disabled-cloud", "disabled-cloud-plan"] : [],
      );
      expect(lookupMaps.authEvidenceMap["disabled-cloud-plan"]).toEqual(
        enabled ? plugin.setup?.providers?.[0]?.authEvidence : undefined,
      );
      expect(lookupMaps.envCandidateMap["disabled-cloud-plan"]).toEqual(["DISABLED_CLOUD_API_KEY"]);
    }
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });
});
