import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  patchChannelOnboardingAdapter,
  setDefaultChannelPluginRegistryForTests,
} from "./channel-test-helpers.js";
import { setupChannels } from "./onboard-channels.js";
import { createExitThrowingRuntime, createWizardPrompter } from "./test-wizard-helpers.js";

function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
  return createWizardPrompter(
    {
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      ...overrides,
    },
    { defaultSelect: "__done__" },
  );
}

function createUnexpectedPromptGuards() {
  return {
    multiselect: vi.fn(async () => {
      throw new Error("unexpected multiselect");
    }),
    text: vi.fn(async ({ message }: { message: string }) => {
      throw new Error(`unexpected text prompt: ${message}`);
    }) as unknown as WizardPrompter["text"],
  };
}

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

vi.mock("./onboarding/plugin-install.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    // Allow tests to simulate an empty plugin registry during onboarding.
    reloadOnboardingPluginRegistry: vi.fn(() => {}),
  };
});

describe("setupChannels", () => {
  beforeEach(() => {
    setDefaultChannelPluginRegistryForTests();
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

    const prompter = createPrompter({
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text: text as unknown as WizardPrompter["text"],
    });

    const runtime = createExitThrowingRuntime();

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

  it("continues Telegram onboarding even when plugin registry is empty (avoids 'plugin not available' block)", async () => {
    // Simulate missing registry entries (the scenario reported in #25545).
    setActivePluginRegistry(createEmptyPluginRegistry());
    // Avoid accidental env-token configuration changing the prompt path.
    process.env.TELEGRAM_BOT_TOKEN = "";

    const note = vi.fn(async (_message?: string, _title?: string) => {});
    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Select channel (QuickStart)") {
        return "telegram";
      }
      return "__done__";
    });
    const text = vi.fn(async () => "123:token");

    const prompter = createPrompter({
      note,
      select: select as unknown as WizardPrompter["select"],
      text: text as unknown as WizardPrompter["text"],
    });

    const runtime = createExitThrowingRuntime();

    await setupChannels({} as OpenClawConfig, runtime, prompter, {
      skipConfirm: true,
      quickstartDefaults: true,
    });

    // The new flow should not stop setup with a hard "plugin not available" note.
    const sawHardStop = note.mock.calls.some((call) => {
      const message = call[0];
      const title = call[1];
      return (
        title === "Channel setup" && String(message).trim() === "telegram plugin not available."
      );
    });
    expect(sawHardStop).toBe(false);
  });

  it("shows explicit dmScope config command in channel primer", async () => {
    const note = vi.fn(async (_message?: string, _title?: string) => {});
    const select = vi.fn(async () => "__done__");
    const { multiselect, text } = createUnexpectedPromptGuards();

    const prompter = createPrompter({
      note,
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text,
    });

    const runtime = createExitThrowingRuntime();

    await setupChannels({} as OpenClawConfig, runtime, prompter, {
      skipConfirm: true,
    });

    const sawPrimer = note.mock.calls.some(
      ([message, title]) =>
        title === "How channels work" &&
        String(message).includes('config set session.dmScope "per-channel-peer"'),
    );
    expect(sawPrimer).toBe(true);
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
    const { multiselect, text } = createUnexpectedPromptGuards();

    const prompter = createPrompter({
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text,
    });

    const runtime = createExitThrowingRuntime();

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
    const prompter = createPrompter({
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text: vi.fn(async () => "") as unknown as WizardPrompter["text"],
    });

    const runtime = createExitThrowingRuntime();

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

  it("uses configureInteractive skip without mutating selection/account state", async () => {
    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Select channel (QuickStart)") {
        return "telegram";
      }
      return "__done__";
    });
    const selection = vi.fn();
    const onAccountId = vi.fn();
    const configureInteractive = vi.fn(async () => "skip" as const);
    const restore = patchChannelOnboardingAdapter("telegram", {
      getStatus: vi.fn(async ({ cfg }) => ({
        channel: "telegram",
        configured: Boolean(cfg.channels?.telegram?.botToken),
        statusLines: [],
      })),
      configureInteractive,
    });
    const { multiselect, text } = createUnexpectedPromptGuards();

    const prompter = createPrompter({
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text,
    });

    const runtime = createExitThrowingRuntime();
    try {
      const cfg = await setupChannels({} as OpenClawConfig, runtime, prompter, {
        skipConfirm: true,
        quickstartDefaults: true,
        onSelection: selection,
        onAccountId,
      });

      expect(configureInteractive).toHaveBeenCalledWith(
        expect.objectContaining({ configured: false, label: expect.any(String) }),
      );
      expect(selection).toHaveBeenCalledWith([]);
      expect(onAccountId).not.toHaveBeenCalled();
      expect(cfg.channels?.telegram?.botToken).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("applies configureInteractive result cfg/account updates", async () => {
    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Select channel (QuickStart)") {
        return "telegram";
      }
      return "__done__";
    });
    const selection = vi.fn();
    const onAccountId = vi.fn();
    const configureInteractive = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
      cfg: {
        ...cfg,
        channels: {
          ...cfg.channels,
          telegram: { ...cfg.channels?.telegram, botToken: "new-token" },
        },
      } as OpenClawConfig,
      accountId: "acct-1",
    }));
    const configure = vi.fn(async () => {
      throw new Error("configure should not be called when configureInteractive is present");
    });
    const restore = patchChannelOnboardingAdapter("telegram", {
      getStatus: vi.fn(async ({ cfg }) => ({
        channel: "telegram",
        configured: Boolean(cfg.channels?.telegram?.botToken),
        statusLines: [],
      })),
      configureInteractive,
      configure,
    });
    const { multiselect, text } = createUnexpectedPromptGuards();

    const prompter = createPrompter({
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text,
    });

    const runtime = createExitThrowingRuntime();
    try {
      const cfg = await setupChannels({} as OpenClawConfig, runtime, prompter, {
        skipConfirm: true,
        quickstartDefaults: true,
        onSelection: selection,
        onAccountId,
      });

      expect(configureInteractive).toHaveBeenCalledTimes(1);
      expect(configure).not.toHaveBeenCalled();
      expect(selection).toHaveBeenCalledWith(["telegram"]);
      expect(onAccountId).toHaveBeenCalledWith("telegram", "acct-1");
      expect(cfg.channels?.telegram?.botToken).toBe("new-token");
    } finally {
      restore();
    }
  });

  it("uses configureWhenConfigured when channel is already configured", async () => {
    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Select channel (QuickStart)") {
        return "telegram";
      }
      return "__done__";
    });
    const selection = vi.fn();
    const onAccountId = vi.fn();
    const configureWhenConfigured = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
      cfg: {
        ...cfg,
        channels: {
          ...cfg.channels,
          telegram: { ...cfg.channels?.telegram, botToken: "updated-token" },
        },
      } as OpenClawConfig,
      accountId: "acct-2",
    }));
    const configure = vi.fn(async () => {
      throw new Error(
        "configure should not be called when configureWhenConfigured handles updates",
      );
    });
    const restore = patchChannelOnboardingAdapter("telegram", {
      getStatus: vi.fn(async ({ cfg }) => ({
        channel: "telegram",
        configured: Boolean(cfg.channels?.telegram?.botToken),
        statusLines: [],
      })),
      configureInteractive: undefined,
      configureWhenConfigured,
      configure,
    });
    const { multiselect, text } = createUnexpectedPromptGuards();

    const prompter = createPrompter({
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text,
    });

    const runtime = createExitThrowingRuntime();
    try {
      const cfg = await setupChannels(
        {
          channels: {
            telegram: {
              botToken: "old-token",
            },
          },
        } as OpenClawConfig,
        runtime,
        prompter,
        {
          skipConfirm: true,
          quickstartDefaults: true,
          onSelection: selection,
          onAccountId,
        },
      );

      expect(configureWhenConfigured).toHaveBeenCalledTimes(1);
      expect(configureWhenConfigured).toHaveBeenCalledWith(
        expect.objectContaining({ configured: true, label: expect.any(String) }),
      );
      expect(configure).not.toHaveBeenCalled();
      expect(selection).toHaveBeenCalledWith(["telegram"]);
      expect(onAccountId).toHaveBeenCalledWith("telegram", "acct-2");
      expect(cfg.channels?.telegram?.botToken).toBe("updated-token");
    } finally {
      restore();
    }
  });

  it("respects configureWhenConfigured skip without mutating selection or account state", async () => {
    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Select channel (QuickStart)") {
        return "telegram";
      }
      throw new Error(`unexpected select prompt: ${message}`);
    });
    const selection = vi.fn();
    const onAccountId = vi.fn();
    const configureWhenConfigured = vi.fn(async () => "skip" as const);
    const configure = vi.fn(async () => {
      throw new Error("configure should not run when configureWhenConfigured handles skip");
    });
    const restore = patchChannelOnboardingAdapter("telegram", {
      getStatus: vi.fn(async ({ cfg }) => ({
        channel: "telegram",
        configured: Boolean(cfg.channels?.telegram?.botToken),
        statusLines: [],
      })),
      configureInteractive: undefined,
      configureWhenConfigured,
      configure,
    });
    const { multiselect, text } = createUnexpectedPromptGuards();

    const prompter = createPrompter({
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text,
    });

    const runtime = createExitThrowingRuntime();
    try {
      const cfg = await setupChannels(
        {
          channels: {
            telegram: {
              botToken: "old-token",
            },
          },
        } as OpenClawConfig,
        runtime,
        prompter,
        {
          skipConfirm: true,
          quickstartDefaults: true,
          onSelection: selection,
          onAccountId,
        },
      );

      expect(configureWhenConfigured).toHaveBeenCalledWith(
        expect.objectContaining({ configured: true, label: expect.any(String) }),
      );
      expect(configure).not.toHaveBeenCalled();
      expect(selection).toHaveBeenCalledWith([]);
      expect(onAccountId).not.toHaveBeenCalled();
      expect(cfg.channels?.telegram?.botToken).toBe("old-token");
    } finally {
      restore();
    }
  });

  it("prefers configureInteractive over configureWhenConfigured when both hooks exist", async () => {
    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Select channel (QuickStart)") {
        return "telegram";
      }
      throw new Error(`unexpected select prompt: ${message}`);
    });
    const selection = vi.fn();
    const onAccountId = vi.fn();
    const configureInteractive = vi.fn(async () => "skip" as const);
    const configureWhenConfigured = vi.fn(async () => {
      throw new Error("configureWhenConfigured should not run when configureInteractive exists");
    });
    const restore = patchChannelOnboardingAdapter("telegram", {
      getStatus: vi.fn(async ({ cfg }) => ({
        channel: "telegram",
        configured: Boolean(cfg.channels?.telegram?.botToken),
        statusLines: [],
      })),
      configureInteractive,
      configureWhenConfigured,
    });
    const { multiselect, text } = createUnexpectedPromptGuards();

    const prompter = createPrompter({
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text,
    });

    const runtime = createExitThrowingRuntime();
    try {
      await setupChannels(
        {
          channels: {
            telegram: {
              botToken: "old-token",
            },
          },
        } as OpenClawConfig,
        runtime,
        prompter,
        {
          skipConfirm: true,
          quickstartDefaults: true,
          onSelection: selection,
          onAccountId,
        },
      );

      expect(configureInteractive).toHaveBeenCalledWith(
        expect.objectContaining({ configured: true, label: expect.any(String) }),
      );
      expect(configureWhenConfigured).not.toHaveBeenCalled();
      expect(selection).toHaveBeenCalledWith([]);
      expect(onAccountId).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
