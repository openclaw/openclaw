// Covers provider install catalog entries from plugin metadata.
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

const loadPluginRegistrySnapshot = vi.hoisted(() =>
  vi.fn<LoadPluginRegistrySnapshot>(() => ({
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 0,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  })),
);
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

function registrySnapshot(
  overrides: {
    installRecords?: Record<string, InstalledPluginInstallRecordInfo>;
    plugins?: InstalledPluginIndexRecord[];
  } = {},
) {
  return {
    version: 1 as const,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1 as const,
    policyHash: "test",
    generatedAtMs: 0,
    installRecords: overrides.installRecords ?? {},
    plugins: overrides.plugins ?? [],
    diagnostics: [],
  };
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

function mockVllmAuthChoice() {
  resolveManifestProviderAuthChoices.mockReturnValue([
    {
      pluginId: "vllm",
      providerId: "vllm",
      methodId: "server",
      choiceId: "vllm",
      choiceLabel: "vLLM",
      groupLabel: "vLLM",
    },
  ]);
}

function mockInstalled(
  plugins: InstalledPluginIndexRecord[],
  installRecords: Record<string, InstalledPluginInstallRecordInfo> = {},
) {
  loadPluginRegistrySnapshot.mockReturnValue(registrySnapshot({ plugins, installRecords }));
}

function mockAuthChoice(pluginId: string, choiceLabel: string) {
  resolveManifestProviderAuthChoices.mockReturnValue([
    {
      pluginId,
      providerId: pluginId,
      methodId: "api-key",
      choiceId: `${pluginId}-api-key`,
      choiceLabel,
    },
  ]);
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

function expectVllm(
  install: NonNullable<ReturnType<typeof resolveProviderInstallCatalogEntry>>["install"],
  installSource: PluginInstallSourceInfo,
) {
  expect(resolveProviderInstallCatalogEntry("vllm")).toEqual({
    pluginId: "vllm",
    providerId: "vllm",
    methodId: "server",
    choiceId: "vllm",
    choiceLabel: "vLLM",
    groupLabel: "vLLM",
    label: "vLLM",
    origin: "global",
    install,
    installSource,
  });
}

describe("provider install catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadPluginRegistrySnapshot.mockReturnValue(registrySnapshot());
    resolveManifestProviderAuthChoices.mockReturnValue([]);
    listOfficialExternalProviderCatalogEntries.mockReturnValue([]);
  });

  it("merges manifest auth-choice metadata with registry install metadata", () => {
    mockInstalled([
      installedPlugin("openai", "bundled", {
        packageName: "@openclaw/openai",
        packageInstall: {
          defaultChoice: "npm",
          npm: npmSource("@openclaw/openai", "1.2.3", "sha512-openai"),
          local: { path: "extensions/openai" },
          warnings: [],
        },
      }),
    ]);
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        groupId: "openai",
        groupLabel: "OpenAI",
      },
    ]);

    expect(resolveProviderInstallCatalogEntries()).toEqual([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        groupId: "openai",
        groupLabel: "OpenAI",
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
          npm: npmSource("@openclaw/openai", "1.2.3", "sha512-openai"),
          local: { path: "extensions/openai" },
          warnings: [],
        },
      },
    ]);
  });

  it("keeps stable label order and installed-choice priority when merging official entries", () => {
    mockInstalled([{ ...vllmPluginWithPackageInstall(), origin: "bundled" }]);
    const choice = (choiceId: string, choiceLabel: string) => ({
      pluginId: "vllm",
      providerId: "vllm",
      methodId: "api-key",
      choiceId,
      choiceLabel,
    });
    resolveManifestProviderAuthChoices.mockReturnValue([
      choice("last", "Zulu"),
      choice("same-first", "Same"),
      choice("same-second", "Same"),
      choice("first", "Alpha"),
    ]);
    listOfficialExternalProviderCatalogEntries.mockReturnValue([
      {
        name: "@openclaw/qwen-provider",
        openclaw: {
          plugin: { id: "qwen", label: "Qwen" },
          install: { npmSpec: "@openclaw/qwen-provider" },
          providers: [
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
          ],
        },
      },
    ]);

    expect(
      resolveProviderInstallCatalogEntries().map(({ choiceId, pluginId }) => ({
        choiceId,
        pluginId,
      })),
    ).toEqual([
      { choiceId: "first", pluginId: "vllm" },
      { choiceId: "same-first", pluginId: "vllm" },
      { choiceId: "same-second", pluginId: "vllm" },
      { choiceId: "same-official", pluginId: "qwen" },
      { choiceId: "last", pluginId: "vllm" },
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
    mockVllmAuthChoice();

    expectVllm(
      { npmSpec: "@openclaw/vllm@2.0.0", expectedIntegrity: "sha512-vllm", defaultChoice: "npm" },
      {
        defaultChoice: "npm",
        npm: npmSource("@openclaw/vllm", "2.0.0", "sha512-vllm"),
        warnings: [],
      },
    );
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
    mockVllmAuthChoice();

    expectVllm(
      { clawhubSpec: "clawhub:openclaw/vllm@2026.5.2", defaultChoice: "clawhub" },
      {
        defaultChoice: "clawhub",
        clawhub: {
          spec: "clawhub:openclaw/vllm@2026.5.2",
          packageName: "openclaw/vllm",
          version: "2026.5.2",
          exactVersion: true,
        },
        warnings: [],
      },
    );
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
    listOfficialExternalProviderCatalogEntries.mockReturnValue([
      {
        name: "@openclaw/codex",
        source: "official",
        kind: "provider",
        openclaw: {
          plugin: { id: "codex", label: "Codex" },
          providers: [
            {
              id: "codex",
              name: "Codex",
              authChoices: [
                {
                  method: "app-server",
                  choiceId: "codex",
                  choiceLabel: "Codex app-server",
                  choiceHint: "Use the Codex app-server runtime.",
                  groupId: "codex",
                  groupLabel: "Codex",
                  onboardingScopes: ["text-inference"],
                },
              ],
            },
          ],
          install: {
            npmSpec: "@openclaw/codex",
            defaultChoice: "npm",
          },
        },
      },
    ]);

    expect(resolveProviderInstallCatalogEntry("codex")).toEqual({
      pluginId: "codex",
      providerId: "codex",
      methodId: "app-server",
      choiceId: "codex",
      choiceLabel: "Codex app-server",
      choiceHint: "Use the Codex app-server runtime.",
      groupId: "codex",
      groupLabel: "Codex",
      onboardingScopes: ["text-inference"],
      label: "Codex",
      origin: "bundled",
      install: {
        npmSpec: "@openclaw/codex",
        defaultChoice: "npm",
      },
      installSource: {
        defaultChoice: "npm",
        npm: {
          spec: "@openclaw/codex",
          packageName: "@openclaw/codex",
          selectorKind: "none",
          exactVersion: false,
          pinState: "floating-without-integrity",
        },
        warnings: ["npm-spec-floating", "npm-spec-missing-integrity"],
      },
    });
  });

  it("surfaces the pinned Telnyx auth choice before the plugin is installed", () => {
    const integrity =
      "sha512-htqOJfPx+TlLWE/nmpdJJVgrg8zDqRIX87smzY3CnKcdJPlx51Rc1kWzarvE+2hvhpm2lzD5sKkxRSIWKz2AaA==";
    const choice = {
      choiceId: "telnyx-api-key",
      choiceLabel: "Telnyx API key",
      choiceHint: "OpenAI-compatible Telnyx AI inference endpoint",
      groupId: "telnyx",
      groupLabel: "Telnyx",
      groupHint: "OpenAI-compatible Telnyx AI inference endpoint",
      optionKey: "telnyxApiKey",
      cliFlag: "--telnyx-api-key",
      cliOption: "--telnyx-api-key <key>",
      cliDescription: "Telnyx API key",
      onboardingScopes: ["text-inference" as const],
    };
    const install = {
      clawhubSpec: "clawhub:@telnyx/openclaw-provider@0.2.0",
      npmSpec: "@telnyx/openclaw-provider@0.2.0",
      defaultChoice: "npm" as const,
      expectedIntegrity: integrity,
      minHostVersion: ">=2026.8.1",
    };
    listOfficialExternalProviderCatalogEntries.mockReturnValue([
      {
        name: "@telnyx/openclaw-provider",
        source: "external",
        kind: "provider",
        openclaw: {
          plugin: { id: "telnyx", label: "Telnyx" },
          providers: [
            {
              id: "telnyx",
              name: "Telnyx",
              docs: "/providers/telnyx",
              envVars: ["TELNYX_API_KEY"],
              authChoices: [{ method: "api-key", ...choice }],
            },
          ],
          install,
        },
      },
    ]);

    expect(resolveProviderInstallCatalogEntry("telnyx-api-key")).toEqual({
      pluginId: "telnyx",
      providerId: "telnyx",
      methodId: "api-key",
      ...choice,
      label: "Telnyx",
      origin: "bundled",
      install,
      installSource: {
        defaultChoice: "npm",
        clawhub: {
          spec: "clawhub:@telnyx/openclaw-provider@0.2.0",
          packageName: "@telnyx/openclaw-provider",
          version: "0.2.0",
          exactVersion: true,
        },
        npm: npmSource("@telnyx/openclaw-provider", "0.2.0", integrity),
        warnings: [],
      },
    });
  });

  it("preserves official external provider aliases for configured-plugin repair", () => {
    listOfficialExternalProviderCatalogEntries.mockReturnValue([
      officialProvider(
        "gmi",
        "GMI Cloud",
        {
          id: "gmi",
          aliases: ["gmi-cloud", "gmicloud"],
          name: "GMI Cloud",
          authChoices: [
            { method: "api-key", choiceId: "gmi-api-key", choiceLabel: "GMI Cloud API key" },
          ],
        },
        { npmSpec: "@openclaw/gmi-provider", defaultChoice: "npm" },
      ),
    ]);

    expect(resolveProviderInstallCatalogEntry("gmi-api-key")).toMatchObject({
      pluginId: "gmi",
      providerId: "gmi",
      providerAliases: ["gmi-cloud", "gmicloud"],
    });
  });

  it("resolves deprecated official external auth choices before their plugin is installed", () => {
    listOfficialExternalProviderCatalogEntries.mockReturnValue([
      officialProvider(
        "qwen",
        "Qwen Cloud",
        {
          id: "qwen",
          name: "Qwen Cloud",
          authChoices: [
            {
              method: "api-key",
              choiceId: "qwen-api-key",
              deprecatedChoiceIds: ["modelstudio-api-key"],
              choiceLabel: "Qwen Cloud API key",
            },
          ],
        },
        { npmSpec: "@openclaw/qwen-provider", defaultChoice: "npm" },
      ),
    ]);

    expect(resolveDeprecatedProviderInstallCatalogEntry("modelstudio-api-key")).toMatchObject({
      pluginId: "qwen",
      choiceId: "qwen-api-key",
    });
  });
});
