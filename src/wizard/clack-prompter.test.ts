import { describe, expect, it, vi } from "vitest";
import { createClackPrompter, tokenizedOptionFilter } from "./clack-prompter.js";

vi.mock("@clack/prompts", async () => {
  const actual = await vi.importActual<typeof import("@clack/prompts")>("@clack/prompts");
  return {
    ...actual,
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
    text: vi.fn(),
    select: vi.fn(),
    multiselect: vi.fn(),
    autocompleteMultiselect: vi.fn(),
    confirm: vi.fn(),
  };
});

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

describe("createClackPrompter().text", () => {
  it("coerces undefined clack results to an empty string", async () => {
    const clack = await import("@clack/prompts");
    (clack.text as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    const prompter = createClackPrompter();
    const result = await prompter.text({ message: "Enter value" });

    expect(result).toBe("");
  });

  it("passes string results through unchanged", async () => {
    const clack = await import("@clack/prompts");
    (clack.text as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce("hello  ");

    const prompter = createClackPrompter();
    const result = await prompter.text({ message: "Enter value" });

    expect(result).toBe("hello  ");
  });
});
