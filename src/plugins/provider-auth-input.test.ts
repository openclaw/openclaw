import "../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { captureProviderApiKey } from "./provider-api-key-auth.js";
import {
  ensureApiKeyFromEnvOrPrompt,
  ensureApiKeyFromOptionEnvOrPrompt,
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./provider-auth-input.js";

const acceptAnyApiKeyInput = () => undefined;

const resolveEnvApiKey = vi.hoisted(() =>
  vi.fn(
    (
      provider: string,
      env?: NodeJS.ProcessEnv,
      _options?: { config?: OpenClawConfig; workspaceDir?: string },
    ) => {
      if (provider !== "minimax") {
        return null;
      }
      const apiKey = env?.MINIMAX_API_KEY?.trim();
      return apiKey ? { apiKey, source: "env: MINIMAX_API_KEY" } : null;
    },
  ),
);

vi.mock("../agents/model-auth-env.js", () => ({
  resolveEnvApiKey,
}));

type KeyParams = Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0];
function inputFixture(params?: { confirmResult?: boolean; textResult?: string }) {
  const confirm = vi.fn(async () => params?.confirmResult ?? true);
  const note = vi.fn(async () => undefined);
  const text = vi.fn(async () => params?.textResult ?? "prompt-key");
  const setCredential = vi.fn(async () => undefined);
  const prompter = { confirm, note, text } as unknown as WizardPrompter;
  const options: KeyParams = {
    config: {},
    env: {
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
      MINIMAX_OAUTH_TOKEN: process.env.MINIMAX_OAUTH_TOKEN,
    },
    provider: "minimax",
    envLabel: "MINIMAX_API_KEY",
    promptMessage: "Enter key",
    normalize: (value) => value.trim(),
    validate: acceptAnyApiKeyInput,
    prompter,
    setCredential,
  };
  return {
    confirm,
    note,
    text,
    setCredential,
    options,
    run: (overrides: Partial<KeyParams> = {}) =>
      ensureApiKeyFromEnvOrPrompt({ ...options, ...overrides }),
  };
}

