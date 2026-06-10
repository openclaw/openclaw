// Channel doctor tests cover shared channel health checks and repair hints.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectChannelDoctorCompatibilityMutations,
  collectChannelDoctorEmptyAllowlistExtraWarnings,
  collectChannelDoctorMutableAllowlistWarnings,
  collectChannelDoctorPreviewWarnings,
  collectChannelDoctorStaleConfigMutations,
  createChannelDoctorEmptyAllowlistPolicyHooks,
} from "./channel-doctor.js";

const mocks = vi.hoisted(() => ({
  getLoadedChannelPlugin: vi.fn(),
  getBundledChannelPlugin: vi.fn(),
  getBundledChannelSetupPlugin: vi.fn(),
  resolveReadOnlyChannelPluginsForConfig: vi.fn(),
  resolveCommandConfigWithSecrets: vi.fn(),
  getConfiguredChannelsCommandSecretTargetIds: vi.fn(() => new Set<string>(["channels"])),
}));

const READ_ONLY_CHANNEL_DOCTOR_OPTIONS = {
  includePersistedAuthState: false,
  includeSetupFallbackPlugins: true,
} as const;

vi.mock("../../../channels/plugins/registry.js", () => ({
  getLoadedChannelPlugin: (...args: Parameters<typeof mocks.getLoadedChannelPlugin>) =>
    mocks.getLoadedChannelPlugin(...args),
}));

vi.mock("../../../channels/plugins/bundled.js", () => ({
  getBundledChannelPlugin: (...args: Parameters<typeof mocks.getBundledChannelPlugin>) =>
    mocks.getBundledChannelPlugin(...args),
  getBundledChannelSetupPlugin: (...args: Parameters<typeof mocks.getBundledChannelSetupPlugin>) =>
    mocks.getBundledChannelSetupPlugin(...args),
}));

vi.mock("../../../channels/plugins/read-only.js", () => ({
  resolveReadOnlyChannelPluginsForConfig: (
    ...args: Parameters<typeof mocks.resolveReadOnlyChannelPluginsForConfig>
  ) => mocks.resolveReadOnlyChannelPluginsForConfig(...args),
}));

vi.mock("../../../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: (
    ...args: Parameters<typeof mocks.resolveCommandConfigWithSecrets>
  ) => mocks.resolveCommandConfigWithSecrets(...args),
}));

vi.mock("../../../cli/command-secret-targets.js", () => ({
  getConfiguredChannelsCommandSecretTargetIds: (
    ...args: Parameters<typeof mocks.getConfiguredChannelsCommandSecretTargetIds>
  ) => mocks.getConfiguredChannelsCommandSecretTargetIds(...args),
}));

function createMatrixEnabledConfig() {
  return {
    channels: {
      matrix: {
        enabled: true,
      },
    },
  };
}

function createNormalizeCompatibilityConfig(change = "matrix") {
  return vi.fn(({ cfg }: { cfg: unknown }) => ({
    config: cfg,
    changes: [change],
  }));
}

function mockReadOnlyMatrixPlugin(doctor?: Record<string, unknown>) {
  mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
    plugins: [
      {
        id: "matrix",
        ...(doctor ? { doctor } : {}),
      },
    ],
  });
}

function mockBundledMatrixSetupPlugin(doctor?: Record<string, unknown>) {
  mocks.getBundledChannelSetupPlugin.mockImplementation((id: string) =>
    id === "matrix"
      ? {
          id: "matrix",
          ...(doctor ? { doctor } : {}),
        }
      : undefined,
  );
}

function mockBundledMatrixRuntimePlugin(doctor?: Record<string, unknown>) {
  mocks.getBundledChannelPlugin.mockImplementation((id: string) =>
    id === "matrix"
      ? {
          id: "matrix",
          ...(doctor ? { doctor } : {}),
        }
      : undefined,
  );
}

function expectMatrixDoctorLookupCalls(cfg?: unknown) {
  if (cfg) {
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(
      cfg,
      READ_ONLY_CHANNEL_DOCTOR_OPTIONS,
    );
  }
  expect(mocks.getLoadedChannelPlugin).toHaveBeenCalledWith("matrix");
  expect(mocks.getBundledChannelSetupPlugin).toHaveBeenCalledWith("matrix");
  expect(mocks.getBundledChannelPlugin).toHaveBeenCalledWith("matrix");
}

