import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../test-utils/prepare-compiled-subprocesses.js";
import type { OpenClawConfig } from "../../../config/types.js";

const { applyPluginDoctorCompatibilityMigrations, collectRelevantDoctorPluginIds } = vi.hoisted(
  () => ({
    applyPluginDoctorCompatibilityMigrations: vi.fn(),
    collectRelevantDoctorPluginIds: vi.fn(),
  }),
);
const loadBundledChannelDoctorContractApi = vi.hoisted(() => vi.fn());
const getBootstrapChannelPlugin = vi.hoisted(() => vi.fn());

vi.mock(import("../../../plugins/doctor-contract-registry.js"), async (importOriginal) => {
  const { isPluginDoctorMigrationDeferred } = await importOriginal();
  return {
    isPluginDoctorMigrationDeferred,
    collectDoctorConfigRepairPluginIds: (...args: unknown[]) =>
      collectRelevantDoctorPluginIds(...args),
    applyPluginDoctorCompatibilityMigrations: (...args: unknown[]) =>
      applyPluginDoctorCompatibilityMigrations(...args),
    collectRelevantDoctorPluginIds: (...args: unknown[]) => collectRelevantDoctorPluginIds(...args),
  };
});

vi.mock("../../../channels/plugins/doctor-contract-api.js", () => ({
  loadBundledChannelDoctorContractApi: (...args: unknown[]) =>
    loadBundledChannelDoctorContractApi(...args),
}));

vi.mock("../../../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (...args: unknown[]) => getBootstrapChannelPlugin(...args),
}));

let applyChannelDoctorCompatibilityMigrations: typeof import("./channel-legacy-config-migrate.js").applyChannelDoctorCompatibilityMigrations;

beforeAll(async () => {
  // Commands runs on the shared non-isolated worker, so reload after installing
  // this file's mock to avoid inheriting a cached real registry import.
  vi.resetModules();
  ({ applyChannelDoctorCompatibilityMigrations } =
    await import("./channel-legacy-config-migrate.js"));
});

beforeEach(() => {
  applyPluginDoctorCompatibilityMigrations.mockReset();
  collectRelevantDoctorPluginIds.mockReset();
  loadBundledChannelDoctorContractApi.mockReset();
  getBootstrapChannelPlugin.mockReset();
});

