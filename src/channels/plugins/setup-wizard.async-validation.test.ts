import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "./setup-wizard.js";
import type { ChannelPlugin } from "./types.js";

function createPrompter(values: string[]): WizardPrompter {
  const queue = [...values];
  return {
    intro: async () => {},
    outro: async () => {},
    note: async () => {},
    select: async () => {
      throw new Error("unexpected select prompt");
    },
    multiselect: async () => {
      throw new Error("unexpected multiselect prompt");
    },
    text: async () => {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("missing text prompt value");
      }
      return next;
    },
    confirm: async () => {
      throw new Error("unexpected confirm prompt");
    },
    progress: () => ({
      update: () => {},
      stop: () => {},
    }),
  };
}

function createVkSetupTestPlugin(params?: {
  validateCompleteInput?: NonNullable<NonNullable<ChannelPlugin["setup"]>["validateCompleteInput"]>;
  validateInputAsync?: NonNullable<NonNullable<ChannelPlugin["setup"]>["validateInputAsync"]>;
}): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: "vk",
      label: "VK",
      docsPath: "/channels/vk",
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
    }),
    setup: {
      applyAccountConfig: ({ cfg, input }) => {
        const existing = (cfg.channels?.vk as Record<string, unknown> | undefined) ?? {};
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            vk: {
              ...existing,
              enabled: true,
              ...(input.communityId ? { communityId: input.communityId } : {}),
              ...(input.token ? { communityAccessToken: input.token } : {}),
            },
          },
        };
      },
      ...(params?.validateCompleteInput
        ? { validateCompleteInput: params.validateCompleteInput }
        : {}),
      ...(params?.validateInputAsync ? { validateInputAsync: params.validateInputAsync } : {}),
    },
  } as ChannelPlugin;
}

const baseCfg: OpenClawConfig = {};

describe("buildChannelSetupWizardAdapterFromSetupWizard", () => {
  it("validates the fully assembled candidate config before returning", async () => {
    const validateCompleteInput = vi.fn(({ cfg, candidateCfg, accountId, input }) => {
      expect(cfg).toEqual(baseCfg);
      expect(accountId).toBe("default");
      expect(input).toMatchObject({
        communityId: "123",
        token: "vk-token",
      });
      expect(candidateCfg.channels?.vk).toMatchObject({
        enabled: true,
        communityId: "123",
        communityAccessToken: "vk-token",
      });
      return null;
    });
    const validateInputAsync = vi.fn(async () => null);
    const plugin = createVkSetupTestPlugin({
      validateCompleteInput,
      validateInputAsync,
    });
    const adapter = buildChannelSetupWizardAdapterFromSetupWizard({
      plugin,
      wizard: {
        channel: "vk",
        deferApplyUntilValidated: true,
        status: {
          configuredLabel: "Configured",
          unconfiguredLabel: "Not configured",
          resolveConfigured: () => false,
        },
        credentials: [],
        textInputs: [
          {
            inputKey: "communityId",
            message: "Community ID",
          },
          {
            inputKey: "token",
            message: "Community token",
          },
        ],
      },
    });

    const result = await adapter.configure({
      cfg: baseCfg,
      runtime: {} as never,
      prompter: createPrompter(["123", "vk-token"]),
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(validateCompleteInput).toHaveBeenCalledTimes(1);
    expect(validateInputAsync).toHaveBeenCalledTimes(1);
    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.vk).toMatchObject({
      enabled: true,
      communityId: "123",
      communityAccessToken: "vk-token",
    });
  });

  it("surfaces deferred async validation failures", async () => {
    const plugin = createVkSetupTestPlugin({
      validateInputAsync: vi.fn(async ({ candidateCfg }) => {
        expect(candidateCfg.channels?.vk).toMatchObject({
          enabled: true,
          communityId: "123",
          communityAccessToken: "vk-token",
        });
        return "VK long poll probe failed";
      }),
    });
    const adapter = buildChannelSetupWizardAdapterFromSetupWizard({
      plugin,
      wizard: {
        channel: "vk",
        deferApplyUntilValidated: true,
        status: {
          configuredLabel: "Configured",
          unconfiguredLabel: "Not configured",
          resolveConfigured: () => false,
        },
        credentials: [],
        textInputs: [
          {
            inputKey: "communityId",
            message: "Community ID",
          },
          {
            inputKey: "token",
            message: "Community token",
          },
        ],
      },
    });

    await expect(
      adapter.configure({
        cfg: baseCfg,
        runtime: {} as never,
        prompter: createPrompter(["123", "vk-token"]),
        accountOverrides: {},
        shouldPromptAccountIds: false,
        forceAllowFrom: false,
      }),
    ).rejects.toThrow("VK long poll probe failed");
  });
});
