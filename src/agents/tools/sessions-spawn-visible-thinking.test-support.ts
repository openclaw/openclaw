import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";

export type SessionsSpawnVisibleDeps = {
  createTool: typeof import("./sessions-spawn-tool.js").createSessionsSpawnTool;
  mockCallArg: (
    mock: unknown,
    callIndex: number,
    argIndex: number,
    label: string,
  ) => Record<string, unknown>;
};

export function registerSessionsSpawnVisibleThinkingTests(deps: SessionsSpawnVisibleDeps): void {
  describe("sessions_spawn visible thinking", () => {
    it("omits requester, saved, and configured thinking for visible sessions", async () => {
      await withTestDir({ prefix: "openclaw-visible-spawn-thinking-" }, async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: "agent:main:main", storePath },
          { thinkingLevel: "off" },
        );
        const callGateway = vi.fn(async () => ({
          key: "agent:worker:dashboard:child",
          runStarted: true,
          runId: "run-visible-thinking",
        }));
        const tool = deps.createTool({
          agentSessionKey: "agent:main:main",
          requesterThinkingLevel: "ultra",
          config: {
            session: { store: storePath },
            agents: {
              defaults: { subagents: { allowAgents: ["worker"], thinking: "high" } },
              entries: {
                main: { subagents: { thinking: "low" } },
                worker: { subagents: { thinking: "medium" } },
              },
            },
          },
          callGateway: callGateway as never,
          registerRun: vi.fn(),
          countActiveRuns: () => 0,
        });

        await tool.execute("visible-thinking-omitted", {
          task: "inspect",
          agentId: "worker",
          visible: true,
        });

        const createParams = deps.mockCallArg(callGateway, 0, 1, "sessions.create");
        expect(createParams).toMatchObject({ agentId: "worker" });
        expect(createParams).not.toHaveProperty("thinkingLevel");
      });
    });

    it("rejects invalid visible thinking before session creation", async () => {
      const callGateway = vi.fn();
      const tool = deps.createTool({
        agentSessionKey: "agent:main:main",
        callGateway: callGateway as never,
      });

      await expect(
        tool.execute("visible-invalid-thinking", {
          task: "inspect",
          visible: true,
          thinking: "not-a-thinking-level",
        }),
      ).rejects.toThrow(/Invalid thinking level "not-a-thinking-level"\. Use one of:/);
      expect(callGateway).not.toHaveBeenCalled();
    });

    it("preserves omitted thinking for the visible child's selected runtime", async () => {
      const callGateway = vi.fn(async () => ({
        key: "agent:main:dashboard:child",
        runStarted: true,
        runId: "run-visible-inherited-thinking",
      }));
      const tool = deps.createTool({
        agentSessionKey: "agent:main:main",
        requesterThinkingLevel: "xhigh",
        config: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.6-luna" },
              subagents: { model: "openai/gpt-5.6-off" },
            },
            entries: { main: {} },
          },
          models: {
            providers: {
              openai: {
                baseUrl: "http://127.0.0.1",
                models: [
                  {
                    id: "gpt-5.6-off",
                    name: "gpt-5.6-off",
                    reasoning: true,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
        },
        callGateway: callGateway as never,
        registerRun: vi.fn(),
        countActiveRuns: () => 0,
      });

      await tool.execute("visible-inherited-thinking", {
        task: "inspect issue",
        visible: true,
      });

      expect(callGateway).toHaveBeenCalledWith(
        "sessions.create",
        expect.objectContaining({
          agentId: "main",
          model: "openai/gpt-5.6-off",
        }),
      );
      expect(deps.mockCallArg(callGateway, 0, 1, "sessions.create")).not.toHaveProperty(
        "thinkingLevel",
      );
    });

    it("resolves model aliases without inheriting omitted thinking", async () => {
      const callGateway = vi.fn(async () => ({
        key: "agent:main:dashboard:child",
        runStarted: true,
        runId: "run-visible-alias-inherited-thinking",
      }));
      const tool = deps.createTool({
        agentSessionKey: "agent:main:main",
        requesterThinkingLevel: "xhigh",
        config: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.6-luna" },
              subagents: { model: "worker-fast" },
              models: {
                "openai/gpt-5.6-off": { alias: "worker-fast" },
              },
            },
            entries: { main: {} },
          },
          models: {
            providers: {
              openai: {
                baseUrl: "http://127.0.0.1",
                models: [
                  {
                    id: "gpt-5.6-off",
                    name: "gpt-5.6-off",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
        },
        callGateway: callGateway as never,
        registerRun: vi.fn(),
        countActiveRuns: () => 0,
      });

      await tool.execute("visible-alias-inherited-thinking", {
        task: "inspect issue",
        model: "worker-fast",
        visible: true,
      });

      expect(callGateway).toHaveBeenCalledWith(
        "sessions.create",
        expect.objectContaining({
          agentId: "main",
          model: "openai/gpt-5.6-off",
        }),
      );
      expect(deps.mockCallArg(callGateway, 0, 1, "sessions.create")).not.toHaveProperty(
        "thinkingLevel",
      );
    });
  });
}
