import { afterEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  ensureApiKeyFromOptionEnvOrPrompt,
  ensureApiKeyFromEnvOrPrompt,
  maybeApplyApiKeyFromOption,
  normalizeTokenProviderInput,
} from "./auth-choice.apply-helpers.js";

const ORIGINAL_MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const ORIGINAL_MINIMAX_OAUTH_TOKEN = process.env.MINIMAX_OAUTH_TOKEN;

function restoreMinimaxEnv(): void {
  if (ORIGINAL_MINIMAX_API_KEY === undefined) {
    delete process.env.MINIMAX_API_KEY;
  } else {
    process.env.MINIMAX_API_KEY = ORIGINAL_MINIMAX_API_KEY;
  }
  if (ORIGINAL_MINIMAX_OAUTH_TOKEN === undefined) {
    delete process.env.MINIMAX_OAUTH_TOKEN;
  } else {
    process.env.MINIMAX_OAUTH_TOKEN = ORIGINAL_MINIMAX_OAUTH_TOKEN;
  }
}

function createPrompter(params?: {
  confirm?: WizardPrompter["confirm"];
  note?: WizardPrompter["note"];
  select?: WizardPrompter["select"];
  text?: WizardPrompter["text"];
}): WizardPrompter {
  return {
    confirm: params?.confirm ?? (vi.fn(async () => true) as WizardPrompter["confirm"]),
    note: params?.note ?? (vi.fn(async () => undefined) as WizardPrompter["note"]),
    ...(params?.select ? { select: params.select } : {}),
    text: params?.text ?? (vi.fn(async () => "prompt-key") as WizardPrompter["text"]),
  } as unknown as WizardPrompter;
}

function createPromptSpies(params?: { confirmResult?: boolean; textResult?: string }) {
  const confirm = vi.fn(async () => params?.confirmResult ?? true);
  const note = vi.fn(async () => undefined);
  const text = vi.fn(async () => params?.textResult ?? "prompt-key");
  return { confirm, note, text };
}

async function runEnsureMinimaxApiKeyFlow(params: { confirmResult: boolean; textResult: string }) {
  process.env.MINIMAX_API_KEY = "env-key";
  delete process.env.MINIMAX_OAUTH_TOKEN;

  const { confirm, text } = createPromptSpies({
    confirmResult: params.confirmResult,
    textResult: params.textResult,
  });
  const setCredential = vi.fn(async () => undefined);

  const result = await ensureApiKeyFromEnvOrPrompt({
    config: {},
    provider: "minimax",
    envLabel: "MINIMAX_API_KEY",
    promptMessage: "Enter key",
    normalize: (value) => value.trim(),
    validate: () => undefined,
    prompter: createPrompter({ confirm, text }),
    setCredential,
  });

  return { result, setCredential, confirm, text };
}

afterEach(() => {
  restoreMinimaxEnv();
  vi.restoreAllMocks();
});

describe("normalizeTokenProviderInput", () => {
  it("trims and lowercases non-empty values", () => {
    expect(normalizeTokenProviderInput("  HuGgInGfAcE  ")).toBe("huggingface");
    expect(normalizeTokenProviderInput("")).toBeUndefined();
  });
});

describe("maybeApplyApiKeyFromOption", () => {
  it("stores normalized token when provider matches", async () => {
    const setCredential = vi.fn(async () => undefined);

    const result = await maybeApplyApiKeyFromOption({
      token: "  opt-key  ",
      tokenProvider: "huggingface",
      expectedProviders: ["huggingface"],
      normalize: (value) => value.trim(),
      setCredential,
    });

    expect(result).toBe("opt-key");
    expect(setCredential).toHaveBeenCalledWith("opt-key", undefined);
  });

  it("matches provider with whitespace/case normalization", async () => {
    const setCredential = vi.fn(async () => undefined);

    const result = await maybeApplyApiKeyFromOption({
      token: "  opt-key  ",
      tokenProvider: "  HuGgInGfAcE  ",
      expectedProviders: ["huggingface"],
      normalize: (value) => value.trim(),
      setCredential,
    });

    expect(result).toBe("opt-key");
    expect(setCredential).toHaveBeenCalledWith("opt-key", undefined);
  });

  it("skips when provider does not match", async () => {
    const setCredential = vi.fn(async () => undefined);

    const result = await maybeApplyApiKeyFromOption({
      token: "opt-key",
      tokenProvider: "openai",
      expectedProviders: ["huggingface"],
      normalize: (value) => value.trim(),
      setCredential,
    });

    expect(result).toBeUndefined();
    expect(setCredential).not.toHaveBeenCalled();
  });
});

