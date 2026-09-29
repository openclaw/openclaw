import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRunModelThinkingCapability } from "./agent-runner-run-params.js";

const loadProviderScopedThinkingCatalog = vi.hoisted(() =>
  vi.fn(async () => [
    {
      provider: "openai",
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
    },
  ]),
);

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog,
}));

describe("reply-path model thinking capability", () => {
  it("hydrates Codex reasoning efforts when the queued catalog lacks them", async () => {
    const capability = await resolveRunModelThinkingCapability({
      config: {} as OpenClawConfig,
      provider: "openai",
      model: "gpt-5.6-luna",
      agentRuntime: "codex",
      agentId: "main",
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      thinkingCatalog: [
        {
          provider: "openai",
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          compat: {},
        },
      ],
    });

    expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledWith({
      config: {},
      provider: "openai",
      model: "gpt-5.6-luna",
      agentId: "main",
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
    });
    expect(capability).toEqual({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      agentRuntime: "codex",
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
    });
  });

  it("does not erase max when the reply candidate already has prepared Codex metadata", async () => {
    loadProviderScopedThinkingCatalog.mockClear();

    const capability = await resolveRunModelThinkingCapability({
      config: {} as OpenClawConfig,
      provider: "openai",
      model: "gpt-5.6-luna",
      agentRuntime: "codex",
      agentId: "main",
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      thinkingCatalog: [
        {
          provider: "openai",
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          compat: {
            supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
          },
        },
      ],
    });

    expect(capability?.compat.supportedReasoningEfforts).toContain("max");
  });
});
