import { describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
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

describe("setupChannels", () => {
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

    await setupChannels({} as ClawdbotConfig, runtime, prompter, {
      skipConfirm: true,
      quickstartDefaults: true,
      forceAllowFromChannels: ["whatsapp"],
    });

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Select channel (QuickStart)" }),
    );
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("QuickStart prompts for Matrix credentials", async () => {
    const envKeys = [
      "MATRIX_HOMESERVER",
      "MATRIX_USER_ID",
      "MATRIX_ACCESS_TOKEN",
      "MATRIX_PASSWORD",
      "MATRIX_DEVICE_NAME",
    ] as const;
    const prevEnv = Object.fromEntries(
      envKeys.map((key) => [key, process.env[key]]),
    ) as Record<(typeof envKeys)[number], string | undefined>;
    for (const key of envKeys) {
      delete process.env[key];
    }

    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Select channel (QuickStart)") return "matrix";
      throw new Error(`unexpected select prompt: ${message}`);
    });
    const multiselect = vi.fn(async () => {
      throw new Error("unexpected multiselect");
    });
    const text = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Matrix homeserver") {
        return "https://matrix.example.org";
      }
      if (message === "Matrix user id") {
        return "@clawdbot:example.org";
      }
      if (message === "Matrix access token") {
        return "syt_test";
      }
      throw new Error(`unexpected text prompt: ${message}`);
    });
    const confirm = vi.fn(async ({ message }: { message: string }) => {
      if (message.includes("Use a Matrix access token")) return true;
      throw new Error(`unexpected confirm prompt: ${message}`);
    });

    const prompter: WizardPrompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select: select as WizardPrompter["select"],
      multiselect,
      text: text as unknown as WizardPrompter["text"],
      confirm: confirm as WizardPrompter["confirm"],
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    };

    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    try {
      await setupChannels({} as ClawdbotConfig, runtime, prompter, {
        skipConfirm: true,
        quickstartDefaults: true,
        skipDmPolicyPrompt: true,
      });
    } finally {
      for (const key of envKeys) {
        if (prevEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = prevEnv[key];
        }
      }
    }

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Matrix homeserver" }),
    );
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Matrix user id" }),
    );
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Matrix access token" }),
    );
    expect(multiselect).not.toHaveBeenCalled();
  });
});