function setMinimaxEnv(apiKey?: string) {
  vi.stubEnv("MINIMAX_API_KEY", apiKey);
  vi.stubEnv("MINIMAX_OAUTH_TOKEN", undefined);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("retains the storage reference while resolving through the staged workspace and explicit env", async () => {
  setMinimaxEnv("host-key");
  const workspaceDir = "/tmp/openclaw-provider-workspace";
  const config: OpenClawConfig = {
    agents: { entries: { main: {}, work: { workspace: workspaceDir } } },
    plugins: { entries: { minimax: { enabled: true } } },
  };
  const env = { MINIMAX_API_KEY: "workspace-env-key" };
  const { options, text } = inputFixture();
  const captured = await captureProviderApiKey(
    {
      config,
      workspaceDir,
      prompter: options.prompter,
      secretInputMode: "ref",
    },
    {
      token: undefined,
      tokenProvider: undefined,
      env,
      expectedProviders: ["minimax"],
      provider: "minimax",
      envLabel: "MINIMAX_API_KEY",
      promptMessage: "Enter key",
    },
  );

  expect(captured).toEqual({
    apiKey: "workspace-env-key",
    input: { source: "env", provider: "default", id: "MINIMAX_API_KEY" },
    mode: "ref",
  });
  expect(resolveEnvApiKey).toHaveBeenCalledWith("minimax", env, { config, workspaceDir });
  expect(text).not.toHaveBeenCalled();
});

describe("normalizeApiKeyInput", () => {
  it("strips shell syntax, pasted line breaks, and non-header-safe artifacts", () => {
    expect(normalizeApiKeyInput("export OPENAI_API_KEY='sk-\r\nabc│';")).toBe("sk-abc");
  });

  it("preserves ordinary interior spaces in bearer-style values", () => {
    expect(normalizeApiKeyInput('TOKEN="Bearer demo token"')).toBe("Bearer demo token");
  });
});

it("rejects a pasted OpenClaw onboarding command", () => {
  expect(validateApiKeyInput("openclaw onboard --auth-choice=zai-coding-global")).toBe(
    "Paste the API key value, not an OpenClaw onboarding command.",
  );
});

describe("ensureApiKeyFromEnvOrPrompt", () => {
  it("falls back to prompt when env is declined", async () => {
    setMinimaxEnv("env-key");
    const { run, text, setCredential } = inputFixture({
      confirmResult: false,
      textResult: "  prompted-key  ",
    });
    const result = await run();

    expect(result).toBe("prompted-key");
    expect(setCredential).toHaveBeenCalledWith("prompted-key", "plaintext");
    expect(text).toHaveBeenCalledWith({
      message: "Enter key",
      placeholder: "API key",
      validate: acceptAnyApiKeyInput,
      sensitive: true,
    });
  });

  it("fails ref mode without select when fallback env var is missing", async () => {
    setMinimaxEnv();

    const { run, setCredential } = inputFixture();

    await expect(
      run({
        secretInputMode: "ref", // pragma: allowlist secret
      }),
    ).rejects.toThrow(
      'Environment variable "MINIMAX_API_KEY" is required for --secret-input-mode ref in non-interactive setup.',
    );
    expect(setCredential).not.toHaveBeenCalled();
  });

  it("re-prompts after provider ref validation failure and succeeds with env ref", async () => {
    setMinimaxEnv("env-key");

    const selectValues: Array<"provider" | "env" | "filemain"> = ["provider", "filemain", "env"];
    const select = vi.fn(async () => selectValues.shift() ?? "env") as WizardPrompter["select"];
    const { run, options, text, note, setCredential } = inputFixture();
    text
      .mockResolvedValueOnce("/providers/minimax/apiKey")
      .mockResolvedValueOnce("MINIMAX_API_KEY");

    const result = await run({
      secretInputMode: "ref",
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
      prompter: { ...options.prompter, select },
    });

    expect(result).toBe("env-key");
    expect(setCredential).toHaveBeenCalledWith(
      { source: "env", provider: "default", id: "MINIMAX_API_KEY" },
      "ref",
    );
    const noteMessages = note.mock.calls.map((call) => call.at(0) ?? "").join("\n");
    expect(noteMessages).not.toContain("env-key");
    for (const message of [
      "Could not validate provider reference filemain:/providers/minimax/apiKey.",
      "secrets.providers.filemain.path is not readable: /tmp/does-not-exist-secrets.json",
      "Check your provider configuration and try again.",
    ]) {
      expect(note).toHaveBeenCalledWith(expect.stringContaining(message), "Reference check failed");
    }
    expect(note).toHaveBeenCalledWith(
      "Validated environment variable MINIMAX_API_KEY. OpenClaw will store a reference, not the key value.",
      "Reference validated",
    );
  });
});

describe("ensureApiKeyFromOptionEnvOrPrompt", () => {
  it("uses opts token and skips note/env/prompt", async () => {
    const { options, confirm, note, text, setCredential } = inputFixture();

    const result = await ensureApiKeyFromOptionEnvOrPrompt({
      ...options,
      token: "  opts-key  ",
      tokenProvider: " DEMO-PROVIDER ",
      expectedProviders: ["demo-provider"],
      provider: "demo-provider",
      envLabel: "DEMO_TOKEN",
      noteMessage: "Demo note",
      noteTitle: "Demo",
    });

    expect(result).toBe("opts-key");
    expect(setCredential).toHaveBeenCalledWith("opts-key", undefined);
    expect(note).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("falls back to env flow and shows note when opts provider does not match", async () => {
    setMinimaxEnv("env-key");

    const { options, confirm, note, text, setCredential } = inputFixture();

    const result = await ensureApiKeyFromOptionEnvOrPrompt({
      ...options,
      token: "opts-key",
      tokenProvider: "other-provider",
      expectedProviders: ["minimax"],
      provider: "minimax",
      envLabel: "MINIMAX_API_KEY",
      noteMessage: "Demo provider note",
      noteTitle: "Demo provider",
    });

    expect(result).toBe("env-key");
    expect(note).toHaveBeenCalledWith("Demo provider note", "Demo provider");
    expect(confirm).toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(setCredential).toHaveBeenCalledWith("env-key", "plaintext");
  });
});

it.each([
  ["a😀b", "a…b"],
  [`abc😀${"x".repeat(20)}`, "abc…xxxx"],
  [`${"x".repeat(20)}😀abc`, "xxxx…abc"],
  ["😀".repeat(10), "😀😀…😀😀"],
])("redacts %p without splitting surrogate pairs", (value, expected) => {
  expect(formatApiKeyPreview(value)).toBe(expected);
});
