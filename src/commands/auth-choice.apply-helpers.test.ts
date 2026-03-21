import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authProfilePathForAgent, setupAuthTestEnv } from "../../test/helpers/auth-wizard.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  ensureApiKeyFromOptionEnvOrPrompt,
  ensureApiKeyFromEnvOrPrompt,
  maybeApplyApiKeyFromOption,
  normalizeTokenProviderInput,
} from "./auth-choice.apply-helpers.js";

const ORIGINAL_MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const ORIGINAL_MINIMAX_OAUTH_TOKEN = process.env.MINIMAX_OAUTH_TOKEN;
const ORIGINAL_CUSTOM_MINIMAX_API_KEY = process.env.CUSTOM_MINIMAX_API_KEY;

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
  if (ORIGINAL_CUSTOM_MINIMAX_API_KEY === undefined) {
    delete process.env.CUSTOM_MINIMAX_API_KEY;
  } else {
    process.env.CUSTOM_MINIMAX_API_KEY = ORIGINAL_CUSTOM_MINIMAX_API_KEY;
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

function createPromptAndCredentialSpies(params?: { confirmResult?: boolean; textResult?: string }) {
  return {
    ...createPromptSpies(params),
    setCredential: vi.fn(async () => undefined),
  };
}

async function ensureMinimaxApiKey(params: {
  config?: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["config"];
  agentDir?: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["agentDir"];
  confirm: WizardPrompter["confirm"];
  note?: WizardPrompter["note"];
  select?: WizardPrompter["select"];
  text: WizardPrompter["text"];
  setCredential: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["setCredential"];
  secretInputMode?: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["secretInputMode"];
}) {
  return await ensureMinimaxApiKeyInternal({
    config: params.config,
    agentDir: params.agentDir,
    prompter: createPrompter({
      confirm: params.confirm,
      note: params.note,
      select: params.select,
      text: params.text,
    }),
    secretInputMode: params.secretInputMode,
    setCredential: params.setCredential,
  });
}

async function ensureMinimaxApiKeyInternal(params: {
  config?: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["config"];
  agentDir?: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["agentDir"];
  prompter: WizardPrompter;
  secretInputMode?: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["secretInputMode"];
  setCredential: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["setCredential"];
}) {
  return await ensureApiKeyFromEnvOrPrompt({
    config: params.config ?? {},
    agentDir: params.agentDir,
    provider: "minimax",
    envLabel: "MINIMAX_API_KEY",
    promptMessage: "Enter key",
    normalize: (value) => value.trim(),
    validate: () => undefined,
    prompter: params.prompter,
    secretInputMode: params.secretInputMode,
    setCredential: params.setCredential,
  });
}

async function ensureMinimaxApiKeyWithEnvRefPrompter(params: {
  config?: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["config"];
  agentDir?: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["agentDir"];
  note: WizardPrompter["note"];
  select: WizardPrompter["select"];
  setCredential: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["setCredential"];
  text: WizardPrompter["text"];
}) {
  return await ensureMinimaxApiKeyInternal({
    config: params.config,
    agentDir: params.agentDir,
    prompter: createPrompter({ select: params.select, text: params.text, note: params.note }),
    secretInputMode: "ref", // pragma: allowlist secret
    setCredential: params.setCredential,
  });
}

async function runEnsureMinimaxApiKeyFlow(params: { confirmResult: boolean; textResult: string }) {
  process.env.MINIMAX_API_KEY = "env-key"; // pragma: allowlist secret
  delete process.env.MINIMAX_OAUTH_TOKEN;

  const { confirm, text } = createPromptSpies({
    confirmResult: params.confirmResult,
    textResult: params.textResult,
  });
  const setCredential = vi.fn(async () => undefined);
  const result = await ensureMinimaxApiKey({
    confirm,
    text,
    setCredential,
  });

  return { result, setCredential, confirm, text };
}

async function runMaybeApplyHuggingFaceToken(tokenProvider: string) {
  const setCredential = vi.fn(async () => undefined);
  const result = await maybeApplyApiKeyFromOption({
    token: "  opt-key  ",
    tokenProvider,
    expectedProviders: ["huggingface"],
    normalize: (value) => value.trim(),
    setCredential,
  });
  return { result, setCredential };
}

function expectMinimaxEnvRefCredentialStored(setCredential: ReturnType<typeof vi.fn>) {
  expect(setCredential).toHaveBeenCalledWith(
    { source: "env", provider: "default", id: "MINIMAX_API_KEY" },
    "ref",
  );
}

async function ensureWithOptionEnvOrPrompt(params: {
  token: string;
  tokenProvider: string;
  config?: Parameters<typeof ensureApiKeyFromOptionEnvOrPrompt>[0]["config"];
  agentDir?: Parameters<typeof ensureApiKeyFromOptionEnvOrPrompt>[0]["agentDir"];
  expectedProviders: string[];
  reuseProviders?: Parameters<typeof ensureApiKeyFromOptionEnvOrPrompt>[0]["reuseProviders"];
  provider: string;
  envLabel: string;
  confirm: WizardPrompter["confirm"];
  note: WizardPrompter["note"];
  noteMessage: string;
  noteTitle: string;
  setCredential: Parameters<typeof ensureApiKeyFromOptionEnvOrPrompt>[0]["setCredential"];
  text: WizardPrompter["text"];
}) {
  return await ensureApiKeyFromOptionEnvOrPrompt({
    token: params.token,
    tokenProvider: params.tokenProvider,
    config: params.config ?? {},
    agentDir: params.agentDir,
    expectedProviders: params.expectedProviders,
    reuseProviders: params.reuseProviders,
    provider: params.provider,
    envLabel: params.envLabel,
    promptMessage: "Enter key",
    normalize: (value) => value.trim(),
    validate: () => undefined,
    prompter: createPrompter({ confirm: params.confirm, note: params.note, text: params.text }),
    setCredential: params.setCredential,
    noteMessage: params.noteMessage,
    noteTitle: params.noteTitle,
  });
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
    const { result, setCredential } = await runMaybeApplyHuggingFaceToken("huggingface");

    expect(result).toBe("opt-key");
    expect(setCredential).toHaveBeenCalledWith("opt-key", undefined);
  });

  it("matches provider with whitespace/case normalization", async () => {
    const { result, setCredential } = await runMaybeApplyHuggingFaceToken("  HuGgInGfAcE  ");

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
  it("prefers provider API key env vars over oauth env vars for reuse", async () => {
    process.env.MINIMAX_OAUTH_TOKEN = "oauth-token";
    process.env.MINIMAX_API_KEY = "api-key";

    const { confirm, text, setCredential } = createPromptAndCredentialSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });

    const result = await ensureMinimaxApiKey({
      confirm,
      text,
      setCredential,
    });

    expect(result).toBe("api-key");
    expect(setCredential).toHaveBeenCalledWith("api-key", "plaintext");
    expect(text).not.toHaveBeenCalled();
  });

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
    process.env.MINIMAX_API_KEY = "env-key"; // pragma: allowlist secret
    delete process.env.MINIMAX_OAUTH_TOKEN;

    const { confirm, text, setCredential } = createPromptAndCredentialSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });

    const result = await ensureMinimaxApiKey({
      confirm,
      text,
      secretInputMode: "ref", // pragma: allowlist secret
      setCredential,
    });

    expect(result).toBe("env-key");
    expectMinimaxEnvRefCredentialStored(setCredential);
    expect(text).not.toHaveBeenCalled();
  });

  it("fails ref mode without select when fallback env var is missing", async () => {
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_OAUTH_TOKEN;

    const { confirm, text, setCredential } = createPromptAndCredentialSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });

    await expect(
      ensureMinimaxApiKey({
        confirm,
        text,
        secretInputMode: "ref", // pragma: allowlist secret
        setCredential,
      }),
    ).rejects.toThrow(
      'Environment variable "MINIMAX_API_KEY" is required for --secret-input-mode ref in non-interactive setup.',
    );
    expect(setCredential).not.toHaveBeenCalled();
  });

  it("re-prompts after provider ref validation failure and succeeds with env ref", async () => {
    process.env.MINIMAX_API_KEY = "env-key"; // pragma: allowlist secret
    delete process.env.MINIMAX_OAUTH_TOKEN;

    const selectValues: Array<"provider" | "env" | "filemain"> = ["provider", "filemain", "env"];
    const select = vi.fn(async () => selectValues.shift() ?? "env") as WizardPrompter["select"];
    const text = vi
      .fn<WizardPrompter["text"]>()
      .mockResolvedValueOnce("/providers/minimax/apiKey")
      .mockResolvedValueOnce("MINIMAX_API_KEY");
    const note = vi.fn(async () => undefined);
    const setCredential = vi.fn(async () => undefined);

    const result = await ensureMinimaxApiKeyWithEnvRefPrompter({
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
      select,
      text,
      note,
      setCredential,
    });

    expect(result).toBe("env-key");
    expectMinimaxEnvRefCredentialStored(setCredential);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Could not validate provider reference"),
      "Reference check failed",
    );
  });

  it("never includes resolved env secret values in reference validation notes", async () => {
    process.env.MINIMAX_API_KEY = "sk-minimax-redacted-value"; // pragma: allowlist secret
    delete process.env.MINIMAX_OAUTH_TOKEN;

    const select = vi.fn(async () => "env") as WizardPrompter["select"];
    const text = vi.fn<WizardPrompter["text"]>().mockResolvedValue("MINIMAX_API_KEY");
    const note = vi.fn(async () => undefined);
    const setCredential = vi.fn(async () => undefined);

    const result = await ensureMinimaxApiKeyWithEnvRefPrompter({
      config: {},
      select,
      text,
      note,
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
    const { confirm, note, text, setCredential } = createPromptAndCredentialSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });

    const result = await ensureWithOptionEnvOrPrompt({
      token: "  opts-key  ",
      tokenProvider: " HUGGINGFACE ",
      expectedProviders: ["huggingface"],
      provider: "huggingface",
      envLabel: "HF_TOKEN",
      confirm,
      note,
      noteMessage: "Hugging Face note",
      noteTitle: "Hugging Face",
      setCredential,
      text,
    });

    expect(result).toBe("opts-key");
    expect(setCredential).toHaveBeenCalledWith("opts-key", undefined);
    expect(note).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("falls back to env flow and shows note when opts provider does not match", async () => {
    delete process.env.MINIMAX_OAUTH_TOKEN;
    process.env.MINIMAX_API_KEY = "env-key"; // pragma: allowlist secret

    const { confirm, note, text, setCredential } = createPromptAndCredentialSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });

    const result = await ensureWithOptionEnvOrPrompt({
      token: "opts-key",
      tokenProvider: "openai",
      expectedProviders: ["minimax"],
      provider: "minimax",
      envLabel: "MINIMAX_API_KEY",
      confirm,
      note,
      noteMessage: "MiniMax note",
      noteTitle: "MiniMax",
      setCredential,
      text,
    });

    expect(result).toBe("env-key");
    expect(note).toHaveBeenCalledWith("MiniMax note", "MiniMax");
    expect(confirm).toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(setCredential).toHaveBeenCalledWith("env-key", "plaintext");
  });

  it("reuses stored API keys across shared provider aliases", async () => {
    const { stateDir, agentDir } = await setupAuthTestEnv("openclaw-auth-alias-", {
      agentSubdir: "agents/opencode-go",
    });
    await fs.writeFile(
      authProfilePathForAgent(agentDir),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "opencode:default": {
              type: "api_key",
              provider: "opencode",
              key: "shared-opencode-key",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { confirm, note, text, setCredential } = createPromptAndCredentialSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });

    try {
      const result = await ensureWithOptionEnvOrPrompt({
        token: "",
        tokenProvider: "",
        config: {
          auth: {
            profiles: {
              "opencode:default": { provider: "opencode", mode: "api_key" },
            },
          },
        },
        agentDir,
        expectedProviders: ["opencode", "opencode-go"],
        reuseProviders: ["opencode", "opencode-go"],
        provider: "opencode-go",
        envLabel: "OPENCODE_API_KEY",
        confirm,
        note,
        noteMessage: "OpenCode note",
        noteTitle: "OpenCode",
        setCredential,
        text,
      });

      expect(result).toBe("shared-opencode-key");
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("profile:opencode:default"),
        }),
      );
      expect(setCredential).toHaveBeenCalledWith("shared-opencode-key", "plaintext");
      expect(text).not.toHaveBeenCalled();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reuses the first ordered API-key profile from the scoped agent store", async () => {
    const { stateDir, agentDir } = await setupAuthTestEnv("openclaw-auth-order-", {
      agentSubdir: "agents/minimax",
    });
    await fs.writeFile(
      authProfilePathForAgent(agentDir),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "minimax:default": { type: "api_key", provider: "minimax", key: "default-key" },
            "minimax:alt": { type: "api_key", provider: "minimax", key: "alt-key" },
          },
          order: {
            minimax: ["minimax:alt", "minimax:default"],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_OAUTH_TOKEN;
    const { confirm, text, setCredential } = createPromptAndCredentialSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });

    try {
      const result = await ensureMinimaxApiKey({
        agentDir,
        confirm,
        text,
        setCredential,
        config: {
          auth: {
            profiles: {
              "minimax:default": { provider: "minimax", mode: "api_key" },
              "minimax:alt": { provider: "minimax", mode: "api_key" },
            },
          },
        },
      });

      expect(result).toBe("alt-key");
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("profile:minimax:alt"),
        }),
      );
      expect(setCredential).toHaveBeenCalledWith("alt-key", "plaintext");
      expect(text).not.toHaveBeenCalled();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves inline env refs when reusing a stored profile key", async () => {
    const { stateDir, agentDir } = await setupAuthTestEnv("openclaw-auth-inline-ref-", {
      agentSubdir: "agents/minimax",
    });
    process.env.MINIMAX_API_KEY = "inline-env-key"; // pragma: allowlist secret
    delete process.env.MINIMAX_OAUTH_TOKEN;
    await fs.writeFile(
      authProfilePathForAgent(agentDir),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "minimax:default": {
              type: "api_key",
              provider: "minimax",
              key: "${MINIMAX_API_KEY}",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { confirm, text, setCredential } = createPromptAndCredentialSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });

    try {
      const result = await ensureMinimaxApiKey({
        agentDir,
        confirm,
        text,
        setCredential,
        config: {
          secrets: {
            providers: {
              shellenv: { source: "env" },
            },
            defaults: {
              env: "shellenv",
            },
          },
          auth: {
            profiles: {
              "minimax:default": { provider: "minimax", mode: "api_key" },
            },
          },
        },
      });

      expect(result).toBe("inline-env-key");
      expect(setCredential).toHaveBeenCalledWith(
        { source: "env", provider: "shellenv", id: "MINIMAX_API_KEY" },
        "plaintext",
      );
      expect(text).not.toHaveBeenCalled();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reuses SecretRef-valued models.json API keys without flattening them", async () => {
    delete process.env.MINIMAX_API_KEY;
    process.env.CUSTOM_MINIMAX_API_KEY = "ref-models-key"; // pragma: allowlist secret
    delete process.env.MINIMAX_OAUTH_TOKEN;

    const { confirm, text, setCredential } = createPromptAndCredentialSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });

    const result = await ensureMinimaxApiKey({
      confirm,
      text,
      setCredential,
      config: {
        secrets: {
          providers: {
            shellenv: { source: "env" },
          },
          defaults: {
            env: "shellenv",
          },
        },
        models: {
          providers: {
            minimax: {
              baseUrl: "https://api.minimax.example/v1",
              apiKey: { source: "env", provider: "shellenv", id: "CUSTOM_MINIMAX_API_KEY" },
              models: [],
            },
          },
        },
      },
    });

    expect(result).toBe("ref-models-key");
    expect(setCredential).toHaveBeenCalledWith(
      { source: "env", provider: "shellenv", id: "CUSTOM_MINIMAX_API_KEY" },
      "plaintext",
    );
    expect(text).not.toHaveBeenCalled();
  });

  it("does not reuse the main agent store for a secondary agent prompt", async () => {
    const { stateDir, agentDir: mainAgentDir } = await setupAuthTestEnv("openclaw-auth-scope-");
    const agentDir = `${stateDir}/agents/minimax`;
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      authProfilePathForAgent(mainAgentDir),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "minimax:default": { type: "api_key", provider: "minimax", key: "main-key" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_OAUTH_TOKEN;
    const { confirm, text, setCredential } = createPromptAndCredentialSpies({
      confirmResult: true,
      textResult: "  prompted-key  ",
    });

    try {
      const result = await ensureMinimaxApiKey({
        agentDir,
        confirm,
        text,
        setCredential,
      });

      expect(result).toBe("prompted-key");
      expect(confirm).not.toHaveBeenCalled();
      expect(text).toHaveBeenCalled();
      expect(setCredential).toHaveBeenCalledWith("prompted-key", "plaintext");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
