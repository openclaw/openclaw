import { beforeEach, describe, expect, it, vi } from "vitest";

const completeMock = vi.fn();
const minimaxUnderstandImageMock = vi.fn();
const ensureOpenClawModelsJsonMock = vi.fn(async () => {});
const getApiKeyForModelMock = vi.fn(async () => ({
  apiKey: "oauth-test",
  source: "test",
  mode: "oauth",
}));
const requireApiKeyMock = vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? "");
const setRuntimeApiKeyMock = vi.fn();
const discoverModelsMock = vi.fn();

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    complete: completeMock,
  };
});

vi.mock("../../agents/minimax-vlm.js", () => ({
  isMinimaxVlmProvider: (provider: string) =>
    provider === "minimax" || provider === "minimax-portal",
  minimaxUnderstandImage: minimaxUnderstandImageMock,
}));

vi.mock("../../agents/models-config.js", () => ({
  ensureOpenClawModelsJson: ensureOpenClawModelsJsonMock,
}));

vi.mock("../../agents/model-auth.js", () => ({
  getApiKeyForModel: getApiKeyForModelMock,
  requireApiKey: requireApiKeyMock,
}));

vi.mock("../../agents/pi-model-discovery-runtime.js", () => ({
  discoverAuthStorage: () => ({
    setRuntimeApiKey: setRuntimeApiKeyMock,
  }),
  discoverModels: discoverModelsMock,
}));

describe("describeImageWithModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    minimaxUnderstandImageMock.mockResolvedValue("portal ok");
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "minimax-portal",
        id: "MiniMax-VL-01",
        input: ["text", "image"],
        baseUrl: "https://api.minimax.io/anthropic",
      })),
    });
  });

  it("routes minimax-portal image models through the MiniMax VLM endpoint", async () => {
    const { describeImageWithModel } = await import("./image.js");

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "minimax-portal",
      model: "MiniMax-VL-01",
      buffer: Buffer.from("png-bytes"),
      mime: "image/png",
      prompt: "Describe the image.",
    });

    expect(result).toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalled();
    expect(getApiKeyForModelMock).toHaveBeenCalled();
    expect(requireApiKeyMock).toHaveBeenCalled();
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("minimax-portal", "oauth-test");
    expect(minimaxUnderstandImageMock).toHaveBeenCalledWith({
      apiKey: "oauth-test",
      prompt: "Describe the image.",
      imageDataUrl: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`,
      modelBaseUrl: "https://api.minimax.io/anthropic",
    });
    expect(completeMock).not.toHaveBeenCalled();
  });
});
