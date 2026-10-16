// Tests compact command context-budget resolution separately from command lifecycle behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSessionAgentIdMock } from "./commands-agent-scope.test-support.js";
import {
  buildCompactParams,
  compactEmbeddedAgentSession,
  formatContextUsageShort,
  handleCompactCommand,
  requireCompactEmbeddedAgentSessionCall,
  resetCompactCommandMocks,
} from "./commands-compact.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

describe("handleCompactCommand context budget", () => {
  beforeEach(() => {
    resetCompactCommandMocks();
    resolveSessionAgentIdMock.mockReturnValue("main");
  });

  it("resolves the active Codex runtime config instead of stale session metadata", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "compacted",
        firstKeptEntryId: "first-kept",
        tokensBefore: 199_000,
        tokensAfter: 56_000,
      },
    });

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": {
                  agentRuntime: { id: "codex" },
                },
              },
            },
          },
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
          models: {
            providers: {
              openai: {
                models: [{ id: "gpt-5.5", contextWindow: 258_000 }],
              },
            },
          },
        } as unknown as OpenClawConfig),
        provider: "openai",
        model: "openai/gpt-5.5",
        contextTokens: 0,
        sessionEntry: {
          sessionId: "live-session",
          updatedAt: Date.now(),
          contextTokens: 400_000,
        },
      } as HandleCommandsParams,
      true,
    );

    expect(requireCompactEmbeddedAgentSessionCall().contextTokenBudget).toBe(258_000);
    expect(vi.mocked(formatContextUsageShort)).toHaveBeenLastCalledWith(56_000, 258_000);
  });

  it("retains persisted context when an unknown custom model uses a legacy alias", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "already compacted",
    });

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          agents: {
            defaults: {
              models: { "custom/actual-model": { alias: "legacy-fast-model" } },
            },
          },
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        provider: "custom",
        model: "actual-model",
        contextTokens: 0,
        sessionEntry: {
          sessionId: "legacy-model-session",
          updatedAt: Date.now(),
          providerOverride: "custom",
          modelOverride: "legacy-fast-model",
          modelOverrideSource: "user",
          contextTokens: 777_777,
        },
      } as HandleCommandsParams,
      true,
    );

    expect(requireCompactEmbeddedAgentSessionCall().contextTokenBudget).toBe(777_777);
  });
});
