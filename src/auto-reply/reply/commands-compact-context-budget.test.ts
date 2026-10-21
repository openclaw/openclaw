import { beforeEach, expect, it, vi } from "vitest";
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

beforeEach(() => {
  resetCompactCommandMocks();
  resolveSessionAgentIdMock.mockReturnValue("main");
});

it.each([
  {
    name: "active Codex runtime config instead of stale session metadata",
    cfg: {
      agents: { defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } } },
      models: { providers: { openai: { models: [{ id: "gpt-5.5", contextWindow: 258_000 }] } } },
    } as unknown as OpenClawConfig,
    provider: "openai",
    model: "openai/gpt-5.5",
    session: { sessionId: "live-session", contextTokens: 400_000 },
    result: {
      ok: true,
      compacted: true,
      result: {
        summary: "compacted",
        firstKeptEntryId: "first-kept",
        tokensBefore: 199_000,
        tokensAfter: 56_000,
      },
    },
    budget: 258_000,
  },
  {
    name: "persisted context for an unknown custom model with a legacy alias",
    cfg: {
      agents: { defaults: { models: { "custom/actual-model": { alias: "legacy-fast-model" } } } },
    },
    provider: "custom",
    model: "actual-model",
    session: {
      sessionId: "legacy-model-session",
      contextTokens: 777_777,
      providerOverride: "custom",
      modelOverride: "legacy-fast-model",
      modelOverrideSource: "user",
    },
    result: { ok: true, compacted: false, reason: "already compacted" },
    budget: 777_777,
  },
] as const)("resolves $name", async ({ cfg, provider, model, session, result, budget }) => {
  vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce(result);
  await handleCompactCommand(
    {
      ...buildCompactParams("/compact", {
        ...cfg,
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      }),
      provider,
      model,
      contextTokens: 0,
      sessionEntry: { ...session, updatedAt: Date.now() },
    },
    true,
  );
  expect(requireCompactEmbeddedAgentSessionCall().contextTokenBudget).toBe(budget);
  if (result.compacted) {
    expect(vi.mocked(formatContextUsageShort)).toHaveBeenLastCalledWith(56_000, 258_000);
  }
});
