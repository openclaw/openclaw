import { expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { promptAndConfigureOpenAICompatibleSelfHostedProviderAuth as configure } from "./provider-self-hosted-setup.js";

const { fetchWithSsrFGuardMock, upsertAuthProfileWithLockOrThrow } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  upsertAuthProfileWithLockOrThrow: vi.fn(async () => undefined),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../agents/auth-profiles/upsert-with-lock.js", () => ({
  upsertAuthProfileWithLockOrThrow,
}));

const fixtureProvider = {
  providerId: "fixture",
  providerLabel: "Fixture",
  defaultBaseUrl: "http://127.0.0.1:8000/v1",
  defaultApiKeyEnvVar: "FIXTURE_API_KEY",
  modelPlaceholder: "org/example",
};

function prompts(...answers: string[]) {
  const prompter = createWizardPrompter();
  for (const answer of answers) {
    vi.mocked(prompter.text).mockResolvedValueOnce(answer);
  }
  return prompter;
}

it("returns normalized interactive setup results", async () => {
  const cfg = {
    agents: { defaults: { model: "existing/model" } },
    models: {
      mode: "replace",
      providers: { existing: { baseUrl: "https://existing.example.invalid/v1", models: [] } },
    },
  } satisfies OpenClawConfig;

  const prompter = prompts(
    " https://fixture.example.invalid/v1/// ",
    " synthetic-setup-key ",
    " org/demo-model ",
  );
  const result = await configure({
    ...fixtureProvider,
    cfg,
    prompter,
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 8192,
    maxTokens: 1024,
  });

  expect(result).toEqual({
    profiles: [
      {
        profileId: "fixture:default",
        credential: { type: "api_key", provider: "fixture", key: "synthetic-setup-key" },
      },
    ],
    configPatch: {
      ...cfg,
      models: {
        ...cfg.models,
        providers: {
          ...cfg.models.providers,
          fixture: {
            baseUrl: "https://fixture.example.invalid/v1",
            api: "openai-completions",
            apiKey: "FIXTURE_API_KEY",
            models: [
              {
                id: "org/demo-model",
                name: "org/demo-model",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 1024,
              },
            ],
          },
        },
      },
    },
    defaultModel: "fixture/org/demo-model",
  });
  const calls = vi.mocked(prompter.text).mock.calls;
  expect(calls).toHaveLength(3);
  expect(calls[1]?.[0]).toMatchObject({
    placeholder: "sk-... (or any non-empty string)",
    sensitive: true,
  });
  expect(calls[2]?.[0].placeholder).toBe("org/example");
  for (const [prompt] of calls.slice(1)) {
    expect(prompt.validate?.(" ")).toBe("Required");
    expect(prompt.validate?.(" value ")).toBeUndefined();
  }
  expect(upsertAuthProfileWithLockOrThrow).not.toHaveBeenCalled();
  expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
});

it.each([
  [undefined, "http://127.0.0.1:8000/v1"],
  ["http://gpu-box:8000/v1/", "http://gpu-box:8000/v1"],
])("blank input falls back to stored URL %s or default", async (initialValue, baseUrl) => {
  const cfg: OpenClawConfig = initialValue
    ? { models: { providers: { fixture: { baseUrl: initialValue, models: [] } } } }
    : {};
  const prompter = prompts(" ", "key", "model");
  const result = await configure({ ...fixtureProvider, cfg, prompter });

  expect(vi.mocked(prompter.text).mock.calls[0]?.[0]).toMatchObject({
    initialValue,
    placeholder: "http://127.0.0.1:8000/v1",
  });
  expect(result.configPatch?.models?.providers?.fixture?.baseUrl).toBe(baseUrl);
});
