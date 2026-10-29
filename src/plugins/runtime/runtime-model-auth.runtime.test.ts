import { beforeAll, beforeEach, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getApiKeyForModel: vi.fn(),
  prepareProviderRuntimeAuth: vi.fn(),
}));

vi.mock("../../agents/model-auth.js", () => ({
  getApiKeyForModelCore: hoisted.getApiKeyForModel,
  resolveApiKeyForProviderCore: vi.fn(),
}));

vi.mock("../provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: hoisted.prepareProviderRuntimeAuth,
}));

let getRuntimeAuthForModelCore: typeof import("./runtime-model-auth.runtime.js").getRuntimeAuthForModelCore;

const MODEL = {
  id: "github-copilot/gpt-4o",
  provider: "github-copilot",
  api: "openai-responses",
  baseUrl: "https://api.githubcopilot.com",
};

function resolveAuth(provider = MODEL.provider, id = MODEL.id) {
  return getRuntimeAuthForModelCore({ model: { ...MODEL, provider, id } as never });
}

beforeAll(async () => {
  ({ getRuntimeAuthForModelCore } = await import("./runtime-model-auth.runtime.js"));
});

beforeEach(() => {
  hoisted.getApiKeyForModel.mockReset();
  hoisted.prepareProviderRuntimeAuth.mockReset();
});

it("returns provider-prepared runtime auth when the provider transforms credentials", async () => {
  const raw = {
    apiKey: "github-device-token",
    source: "profile:github-copilot:github",
    mode: "token",
    profileId: "github-copilot:github",
  };
  const prepared = {
    apiKey: "copilot-bearer-token",
    baseUrl: "https://api.individual.githubcopilot.com",
    expiresAt: 123,
  };
  hoisted.getApiKeyForModel.mockResolvedValue(raw);
  hoisted.prepareProviderRuntimeAuth.mockResolvedValue(prepared);

  await expect(resolveAuth()).resolves.toEqual({ ...raw, ...prepared });
  const scope = {
    provider: MODEL.provider,
    config: undefined,
    workspaceDir: undefined,
    env: process.env,
  };
  expect(hoisted.prepareProviderRuntimeAuth).toHaveBeenCalledWith({
    ...scope,
    context: {
      ...scope,
      modelId: MODEL.id,
      model: MODEL,
      apiKey: raw.apiKey,
      authMode: raw.mode,
      profileId: raw.profileId,
    },
  });
});

it("falls back to raw auth when the provider has no runtime auth hook", async () => {
  const raw = {
    apiKey: "plain-api-key",
    source: "env:OPENAI_API_KEY",
    mode: "api-key",
  };
  hoisted.getApiKeyForModel.mockResolvedValue(raw);
  hoisted.prepareProviderRuntimeAuth.mockResolvedValue(undefined);

  await expect(resolveAuth("openai", "openai/gpt-5.4")).resolves.toEqual(raw);
});

it("skips provider preparation when raw auth does not expose an apiKey", async () => {
  const raw = { source: "env:AWS_PROFILE", mode: "aws-sdk" };
  hoisted.getApiKeyForModel.mockResolvedValue(raw);

  await expect(resolveAuth("bedrock", "bedrock/claude-sonnet")).resolves.toEqual(raw);
  expect(hoisted.prepareProviderRuntimeAuth).not.toHaveBeenCalled();
});
