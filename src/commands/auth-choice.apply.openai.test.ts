import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoiceOpenAI } from "./auth-choice.apply.openai.js";

const loginOpenAICodex = vi.hoisted(() => vi.fn());

vi.mock("@mariozechner/pi-ai", () => ({
  loginOpenAICodex,
}));

const noopAsync = async () => {};

describe("applyAuthChoiceOpenAI", () => {
  const previousSshTty = process.env.SSH_TTY;

  afterEach(() => {
    loginOpenAICodex.mockReset();
    if (previousSshTty === undefined) {
      delete process.env.SSH_TTY;
    } else {
      process.env.SSH_TTY = previousSshTty;
    }
  });

  it("throws when openai-codex OAuth login fails", async () => {
    process.env.SSH_TTY = "1";
    loginOpenAICodex.mockRejectedValueOnce(new Error("oauth failed"));

    const prompter: WizardPrompter = {
      intro: vi.fn(noopAsync),
      outro: vi.fn(noopAsync),
      note: vi.fn(noopAsync),
      select: vi.fn(async () => "" as never),
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

    await expect(
      applyAuthChoiceOpenAI({
        authChoice: "openai-codex",
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
      }),
    ).rejects.toThrow("oauth failed");
  });
});
