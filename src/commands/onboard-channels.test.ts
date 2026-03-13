import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { discordPlugin } from "../../extensions/discord/src/channel.js";
import { imessagePlugin } from "../../extensions/imessage/src/channel.js";
import { signalPlugin } from "../../extensions/signal/src/channel.js";
import { slackPlugin } from "../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { whatsappPlugin } from "../../extensions/whatsapp/src/channel.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { setupChannels } from "./onboard-channels.js";

vi.mock("node:fs/promises", () => ({
  default: {
    access: vi.fn(async () => {
      throw new Error("ENOENT");
    }),
  },
}));

vi.mock("../channel-web.js", () => ({
  loginWeb: vi.fn(async () => {}),
}));

vi.mock("./onboard-helpers.js", () => ({
  detectBinary: vi.fn(async () => false),
}));

function createDirectOnboardingPlugin(params: { id: string; multiAccount: boolean }) {
  const { id, multiAccount } = params;
  return {
    id,
    meta: {
      id,
      label: id,
      selectionLabel: id,
      docsPath: `/channels/${id}`,
      blurb: "test stub.",
    },
    capabilities: {
      chatTypes: ["direct"],
    },
    onboarding: {
      channel: id,
      getStatus: async () => ({
        channel: id,
        configured: false,
        statusLines: [`${id}: not configured`],
        selectionHint: "not configured",
        quickstartScore: 1,
      }),
      configure: async ({ cfg }: { cfg: OpenClawConfig }) => ({ cfg }),
    },
    config: {
      listAccountIds: () => [DEFAULT_ACCOUNT_ID],
      resolveAccount: (_cfg: OpenClawConfig, accountId?: string | null) => ({
        accountId: multiAccount ? accountId?.trim() || DEFAULT_ACCOUNT_ID : DEFAULT_ACCOUNT_ID,
      }),
    },
    setup: {
      resolveAccountId: ({ accountId }: { accountId?: string }) =>
        multiAccount ? accountId?.trim() || DEFAULT_ACCOUNT_ID : DEFAULT_ACCOUNT_ID,
      applyAccountConfig: ({ cfg }: { cfg: OpenClawConfig }) => cfg,
    },
  };
}

describe("setupChannels", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "discord", plugin: discordPlugin, source: "test" },
        { pluginId: "slack", plugin: slackPlugin, source: "test" },
        { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
        { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
        { pluginId: "signal", plugin: signalPlugin, source: "test" },
        { pluginId: "imessage", plugin: imessagePlugin, source: "test" },
      ]),
    );
  });
  it("QuickStart uses single-select (no multiselect) and doesn't prompt for Telegram token when WhatsApp is chosen", async () => {
    const select = vi.fn(async () => "whatsapp");
    const multiselect = vi.fn(async () => {
      throw new Error("unexpected multiselect");
    });
    const text = vi.fn(async ({ message }: { message: string }) => {
      if (message.includes("Enter Telegram bot token")) {
        throw new Error("unexpected Telegram token prompt");
      }
      if (message.includes("Your personal WhatsApp number")) {
        return "+15555550123";
      }
      throw new Error(`unexpected text prompt: ${message}`);
    });

    const prompter: WizardPrompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select,
      multiselect,
      text: text as unknown as WizardPrompter["text"],
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    };

    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    await setupChannels({} as OpenClawConfig, runtime, prompter, {
      skipConfirm: true,
      quickstartDefaults: true,
      forceAllowFromChannels: ["whatsapp"],
    });

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Select channel (QuickStart)" }),
    );
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("prompts for configured channel action and skips configuration when told to skip", async () => {
    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Select channel (QuickStart)") {
        return "telegram";
      }
      if (message.includes("already configured")) {
        return "skip";
      }
      throw new Error(`unexpected select prompt: ${message}`);
    });
    const multiselect = vi.fn(async () => {
      throw new Error("unexpected multiselect");
    });
    const text = vi.fn(async ({ message }: { message: string }) => {
      throw new Error(`unexpected text prompt: ${message}`);
    });

    const prompter: WizardPrompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select,
      multiselect,
      text: text as unknown as WizardPrompter["text"],
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    };

    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    await setupChannels(
      {
        channels: {
          telegram: {
            botToken: "token",
          },
        },
      } as OpenClawConfig,
      runtime,
      prompter,
      {
        skipConfirm: true,
        quickstartDefaults: true,
      },
    );

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Select channel (QuickStart)" }),
    );
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("already configured") }),
    );
    expect(multiselect).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("adds disabled hint to channel selection when a channel is disabled", async () => {
    let selectionCount = 0;
    const select = vi.fn(async ({ message, options }: { message: string; options: unknown[] }) => {
      if (message === "Select a channel") {
        selectionCount += 1;
        const opts = options as Array<{ value: string; hint?: string }>;
        const telegram = opts.find((opt) => opt.value === "telegram");
        expect(telegram?.hint).toContain("disabled");
        return selectionCount === 1 ? "telegram" : "__done__";
      }
      if (message.includes("already configured")) {
        return "skip";
      }
      return "__done__";
    });
    const multiselect = vi.fn(async () => {
      throw new Error("unexpected multiselect");
    });
    const prompter: WizardPrompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select,
      multiselect,
      text: vi.fn(async () => ""),
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    };

    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    await setupChannels(
      {
        channels: {
          telegram: {
            botToken: "token",
            enabled: false,
          },
        },
      } as OpenClawConfig,
      runtime,
      prompter,
      {
        skipConfirm: true,
      },
    );

    expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: "Select a channel" }));
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("defaults DM isolation to per-account-channel-peer when selected channels support multiple accounts", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "alpha",
          plugin: createDirectOnboardingPlugin({ id: "alpha", multiAccount: true }),
          source: "test",
        },
        {
          pluginId: "beta",
          plugin: createDirectOnboardingPlugin({ id: "beta", multiAccount: true }),
          source: "test",
        },
      ]),
    );

    const select = vi
      .fn()
      .mockResolvedValueOnce("alpha")
      .mockResolvedValueOnce("beta")
      .mockResolvedValueOnce("__done__");
    const note = vi.fn(async () => {});
    const prompter: WizardPrompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note,
      select,
      multiselect: vi.fn(async () => []),
      text: vi.fn(async () => ""),
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    const result = await setupChannels({} as OpenClawConfig, runtime, prompter, {
      skipConfirm: true,
      skipDmPolicyPrompt: true,
    });

    expect(result.session?.dmScope).toBe("per-account-channel-peer");
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('session.dmScope="per-account-channel-peer"'),
      "DM session scope",
    );
  });

  it("defaults DM isolation to per-channel-peer when selected channels are single-account", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "alpha",
          plugin: createDirectOnboardingPlugin({ id: "alpha", multiAccount: false }),
          source: "test",
        },
        {
          pluginId: "beta",
          plugin: createDirectOnboardingPlugin({ id: "beta", multiAccount: false }),
          source: "test",
        },
      ]),
    );

    const select = vi
      .fn()
      .mockResolvedValueOnce("alpha")
      .mockResolvedValueOnce("beta")
      .mockResolvedValueOnce("__done__");
    const note = vi.fn(async () => {});
    const prompter: WizardPrompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note,
      select,
      multiselect: vi.fn(async () => []),
      text: vi.fn(async () => ""),
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    const result = await setupChannels({} as OpenClawConfig, runtime, prompter, {
      skipConfirm: true,
      skipDmPolicyPrompt: true,
    });

    expect(result.session?.dmScope).toBe("per-channel-peer");
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('session.dmScope="per-channel-peer"'),
      "DM session scope",
    );
  });
});
