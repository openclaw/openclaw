import { expect, it } from "vitest";
import type { runReplyAgent } from "./agent-runner.runtime.js";
import type { runPreparedReply } from "./get-reply-run.js";

export function registerPreparedReplyCwdCases({
  runPrepared,
  requireRunReplyAgentCall,
}: {
  runPrepared: (
    overrides?: Partial<Parameters<typeof runPreparedReply>[0]>,
  ) => ReturnType<typeof runPreparedReply>;
  requireRunReplyAgentCall: () => Parameters<typeof runReplyAgent>[0];
}): void {
  it.each([
    {
      name: "unset",
      defaultCwd: undefined,
      agentCwd: undefined,
      spawnedCwd: undefined,
      storedCwd: undefined,
      expected: undefined,
    },
    {
      name: "defaults",
      defaultCwd: "/tmp/default-repo",
      agentCwd: undefined,
      spawnedCwd: undefined,
      storedCwd: undefined,
      expected: "/tmp/default-repo",
    },
    {
      name: "agent override",
      defaultCwd: "/tmp/default-repo",
      agentCwd: "/tmp/agent-repo",
      spawnedCwd: undefined,
      storedCwd: undefined,
      expected: "/tmp/agent-repo",
    },
    {
      name: "spawned override",
      defaultCwd: "/tmp/default-repo",
      agentCwd: "/tmp/agent-repo",
      spawnedCwd: "/tmp/session-repo",
      storedCwd: undefined,
      expected: "/tmp/session-repo",
    },
    {
      name: "admitted spawned override",
      defaultCwd: "/tmp/default-repo",
      agentCwd: "/tmp/agent-repo",
      spawnedCwd: "/tmp/stale-session-repo",
      storedCwd: "/tmp/current-session-repo",
      expected: "/tmp/current-session-repo",
    },
    {
      name: "cleared admitted spawned override",
      defaultCwd: "/tmp/default-repo",
      agentCwd: "/tmp/agent-repo",
      spawnedCwd: "/tmp/stale-session-repo",
      storedCwd: null,
      expected: "/tmp/agent-repo",
    },
  ])(
    "keeps workspace separate from $name run cwd",
    async ({ defaultCwd, agentCwd, spawnedCwd, storedCwd, expected }) => {
      const sessionEntry = {
        sessionId: "session-1",
        updatedAt: Date.now(),
        spawnedCwd,
        spawnedBy: spawnedCwd ? "agent:default:main" : undefined,
      };
      await runPrepared({
        cfg: {
          agents: { defaults: { cwd: defaultCwd }, entries: { default: { cwd: agentCwd } } },
        },
        workspaceDir: "/tmp/agent-workspace",
        sessionEntry,
        sessionStore:
          storedCwd !== undefined
            ? { "session-key": { ...sessionEntry, spawnedCwd: storedCwd ?? undefined } }
            : undefined,
      });
      expect(requireRunReplyAgentCall().followupRun.run).toMatchObject({
        cwd: expected,
        workspaceDir: "/tmp/agent-workspace",
      });
    },
  );
}
