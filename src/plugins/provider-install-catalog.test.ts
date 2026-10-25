import { beforeEach, describe, expect, it, vi } from "vitest";

type LoadPluginRegistrySnapshot = typeof import("./plugin-registry.js").loadPluginRegistrySnapshot;
type ResolveManifestProviderAuthChoices =
  typeof import("./provider-auth-choices.js").resolveManifestProviderAuthChoices;
type ListOfficialExternalProviderCatalogEntries =
  typeof import("./official-external-plugin-catalog.js").listOfficialExternalProviderCatalogEntries;
type PluginInstallSourceInfo = import("./install-source-info.js").PluginInstallSourceInfo;
type InstalledPluginInstallRecordInfo =
  import("./installed-plugin-index.js").InstalledPluginInstallRecordInfo;
type InstalledPluginIndexRecord = import("./installed-plugin-index.js").InstalledPluginIndexRecord;

const loadPluginRegistrySnapshot = vi.hoisted(() => vi.fn<LoadPluginRegistrySnapshot>());
// mock-isolation: Pin installed metadata without consulting the operator plugin registry.
vi.mock("./plugin-registry.js", () => ({ loadPluginRegistrySnapshot }));

const resolveManifestProviderAuthChoices = vi.hoisted(() =>
  vi.fn<ResolveManifestProviderAuthChoices>(() => []),
);
// mock-isolation: Supply manifest auth choices without loading provider artifacts.
vi.mock("./provider-auth-choices.js", () => ({ resolveManifestProviderAuthChoices }));

const listOfficialExternalProviderCatalogEntries = vi.hoisted(() =>
  vi.fn<ListOfficialExternalProviderCatalogEntries>(() => []),
);
vi.mock("./official-external-plugin-catalog.js", async () => {
  const actual = await vi.importActual<typeof import("./official-external-plugin-catalog.js")>(
    "./official-external-plugin-catalog.js",
  );
  return { ...actual, listOfficialExternalProviderCatalogEntries };
});

import {
  resolveDeprecatedProviderInstallCatalogEntry,
  resolveProviderInstallCatalogEntries,
  resolveProviderInstallCatalogEntry,
} from "./provider-install-catalog.js";

function mockInstalled(
  plugins: InstalledPluginIndexRecord[] = [],
  installRecords: Record<string, InstalledPluginInstallRecordInfo> = {},
) {
  loadPluginRegistrySnapshot.mockReturnValue({
    version: 1 as const,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1 as const,
    policyHash: "test",
    generatedAtMs: 0,
    installRecords,
    plugins,
    diagnostics: [],
  });
}

function installedPlugin(
  pluginId: string,
  origin: InstalledPluginIndexRecord["origin"],
  overrides: Partial<InstalledPluginIndexRecord>,
): InstalledPluginIndexRecord {
  const rootDir = `${origin === "global" ? "/Users/test/.openclaw/plugins" : "/repo/extensions"}/${pluginId}`;
  return {
    pluginId,
    origin,
    rootDir,
    manifestPath: `${rootDir}/openclaw.plugin.json`,
    manifestHash: "hash",
    enabled: true,
    startup: { sidecar: false, memory: false, agentHarnesses: [] },
    compat: [],
    ...overrides,
  };
}

function npmSource(
  packageName: string,
  selector: string,
  expectedIntegrity: string,
): NonNullable<PluginInstallSourceInfo["npm"]> {
  return {
    spec: packageName + "@" + selector,
    packageName,
    selector,
    selectorKind: "exact-version",
    exactVersion: true,
    expectedIntegrity,
    pinState: "exact-with-integrity",
  };
}

function vllmPluginWithPackageInstall(): InstalledPluginIndexRecord {
  return installedPlugin("vllm", "global", {
    packageName: "@openclaw/vllm",
    packageInstall: {
      npm: npmSource("@openclaw/vllm-fork", "1.0.0", "sha512-old"),
      warnings: [],
    },
  });
}

const vllmChoice = {
  pluginId: "vllm",
  providerId: "vllm",
  methodId: "server",
  choiceId: "vllm",
  choiceLabel: "vLLM",
  groupLabel: "vLLM",
};

function mockAuthChoice(pluginId: string, choiceLabel: string) {
  resolveManifestProviderAuthChoices.mockReturnValue([authChoice(pluginId, choiceLabel)]);
}

