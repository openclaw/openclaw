import "../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, expect, it, vi } from "vitest";
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
const envRef = { source: "env", provider: "default", id: "MINIMAX_API_KEY" } as const;

const resolveEnvApiKey = vi.hoisted(() =>
  vi.fn<typeof import("../agents/model-auth-env.js").resolveEnvApiKey>((provider, env) => {
    if (provider !== "minimax") {
      return null;
    }
    const apiKey = env?.MINIMAX_API_KEY?.trim();
    return apiKey ? { apiKey, source: "env: MINIMAX_API_KEY" } : null;
  }),
);

vi.mock("../agents/model-auth-env.js", () => ({
  resolveEnvApiKey,
}));

type KeyParams = Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0];
function inputFixture(params?: { envKey?: string; confirmResult?: boolean; textResult?: string }) {
  const confirm = vi.fn(async () => params?.confirmResult ?? true);
  const note = vi.fn(async () => undefined);
  const text = vi.fn(async () => params?.textResult ?? "prompt-key");
  const setCredential = vi.fn(async () => undefined);
  const prompter = { confirm, note, text } as unknown as WizardPrompter;
  const options: KeyParams = {
    config: {},
    env: { MINIMAX_API_KEY: params?.envKey },
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("retains the storage reference while resolving through the staged workspace and explicit env", async () => {
  vi.stubEnv("MINIMAX_API_KEY", "host-key");
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
    input: envRef,
    mode: "ref",
  });
  expect(resolveEnvApiKey).toHaveBeenCalledWith("minimax", env, { config, workspaceDir });
  expect(text).not.toHaveBeenCalled();
});

it.each([
  ["export OPENAI_API_KEY='sk-\r\nabc│';", "sk-abc"],
  ['TOKEN="Bearer demo token"', "Bearer demo token"],
])("normalizes pasted key %j without losing ordinary spaces", (input, expected) => {
  expect(normalizeApiKeyInput(input)).toBe(expected);
});

it("rejects a pasted OpenClaw onboarding command", () => {
  expect(validateApiKeyInput("openclaw onboard --auth-choice=zai-coding-global")).toBe(
    "Paste the API key value, not an OpenClaw onboarding command.",
  );
});

it("falls back to prompt when env is declined", async () => {
  const { run, text, setCredential } = inputFixture({
    envKey: "env-key",
    confirmResult: false,
    textResult: "  prompted-key  ",
  });
  const result = await run();

  expect(result).toBe("prompted-key");
  expect(setCredential).toHaveBeenCalledWith("prompted-key", "plaintext");
  expect(text).toHaveBeenCalledWith(expect.objectContaining({ sensitive: true }));
});

it("fails ref mode without select when fallback env var is missing", async () => {
  const { run, setCredential } = inputFixture();

  await expect(run({ secretInputMode: "ref" /* pragma: allowlist secret */ })).rejects.toThrow(
    'Environment variable "MINIMAX_API_KEY" is required for --secret-input-mode ref in non-interactive setup.',
  );
  expect(setCredential).not.toHaveBeenCalled();
});

it("re-prompts after provider ref validation failure and succeeds with env ref", async () => {
  const selectValues: Array<"provider" | "env" | "filemain"> = ["provider", "filemain", "env"];
  const select = vi.fn(async () => selectValues.shift() ?? "env") as WizardPrompter["select"];
  const { run, options, text, note, setCredential } = inputFixture({ envKey: "env-key" });
  text.mockResolvedValueOnce("/providers/minimax/apiKey").mockResolvedValueOnce("MINIMAX_API_KEY");

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
  expect(setCredential).toHaveBeenCalledWith(envRef, "ref");
  const noteMessages = note.mock.calls.map((call) => call.at(0) ?? "").join("\n");
  expect(noteMessages).not.toContain("env-key");
  expect(note.mock.calls.map((call) => call.at(1))).toEqual([
    "Reference check failed",
    "Reference validated",
  ]);
});

it.each([
  [" DEMO-PROVIDER ", "demo-provider", "opts-key", undefined],
  ["other-provider", "minimax", "env-key", "plaintext"],
] as const)(
  "resolves option provider %s before environment/prompt",
  async (tokenProvider, provider, expected, mode) => {
    const { options, confirm, note, text, setCredential } = inputFixture({
      envKey: mode ? "env-key" : undefined,
    });
    expect(
      await ensureApiKeyFromOptionEnvOrPrompt({
        ...options,
        token: "  opts-key  ",
        tokenProvider,
        provider,
        expectedProviders: [provider],
        envLabel: provider === "minimax" ? "MINIMAX_API_KEY" : "DEMO_TOKEN",
        noteMessage: "Demo provider note",
        noteTitle: "Demo provider",
      }),
    ).toBe(expected);
    expect(setCredential).toHaveBeenCalledWith(expected, mode);
    expect(text).not.toHaveBeenCalled();
    if (mode) {
      expect(note).toHaveBeenCalledWith("Demo provider note", "Demo provider");
      expect(confirm).toHaveBeenCalled();
    } else {
      expect(note).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    }
  },
);

it.each([
  ["a😀b", "a…b"],
  [`abc😀${"x".repeat(20)}😀abc`, "abc…abc"],
  ["😀".repeat(10), "😀😀…😀😀"],
])("redacts %p without splitting surrogate pairs", (value, expected) => {
  expect(formatApiKeyPreview(value)).toBe(expected);
});
