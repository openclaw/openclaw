import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { setDefaultChannelPluginRegistryForTests } from "./channel-test-helpers.js";
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
      select,
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

  it("shows explicit dmScope config command in channel primer", async () => {
    const note = vi.fn(async () => {});
    const select = vi.fn(async () => "__done__");
    const { multiselect, text } = createUnexpectedPromptGuards();

    const prompter = createPrompter({
      note,
      select,
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
      select,
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
      select,
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
});
