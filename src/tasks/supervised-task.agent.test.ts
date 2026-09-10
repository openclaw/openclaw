import { beforeEach, expect, it, vi } from "vitest";
import type { agentCommandFromSystem } from "../agents/agent-command.js";
import type { OpenClawConfig } from "../config/config.js";
import { runSupervisedAgentAttempt } from "./supervised-task.agent.js";
import type { SupervisedTask } from "./supervised-task.types.js";

const mocks = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  command: vi.fn<typeof agentCommandFromSystem>(),
}));
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => mocks.config }));
vi.mock("../agents/agent-command.js", () => ({ agentCommandFromSystem: mocks.command }));

function task(runtime: SupervisedTask["runtime"], model: string): SupervisedTask {
  const now = Date.now();
  mocks.config = {
    agents: { defaults: { models: { [model]: { agentRuntime: { id: runtime } } } } },
  };
  return {
    version: 1,
    flowId: "fixture",
    episode: 1,
    revision: 1,
    agentId: "poc",
    runtime,
    model,
    prompt: "Define the fixture goal",
    goal: null,
    goalSource: null,
    policy: { deadlineAt: now + 60_000, maxAttempts: 3, attemptTimeoutMs: 10_000 },
    phase: "running",
    next: "Define the fixture goal",
    dueAt: now,
    attempts: 1,
    lastAttemptId: null,
    attempt: {
      id: "attempt",
      ownerId: "owner",
      startedAt: now,
      expiresAt: now + 10_000,
      dispatched: true,
    },
    endpoint: null,
    createdAt: now,
    updatedAt: now,
  };
}
const decision = {
  kind: "define_goal",
  goal: {
    objective: "Read fixture",
    success: [{ id: "read", description: "Read fixture" }],
    partial: [],
  },
};
const context = () => ({ signal: new AbortController().signal, assertCurrent: vi.fn() });

beforeEach(() => mocks.command.mockReset());

it("refuses a CLI runtime alias as a canonical model provider before invoking the command", async () => {
  mocks.command.mockResolvedValue({
    payloads: [{ mediaUrl: null, text: JSON.stringify(decision) }],
    meta: {
      durationMs: 1,
      agentMeta: { sessionId: "attempt", provider: "anthropic", model: "fixture" },
    },
  });
  await expect(
    runSupervisedAgentAttempt(task("claude-cli", "claude-cli/fixture"), context()),
  ).rejects.toThrow("Configure the requested explicit");
  expect(mocks.command).not.toHaveBeenCalled();
});

it("requires actual CLI execution evidence, not an echoed provider name", async () => {
  const current = task("claude-cli", "anthropic/fixture");
  mocks.command.mockResolvedValue({
    payloads: [{ mediaUrl: null, text: JSON.stringify(decision) }],
    meta: {
      durationMs: 1,
      agentMeta: { sessionId: "attempt", provider: "claude-cli", model: "fixture" },
    },
  });
  await expect(runSupervisedAgentAttempt(current, context())).rejects.toThrow("Observed execution");
  mocks.command.mockResolvedValue({
    payloads: [{ mediaUrl: null, text: JSON.stringify(decision) }],
    meta: {
      durationMs: 1,
      executionTrace: {
        runner: "cli",
        winnerProvider: "claude-cli",
        winnerModel: "fixture",
        attempts: [],
        fallbackUsed: false,
      },
      agentMeta: { sessionId: "attempt", provider: "claude-cli", model: "fixture" },
    },
  });
  await expect(runSupervisedAgentAttempt(current, context())).resolves.toEqual(decision);
  expect(mocks.command.mock.calls[1]![0]).toMatchObject({
    extraSystemPrompt: expect.stringContaining("machine-consumed state transition"),
    toolsAllow: [],
    cleanupCliLiveSessionOnRunEnd: true,
    cleanupBundleMcpOnRunEnd: true,
    sessionEffects: "internal",
    modelFallbacksOverride: [],
  });
  mocks.command.mockResolvedValue({
    payloads: [{ mediaUrl: null, text: `The result is ready.\n${JSON.stringify(decision)}` }],
    meta: {
      durationMs: 1,
      executionTrace: {
        runner: "cli",
        winnerProvider: "claude-cli",
        winnerModel: "fixture",
        attempts: [],
        fallbackUsed: false,
      },
      agentMeta: { sessionId: "attempt", provider: "claude-cli", model: "fixture" },
    },
  });
  await expect(runSupervisedAgentAttempt(current, context())).rejects.toThrow(SyntaxError);
  expect(mocks.command).toHaveBeenCalledTimes(3);
});

it("rejects stale source ownership after an otherwise successful Codex response", async () => {
  const current = task("codex", "openai/fixture");
  const source = context();
  mocks.command.mockImplementation(async () => {
    source.assertCurrent.mockImplementation(() => {
      throw new Error("source retired");
    });
    return {
      payloads: [{ mediaUrl: null, text: JSON.stringify(decision) }],
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "attempt",
          provider: "openai",
          model: "fixture",
          agentHarnessId: "codex",
        },
      },
    };
  });
  await expect(runSupervisedAgentAttempt(current, source)).rejects.toThrow("source retired");
});