async function expectRuntimeWarningFallback(params: {
  cfg: unknown;
  normalizeCompatibilityConfig: ReturnType<typeof vi.fn>;
  collectMutableAllowlistWarnings: ReturnType<typeof vi.fn>;
}) {
  expect(collectChannelDoctorCompatibilityMutations(params.cfg as never)).toHaveLength(1);
  await expect(
    collectChannelDoctorMutableAllowlistWarnings({ cfg: params.cfg as never }),
  ).resolves.toEqual(["runtime warning"]);
  expect(params.normalizeCompatibilityConfig).toHaveBeenCalledTimes(1);
  expect(params.collectMutableAllowlistWarnings).toHaveBeenCalledTimes(1);
}

describe("channel doctor compatibility mutations", () => {
  beforeEach(() => {
    mocks.getLoadedChannelPlugin.mockReset();
    mocks.getBundledChannelPlugin.mockReset();
    mocks.getBundledChannelSetupPlugin.mockReset();
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReset();
    mocks.getLoadedChannelPlugin.mockReturnValue(undefined);
    mocks.getBundledChannelPlugin.mockReturnValue(undefined);
    mocks.getBundledChannelSetupPlugin.mockReturnValue(undefined);
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({ plugins: [] });
  });

  it("skips plugin discovery when no channels are configured", () => {
    const result = collectChannelDoctorCompatibilityMutations({} as never);

    expect(result).toStrictEqual([]);
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).not.toHaveBeenCalled();
  });

  it("skips plugin discovery when only channel defaults are configured", async () => {
    const result = await collectChannelDoctorStaleConfigMutations({
      channels: {
        defaults: {
          enabled: true,
        },
      },
    } as never);

    expect(result).toStrictEqual([]);
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).not.toHaveBeenCalled();
    expect(mocks.getLoadedChannelPlugin).not.toHaveBeenCalled();
    expect(mocks.getBundledChannelSetupPlugin).not.toHaveBeenCalled();
    expect(mocks.getBundledChannelPlugin).not.toHaveBeenCalled();
  });

  it("skips plugin discovery for explicitly disabled channels", () => {
    const result = collectChannelDoctorCompatibilityMutations({
      channels: {
        mattermost: {
          enabled: false,
        },
      },
    } as never);

    expect(result).toStrictEqual([]);
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).not.toHaveBeenCalled();
    expect(mocks.getLoadedChannelPlugin).not.toHaveBeenCalled();
    expect(mocks.getBundledChannelSetupPlugin).not.toHaveBeenCalled();
    expect(mocks.getBundledChannelPlugin).not.toHaveBeenCalled();
  });

  it("uses read-only doctor adapters for configured channel ids", () => {
    const normalizeCompatibilityConfig = createNormalizeCompatibilityConfig();
    mockReadOnlyMatrixPlugin({ normalizeCompatibilityConfig });
    const cfg = createMatrixEnabledConfig();

    const result = collectChannelDoctorCompatibilityMutations(cfg as never);

    expect(result).toHaveLength(1);
    expect(normalizeCompatibilityConfig).toHaveBeenCalledTimes(1);
    expectMatrixDoctorLookupCalls(cfg);
    expect(mocks.getBundledChannelSetupPlugin).not.toHaveBeenCalledWith("discord");
  });

  it("merges partial doctor adapters instead of masking runtime-only hooks", async () => {
    const normalizeCompatibilityConfig = createNormalizeCompatibilityConfig();
    const collectMutableAllowlistWarnings = vi.fn(() => ["runtime warning"]);
    mockReadOnlyMatrixPlugin({ normalizeCompatibilityConfig });
    mockBundledMatrixRuntimePlugin({ collectMutableAllowlistWarnings });
    const cfg = createMatrixEnabledConfig();

    await expectRuntimeWarningFallback({
      cfg,
      normalizeCompatibilityConfig,
      collectMutableAllowlistWarnings,
    });
  });

  it("ignores malformed doctor adapter values so valid fallbacks still run", async () => {
    const normalizeCompatibilityConfig = createNormalizeCompatibilityConfig("setup");
    const collectMutableAllowlistWarnings = vi.fn(() => ["runtime warning"]);
    mockReadOnlyMatrixPlugin({
      normalizeCompatibilityConfig: null,
      collectMutableAllowlistWarnings: "not-a-function",
      warnOnEmptyGroupSenderAllowlist: "yes",
    });
    mockBundledMatrixSetupPlugin({ normalizeCompatibilityConfig });
    mockBundledMatrixRuntimePlugin({ collectMutableAllowlistWarnings });
    const cfg = createMatrixEnabledConfig();

    await expectRuntimeWarningFallback({
      cfg,
      normalizeCompatibilityConfig,
      collectMutableAllowlistWarnings,
    });
  });

  it("falls back to setup doctor adapters when read-only plugins lack doctor hooks", () => {
    const normalizeCompatibilityConfig = createNormalizeCompatibilityConfig();
    mockReadOnlyMatrixPlugin();
    mockBundledMatrixSetupPlugin({ normalizeCompatibilityConfig });
    const cfg = createMatrixEnabledConfig();

    const result = collectChannelDoctorCompatibilityMutations(cfg as never);

    expect(result).toHaveLength(1);
    expect(normalizeCompatibilityConfig).toHaveBeenCalledTimes(1);
    expectMatrixDoctorLookupCalls(cfg);
  });

  it("falls back to bundled runtime doctor adapters when setup adapters lack doctor hooks", () => {
    const normalizeCompatibilityConfig = createNormalizeCompatibilityConfig();
    mockReadOnlyMatrixPlugin();
    mockBundledMatrixSetupPlugin();
    mockBundledMatrixRuntimePlugin({ normalizeCompatibilityConfig });
    const cfg = createMatrixEnabledConfig();

    const result = collectChannelDoctorCompatibilityMutations(cfg as never);

    expect(result).toHaveLength(1);
    expect(normalizeCompatibilityConfig).toHaveBeenCalledTimes(1);
    expectMatrixDoctorLookupCalls();
  });

  it("passes explicit env into read-only channel plugin discovery", () => {
    const cfg = createMatrixEnabledConfig();
    const env = { OPENCLAW_HOME: "/tmp/openclaw-test-home" };

    collectChannelDoctorCompatibilityMutations(cfg as never, { env });

    expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(cfg, {
      env,
      ...READ_ONLY_CHANNEL_DOCTOR_OPTIONS,
    });
  });

  it("keeps configured channel doctor lookup non-fatal when setup loading fails", () => {
    mocks.resolveReadOnlyChannelPluginsForConfig.mockImplementation(() => {
      throw new Error("missing runtime dep");
    });
    mocks.getBundledChannelSetupPlugin.mockImplementation((id: string) => {
      if (id === "discord") {
        throw new Error("missing runtime dep");
      }
      return undefined;
    });

    const result = collectChannelDoctorCompatibilityMutations({
      channels: {
        discord: {
          enabled: true,
        },
      },
    } as never);

    expect(result).toStrictEqual([]);
    expect(mocks.getLoadedChannelPlugin).toHaveBeenCalledWith("discord");
    expect(mocks.getBundledChannelSetupPlugin).toHaveBeenCalledWith("discord");
    expect(mocks.getBundledChannelPlugin).toHaveBeenCalledWith("discord");
  });

  it("uses config for empty allowlist lookup without exposing it to plugin hooks", () => {
    const collectEmptyAllowlistExtraWarnings = vi.fn(({ prefix }: { prefix: string }) => [
      `${prefix} extra`,
    ]);
    const cfg = {
      channels: {
        matrix: {
          groupPolicy: "allowlist",
        },
      },
    };
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
      plugins: [
        {
          id: "matrix",
          doctor: { collectEmptyAllowlistExtraWarnings },
        },
      ],
    });

    const result = collectChannelDoctorEmptyAllowlistExtraWarnings({
      account: {},
      channelName: "matrix",
      cfg: cfg as never,
      prefix: "channels.matrix",
    });

    expect(result).toEqual(["channels.matrix extra"]);
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(
      cfg,
      READ_ONLY_CHANNEL_DOCTOR_OPTIONS,
    );
    expect(collectEmptyAllowlistExtraWarnings.mock.calls[0]?.[0]).not.toHaveProperty("cfg");
  });

  it("reuses empty allowlist doctor entries across per-account hooks", () => {
    const collectEmptyAllowlistExtraWarnings = vi.fn(({ prefix }: { prefix: string }) => [
      `${prefix} extra`,
    ]);
    const shouldSkipDefaultEmptyGroupAllowlistWarning = vi.fn(() => true);
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            work: {},
            personal: {},
          },
        },
        slack: {
          accounts: {
            team: {},
          },
        },
      },
    };
    const env = { OPENCLAW_HOME: "/tmp/openclaw-test-home" };
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
      plugins: [
        {
          id: "matrix",
          doctor: {
            collectEmptyAllowlistExtraWarnings,
            shouldSkipDefaultEmptyGroupAllowlistWarning,
          },
        },
        {
          id: "slack",
          doctor: {
            collectEmptyAllowlistExtraWarnings,
          },
        },
      ],
    });

    const hooks = createChannelDoctorEmptyAllowlistPolicyHooks({ cfg: cfg as never, env });

    expect(
      hooks.extraWarningsForAccount({
        account: {},
        channelName: "matrix",
        prefix: "channels.matrix.accounts.work",
      }),
    ).toEqual(["channels.matrix.accounts.work extra"]);
    expect(
      hooks.shouldSkipDefaultEmptyGroupAllowlistWarning({
        account: {},
        channelName: "matrix",
        prefix: "channels.matrix.accounts.work",
      }),
    ).toBe(true);
    expect(
      hooks.extraWarningsForAccount({
        account: {},
        channelName: "matrix",
        prefix: "channels.matrix.accounts.personal",
      }),
    ).toEqual(["channels.matrix.accounts.personal extra"]);
    expect(
      hooks.extraWarningsForAccount({
        account: {},
        channelName: "slack",
        prefix: "channels.slack.accounts.team",
      }),
    ).toEqual(["channels.slack.accounts.team extra"]);

    expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledTimes(1);
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(cfg, {
      env,
      ...READ_ONLY_CHANNEL_DOCTOR_OPTIONS,
    });
    expect(collectEmptyAllowlistExtraWarnings).toHaveBeenCalledTimes(3);
    expect(shouldSkipDefaultEmptyGroupAllowlistWarning).toHaveBeenCalledTimes(1);
  });
});

