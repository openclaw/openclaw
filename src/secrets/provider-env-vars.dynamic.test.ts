/** Tests dynamic provider env-var discovery from plugin metadata. */
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeEnvVars } from "../agents/sandbox/sanitize-env-vars.js";
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

type MockManifestPlugin = {
  id: string;
  origin: PluginManifestRecord["origin"];
  enabled?: boolean;
  enabledByDefault?: boolean;
  kind?: "memory" | "context-engine" | Array<"memory" | "context-engine">;
  providers?: string[];
  providerUsageAuthEnvVars?: Record<string, string[]>;
  providerAuthAliases?: Record<string, string>;
  setup?: {
    requiresRuntime?: boolean;
    providers?: Array<{
      id: string;
      envVars?: string[];
      authEvidence?: Array<{
        type: "local-file-with-env";
        fileEnvVar?: string;
        fallbackPaths?: string[];
        requiresAnyEnv?: string[];
        requiresAllEnv?: string[];
        credentialMarker: string;
        source?: string;
      }>;
    }>;
  };
};

type MockManifestRegistry = {
  plugins: MockManifestPlugin[];
  diagnostics: unknown[];
};

type MockSetupProvider = NonNullable<NonNullable<MockManifestPlugin["setup"]>["providers"]>[number];

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

function manifestRegistry(...plugins: MockManifestPlugin[]): MockManifestRegistry {
  return { plugins, diagnostics: [] };
}

function setupPlugin(
  id: string,
  origin: PluginManifestRecord["origin"],
  provider: MockSetupProvider,
  extra: Omit<MockManifestPlugin, "id" | "origin" | "setup"> = {},
): MockManifestPlugin {
  return { id, origin, ...extra, setup: { providers: [provider] } };
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

const LOAD_PATH_PROVIDER_PLUGIN = setupPlugin("load-path-provider", "global", {
  id: "load-path-provider",
  envVars: ["LOAD_PATH_PROVIDER_API_KEY"],
});

function useInstalledPlugins(...plugins: MockManifestPlugin[]): void {
  pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
    manifestRegistry(...plugins),
  );
}

function useInstalledSetupPlugin(
  id: string,
  origin: PluginManifestRecord["origin"],
  provider: MockSetupProvider,
  extra?: Omit<MockManifestPlugin, "id" | "origin" | "setup">,
): void {
  useInstalledPlugins(setupPlugin(id, origin, provider, extra));
}

function useRegistryPlugins(...plugins: MockManifestPlugin[]): void {
  pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue(
    manifestRegistry(...plugins),
  );
}

