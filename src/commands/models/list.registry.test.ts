import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const MOCK_1M_TOKENS = 1_048_576;

const mocks = vi.hoisted(() => ({
  resolveContextTokensForModel: vi.fn(),
}));

vi.mock("../../agents/context.js", () => ({
  resolveContextTokensForModel: (...args: unknown[]) => mocks.resolveContextTokensForModel(...args),
}));
vi.mock("../../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: () => "/tmp/fake-agent-dir",
}));
vi.mock("../../agents/auth-profiles.js", () => ({
  listProfilesForProvider: () => [],
}));
vi.mock("../../agents/model-auth.js", () => ({
  hasUsableCustomProviderApiKey: () => false,
  resolveAwsSdkEnvVarName: () => undefined,
  resolveEnvApiKey: () => undefined,
}));
vi.mock("../../agents/model-suppression.js", () => ({
  shouldSuppressBuiltInModel: () => false,
}));
vi.mock("../../agents/pi-model-discovery.js", () => ({
  discoverAuthStorage: () => ({}),
  discoverModels: () => ({ getAll: () => [], getAvailable: () => [] }),
}));

const { toModelRow } = await import("./list.registry.js");

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    provider: "anthropic",
    id: "claude-opus-4-6",
    api: "anthropic-messages",
    name: "Claude Opus 4.6",
    input: ["text", "image"],
    contextWindow: 200_000,
    ...overrides,
  } as Model<Api>;
}

describe("toModelRow", () => {
  it("reflects context1m-resolved contextWindow from resolveContextTokensForModel", () => {
    mocks.resolveContextTokensForModel.mockReturnValue(MOCK_1M_TOKENS);

    const row = toModelRow({
      model: makeModel(),
      key: "anthropic/claude-opus-4-6",
      tags: [],
      cfg: {} as OpenClawConfig,
    });

    expect(row.contextWindow).toBe(MOCK_1M_TOKENS);
    expect(mocks.resolveContextTokensForModel).toHaveBeenCalledWith({
      cfg: expect.anything(),
      provider: "anthropic",
      model: "claude-opus-4-6",
      fallbackContextTokens: 200_000,
    });
  });

  it("falls back to registry contextWindow when resolveContextTokensForModel returns undefined", () => {
    mocks.resolveContextTokensForModel.mockReturnValue(undefined);

    const row = toModelRow({
      model: makeModel({ contextWindow: 200_000 }),
      key: "anthropic/claude-opus-4-6",
      tags: [],
      cfg: {} as OpenClawConfig,
    });

    expect(row.contextWindow).toBeNull();
  });

  it("passes provider and model from the Model object, not the key", () => {
    mocks.resolveContextTokensForModel.mockReturnValue(128_000);

    const row = toModelRow({
      model: makeModel({ provider: "openai", id: "gpt-5.2", contextWindow: 128_000 }),
      key: "openai/gpt-5.2",
      tags: [],
      cfg: {} as OpenClawConfig,
    });

    expect(row.contextWindow).toBe(128_000);
    expect(mocks.resolveContextTokensForModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.2",
        fallbackContextTokens: 128_000,
      }),
    );
  });
});
