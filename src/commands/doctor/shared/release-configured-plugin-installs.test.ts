import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import { maybeRunConfiguredPluginInstallReleaseStep } from "./release-configured-plugin-installs.js";

const mocks = vi.hoisted(() => ({
  detectPluginAutoEnableCandidates: vi.fn(),
  getOfficialExternalPluginCatalogEntry: vi.fn(),
  repairMissingPluginInstallsForIds: vi.fn(),
  resolveProviderInstallCatalogEntries: vi.fn(),
}));

function useOfficialLobsterCatalog() {
  mocks.getOfficialExternalPluginCatalogEntry.mockImplementation((pluginId: string) =>
    pluginId === "lobster" ? { name: "@openclaw/lobster" } : undefined,
  );
}

type ReleaseParams = Parameters<typeof maybeRunConfiguredPluginInstallReleaseStep>[0];
type MissingPluginInstallRepairCall = Parameters<
  typeof import("./missing-configured-plugin-install.js").repairMissingPluginInstallsForIds
>[0];

function run(params: Partial<ReleaseParams>) {
  return maybeRunConfiguredPluginInstallReleaseStep({
    cfg: {},
    env: {},
    currentVersion: "2026.5.2",
    touchedVersion: "2026.5.1",
    ...params,
  });
}

function readOnlyMissingPluginInstallRepairCall(): MissingPluginInstallRepairCall {
  expect(mocks.repairMissingPluginInstallsForIds).toHaveBeenCalledOnce();
  const call: MissingPluginInstallRepairCall | undefined =
    mocks.repairMissingPluginInstallsForIds.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("Expected missing plugin install repair call");
  }
  return call;
}

async function collectReleaseConfiguredPluginIdsThroughDoctor(params: {
  cfg: ReleaseParams["cfg"];
  env?: NodeJS.ProcessEnv;
}): Promise<{ pluginIds: string[]; channelIds: string[] }> {
  mocks.repairMissingPluginInstallsForIds.mockClear();
  await run(params);
  const call: MissingPluginInstallRepairCall | undefined =
    mocks.repairMissingPluginInstallsForIds.mock.calls[0]?.[0];
  return {
    pluginIds: Array.from(call?.pluginIds ?? []),
    channelIds: Array.from(call?.channelIds ?? []),
  };
}

vi.mock("../../../config/plugin-auto-enable.js", () => ({
  detectPluginAutoEnableCandidates: mocks.detectPluginAutoEnableCandidates,
}));

vi.mock("../../../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntries: mocks.resolveProviderInstallCatalogEntries,
}));

vi.mock(import("../../../plugins/official-external-plugin-catalog.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getOfficialExternalPluginCatalogEntry: mocks.getOfficialExternalPluginCatalogEntry,
  };
});

vi.mock("./missing-configured-plugin-install.js", () => ({
  repairMissingPluginInstallsForIds: mocks.repairMissingPluginInstallsForIds,
}));

