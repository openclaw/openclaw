import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => ({
  completeMock: vi.fn(),
  prepareSimpleCompletionModelForAgentMock: vi.fn(),
  extractAssistantTextMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  complete: hoisted.completeMock,
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  prepareSimpleCompletionModelForAgent: hoisted.prepareSimpleCompletionModelForAgentMock,
}));

vi.mock("../../agents/pi-embedded-utils.js", () => ({
  extractAssistantText: hoisted.extractAssistantTextMock,
}));

import { generateThreadTitle } from "./thread-title.js";

beforeEach(() => {
  hoisted.completeMock.mockReset();
  hoisted.prepareSimpleCompletionModelForAgentMock.mockReset();
  hoisted.extractAssistantTextMock.mockReset();

  hoisted.prepareSimpleCompletionModelForAgentMock.mockResolvedValue({
    selection: {
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentDir: "/tmp/openclaw-agent",
    },
    model: {
      provider: "anthropic",
      id: "claude-opus-4-6",
    },
    auth: {
      apiKey: "sk-test",
      source: "env:TEST_API_KEY",
      mode: "api-key",
    },
  });
  hoisted.completeMock.mockResolvedValue({});
  hoisted.extractAssistantTextMock.mockReturnValue("Generated title");
});

describe("generateThreadTitle", () => {
  it("calls shared one-shot model prep with aws-sdk allowance", async () => {
    hoisted.prepareSimpleCompletionModelForAgentMock.mockResolvedValueOnce({
      selection: {
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4-5",
        profileId: "work",
        agentDir: "/tmp/openclaw-agent",
      },
      model: {
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4-5",
      },
      auth: {
        apiKey: "sk-openrouter",
        source: "profile:work",
        mode: "api-key",
      },
    });
    const cfg = {
      agents: {
        defaults: {
          model: "openrouter/anthropic/claude-sonnet-4-5@work",
        },
      },
    } as OpenClawConfig;

    await generateThreadTitle({
      cfg,
      agentId: "main",
      messageText: "Need a generated title.",
    });

    expect(hoisted.prepareSimpleCompletionModelForAgentMock).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      allowMissingApiKeyModes: ["aws-sdk"],
    });
  });

  it("returns null when shared model prep cannot resolve selection", async () => {
    hoisted.prepareSimpleCompletionModelForAgentMock.mockResolvedValueOnce({
      error: "No model configured for agent main.",
    });

    const result = await generateThreadTitle({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      messageText: "Need a thread title.",
    });

    expect(result).toBeNull();
    expect(hoisted.completeMock).not.toHaveBeenCalled();
  });

  it("returns null when shared completion prep fails", async () => {
    hoisted.prepareSimpleCompletionModelForAgentMock.mockResolvedValue({
      error: 'No API key resolved for provider "anthropic" (auth mode: api-key).',
      selection: {
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        agentDir: "/tmp/openclaw-agent",
      },
    });

    const result = await generateThreadTitle({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      messageText: "Need a thread title.",
    });

    expect(result).toBeNull();
    expect(hoisted.completeMock).not.toHaveBeenCalled();
  });

  it("builds contextual prompt and forwards completion options", async () => {
    const result = await generateThreadTitle({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      messageText: "Summarize deployment blockers and owner follow-ups.",
      channelName: "release-status",
      channelDescription: "Deploy updates and incident notes",
    });

    expect(result).toBe("Generated title");
    expect(hoisted.completeMock).toHaveBeenCalledTimes(1);
    expect(hoisted.completeMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        systemPrompt:
          "Generate a concise Discord thread title (3-6 words). Return only the title. Use channel context when provided and avoid redundant channel-name words unless needed for clarity.",
        messages: [
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Channel: release-status"),
          }),
        ],
      }),
    );
    expect(hoisted.completeMock.mock.calls[0]?.[1]?.messages?.[0]?.content).toContain(
      "Channel description: Deploy updates and incident notes",
    );
    expect(hoisted.completeMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        maxTokens: 24,
        temperature: 0.2,
      }),
    );
  });

  it("returns null when completion throws", async () => {
    hoisted.completeMock.mockRejectedValueOnce(new Error("network timeout"));

    const result = await generateThreadTitle({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      messageText: "Generate title.",
    });

    expect(result).toBeNull();
  });
});