describe("bundled channel legacy config migrations", () => {
  it("does not treat channel metadata or blank ids as channel plugins", () => {
    collectRelevantDoctorPluginIds.mockReturnValue([]);
    applyPluginDoctorCompatibilityMigrations.mockReturnValue({ config: {}, changes: [] });

    applyChannelDoctorCompatibilityMigrations({
      channels: {
        defaults: {},
        modelByChannel: { discord: "openai/gpt-5.6-luna" },
        " ": {},
      },
    });

    expect(loadBundledChannelDoctorContractApi).not.toHaveBeenCalled();
    expect(getBootstrapChannelPlugin).not.toHaveBeenCalled();
    expect(applyPluginDoctorCompatibilityMigrations).not.toHaveBeenCalled();
  });

  it("only renames heartbeat blocks that use the common visibility shape", () => {
    collectRelevantDoctorPluginIds.mockReturnValue([]);
    loadBundledChannelDoctorContractApi.mockReturnValue({
      normalizeCompatibilityConfig: ({ cfg }: { cfg: OpenClawConfig }) => ({
        config: cfg,
        changes: [],
      }),
    });

    const result = applyChannelDoctorCompatibilityMigrations({
      channels: {
        feishu: {
          heartbeat: { visibility: "hidden", intervalMs: 1000 },
          accounts: {
            work: { heartbeat: { visibility: "visible" } },
            empty: { heartbeat: {} },
          },
        },
        slack: {
          heartbeat: { showOk: true },
          accounts: {
            work: { heartbeat: { showAlerts: false } },
          },
        },
      },
    });

    expect(result.next.channels).toEqual({
      feishu: {
        heartbeat: { visibility: "hidden", intervalMs: 1000 },
        accounts: { work: { heartbeat: { visibility: "visible" } }, empty: { heartbeat: {} } },
      },
      slack: {
        heartbeatVisibility: { showOk: true },
        accounts: { work: { heartbeatVisibility: { showAlerts: false } } },
      },
    });
  });

  it.each([false, true])(
    "prefers bundled channel doctor contracts (pluginContracts=%s)",
    (pluginContracts) => {
      collectRelevantDoctorPluginIds.mockReturnValueOnce([]);
      loadBundledChannelDoctorContractApi.mockImplementation((channelId: string) =>
        channelId === "slack"
          ? {
              normalizeCompatibilityConfig: ({ cfg }: { cfg: OpenClawConfig }) => ({
                config: {
                  ...cfg,
                  channels: {
                    ...cfg.channels,
                    slack: {
                      ...cfg.channels?.slack,
                      normalizedByBundledContract: true,
                    },
                  },
                },
                changes: ["Normalized channels.slack via bundled doctor contract."],
              }),
            }
          : undefined,
      );
      getBootstrapChannelPlugin.mockReturnValue(undefined);

      const result = applyChannelDoctorCompatibilityMigrations(
        { channels: { slack: { streaming: true } } },
        { pluginContracts },
      );
      expect(collectRelevantDoctorPluginIds).toHaveBeenCalledTimes(pluginContracts ? 1 : 0);

      expect(applyPluginDoctorCompatibilityMigrations).not.toHaveBeenCalled();
      expect(loadBundledChannelDoctorContractApi).toHaveBeenCalledWith("slack");
      expect(result.next).toHaveProperty("channels.slack", {
        streaming: true,
        normalizedByBundledContract: true,
      });
      expect(result.changes).toEqual(["Normalized channels.slack via bundled doctor contract."]);
    },
  );

  it("uses registry fallback when a bundled channel contract is unavailable", () => {
    collectRelevantDoctorPluginIds.mockReturnValueOnce(["mattermost"]);
    loadBundledChannelDoctorContractApi.mockReturnValue(undefined);
    getBootstrapChannelPlugin.mockReturnValue(undefined);
    const config = { channels: { mattermost: { allowPrivateNetwork: true } } };
    const migrated = {
      channels: { mattermost: { network: { dangerouslyAllowPrivateNetwork: true } } },
    };
    const changes = ["Migrated channel config."];
    applyPluginDoctorCompatibilityMigrations.mockReturnValueOnce({ config: migrated, changes });

    const result = applyChannelDoctorCompatibilityMigrations(config);

    expect(loadBundledChannelDoctorContractApi).toHaveBeenCalledWith("mattermost");
    expect(getBootstrapChannelPlugin).toHaveBeenCalledWith("mattermost");
    expect(applyPluginDoctorCompatibilityMigrations).toHaveBeenCalledTimes(1);
    expect(applyPluginDoctorCompatibilityMigrations).toHaveBeenCalledWith(config, {
      config,
      pluginIds: ["mattermost"],
    });
    expect(result).toEqual({ next: migrated, changes });
  });

  it("applies plugin doctor normalizers for configured non-channel plugin entries", () => {
    const model = "openai-codex/gpt-5.4-mini";
    const pluginConfig = (config: Record<string, unknown>) => ({
      plugins: { entries: { "lossless-claw": config } },
    });
    collectRelevantDoctorPluginIds.mockReturnValueOnce(["lossless-claw"]);
    applyPluginDoctorCompatibilityMigrations.mockReturnValueOnce({
      config: pluginConfig({ llm: { allowModelOverride: true, allowedModels: [model] } }),
      changes: ["Configured plugins.entries.lossless-claw.llm.allowedModels."],
    });

    const config = pluginConfig({ config: { summaryModel: model } });
    const result = applyChannelDoctorCompatibilityMigrations(config);

    expect(applyPluginDoctorCompatibilityMigrations).toHaveBeenCalledOnce();
    const migrationCall = applyPluginDoctorCompatibilityMigrations.mock.calls[0];
    expect(typeof migrationCall?.[0]).toBe("object");
    expect(migrationCall?.[1]).toStrictEqual({
      config,
      pluginIds: ["lossless-claw"],
      historicalWebhookListeners: undefined,
    });
    expect(result.changes).toEqual(["Configured plugins.entries.lossless-claw.llm.allowedModels."]);
  });
});