describe("configured plugin install release step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectPluginAutoEnableCandidates.mockReturnValue([]);
    mocks.getOfficialExternalPluginCatalogEntry.mockReturnValue(undefined);
    mocks.resolveProviderInstallCatalogEntries.mockReturnValue([]);
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({ changes: [], warnings: [] });
  });

  it("runs only for configs last touched before 2026.5.2", async () => {
    for (const [currentVersion, touchedVersion, expected] of [
      ["2026.5.1", "2026.4.30", false],
      ["2026.5.2-beta.1", "2026.5.1", true],
      ["2026.5.2", "2026.5.1", true],
      ["2026.5.2", "2026.5.2", false],
      ["2026.5.3", "2026.5.3", false],
      ["2026.5.2", "not-a-version", true],
    ] as const) {
      const result = await run({ currentVersion, touchedVersion });
      expect(result.touchedConfig).toBe(false);
      expect(mocks.repairMissingPluginInstallsForIds).not.toHaveBeenCalled();
      expect(result.completed).toBe(expected);
    }
  });

  it("collects used plugin ids without treating allow-only entries as usage", async () => {
    mocks.detectPluginAutoEnableCandidates.mockReturnValue([
      { pluginId: "matrix", kind: "channel-configured", channelId: "matrix" },
      { pluginId: "denied", kind: "setup-auto-enable", reason: "test" },
      { pluginId: "disabled-entry", kind: "setup-auto-enable", reason: "test" },
    ]);
    mocks.resolveProviderInstallCatalogEntries.mockReturnValue([
      { pluginId: "anthropic-provider", providerId: "anthropic" },
      { pluginId: "unused-provider", providerId: "unused" },
    ]);
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {
        auth: { profiles: { work: { provider: "anthropic", mode: "api_key" } } },
        channels: { wecom: { enabled: true }, off: { enabled: false } },
        plugins: {
          allow: ["allow-only"],
          deny: ["denied"],
          slots: { memory: "memory-lancedb", contextEngine: "none" },
          entries: {
            configured: { config: { nested: true } },
            "disabled-entry": { enabled: false, config: { nested: true } },
          },
        },
      },
    });

    expect(result).toEqual({
      pluginIds: ["anthropic-provider", "configured", "matrix", "memory-lancedb"],
      channelIds: ["wecom"],
    });
    expect(readOnlyMissingPluginInstallRepairCall().blockedPluginIds).toEqual([
      "denied",
      "disabled-entry",
    ]);
  });

  it.each([
    {
      source: "channel-only model overrides",
      cfg: { channels: { modelByChannel: { discord: { default: "anthropic/claude-opus-4-7" } } } },
      catalog: [{ pluginId: "anthropic-provider", providerId: "anthropic" }],
      pluginIds: ["anthropic-provider"],
    },
    {
      source: "external speech and web-fetch config",
      cfg: {
        agents: { defaults: { model: "groq/openai/gpt-oss-120b" } },
        tts: { provider: "gradium", providers: { inworld: {} } },
        tools: { web: { fetch: { provider: "firecrawl" } } },
      },
      pluginIds: ["firecrawl", "gradium", "groq", "inworld"],
    },
    {
      source: "external media-understanding config only",
      cfg: {
        tools: {
          media: {
            models: [
              { provider: "groq", model: "whisper-large-v3-turbo", capabilities: ["audio"] },
            ],
          },
        },
      },
      pluginIds: ["groq"],
    },
    {
      source: "environment-only web providers before auto-detection",
      cfg: {},
      env: { EXA_API_KEY: "exa-key", FIRECRAWL_API_KEY: "firecrawl-key" },
      pluginIds: ["exa", "firecrawl"],
    },
    {
      source: "disabled environment-only web providers",
      cfg: { tools: { web: { search: { enabled: false }, fetch: { enabled: false } } } },
      env: { EXA_API_KEY: "exa-key", FIRECRAWL_API_KEY: "firecrawl-key" },
      pluginIds: [],
    },
    {
      source: "environment-only external providers before model discovery",
      cfg: {},
      env: { GROQ_API_KEY: "groq-key", MODELSTUDIO_API_KEY: "qwen-key" },
      pluginIds: ["groq", "qwen"],
    },
    {
      source: "external web search and ACP config-only usage",
      cfg: {
        acp: { enabled: true, backend: "acpx" },
        tools: { web: { search: { provider: "brave" } } },
      },
      pluginIds: ["acpx", "brave"],
    },
  ] satisfies Array<{
    source: string;
    cfg: OpenClawConfigWithLegacyRoster;
    env?: NodeJS.ProcessEnv;
    catalog?: Array<{ pluginId: string; providerId: string }>;
    pluginIds: string[];
  }>)("collects plugin ids from $source", async ({ cfg, env, catalog, pluginIds }) => {
    mocks.resolveProviderInstallCatalogEntries.mockReturnValue(catalog ?? []);
    expect(await collectReleaseConfiguredPluginIdsThroughDoctor({ cfg, env: env ?? {} })).toEqual({
      pluginIds,
      channelIds: [],
    });
  });

  it("collects provider plugins from documented external provider aliases", async () => {
    mocks.resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "gmi",
        providerId: "gmi",
        providerAliases: ["gmi-cloud", "gmicloud"],
      },
    ]);
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {
        agents: { defaults: { model: "gmi-cloud/google/gemini-3.1-flash-lite" } },
        auth: { profiles: { gmi: { provider: "gmi-cloud", mode: "api_key" } } },
        models: {
          providers: { gmicloud: { baseUrl: "https://api.gmi-serving.com/v1", models: [] } },
        },
      },
    });

    expect(result).toEqual({ pluginIds: ["gmi"], channelIds: [] });
  });

  it.each([
    { plugins: { deny: ["matrix"] } },
    { plugins: { entries: { matrix: { enabled: false } } } },
  ])("does not collect channel ids blocked by $plugins", async ({ plugins }) => {
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: { channels: { matrix: { accessToken: "test" } }, plugins },
    });
    expect(result.channelIds).toStrictEqual([]);
  });

  it("does not collect disabled channels even when configured by environment", async () => {
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: { channels: { Matrix: { enabled: false, accessToken: "test" } } },
      env: { MATRIX_ACCESS_TOKEN: "test" },
    });
    expect(result.channelIds).toStrictEqual([]);
  });

  it("repairs used plugin installs and touches config only on success", async () => {
    const reviewNotice = "REVIEW RECOMMENDED - ClawHub has not completed a fresh clean check";
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: ['Installed missing configured plugin "codex".'],
      warnings: [],
      notices: [reviewNotice],
      pluginInventoryChanged: true,
    });
    const cfg: OpenClawConfigWithLegacyRoster = {
      agents: { defaults: { model: "openai/gpt-5.4", agentRuntime: { id: "codex" } } },
    };
    const result = await run({
      cfg,
      currentVersion: "2026.5.2-beta.1",
    });

    const repairCall = readOnlyMissingPluginInstallRepairCall();
    expect(repairCall).toMatchObject({ pluginIds: ["codex"], channelIds: [] });
    expect(repairCall.env).toEqual({});
    expect(result).toMatchObject({
      touchedConfig: true,
      completed: true,
      warnings: [reviewNotice],
      pluginInventoryChanged: true,
    });
  });

  it("defers package-manager plugin release completion for writable legacy parents", async () => {
    const details = [
      'Skipped package-manager repair for configured plugin "discord" during package update; rerun "openclaw doctor --fix" after the update completes.',
    ];
    const env = {
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
    };
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: details,
      warnings: [],
      deferredRepairDetails: details,
    });
    const result = await run({
      cfg: { plugins: { entries: { discord: { enabled: true } } } },
      currentVersion: "2026.5.2-beta.1",
      env,
    });

    expect(readOnlyMissingPluginInstallRepairCall().env).toEqual(env);
    expect(result).toEqual({
      changes: details,
      warnings: [],
      completed: false,
      touchedConfig: false,
      postInstallDoctorResult: {
        status: "advisory",
        advisory: expect.objectContaining({
          kind: "package-post-install-doctor",
          reason: "deferred-configured-plugin-repair",
          details,
        }),
      },
    });
  });

  it("repairs same-id externalized channel installs from channel config after prior update writes", async () => {
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: ['Installed missing configured channel plugin "whatsapp".'],
      warnings: [],
    });
    const result = await run({
      cfg: { channels: { whatsapp: { allowFrom: ["+15555550123"] } } },
      currentVersion: "2026.5.12",
      touchedVersion: "2026.5.12",
    });

    const repairCall = readOnlyMissingPluginInstallRepairCall();
    expect(repairCall).toMatchObject({ pluginIds: [], channelIds: ["whatsapp"] });
    expect(result).toEqual({
      changes: ['Installed missing configured channel plugin "whatsapp".'],
      warnings: [],
      completed: true,
      touchedConfig: false,
    });
  });

  it("includes allow-only official plugin ids in the repair set", async () => {
    useOfficialLobsterCatalog();
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: { plugins: { allow: ["lobster", "unofficial-custom"] } },
    });

    expect(result).toEqual({ pluginIds: ["lobster"], channelIds: [] });
  });

  it("skips allow-only plugin ids that already have material plugin entries", async () => {
    useOfficialLobsterCatalog();
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: { plugins: { allow: ["lobster"], entries: { lobster: { enabled: true } } } },
      env: {},
    });

    expect(result.pluginIds).toEqual(["lobster"]);
    expect(mocks.getOfficialExternalPluginCatalogEntry).not.toHaveBeenCalledWith("lobster");
  });
});
