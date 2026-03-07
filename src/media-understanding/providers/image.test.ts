import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  completeMock,
  ensureOpenClawModelsJsonMock,
  discoverAuthStorageMock,
  discoverModelsMock,
  getApiKeyForModelMock,
  requireApiKeyMock,
  coerceImageAssistantTextMock,
} = vi.hoisted(() => ({
  completeMock: vi.fn(),
  ensureOpenClawModelsJsonMock: vi.fn(async () => {}),
  discoverAuthStorageMock: vi.fn(),
  discoverModelsMock: vi.fn(),
  getApiKeyForModelMock: vi.fn(async () => ({ apiKey: "ignored" })),
  requireApiKeyMock: vi.fn(() => "test-key"),
  coerceImageAssistantTextMock: vi.fn(() => "ok"),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  complete: completeMock,
}));

vi.mock("../../agents/models-config.js", () => ({
  ensureOpenClawModelsJson: ensureOpenClawModelsJsonMock,
}));

vi.mock("../../agents/pi-model-discovery.js", () => ({
  discoverAuthStorage: discoverAuthStorageMock,
  discoverModels: discoverModelsMock,
}));

vi.mock("../../agents/model-auth.js", () => ({
  getApiKeyForModel: getApiKeyForModelMock,
  requireApiKey: requireApiKeyMock,
}));

vi.mock("../../agents/tools/image-tool.helpers.js", () => ({
  coerceImageAssistantText: coerceImageAssistantTextMock,
}));

vi.mock("../../agents/minimax-vlm.js", () => ({
  minimaxUnderstandImage: vi.fn(),
}));

import { describeImageWithModel } from "./image.js";

function makeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "gpt-5.3-codex",
    provider: "openai-codex",
    api: "openai-codex-responses",
    input: ["text", "image"],
    ...overrides,
  };
}

function mockRegistryWithModel(model: Record<string, unknown>) {
  discoverAuthStorageMock.mockReturnValue({
    setRuntimeApiKey: vi.fn(),
  });
  discoverModelsMock.mockReturnValue({
    find: vi.fn(() => model),
  });
}

describe("describeImageWithModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    completeMock.mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      timestamp: Date.now(),
    });
  });

  it("adds a system prompt for openai-codex image requests", async () => {
    mockRegistryWithModel(makeModel());

    await describeImageWithModel({
      buffer: Buffer.from("img"),
      fileName: "a.jpg",
      mime: "image/jpeg",
      model: "gpt-5.3-codex",
      provider: "openai-codex",
      prompt: "Describe everything visible in this image.",
      timeoutMs: 1000,
      agentDir: "/tmp/agent",
      cfg: {} as never,
    });

    expect(completeMock).toHaveBeenCalledTimes(1);
    const [, context] = completeMock.mock.calls[0] ?? [];
    expect(context?.systemPrompt).toContain("Analyze the provided image");
  });

  it("does not force a system prompt for non-codex image providers", async () => {
    mockRegistryWithModel(
      makeModel({
        id: "gpt-4.1",
        provider: "openai",
        api: "openai-responses",
      }),
    );

    await describeImageWithModel({
      buffer: Buffer.from("img"),
      fileName: "a.jpg",
      mime: "image/jpeg",
      model: "gpt-4.1",
      provider: "openai",
      prompt: "Describe this image.",
      timeoutMs: 1000,
      agentDir: "/tmp/agent",
      cfg: {} as never,
    });

    const [, context] = completeMock.mock.calls[0] ?? [];
    expect(context?.systemPrompt).toBeUndefined();
  });
});
