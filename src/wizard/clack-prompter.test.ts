import { password, text } from "@clack/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClackPrompter, tokenizedOptionFilter } from "./clack-prompter.js";

vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...actual,
    password: vi.fn(),
    text: vi.fn(),
  };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
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

describe("createClackPrompter", () => {
  it("prints plain output without note framing", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prompter = createClackPrompter();

    await prompter.plain?.('{"ok":true}');

    expect(write).toHaveBeenCalledWith('{"ok":true}\n');
  });

  it("normalizes nullish clack text results to empty strings", async () => {
    vi.mocked(text).mockResolvedValueOnce(undefined as never);
    const validate = vi.fn((value: string) => (value ? undefined : "Required"));
    const prompter = createClackPrompter();

    const result = await prompter.text({
      message: "Name",
      validate,
    });

    const validateText = vi.mocked(text).mock.calls[0]?.[0].validate;
    expect(validateText?.(undefined)).toBe("Required");
    expect(validate).toHaveBeenCalledWith("");
    expect(result).toBe("");
  });

  it("preserves string clack text results without trimming", async () => {
    vi.mocked(text).mockResolvedValueOnce("  Alice  ");
    const prompter = createClackPrompter();

    const result = await prompter.text({
      message: "Name",
    });

    expect(result).toBe("  Alice  ");
  });

  it("normalizes non-string clack password results to empty strings", async () => {
    vi.mocked(password).mockResolvedValueOnce({ cancelled: true } as never);
    const prompter = createClackPrompter();

    const result = await prompter.text({
      message: "Token",
      sensitive: true,
    });

    expect(result).toBe("");
  });
});
