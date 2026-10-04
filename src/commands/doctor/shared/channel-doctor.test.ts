import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeResolvedSecretInputString } from "../../../config/types.secrets.js";
import {
  collectChannelDoctorCompatibilityMutations,
  collectChannelDoctorMutableAllowlistWarnings,
  collectChannelDoctorPreviewWarnings,
  collectChannelDoctorStaleConfigMutations,
  createChannelDoctorEmptyAllowlistPolicyHooks,
  runChannelDoctorConfigSequences,
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

  it.each([
    { name: "no channels", cfg: {}, stale: false },
    {
      name: "channel metadata",
      cfg: {
        channels: {
          defaults: { heartbeatVisibility: { showOk: true } },
          modelByChannel: { discord: { "fixture-channel": "openai/gpt-5.6-luna" } },
          " ": { token: "dummy" },
        },
      },
      stale: true,
    },
    {
      name: "disabled channel",
      cfg: { channels: { mattermost: { enabled: false } } },
      stale: false,
    },
  ])("skips plugin discovery for $name", async ({ cfg, stale }) => {
    const result = stale
      ? await collectChannelDoctorStaleConfigMutations(cfg)
      : collectChannelDoctorCompatibilityMutations(cfg);
    expect(result).toStrictEqual([]);
    for (const lookup of Object.values(mocks)) {
      expect(lookup).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])(
    "keeps stale cleanup scoped and warning-only config unchanged (warning=%s)",
    async (warning) => {
      const cfg = { channels: { matrix: { enabled: true }, discord: { enabled: true } } };
      const alternateConfig = { ...cfg, channels: { ...cfg.channels, matrix: { enabled: false } } };
      const matrixCleanup = vi.fn(({ cfg: currentCfg }: { cfg: OpenClawConfig }) =>
        warning
          ? { config: alternateConfig, changes: [], warnings: ["matrix warning"] }
          : { config: currentCfg, changes: ["matrix cleanup"] },
      );
      const discordCleanup = vi.fn(({ cfg: currentCfg }: { cfg: OpenClawConfig }) => ({
        config: currentCfg,
        changes: ["discord cleanup"],
      }));
      mocks.getBundledChannelSetupPlugin.mockImplementation((id: string) => ({
        id,
        doctor: { cleanStaleConfig: id === "matrix" ? matrixCleanup : discordCleanup },
      }));
      const result = await collectChannelDoctorStaleConfigMutations(cfg, {
        channelIds: warning ? ["matrix", "discord"] : ["matrix"],
      });
      expect(matrixCleanup).toHaveBeenCalledTimes(1);
      if (warning) {
        expect(result).toEqual([
          { config: cfg, changes: [], warnings: ["matrix warning"] },
          { config: cfg, changes: ["discord cleanup"] },
        ]);
        expect(discordCleanup).toHaveBeenCalledWith({ cfg });
      } else {
        expect(result).toEqual([{ config: cfg, changes: ["matrix cleanup"] }]);
        expect(discordCleanup).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["read-only", "setup", "runtime", "malformed"])(
    "merges %s doctor adapters with their receiver and runtime-only hooks",
    async (source) => {
      const normalizeCompatibilityConfig = vi.fn(function (
        this: { groupModel: string },
        { cfg }: { cfg: OpenClawConfig },
      ) {
        return { config: cfg, changes: [this.groupModel] };
      });
      const collectMutableAllowlistWarnings = vi.fn(() => ["runtime warning"]);
      const doctor = { groupModel: "sender", normalizeCompatibilityConfig };
      mockReadOnlyMatrixPlugin(
        source === "read-only"
          ? doctor
          : source === "malformed"
            ? {
                normalizeCompatibilityConfig: null,
                collectMutableAllowlistWarnings: "not-a-function",
                warnOnEmptyGroupSenderAllowlist: "yes",
              }
            : undefined,
      );
      mockBundledMatrixSetupPlugin(
        source === "setup" || source === "malformed" ? doctor : undefined,
      );
      mockBundledMatrixRuntimePlugin({
        ...(source === "runtime" ? doctor : {}),
        collectMutableAllowlistWarnings,
      });
      const cfg = createMatrixEnabledConfig();
      const env = { OPENCLAW_HOME: "/tmp/openclaw-test-home" };
      expect(collectChannelDoctorCompatibilityMutations(cfg, { env })).toEqual([
        { config: cfg, changes: ["sender"] },
      ]);
      expect(normalizeCompatibilityConfig).toHaveBeenCalledTimes(1);
      expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(cfg, {
        env,
        ...READ_ONLY_CHANNEL_DOCTOR_OPTIONS,
      });
      for (const lookup of [
        mocks.getLoadedChannelPlugin,
        mocks.getBundledChannelSetupPlugin,
        mocks.getBundledChannelPlugin,
      ]) {
        expect(lookup).toHaveBeenCalledWith("matrix");
      }
      expect(mocks.getBundledChannelSetupPlugin).not.toHaveBeenCalledWith("discord");
      await expect(collectChannelDoctorMutableAllowlistWarnings({ cfg })).resolves.toEqual([
        "runtime warning",
      ]);
      expect(collectMutableAllowlistWarnings).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves config and continues after a channel repair throws", () => {
    const cfg = { channels: { matrix: { enabled: true }, slack: { enabled: true } } };
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
      plugins: [
        {
          id: "matrix",
          doctor: {
            normalizeCompatibilityConfig({ cfg: candidate }: { cfg: typeof cfg }) {
              candidate.channels.matrix.enabled = false;
              throw new Error("fixture repair failed");
            },
          },
        },
        {
          id: "slack",
          doctor: { normalizeCompatibilityConfig: createNormalizeCompatibilityConfig("slack") },
        },
      ],
    });

    expect(collectChannelDoctorCompatibilityMutations(cfg)).toEqual([
      {
        config: cfg,
        changes: ["slack"],
        warnings: [expect.stringContaining('Plugin "matrix" config repair failed')],
      },
    ]);
    expect(cfg.channels.matrix.enabled).toBe(true);
  });

  it("retains informational channel guidance separately from changes and warnings", async () => {
    mockReadOnlyMatrixPlugin({
      runConfigSequence: () => ({
        changeNotes: ["Migrated explicit listener settings."],
        infoNotes: ["The default listener remains available; set legacyWebhook:false to close it."],
        warningNotes: ["The callback path requires Gateway authentication."],
      }),
    });
    await expect(
      runChannelDoctorConfigSequences({
        cfg: createMatrixEnabledConfig(),
        env: {},
        shouldRepair: false,
      }),
    ).resolves.toEqual({
      changeNotes: ["Migrated explicit listener settings."],
      infoNotes: ["The default listener remains available; set legacyWebhook:false to close it."],
      warningNotes: ["The callback path requires Gateway authentication."],
    });
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

  it("reuses empty allowlist entries without exposing config to per-account hooks", () => {
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
    expect(collectEmptyAllowlistExtraWarnings.mock.calls[0]?.[0]).not.toHaveProperty("cfg");
    expect(collectEmptyAllowlistExtraWarnings).toHaveBeenCalledTimes(3);
    expect(shouldSkipDefaultEmptyGroupAllowlistWarning).toHaveBeenCalledTimes(1);
  });
});