describe("ensureApiKeyFromEnvOrPrompt", () => {
  it("uses env credential when user confirms", async () => {
    const { result, setCredential, text } = await runEnsureMinimaxApiKeyFlow({
      confirmResult: true,
      textResult: "prompt-key",
    });

    expect(result).toBe("env-key");
    expect(setCredential).toHaveBeenCalledWith("env-key", "plaintext");
    expect(text).not.toHaveBeenCalled();
  });

  it("falls back to prompt when env is declined", async () => {
    const { result, setCredential, text } = await runEnsureMinimaxApiKeyFlow({
      confirmResult: false,
      textResult: "  prompted-key  ",
    });

    expect(result).toBe("prompted-key");
    expect(setCredential).toHaveBeenCalledWith("prompted-key", "plaintext");
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Enter key",
      }),
    );
  });

  it("uses explicit inline env ref when secret-input-mode=ref selects existing env key", async () => {
    process.env.MINIMAX_API_KEY = "env-key";
    delete process.env.MINIMAX_OAUTH_TOKEN;

    const { confirm, text } = createPromptSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });
    const setCredential = vi.fn(async () => undefined);

    const result = await ensureApiKeyFromEnvOrPrompt({
      config: {},
      provider: "minimax",
      envLabel: "MINIMAX_API_KEY",
      promptMessage: "Enter key",
      normalize: (value) => value.trim(),
      validate: () => undefined,
      prompter: createPrompter({ confirm, text }),
      secretInputMode: "ref",
      setCredential,
    });

    expect(result).toBe("env-key");
    expect(setCredential).toHaveBeenCalledWith(
      { source: "env", provider: "default", id: "MINIMAX_API_KEY" },
      "ref",
    );
    expect(text).not.toHaveBeenCalled();
  });

  it("fails ref mode without select when fallback env var is missing", async () => {
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_OAUTH_TOKEN;

    const { confirm, text } = createPromptSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });
    const setCredential = vi.fn(async () => undefined);

    await expect(
      ensureApiKeyFromEnvOrPrompt({
        config: {},
        provider: "minimax",
        envLabel: "MINIMAX_API_KEY",
        promptMessage: "Enter key",
        normalize: (value) => value.trim(),
        validate: () => undefined,
        prompter: createPrompter({ confirm, text }),
        secretInputMode: "ref",
        setCredential,
      }),
    ).rejects.toThrow(
      'Environment variable "MINIMAX_API_KEY" is required for --secret-input-mode ref in non-interactive onboarding.',
    );
    expect(setCredential).not.toHaveBeenCalled();
  });

  it("re-prompts after provider ref validation failure and succeeds with env ref", async () => {
    process.env.MINIMAX_API_KEY = "env-key";
    delete process.env.MINIMAX_OAUTH_TOKEN;

    const selectValues: Array<"provider" | "env" | "filemain"> = ["provider", "filemain", "env"];
    const select = vi.fn(async () => selectValues.shift() ?? "env") as WizardPrompter["select"];
    const text = vi
      .fn<WizardPrompter["text"]>()
      .mockResolvedValueOnce("/providers/minimax/apiKey")
      .mockResolvedValueOnce("MINIMAX_API_KEY");
    const note = vi.fn(async () => undefined);
    const setCredential = vi.fn(async () => undefined);

    const result = await ensureApiKeyFromEnvOrPrompt({
      config: {
        secrets: {
          providers: {
            filemain: {
              source: "file",
              path: "/tmp/does-not-exist-secrets.json",
              mode: "json",
            },
          },
        },
      },
      provider: "minimax",
      envLabel: "MINIMAX_API_KEY",
      promptMessage: "Enter key",
      normalize: (value) => value.trim(),
      validate: () => undefined,
      prompter: createPrompter({ select, text, note }),
      secretInputMode: "ref",
      setCredential,
    });

    expect(result).toBe("env-key");
    expect(setCredential).toHaveBeenCalledWith(
      { source: "env", provider: "default", id: "MINIMAX_API_KEY" },
      "ref",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Could not validate provider reference"),
      "Reference check failed",
    );
  });

  it("never includes resolved env secret values in reference validation notes", async () => {
    process.env.MINIMAX_API_KEY = "sk-minimax-redacted-value";
    delete process.env.MINIMAX_OAUTH_TOKEN;

    const select = vi.fn(async () => "env") as WizardPrompter["select"];
    const text = vi.fn<WizardPrompter["text"]>().mockResolvedValue("MINIMAX_API_KEY");
    const note = vi.fn(async () => undefined);
    const setCredential = vi.fn(async () => undefined);

    const result = await ensureApiKeyFromEnvOrPrompt({
      config: {},
      provider: "minimax",
      envLabel: "MINIMAX_API_KEY",
      promptMessage: "Enter key",
      normalize: (value) => value.trim(),
      validate: () => undefined,
      prompter: createPrompter({ select, text, note }),
      secretInputMode: "ref",
      setCredential,
    });

    expect(result).toBe("sk-minimax-redacted-value");
    const noteMessages = note.mock.calls.map((call) => String(call.at(0) ?? "")).join("\n");
    expect(noteMessages).toContain("Validated environment variable MINIMAX_API_KEY.");
    expect(noteMessages).not.toContain("sk-minimax-redacted-value");
  });
});

