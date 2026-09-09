import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import * as requesterPreferences from "../subagents/spawn/subagent-spawn-requester-prefs.js";

type SessionsSpawnVisibleDeps = {
  createTool: typeof import("./sessions-spawn-tool.js").createSessionsSpawnTool;
  inProcessCreationMock: unknown;
  mockCallArg: (
    mock: unknown,
    callIndex: number,
    argIndex: number,
    label: string,
  ) => Record<string, unknown>;
};

export function registerSessionsSpawnVisibleThinkingTests(deps: SessionsSpawnVisibleDeps): void {
  describe("sessions_spawn visible thinking", () => {
    it.each([
      {
        name: "does not persist active thinking when visible thinking is omitted",
        requesterThinking: undefined,
        targetThinking: "off",
      },
      {
        name: "does not persist configured thinking when visible thinking is omitted",
        requesterThinking: "low",
        targetThinking: "medium",
      },
    ])("preserves child defaults for visible sessions: $name", async (input) => {
      await withTestDir({ prefix: "openclaw-visible-spawn-thinking-" }, async (dir) => {
        const callGateway = vi.fn(async () => ({
          key: "agent:worker:dashboard:child",
          runStarted: true,
          runId: "run-visible-thinking",
        }));
        const tool = deps.createTool({
          agentSessionKey: "agent:main:main",
          requesterThinkingLevel: "high",
          config: {
            session: { store: path.join(dir, "sessions.json") },
            agents: {
              defaults: { subagents: { allowAgents: ["worker"], thinking: "high" } },
              list: [
                {
                  id: "main",
                  ...(input.requesterThinking
                    ? { subagents: { thinking: input.requesterThinking } }
                    : {}),
                },
                {
                  id: "worker",
                  ...(input.targetThinking
                    ? { subagents: { thinking: input.targetThinking } }
                    : {}),
                },
              ],
            },
          },
          callGateway: callGateway as never,
          registerRun: vi.fn(),
          countActiveRuns: () => 0,
        });

        await tool.execute("visible-thinking-precedence", {
          task: "inspect",
          agentId: "worker",
          visible: true,
        });

        const createParams = deps.mockCallArg(callGateway, 0, 1, "sessions.create");
        expect(createParams).toMatchObject({ agentId: "worker" });
        expect(createParams).not.toHaveProperty("thinkingLevel");
      });
    });

    it("does not inherit the caller thinking level when visible thinking is omitted", async () => {
      await withTestDir({ prefix: "openclaw-visible-spawn-caller-thinking-" }, async (dir) => {
        const readThinkingLevel = vi.spyOn(requesterPreferences, "readRequesterThinkingLevel");
        const storePath = path.join(dir, "sessions.json");
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: "agent:main:main", storePath },
          { thinkingLevel: "off" },
        );
        const callGateway = vi.fn(async () => ({
          key: "agent:main:dashboard:child",
          runStarted: true,
          runId: "run-visible-caller-thinking",
        }));
        const tool = deps.createTool({
          agentSessionKey: "agent:main:main",
          config: {
            session: { store: storePath },
            agents: { defaults: { subagents: {} }, list: [{ id: "main" }] },
          },
          callGateway: callGateway as never,
          registerRun: vi.fn(),
          countActiveRuns: () => 0,
        });

        try {
          await tool.execute("visible-caller-thinking", {
            task: "inspect",
            visible: true,
          });

          const createParams = deps.mockCallArg(callGateway, 0, 1, "sessions.create");
          expect(createParams).not.toHaveProperty("thinkingLevel");
          expect(readThinkingLevel).not.toHaveBeenCalled();
        } finally {
          readThinkingLevel.mockRestore();
        }
      });
    });

    it("does not inherit active thinking when visible thinking is omitted", async () => {
      await withTestDir({ prefix: "openclaw-visible-spawn-active-thinking-" }, async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: "agent:main:main", storePath },
          { thinkingLevel: "off" },
        );
        const callGateway = vi.fn(async () => ({
          key: "agent:main:dashboard:child",
          runStarted: true,
          runId: "run-visible-active-thinking",
        }));
        const tool = deps.createTool({
          agentSessionKey: "agent:main:main",
          requesterThinkingLevel: "ultra",
          config: {
            session: { store: storePath },
            agents: { defaults: { subagents: {} }, list: [{ id: "main" }] },
          },
          callGateway: callGateway as never,
          registerRun: vi.fn(),
          countActiveRuns: () => 0,
        });

        await tool.execute("visible-active-thinking", {
          task: "inspect",
          visible: true,
        });

        const createParams = deps.mockCallArg(callGateway, 0, 1, "sessions.create");
        expect(createParams).not.toHaveProperty("thinkingLevel");
      });
    });

    it.each([
      { label: "default", mode: undefined },
      { label: "read-only", mode: "read-only" },
      { label: "guarded", mode: "guarded" },
      { label: "workspace", mode: "workspace" },
      { label: "full", mode: "full" },
    ] as const)(
      "inherits the parent's $label permission mode in a visible child",
      async ({ mode }) => {
        const creationMock = deps.inProcessCreationMock as {
          mockResolvedValue: (value: unknown) => unknown;
        };
        creationMock.mockResolvedValue({
          key: "agent:main:dashboard:child",
          runStarted: true,
          runId: "run-visible",
        });
        const tool = deps.createTool({
          agentSessionKey: "agent:main:main",
          ...(mode ? { sessionPermissionPolicy: { mode, root: "/workspace/main" } } : {}),
          config: { agents: { list: [{ id: "main" }] } },
          registerRun: vi.fn(),
          countActiveRuns: () => 0,
        });

        await tool.execute("visible-permissions", {
          task: "inspect",
          visible: true,
          worktree: true,
        });

        const createParams = deps.mockCallArg(deps.inProcessCreationMock, 0, 1, "sessions.create");
        expect(createParams.worktree).toBe(true);
        expect(createParams).not.toHaveProperty("sessionRoot");
        expect(createParams).not.toHaveProperty("permissionMode");
        const creation = deps.mockCallArg(deps.inProcessCreationMock, 0, 2, "sessions.create");
        if (mode) {
          expect(creation.inheritedPermissionMode).toBe(mode);
        } else {
          expect(creation).not.toHaveProperty("inheritedPermissionMode");
        }
      },
    );

    it("reports every unsupported visible parameter in one error", async () => {
      const tool = deps.createTool({ agentSessionKey: "agent:main:main" });

      await expect(
        tool.execute("visible-unsupported-many", {
          task: "inspect",
          runtime: "acp",
          thinking: "high",
          thread: true,
          mode: "session",
          lightContext: true,
          attachments: [{ name: "note.txt", content: "hello" }],
          attachAs: { mountPath: "inputs" },
          visible: true,
        }),
      ).rejects.toThrow(
        'Parameters unavailable with visible=true: runtime: supports runtime="subagent" only; thread: visible sessions route to the dashboard, not a channel thread; mode: visible sessions are persistent dashboard sessions; lightContext: bootstrap staging is not wired to the sessions.create path; attachments: attachment staging is not wired to the sessions.create path; attachAs: attachment staging is not wired to the sessions.create path',
      );
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
            list: [{ id: "main" }],
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
            list: [{ id: "main" }],
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

    it("does not let configured subagent thinking override an omitted visible-spawn value", async () => {
      const callGateway = vi.fn(async () => ({
        key: "agent:main:dashboard:child",
        runStarted: true,
        runId: "run-visible-configured-thinking",
      }));
      const tool = deps.createTool({
        agentSessionKey: "agent:main:main",
        requesterThinkingLevel: "xhigh",
        config: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.6-luna" },
              subagents: { model: "openai/gpt-5.6-off", thinking: "high" },
            },
            list: [{ id: "main" }],
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

      await tool.execute("visible-configured-thinking", {
        task: "inspect issue",
        visible: true,
      });

      const createCall = callGateway.mock.calls[0] as unknown as [string, Record<string, unknown>];
      const createParams = createCall[1];
      expect(createParams).toMatchObject({
        agentId: "main",
        model: "openai/gpt-5.6-off",
      });
      expect(createParams).not.toHaveProperty("thinkingLevel");
    });

    it("preserves omitted thinking over the active caller preference", async () => {
      await withTestDir({ prefix: "openclaw-visible-spawn-active-thinking-" }, async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: "agent:main:main", storePath },
          { thinkingLevel: "off" },
        );
        const callGateway = vi.fn(async () => ({
          key: "agent:main:dashboard:child",
          runStarted: true,
          runId: "run-visible-active-thinking",
        }));
        const tool = deps.createTool({
          agentSessionKey: "agent:main:main",
          requesterThinkingLevel: "ultra",
          config: {
            session: { store: storePath },
            agents: { defaults: { subagents: {} }, list: [{ id: "main" }] },
          },
          callGateway: callGateway as never,
          registerRun: vi.fn(),
          countActiveRuns: () => 0,
        });

        await tool.execute("visible-active-thinking", {
          task: "inspect",
          visible: true,
        });

        expect(deps.mockCallArg(callGateway, 0, 1, "sessions.create")).not.toHaveProperty(
          "thinkingLevel",
        );
      });
    });
  });
}
