// Channel doctor tests cover shared channel health checks and repair hints.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeResolvedSecretInputString } from "../../../config/types.secrets.js";
import {
  collectChannelDoctorEmptyAllowlistExtraWarnings,
  collectChannelDoctorMutableAllowlistWarnings,
  collectChannelDoctorPreviewWarnings,
  collectChannelDoctorRepairMutations,
  collectChannelDoctorStaleConfigMutations,
  createChannelDoctorEmptyAllowlistPolicyHooks,
  runChannelDoctorConfigSequences,
  shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning,
} from "./channel-doctor.js";

const mocks = vi.hoisted(() => ({
  getLoadedChannelPlugin: vi.fn(),
  getBundledChannelPlugin: vi.fn(),
  getBundledChannelSetupPlugin: vi.fn(),
  resolveReadOnlyChannelPluginsForConfig: vi.fn(),
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

function createMatrixEnabledConfig() {
  return {
    channels: {
      matrix: {
        enabled: true,
      },
    },
  };
}

function createCleanStaleConfig(change = "matrix") {
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
  cleanStaleConfig: ReturnType<typeof vi.fn>;
  collectMutableAllowlistWarnings: ReturnType<typeof vi.fn>;
}) {
  await expect(collectChannelDoctorStaleConfigMutations(params.cfg as never)).resolves.toHaveLength(
    1,
  );
  await expect(
    collectChannelDoctorMutableAllowlistWarnings({ cfg: params.cfg as never }),
  ).resolves.toEqual(["runtime warning"]);
  expect(params.cleanStaleConfig).toHaveBeenCalledTimes(1);
  expect(params.collectMutableAllowlistWarnings).toHaveBeenCalledTimes(1);
}

describe("channel doctor stale config mutations", () => {
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

  it("skips plugin discovery when no channels are configured", async () => {
    const result = await collectChannelDoctorStaleConfigMutations({} as never);

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

  it("limits stale config cleanup to requested channel ids", async () => {
    const matrixCleanup = vi.fn(({ cfg }: { cfg: unknown }) => ({
      config: cfg,
      changes: ["matrix cleanup"],
    }));
    const discordCleanup = vi.fn(({ cfg }: { cfg: unknown }) => ({
      config: cfg,
      changes: ["discord cleanup"],
    }));
    mocks.getBundledChannelSetupPlugin.mockImplementation((id: string) => ({
      id,
      doctor: {
        cleanStaleConfig: id === "matrix" ? matrixCleanup : discordCleanup,
      },
    }));
    const cfg = {
      channels: {
        discord: { enabled: true },
        matrix: { enabled: true },
      },
    };

    const result = await collectChannelDoctorStaleConfigMutations(cfg as never, {
      channelIds: ["matrix"],
    });

    expect(result).toHaveLength(1);
    expect(matrixCleanup).toHaveBeenCalledTimes(1);
    expect(discordCleanup).not.toHaveBeenCalled();
  });

  it("skips plugin discovery for explicitly disabled channels", async () => {
    const result = await collectChannelDoctorStaleConfigMutations({
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

  it("uses read-only doctor adapters for configured channel ids", async () => {
    const cleanStaleConfig = createCleanStaleConfig();
    mockReadOnlyMatrixPlugin({ cleanStaleConfig });
    const cfg = createMatrixEnabledConfig();

    const result = await collectChannelDoctorStaleConfigMutations(cfg as never);

    expect(result).toHaveLength(1);
    expect(cleanStaleConfig).toHaveBeenCalledTimes(1);
    expectMatrixDoctorLookupCalls(cfg);
    expect(mocks.getBundledChannelSetupPlugin).not.toHaveBeenCalledWith("discord");
  });

  it("keeps unresolved SecretRef preview reads non-fatal", async () => {
    const collectPreviewWarnings = vi.fn(() => {
      normalizeResolvedSecretInputString({
        value: { source: "exec", provider: "default", id: "matrix/access-token" },
        path: "channels.matrix.accessToken",
      });
      return ["unreachable"];
    });
    mockReadOnlyMatrixPlugin({ collectPreviewWarnings });
    const cfg = createMatrixEnabledConfig();

    const result = await collectChannelDoctorPreviewWarnings({
      cfg: cfg as never,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result).toEqual([
      "- channels.matrix: configured SecretRef at channels.matrix.accessToken is unavailable in doctor preview; skipping secret-backed channel preview checks.",
    ]);
    expect(collectPreviewWarnings).toHaveBeenCalledTimes(1);
  });

  it("merges partial doctor adapters instead of masking runtime-only hooks", async () => {
    const cleanStaleConfig = createCleanStaleConfig();
    const collectMutableAllowlistWarnings = vi.fn(() => ["runtime warning"]);
    mockReadOnlyMatrixPlugin({ cleanStaleConfig });
    mockBundledMatrixRuntimePlugin({ collectMutableAllowlistWarnings });
    const cfg = createMatrixEnabledConfig();

    await expectRuntimeWarningFallback({
      cfg,
      cleanStaleConfig,
      collectMutableAllowlistWarnings,
    });
  });

  it("ignores malformed doctor adapter values so valid fallbacks still run", async () => {
    const cleanStaleConfig = createCleanStaleConfig("setup");
    const collectMutableAllowlistWarnings = vi.fn(() => ["runtime warning"]);
    mockReadOnlyMatrixPlugin({
      cleanStaleConfig: null,
      collectMutableAllowlistWarnings: "not-a-function",
      warnOnEmptyGroupSenderAllowlist: "yes",
    });
    mockBundledMatrixSetupPlugin({ cleanStaleConfig });
    mockBundledMatrixRuntimePlugin({ collectMutableAllowlistWarnings });
    const cfg = createMatrixEnabledConfig();

    await expectRuntimeWarningFallback({
      cfg,
      cleanStaleConfig,
      collectMutableAllowlistWarnings,
    });
  });

  it("falls back to setup doctor adapters when read-only plugins lack doctor hooks", async () => {
    const cleanStaleConfig = createCleanStaleConfig();
    mockReadOnlyMatrixPlugin();
    mockBundledMatrixSetupPlugin({ cleanStaleConfig });
    const cfg = createMatrixEnabledConfig();

    const result = await collectChannelDoctorStaleConfigMutations(cfg as never);

    expect(result).toHaveLength(1);
    expect(cleanStaleConfig).toHaveBeenCalledTimes(1);
    expectMatrixDoctorLookupCalls(cfg);
  });

  it("falls back to bundled runtime doctor adapters when setup adapters lack doctor hooks", async () => {
    const cleanStaleConfig = createCleanStaleConfig();
    mockReadOnlyMatrixPlugin();
    mockBundledMatrixSetupPlugin();
    mockBundledMatrixRuntimePlugin({ cleanStaleConfig });
    const cfg = createMatrixEnabledConfig();

    const result = await collectChannelDoctorStaleConfigMutations(cfg as never);

    expect(result).toHaveLength(1);
    expect(cleanStaleConfig).toHaveBeenCalledTimes(1);
    expectMatrixDoctorLookupCalls();
  });

  it("passes explicit env into read-only channel plugin discovery", async () => {
    const cfg = createMatrixEnabledConfig();
    const env = { OPENCLAW_HOME: "/tmp/openclaw-test-home" };

    await collectChannelDoctorStaleConfigMutations(cfg as never, { env });

    expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(cfg, {
      env,
      ...READ_ONLY_CHANNEL_DOCTOR_OPTIONS,
    });
  });

  it("keeps configured channel doctor lookup non-fatal when setup loading fails", async () => {
    mocks.resolveReadOnlyChannelPluginsForConfig.mockImplementation(() => {
      throw new Error("missing runtime dep");
    });
    mocks.getBundledChannelSetupPlugin.mockImplementation((id: string) => {
      if (id === "discord") {
        throw new Error("missing runtime dep");
      }
      return undefined;
    });

    const result = await collectChannelDoctorStaleConfigMutations({
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

describe("channel doctor adapter fail-soft", () => {
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

  function mockReadOnlyPlugins(plugins: Array<{ id: string; doctor: Record<string, unknown> }>) {
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({ plugins });
  }

  function createTwoChannelConfig() {
    return {
      channels: {
        matrix: { enabled: true },
        slack: { enabled: true },
      },
    };
  }

  it("keeps running config sequences when one channel adapter throws", async () => {
    mockReadOnlyPlugins([
      {
        id: "matrix",
        doctor: {
          runConfigSequence: vi.fn(() => {
            throw new TypeError("resolveSessionStoreTargets is not a function");
          }),
        },
      },
      {
        id: "slack",
        doctor: {
          runConfigSequence: vi.fn(() => ({ changeNotes: ["slack change"], warningNotes: [] })),
        },
      },
    ]);

    const result = await runChannelDoctorConfigSequences({
      cfg: createTwoChannelConfig() as never,
      env: {},
      shouldRepair: false,
    });

    expect(result.changeNotes).toEqual(["slack change"]);
    expect(result.warningNotes).toHaveLength(1);
    expect(result.warningNotes[0]).toContain("matrix channel doctor runConfigSequence failed");
    expect(result.warningNotes[0]).toContain("openclaw plugins update matrix");
  });

  it("reports stale-config adapter throws as warning-only mutations and keeps the config chain", async () => {
    const baseCfg = createTwoChannelConfig();
    const slackCleanStaleConfig = vi.fn(({ cfg }: { cfg: unknown }) => ({
      config: cfg,
      changes: ["slack cleanup"],
    }));
    mockReadOnlyPlugins([
      {
        id: "matrix",
        doctor: {
          cleanStaleConfig: vi.fn(() => {
            throw new Error("skewed plugin");
          }),
        },
      },
      { id: "slack", doctor: { cleanStaleConfig: slackCleanStaleConfig } },
    ]);

    const mutations = await collectChannelDoctorStaleConfigMutations(baseCfg as never);

    expect(mutations).toHaveLength(2);
    expect(mutations[0]?.changes).toEqual([]);
    expect(mutations[0]?.config).toBe(baseCfg);
    expect(mutations[0]?.warnings?.[0]).toContain("matrix channel doctor cleanStaleConfig failed");
    expect(mutations[1]?.changes).toEqual(["slack cleanup"]);
    expect(slackCleanStaleConfig).toHaveBeenCalledWith({ cfg: baseCfg });
  });

  it("converts mutable allowlist adapter throws into warnings", async () => {
    mockReadOnlyPlugins([
      {
        id: "matrix",
        doctor: {
          collectMutableAllowlistWarnings: vi.fn(() => {
            throw new Error("boom");
          }),
        },
      },
      {
        id: "slack",
        doctor: { collectMutableAllowlistWarnings: vi.fn(() => ["slack warning"]) },
      },
    ]);

    const warnings = await collectChannelDoctorMutableAllowlistWarnings({
      cfg: createTwoChannelConfig() as never,
    });

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("matrix channel doctor collectMutableAllowlistWarnings failed");
    expect(warnings[0]).toContain("openclaw plugins update matrix");
    expect(warnings[1]).toBe("slack warning");
  });

  it("converts repair adapter throws into warning-only mutations", async () => {
    mockReadOnlyPlugins([
      {
        id: "matrix",
        doctor: {
          repairConfig: vi.fn(() => {
            throw new Error("boom");
          }),
        },
      },
    ]);

    const mutations = await collectChannelDoctorRepairMutations({
      cfg: { channels: { matrix: { enabled: true } } } as never,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.changes).toEqual([]);
    expect(mutations[0]?.warnings?.[0]).toContain("matrix channel doctor repairConfig failed");
  });

  it("skips throwing empty-allowlist hooks without failing the lookup", () => {
    mockReadOnlyPlugins([
      {
        id: "matrix",
        doctor: {
          collectEmptyAllowlistExtraWarnings: vi.fn(() => {
            throw new Error("boom");
          }),
          shouldSkipDefaultEmptyGroupAllowlistWarning: vi.fn(() => {
            throw new Error("boom");
          }),
        },
      },
    ]);
    const cfg = { channels: { matrix: { enabled: true } } };

    expect(
      collectChannelDoctorEmptyAllowlistExtraWarnings({
        account: {},
        channelName: "matrix",
        cfg: cfg as never,
        prefix: "channels.matrix",
      }),
    ).toEqual([]);
    expect(
      shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning({
        account: {},
        channelName: "matrix",
        cfg: cfg as never,
        prefix: "channels.matrix",
      }),
    ).toBe(false);
  });
});
