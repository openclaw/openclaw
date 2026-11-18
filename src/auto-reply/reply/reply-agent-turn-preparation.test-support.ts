import type { FollowupRun } from "./queue/types.js";

export function createPreparationRun(
  overrides: Partial<Omit<FollowupRun, "run">> & { run?: Partial<FollowupRun["run"]> } = {},
): FollowupRun {
  return {
    prompt: "hello",
    enqueuedAt: 1,
    ...overrides,
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      provider: "provider",
      model: "model",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      ...overrides.run,
    },
  };
}
