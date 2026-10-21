// Sessions ACP runtime metadata tests cover session-owned runtime overlays.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCurrentSessionAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import {
  clearAgentHarnesses,
  listRegisteredAgentHarnesses,
  registerAgentHarness,
} from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const NON_ACP_SESSION_KEY = "agent:main:main";

function buildConfigWithoutAgentRuntimePolicy(): OpenClawConfig {
  return {
    agents: {
      entries: { copilot: {}, main: {} },
      defaults: {},
    },
  };
}

const registeredHarnesses = listRegisteredAgentHarnesses();
beforeEach(() => clearAgentHarnesses());
afterAll(() => restoreRegisteredAgentHarnesses(registeredHarnesses));

describe("session ACP runtime metadata", () => {
  it.each(["session-key"] as const)(
    "projects a declared fallback for the next turn while retaining %s attribution",
    (source) => {
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
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-5.6-luna",
                  name: "Sol",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 8192,
                  compat: { supportsStore: false },
                },
              ],
            },
          },
        },
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.6-luna": {},
            },
          },
        },
      };
      const params = {
        cfg,
        agentId: "main",
        provider: "openai",
        model: "gpt-5.6-luna",
        sessionKey: NON_ACP_SESSION_KEY,
        sessionEntry: {
          agentHarnessId: "codex",
          agentRuntimeOverride: "codex",
        },
      };
      expect(resolveCurrentSessionAgentRuntimeMetadata(params)).toEqual({ id: "openclaw", source });
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
    },
  );

  it("reports implicit policy instead of an unlocked historical producer", () => {
    const agentRuntime = resolveCurrentSessionAgentRuntimeMetadata({
      cfg: { agents: { defaults: { models: { "openai/gpt-5.6-luna": {} } } } },
      agentId: "main",
      provider: "openai",
      model: "gpt-5.6-luna",
      sessionKey: NON_ACP_SESSION_KEY,
      sessionEntry: { agentHarnessId: "openclaw" },
    });
    expect(agentRuntime).toEqual({ id: "codex", source: "implicit" });
  });

  it("keeps an explicit compatible runtime override", () => {
    const agentRuntime = resolveCurrentSessionAgentRuntimeMetadata({
      cfg: buildConfigWithoutAgentRuntimePolicy(),
      agentId: "main",
      provider: "openai",
      model: "gpt-5.6-luna",
      sessionKey: NON_ACP_SESSION_KEY,
      sessionEntry: {
        agentHarnessId: "openclaw",
        agentRuntimeOverride: "codex",
      },
    });

    expect(agentRuntime).toEqual({ id: "codex", source: "session-key" });
  });
});
