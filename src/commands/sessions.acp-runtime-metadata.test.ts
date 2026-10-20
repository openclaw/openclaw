// Sessions ACP runtime metadata tests cover session-owned runtime overlays.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCurrentSessionAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import {
  clearAgentHarnesses,
  listRegisteredAgentHarnesses,
  registerAgentHarness,
} from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import {
  completionConfig,
  completionModelDefinition,
} from "../agents/simple-completion.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const session = {
  agentId: "main",
  provider: "openai",
  model: "gpt-5.6-luna",
  sessionKey: "agent:main:main",
};
const configuredModels: OpenClawConfig = {
  agents: { defaults: { models: { "openai/gpt-5.6-luna": {} } } },
};

const registeredHarnesses = listRegisteredAgentHarnesses();
beforeEach(() => clearAgentHarnesses());
afterAll(() => restoreRegisteredAgentHarnesses(registeredHarnesses));

describe("session ACP runtime metadata", () => {
  it("projects a declared fallback for the next turn while retaining session-key attribution", () => {
    const supports = vi.fn((_context: unknown) => ({
      supported: false as const,
      fallbackRuntime: "openclaw" as const,
    }));
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports,
      runAttempt: async () => {
        throw new Error("projection must not execute");
      },
    });
    const cfg = completionConfig(
      "openai",
      {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        models: [
          completionModelDefinition({
            id: "gpt-5.6-luna",
            name: "Sol",
            reasoning: true,
            contextWindow: 200_000,
            maxTokens: 8192,
            compat: { supportsStore: false },
          }),
        ],
      },
      configuredModels,
    );
    const params = {
      ...session,
      cfg,
      sessionEntry: {
        agentHarnessId: "codex",
        agentRuntimeOverride: "codex",
      },
    };
    expect(resolveCurrentSessionAgentRuntimeMetadata(params)).toEqual({
      id: "openclaw",
      source: "session-key",
    });
    expect(
      resolveCurrentSessionAgentRuntimeMetadata({
        ...params,
        sessionEntry: { ...params.sessionEntry, modelSelectionLocked: true },
      }),
    ).toEqual({ id: "codex", source: "session" });
    expect(
      resolveCurrentSessionAgentRuntimeMetadata({
        ...params,
        sessionKey: "agent:main:acp:runtime-test",
        acpRuntime: true,
      }),
    ).toEqual({ id: "acpx", source: "session-key" });
    // Projection consumes registered support only; it never discovers provider ownership.
    for (const [context] of supports.mock.calls) {
      expect(context).not.toHaveProperty("providerOwnerStatus");
    }
  });

  it("reports implicit policy instead of an unlocked historical producer", () => {
    const agentRuntime = resolveCurrentSessionAgentRuntimeMetadata({
      ...session,
      cfg: configuredModels,
      sessionEntry: { agentHarnessId: "openclaw" },
    });
    expect(agentRuntime).toEqual({ id: "codex", source: "implicit" });
  });

  it("keeps an explicit compatible runtime override", () => {
    const agentRuntime = resolveCurrentSessionAgentRuntimeMetadata({
      ...session,
      cfg: { agents: { entries: { copilot: {}, main: {} }, defaults: {} } },
      sessionEntry: {
        agentHarnessId: "openclaw",
        agentRuntimeOverride: "codex",
      },
    });

    expect(agentRuntime).toEqual({ id: "codex", source: "session-key" });
  });
});
