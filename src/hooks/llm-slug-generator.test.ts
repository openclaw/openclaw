import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const resolveAgentEffectiveModelPrimaryMock = vi.fn(() => null);
const runEmbeddedPiAgentMock = vi.fn();
const runCliAgentMock = vi.fn();

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => path.join(os.tmpdir(), "openclaw-slug-workspace")),
  resolveAgentDir: vi.fn(() => path.join(os.tmpdir(), "openclaw-slug-agent")),
  resolveAgentEffectiveModelPrimary: (...args: unknown[]) =>
    resolveAgentEffectiveModelPrimaryMock(...args),
}));

vi.mock("../agents/cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => runCliAgentMock(...args),
}));

vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (...args: unknown[]) => runEmbeddedPiAgentMock(...args),
}));

import { generateSlugViaLLM } from "./llm-slug-generator.js";

describe("generateSlugViaLLM", () => {
  beforeEach(() => {
    resolveAgentEffectiveModelPrimaryMock.mockReset();
    resolveAgentEffectiveModelPrimaryMock.mockReturnValue(null);
    runCliAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "test-slug" }],
    });
  });

  it("keeps the helper default timeout when no agent timeout is configured", async () => {
    await generateSlugViaLLM({
      sessionContent: "hello",
      cfg: {} as OpenClawConfig,
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        timeoutMs: 15_000,
        cleanupBundleMcpOnRunEnd: true,
      }),
    );
  });

  it("honors configured agent timeoutSeconds for slow local providers", async () => {
    await generateSlugViaLLM({
      sessionContent: "hello",
      cfg: {
        agents: {
          defaults: {
            timeoutSeconds: 500,
          },
        },
      } as OpenClawConfig,
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        timeoutMs: 500_000,
      }),
    );
  });

  it("infers provider metadata for bare configured agent models", async () => {
    resolveAgentEffectiveModelPrimaryMock.mockImplementation((cfg: OpenClawConfig) => {
      const model = cfg.agents?.defaults?.model;
      if (typeof model === "string") {
        return model;
      }
      return model?.primary;
    });

    await generateSlugViaLLM({
      sessionContent: "hello",
      cfg: {
        agents: {
          defaults: {
            model: { primary: "gpt-5.5" },
          },
        },
        models: {
          providers: {
            "openai-codex": {
              baseUrl: "https://chatgpt.com/backend-api/codex",
              models: [
                {
                  id: "gpt-5.5",
                  name: "GPT 5.5",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 128_000,
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        provider: "openai-codex",
        model: "gpt-5.5",
      }),
    );
  });

  it("uses runCliAgent for CLI-backed default models and preserves timeout resolution", async () => {
    resolveAgentEffectiveModelPrimaryMock.mockReturnValue("claude-cli/opus");
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Vendor Pitch" }],
      meta: {
        agentMeta: {
          sessionId: "cli-session",
          provider: "claude-cli",
          model: "opus",
        },
      },
    });

    const slug = await generateSlugViaLLM({
      sessionContent: "Discussed the vendor pitch and next steps.",
      cfg: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": { command: "claude" },
            },
            timeoutSeconds: 500,
          },
        },
      } as OpenClawConfig,
    });

    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        model: "opus",
        timeoutMs: 500_000,
      }),
    );
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(slug).toBe("vendor-pitch");
  });
});