describe("collectChannelDoctorPreviewWarnings SecretRef resolution (#91939)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves channel SecretRefs via gateway before delegating to channel doctor adapters", async () => {
    const unresolvedSecretRef = {
      source: "file" as const,
      provider: "default",
      id: "/NEXTCLOUD_TALK_BOT_SECRET",
    };
    const cfg = {
      channels: {
        "nextcloud-talk": {
          enabled: true,
          accounts: {
            default: {
              botSecret: unresolvedSecretRef,
              baseUrl: "https://nc.example.com",
            },
          },
        },
      },
    } as never;
    const resolvedCfg = {
      channels: {
        "nextcloud-talk": {
          enabled: true,
          accounts: {
            default: {
              botSecret: "resolved-secret-value",
              baseUrl: "https://nc.example.com",
            },
          },
        },
      },
    } as never;

    mocks.resolveCommandConfigWithSecrets.mockResolvedValue({
      resolvedConfig: resolvedCfg,
      effectiveConfig: resolvedCfg,
      diagnostics: [],
    });

    const collectPreviewWarnings = vi.fn(async () => [
      "- channels.nextcloud-talk.default: bot probe ok",
    ]);
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
      plugins: [
        {
          id: "nextcloud-talk",
          doctor: { collectPreviewWarnings },
        },
      ],
    });

    const warnings = await collectChannelDoctorPreviewWarnings({
      cfg,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(mocks.resolveCommandConfigWithSecrets).toHaveBeenCalledTimes(1);
    const resolveCall = mocks.resolveCommandConfigWithSecrets.mock.calls[0]?.[0] as {
      mode?: string;
      commandName?: string;
      config?: unknown;
    };
    expect(resolveCall.mode).toBe("read_only_status");
    expect(resolveCall.commandName).toBe("doctor channel preview");
    expect(resolveCall.config).toBe(cfg);

    // Adapter MUST receive the resolved view, not the raw SecretRef config.
    expect(collectPreviewWarnings).toHaveBeenCalledTimes(1);
    const adapterCall = collectPreviewWarnings.mock.calls[0]?.[0] as {
      cfg?: typeof resolvedCfg;
    };
    expect(adapterCall.cfg).toBe(resolvedCfg);

    expect(warnings).toEqual(["- channels.nextcloud-talk.default: bot probe ok"]);
  });

  it("falls back to the raw config when SecretRef resolution throws so doctor still surfaces other warnings", async () => {
    const cfg = {
      channels: {
        "nextcloud-talk": { enabled: true, accounts: { default: { baseUrl: "https://nc" } } },
      },
    } as never;
    mocks.resolveCommandConfigWithSecrets.mockRejectedValue(
      new Error("gateway unreachable and local fallback failed"),
    );
    const collectPreviewWarnings = vi.fn(async () => ["- something else"]);
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
      plugins: [{ id: "nextcloud-talk", doctor: { collectPreviewWarnings } }],
    });

    const warnings = await collectChannelDoctorPreviewWarnings({
      cfg,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(collectPreviewWarnings).toHaveBeenCalledTimes(1);
    const adapterCall = collectPreviewWarnings.mock.calls[0]?.[0] as { cfg?: typeof cfg };
    expect(adapterCall.cfg).toBe(cfg);
    expect(warnings).toEqual(["- something else"]);
  });
});