describe("ensureApiKeyFromOptionEnvOrPrompt", () => {
  it("uses opts token and skips note/env/prompt", async () => {
    const { confirm, note, text } = createPromptSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });
    const setCredential = vi.fn(async () => undefined);

    const result = await ensureApiKeyFromOptionEnvOrPrompt({
      token: "  opts-key  ",
      tokenProvider: " HUGGINGFACE ",
      config: {},
      expectedProviders: ["huggingface"],
      provider: "huggingface",
      envLabel: "HF_TOKEN",
      promptMessage: "Enter key",
      normalize: (value) => value.trim(),
      validate: () => undefined,
      prompter: createPrompter({ confirm, note, text }),
      setCredential,
      noteMessage: "Hugging Face note",
      noteTitle: "Hugging Face",
    });

    expect(result).toBe("opts-key");
    expect(setCredential).toHaveBeenCalledWith("opts-key", undefined);
    expect(note).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("falls back to env flow and shows note when opts provider does not match", async () => {
    delete process.env.MINIMAX_OAUTH_TOKEN;
    process.env.MINIMAX_API_KEY = "env-key";

    const { confirm, note, text } = createPromptSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });
    const setCredential = vi.fn(async () => undefined);

    const result = await ensureApiKeyFromOptionEnvOrPrompt({
      token: "opts-key",
      tokenProvider: "openai",
      config: {},
      expectedProviders: ["minimax"],
      provider: "minimax",
      envLabel: "MINIMAX_API_KEY",
      promptMessage: "Enter key",
      normalize: (value) => value.trim(),
      validate: () => undefined,
      prompter: createPrompter({ confirm, note, text }),
      setCredential,
      noteMessage: "MiniMax note",
      noteTitle: "MiniMax",
    });

    expect(result).toBe("env-key");
    expect(note).toHaveBeenCalledWith("MiniMax note", "MiniMax");
    expect(confirm).toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(setCredential).toHaveBeenCalledWith("env-key", "plaintext");
  });
});