function authChoice(pluginId: string, choiceLabel: string) {
  return {
    pluginId,
    providerId: pluginId,
    methodId: "api-key",
    choiceId: `${pluginId}-api-key`,
    choiceLabel,
  };
}

type OfficialEntry = ReturnType<ListOfficialExternalProviderCatalogEntries>[number];
type OfficialManifest = NonNullable<OfficialEntry["openclaw"]>;
function officialProvider(
  id: string,
  label: string,
  provider: NonNullable<OfficialManifest["providers"]>[number],
  install: OfficialManifest["install"],
): OfficialEntry {
  return {
    name: `@openclaw/${id}-provider`,
    source: "official",
    kind: "provider",
    openclaw: { plugin: { id, label }, providers: [provider], install },
  };
}

describe("provider install catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstalled();
    resolveManifestProviderAuthChoices.mockReturnValue([]);
    listOfficialExternalProviderCatalogEntries.mockReturnValue([]);
  });

  it("merges manifest auth-choice metadata with registry install metadata", () => {
    const npm = npmSource("@openclaw/openai", "1.2.3", "sha512-openai");
    const local = { path: "extensions/openai" };
    const choice = {
      ...authChoice("openai", "OpenAI API key"),
      groupId: "openai",
      groupLabel: "OpenAI",
    };
    mockInstalled([
      installedPlugin("openai", "bundled", {
        packageName: "@openclaw/openai",
        packageInstall: {
          defaultChoice: "npm",
          npm,
          local,
          warnings: [],
        },
      }),
    ]);
    resolveManifestProviderAuthChoices.mockReturnValue([choice]);

    expect(resolveProviderInstallCatalogEntries()).toEqual([
      {
        ...choice,
        label: "OpenAI",
        origin: "bundled",
        install: {
          npmSpec: "@openclaw/openai@1.2.3",
          localPath: "extensions/openai",
          defaultChoice: "npm",
          expectedIntegrity: "sha512-openai",
        },
        installSource: {
          defaultChoice: "npm",
          npm,
          local,
          warnings: [],
        },
      },
    ]);
  });

  it("keeps stable label order and installed-choice priority when merging official entries", () => {
    mockInstalled([{ ...vllmPluginWithPackageInstall(), origin: "bundled" }]);
    const choice = (choiceId: string, choiceLabel: string) => ({
      ...authChoice("vllm", choiceLabel),
      choiceId,
    });
    resolveManifestProviderAuthChoices.mockReturnValue([
      choice("last", "Zulu"),
      choice("same-first", "Same"),
      choice("same-second", "Same"),
      choice("first", "Alpha"),
    ]);
    listOfficialExternalProviderCatalogEntries.mockReturnValue([
      officialProvider(
        "qwen",
        "Qwen",
        {
          id: "qwen",
          name: "Qwen",
          authChoices: [
            { method: "api-key", choiceId: "same-official", choiceLabel: "Same" },
            { method: "api-key", choiceId: "same-first", choiceLabel: "A shadow" },
            {
              method: "local",
              choiceId: "unavailable-local",
              choiceLabel: "Unavailable local model",
              platforms: [],
            },
          ],
        },
        { npmSpec: "@openclaw/qwen-provider" },
      ),
    ]);

    expect(
      resolveProviderInstallCatalogEntries().map(({ choiceId, pluginId }) => [choiceId, pluginId]),
    ).toEqual([
      ["first", "vllm"],
      ["same-first", "vllm"],
      ["same-second", "vllm"],
      ["same-official", "qwen"],
      ["last", "vllm"],
    ]);
  });

  it("prefers durable install records over package-authored install intent", () => {
    mockInstalled([vllmPluginWithPackageInstall()], {
      vllm: {
        source: "npm",
        spec: "@openclaw/vllm",
        resolvedSpec: "@openclaw/vllm@2.0.0",
        integrity: "sha512-vllm",
      },
    });
    resolveManifestProviderAuthChoices.mockReturnValue([vllmChoice]);

    expect(resolveProviderInstallCatalogEntry("vllm")?.install).toEqual({
      npmSpec: "@openclaw/vllm@2.0.0",
      expectedIntegrity: "sha512-vllm",
      defaultChoice: "npm",
    });
  });

  it("preserves durable ClawHub install records for provider setup reinstall hints", () => {
    mockInstalled([vllmPluginWithPackageInstall()], {
      vllm: {
        source: "clawhub",
        spec: "clawhub:openclaw/vllm@2026.5.2",
        integrity: "sha256-clawpack",
        clawhubPackage: "openclaw/vllm",
      },
    });
    resolveManifestProviderAuthChoices.mockReturnValue([vllmChoice]);

    expect(resolveProviderInstallCatalogEntry("vllm")?.install).toEqual({
      clawhubSpec: "clawhub:openclaw/vllm@2026.5.2",
      defaultChoice: "clawhub",
    });
  });

  it("does not expose untrusted global package install intent without an install record", () => {
    mockInstalled([
      installedPlugin("demo-provider", "global", {
        packageName: "@vendor/demo-provider",
        packageInstall: {
          npm: npmSource("@vendor/demo-provider", "1.2.3", "sha512-demo"),
          warnings: [],
        },
      }),
    ]);
    mockAuthChoice("demo-provider", "Demo Provider API key");
    expect(resolveProviderInstallCatalogEntries()).toStrictEqual([]);
  });

  it("ignores malformed persisted package install metadata", () => {
    mockInstalled([
      installedPlugin("openai", "bundled", {
        packageName: "@openclaw/openai",
        packageInstall: {
          defaultChoice: "npm",
          npm: {
            spec: 12,
            packageName: "@openclaw/openai",
            selectorKind: "exact-version",
            exactVersion: true,
            pinState: "exact-with-integrity",
          },
          warnings: [],
        } as unknown as PluginInstallSourceInfo,
      }),
    ]);
    mockAuthChoice("openai", "OpenAI API key");
    expect(resolveProviderInstallCatalogEntries()).toStrictEqual([]);
  });

  it("skips untrusted workspace package install metadata when the plugin is disabled", () => {
    mockInstalled([
      installedPlugin("demo-provider", "workspace", {
        enabled: false,
        packageInstall: { local: { path: "extensions/demo-provider" }, warnings: [] },
      }),
    ]);
    mockAuthChoice("demo-provider", "Demo Provider API key");
    expect(
      resolveProviderInstallCatalogEntries({
        config: { plugins: { enabled: false } },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toStrictEqual([]);
  });

  it("surfaces official external provider install metadata when the provider plugin is not installed", () => {
    const choice = {
      choiceId: "codex",
      choiceLabel: "Codex app-server",
      choiceHint: "Use the Codex app-server runtime.",
      groupId: "codex",
      groupLabel: "Codex",
      onboardingScopes: ["text-inference" as const],
      deprecatedChoiceIds: ["old-codex"],
      groupHint: "Codex runtime",
      optionKey: "codexKey",
      cliFlag: "--codex-key",
      cliOption: "--codex-key <key>",
      cliDescription: "Codex key",
    };
    const install = {
      npmSpec: "@openclaw/codex",
      defaultChoice: "npm" as const,
      minHostVersion: ">=2026.8.1",
    };
    listOfficialExternalProviderCatalogEntries.mockReturnValue([
      {
        ...officialProvider(
          "codex",
          "Codex",
          {
            id: "codex",
            name: "Codex",
            aliases: ["codex-alias", "codex-second"],
            authChoices: [{ method: "app-server", ...choice }],
          },
          install,
        ),
        name: "@openclaw/codex",
      },
    ]);

    const installSource: PluginInstallSourceInfo = {
      defaultChoice: "npm",
      npm: {
        spec: "@openclaw/codex",
        packageName: "@openclaw/codex",
        selectorKind: "none",
        exactVersion: false,
        pinState: "floating-without-integrity",
      },
      warnings: ["npm-spec-floating", "npm-spec-missing-integrity"],
    };
    expect(resolveProviderInstallCatalogEntry("codex")).toEqual({
      pluginId: "codex",
      providerId: "codex",
      providerAliases: ["codex-alias", "codex-second"],
      methodId: "app-server",
      ...choice,
      label: "Codex",
      origin: "bundled",
      install,
      installSource,
    });
    expect(resolveDeprecatedProviderInstallCatalogEntry("old-codex")).toMatchObject({
      pluginId: "codex",
      choiceId: "codex",
    });
  });
});