function useRegistrySetupPlugin(
  id: string,
  origin: PluginManifestRecord["origin"],
  provider: MockSetupProvider,
): void {
  useRegistryPlugins(setupPlugin(id, origin, provider));
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
  beforeEach(() => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReset();
    useInstalledPlugins();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockReset();
    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(undefined);
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockClear();
  });

  it("scrubs provider usage credentials without making them inference auth candidates", () => {
    useInstalledPlugins({
      id: "provider-billing",
      origin: "global",
      providers: ["provider-billing"],
      providerUsageAuthEnvVars: {
        "provider-billing": ["PROVIDER_BILLING_CREDENTIAL"],
      },
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
      owners: buildPluginMetadataProviderFacts([]),
      index: {
        plugins: [
          {
            pluginId: "configured-billing",
            origin: "workspace",
            enabled: true,
            enabledByDefault: true,
          },
          {
            pluginId: "disabled-workspace",
            origin: "workspace",
            enabled: false,
            enabledByDefault: false,
          },
        ],
      },
      plugins: [
        {
          id: "configured-billing",
          origin: "workspace",
          providerUsageAuthEnvVars: {
            "configured-billing": ["CONFIGURED_BILLING_CREDENTIAL"],
          },
        },
        {
          id: "disabled-workspace",
          origin: "workspace",
          providerUsageAuthEnvVars: {
            "disabled-workspace": ["PATH"],
          },
        },
      ],
    };
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
    useRegistrySetupPlugin("external-cloud", "global", {
      id: "external-cloud",
      authEvidence: [
        {
          type: "local-file-with-env",
          fallbackPaths: ["${EXTERNAL_CLOUD_CONFIG}/application_default_credentials.json"],
          requiresAllEnv: ["EXTERNAL_CLOUD_PROJECT"],
          credentialMarker: "external-cloud-local-credentials",
          source: "external cloud credentials",
        },
      ],
    });
    const evidence = resolveProviderAuthLookupMaps().authEvidenceMap["external-cloud"];
    const expectedPath = "/fixture/cloud-sdk/application_default_credentials.json";
    const existsSync = vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return candidate === expectedPath;
    });

    try {
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
    } finally {
      existsSync.mockRestore();
    }
  });

  it("rejects stale home evidence when an explicit provider directory has no credentials", () => {
    useRegistrySetupPlugin("external-cloud", "global", {
      id: "external-cloud",
      authEvidence: [
        {
          type: "local-file-with-env",
          fallbackPaths: [
            "${EXTERNAL_CLOUD_CONFIG}/credentials.json",
            "${HOME}/credentials.json",
            "${APPDATA}/credentials.json",
          ],
          credentialMarker: "external-cloud-local-credentials",
        },
      ],
    });
    const evidence = resolveProviderAuthLookupMaps().authEvidenceMap["external-cloud"];
    const existsSync = vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return candidate === "/fixture/home/credentials.json";
    });

    try {
      expect(
        resolveLocalProviderAuthEvidence(evidence, {
          EXTERNAL_CLOUD_CONFIG: "/fixture/missing-cloud-sdk",
          HOME: "/fixture/home",
          APPDATA: "/fixture/appdata",
        }),
      ).toBeNull();
      expect(existsSync).toHaveBeenCalledOnce();
      expect(existsSync).toHaveBeenCalledWith("/fixture/missing-cloud-sdk/credentials.json");
    } finally {
      existsSync.mockRestore();
    }
  });

  it("preserves home and appdata fallback when no provider directory is selected", () => {
    const fallbackPaths = [
      "${EXTERNAL_CLOUD_CONFIG}/credentials.json",
      "${HOME}/credentials.json",
      "${APPDATA}/credentials.json",
    ];
    const evidence = [
      {
        type: "local-file-with-env" as const,
        fallbackPaths,
        credentialMarker: "external-cloud-local-credentials",
      },
    ];
    const existsSync = vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return (
        candidate === "/fixture/home/credentials.json" ||
        candidate === "/fixture/appdata/credentials.json"
      );
    });

    try {
      expect(resolveLocalProviderAuthEvidence(evidence, { HOME: "/fixture/home" })).toEqual({
        credentialMarker: "external-cloud-local-credentials",
        source: "local auth evidence",
      });
      expect(
        resolveLocalProviderAuthEvidence(evidence, {
          EXTERNAL_CLOUD_CONFIG: "   ",
          HOME: "/fixture/missing-home",
          APPDATA: "/fixture/appdata",
        }),
      ).toEqual({
        credentialMarker: "external-cloud-local-credentials",
        source: "local auth evidence",
      });
    } finally {
      existsSync.mockRestore();
    }
  });

  it("accepts placeholder text introduced by an environment value", () => {
    const existsSync = vi.spyOn(fs, "existsSync").mockReturnValue(true);

    try {
      expect(
        resolveLocalProviderAuthEvidence(
          [
            {
              type: "local-file-with-env",
              fallbackPaths: ["${EXTERNAL_CLOUD_CONFIG}/credentials.json"],
              credentialMarker: "external-cloud-local-credentials",
            },
          ],
          { EXTERNAL_CLOUD_CONFIG: "/fixture/${literal}" },
        ),
      ).toEqual({
        credentialMarker: "external-cloud-local-credentials",
        source: "local auth evidence",
      });
      expect(existsSync).toHaveBeenCalledWith("/fixture/${literal}/credentials.json");
    } finally {
      existsSync.mockRestore();
    }
  });

  it.each([
    {
      scenario: "missing variable",
      fallbackPath: "${EXTERNAL_CLOUD_CONFIG}/credentials.json",
      env: {},
    },
  ])("rejects manifest credential evidence with a $scenario", ({ fallbackPath, env }) => {
    const existsSync = vi.spyOn(fs, "existsSync").mockReturnValue(true);

    try {
      expect(
        resolveLocalProviderAuthEvidence(
          [
            {
              type: "local-file-with-env",
              fallbackPaths: [fallbackPath],
              credentialMarker: "external-cloud-local-credentials",
            },
          ],
          env,
        ),
      ).toBeNull();
      expect(existsSync).not.toHaveBeenCalled();
    } finally {
      existsSync.mockRestore();
    }
  });

  it("reuses the current compatible metadata snapshot for workspace auth evidence", () => {
    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(
      metadataSnapshot(
        setupPlugin("external-cloud", "global", {
          id: "external-cloud",
          authEvidence: [
            {
              type: "local-file-with-env",
              fileEnvVar: "EXTERNAL_CLOUD_CREDENTIALS",
              credentialMarker: "external-cloud-local-credentials",
            },
          ],
        }),
      ),
    );

    expect(
      resolveProviderAuthLookupMaps({
        config: {},
        workspaceDir: "/workspace",
      }).authEvidenceMap["external-cloud"],
    ).toEqual([
      {
        type: "local-file-with-env",
        fileEnvVar: "EXTERNAL_CLOUD_CREDENTIALS",
        credentialMarker: "external-cloud-local-credentials",
      },
    ]);
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

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

  it("excludes untrusted workspace plugin auth evidence by default", () => {
    useRegistrySetupPlugin("workspace-cloud", "workspace", {
      id: "workspace-cloud",
      authEvidence: [
        {
          type: "local-file-with-env",
          fileEnvVar: "WORKSPACE_CLOUD_CREDENTIALS",
          credentialMarker: "workspace-cloud-local-credentials",
        },
      ],
    });

    expect(
      resolveProviderAuthLookupMaps({ config: { plugins: {} } }).authEvidenceMap["workspace-cloud"],
    ).toBeUndefined();
  });

  it("keeps explicitly trusted workspace plugin auth evidence", () => {
    useRegistrySetupPlugin("workspace-cloud", "workspace", {
      id: "workspace-cloud",
      authEvidence: [
        {
          type: "local-file-with-env",
          fileEnvVar: "WORKSPACE_CLOUD_CREDENTIALS",
          credentialMarker: "workspace-cloud-local-credentials",
        },
      ],
    });

    expect(
      resolveProviderAuthLookupMaps({
        config: {
          plugins: {
            allow: ["workspace-cloud"],
          },
        },
      }).authEvidenceMap["workspace-cloud"],
    ).toEqual([
      {
        type: "local-file-with-env",
        fileEnvVar: "WORKSPACE_CLOUD_CREDENTIALS",
        credentialMarker: "workspace-cloud-local-credentials",
      },
    ]);
  });

  it("excludes untrusted workspace plugin env vars when requested", async () => {
    useInstalledPlugins({
      id: "workspace-audio",
      origin: "workspace",
      setup: {
        providers: [
          {
            id: "whisperx",
            envVars: ["AWS_SECRET_ACCESS_KEY"],
          },
          {
            id: "workspace-setup",
            envVars: ["WORKSPACE_SETUP_SECRET"],
          },
        ],
      },
    });

    const mod = await import("./provider-env-vars.js");

    expect(
      mod.getProviderEnvVarsCore("whisperx", {
        config: { plugins: {} },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toStrictEqual([]);
    expect(
      mod.getProviderEnvVarsCore("workspace-setup", {
        config: { plugins: {} },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toStrictEqual([]);
    expect(
      mod.listKnownProviderAuthEnvVarNamesCore({
        config: { plugins: {} },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(
      mod.listKnownProviderAuthEnvVarNamesCore({
        config: { plugins: {} },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).not.toContain("WORKSPACE_SETUP_SECRET");
  });

  it("does not trust arbitrary workspace plugin ids from the context engine slot", async () => {
    useInstalledSetupPlugin("workspace-audio", "workspace", {
      id: "whisperx",
      envVars: ["AWS_SECRET_ACCESS_KEY"],
    });

    const mod = await import("./provider-env-vars.js");

    expect(
      mod.getProviderEnvVarsCore("whisperx", {
        config: {
          plugins: {
            slots: {
              contextEngine: "workspace-audio",
            },
          },
        },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toStrictEqual([]);
  });

  it("keeps selected workspace context engine env vars when requested", async () => {
    useInstalledSetupPlugin(
      "workspace-engine",
      "workspace",
      { id: "whisperx", envVars: ["WHISPERX_API_KEY"] },
      { kind: "context-engine" },
    );

    const mod = await import("./provider-env-vars.js");

    expect(
      mod.getProviderEnvVarsCore("whisperx", {
        config: {
          plugins: {
            slots: {
              contextEngine: "workspace-engine",
            },
          },
        },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toEqual(["WHISPERX_API_KEY"]);
  });

  it("resolves auth maps with policy work bounded to contributing plugins", () => {
    useInstalledPlugins(
      {
        id: "external-fireworks",
        origin: "global",
        providerAuthAliases: {
          "fireworks-plan": "fireworks",
        },
        setup: {
          providers: [
            {
              id: "fireworks",
              envVars: ["FIREWORKS_ALT_API_KEY"],
              authEvidence: [
                {
                  type: "local-file-with-env",
                  fileEnvVar: "FIREWORKS_CREDENTIALS",
                  credentialMarker: "fireworks-local-credentials",
                },
              ],
            },
          ],
        },
      },
      {
        id: "legacy-setup-owner",
        origin: "global",
        providers: ["legacy-cloud"],
        providerAuthAliases: {
          "legacy-cloud-plan": "legacy-cloud",
        },
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
    let lookupMaps: ReturnType<typeof resolveProviderAuthLookupMaps>;
    try {
      lookupMaps = resolveProviderAuthLookupMaps({ config: {} });
      expect(policy.mock.calls.length).toBeLessThanOrEqual(2);
      expect(policy.mock.calls.map(([{ id }]) => id)).not.toContain("channel-only");
      expect(policy.mock.calls.map(([{ id }]) => id)).not.toContain("metadata-only");
    } finally {
      policy.mockRestore();
    }

    expect(lookupMaps.aliasMap["fireworks-plan"]).toBe("fireworks");
    expect(lookupMaps.envCandidateMap["metadata-only"]).toEqual(["METADATA_ONLY_API_KEY"]);
    expect(lookupMaps.envCandidateMap["fireworks-plan"]).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(lookupMaps.authEvidenceMap["fireworks-plan"]).toEqual([
      {
        type: "local-file-with-env",
        fileEnvVar: "FIREWORKS_CREDENTIALS",
        credentialMarker: "fireworks-local-credentials",
      },
    ]);
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
      "global",
      {
        id: "disabled-cloud",
        envVars: ["DISABLED_CLOUD_API_KEY"],
        authEvidence: [{ type: "local-file-with-env", credentialMarker: "cloud-local" }],
      },
      {
        enabled: false,
        providers: ["disabled-cloud"],
        providerAuthAliases: {
          "disabled-cloud-plan": "disabled-cloud",
        },
      },
    );

    pluginRegistryMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(metadataSnapshot(plugin));
    const config = { plugins: { entries: { "disabled-setup-owner": { enabled: false } } } };
    for (const enabled of [false, true, false]) {
      config.plugins.entries["disabled-setup-owner"].enabled = enabled;
      const lookupMaps = resolveProviderAuthLookupMaps({ config });
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
