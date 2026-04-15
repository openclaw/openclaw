import { describe, expect, it, vi } from "vitest";

const clackPromptsMocks = vi.hoisted(() => ({
  autocompleteMultiselect: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
  intro: vi.fn(),
  isCancel: vi.fn(() => false),
  multiselect: vi.fn(),
  outro: vi.fn(),
  select: vi.fn(),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    message: vi.fn(),
    stop: vi.fn(),
  })),
  text: vi.fn(),
}));

vi.mock("@clack/prompts", () => clackPromptsMocks);

import { createClackPrompter, tokenizedOptionFilter } from "./clack-prompter.js";

describe("tokenizedOptionFilter", () => {
  it("matches tokens regardless of order", () => {
    const option = {
      value: "openai/gpt-5.4",
      label: "openai/gpt-5.4",
      hint: "ctx 400k",
    };

    expect(tokenizedOptionFilter("gpt-5.4 openai/", option)).toBe(true);
    expect(tokenizedOptionFilter("openai/ gpt-5.4", option)).toBe(true);
  });

  it("requires all tokens to match", () => {
    const option = {
      value: "openai/gpt-5.4",
      label: "openai/gpt-5.4",
    };

    expect(tokenizedOptionFilter("gpt-5.4 anthropic/", option)).toBe(false);
  });

  it("matches against label, hint, and value", () => {
    const option = {
      value: "openai/gpt-5.4",
      label: "GPT 5.4",
      hint: "provider openai",
    };

    expect(tokenizedOptionFilter("provider openai", option)).toBe(true);
    expect(tokenizedOptionFilter("openai gpt-5.4", option)).toBe(true);
  });
});

describe("createClackPrompter", () => {
  it("normalizes undefined text responses to an empty string", async () => {
    clackPromptsMocks.text.mockResolvedValueOnce(undefined);

    const prompter = createClackPrompter();
    const result = await prompter.text({ message: "Token" });

    expect(result).toBe("");
  });
});
