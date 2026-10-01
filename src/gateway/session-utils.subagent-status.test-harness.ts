import { expect, test } from "vitest";
import { addSubagentRunForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { claimAgentRunContext } from "../infra/agent-run-registry.js";
import type { SessionsListResult } from "./session-utils.types.js";

export function registerSubagentSessionStatusTests(
  listSubagentSessions: (store: Record<string, SessionEntry>) => Promise<SessionsListResult>,
): void {
  test("includes subagent status timing and direct child session keys", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:parent": {
        sessionId: "sess-parent",
        updatedAt: now - 2_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:parent",
        spawnedWorkspaceDir: "/tmp/child-workspace",
        spawnedCwd: "/tmp/task-repo",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
      } as SessionEntry,
      "agent:main:subagent:failed": {
        sessionId: "sess-failed",
        updatedAt: now - 500,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:interrupted": {
        sessionId: "sess-interrupted",
        updatedAt: now - 400,
        spawnedBy: "agent:main:main",
        status: "interrupted",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-parent",
      childSessionKey: "agent:main:subagent:parent",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
      model: "openai/gpt-5.4",
    });
    claimAgentRunContext(
      "run-parent",
      { sessionKey: "agent:main:subagent:parent" },
      { trackOwner: true, ownsContext: true },
    );
    addSubagentRunForTests({
      runId: "run-child",
      childSessionKey: "agent:main:subagent:child",
      controllerSessionKey: "agent:main:subagent:parent",
      createdAt: now - 8_000,
      startedAt: now - 7_500,
      endedAt: now - 2_500,
      outcome: { status: "ok" },
      model: "openai/gpt-5.4",
    });
    addSubagentRunForTests({
      runId: "run-failed",
      childSessionKey: "agent:main:subagent:failed",
      controllerSessionKey: "agent:main:main",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 500,
      outcome: { status: "error", error: "boom" },
      model: "openai/gpt-5.4",
    });

    const result = await listSubagentSessions(store);

    const main = result.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toEqual([
      "agent:main:subagent:parent",
      "agent:main:subagent:failed",
      "agent:main:subagent:interrupted",
    ]);
    expect(main?.status).toBeUndefined();

    const parent = result.sessions.find((session) => session.key === "agent:main:subagent:parent");
    expect(parent?.status).toBe("running");
    expect(parent?.startedAt).toBe(now - 9_000);
    expect(parent?.endedAt).toBeUndefined();
    expect(parent?.runtimeMs).toBeGreaterThanOrEqual(9_000);
    expect(parent?.childSessions).toEqual(["agent:main:subagent:child"]);

    const child = result.sessions.find((session) => session.key === "agent:main:subagent:child");
    expect(child?.status).toBe("done");
    expect(child?.startedAt).toBe(now - 7_500);
    expect(child?.endedAt).toBe(now - 2_500);
    expect(child?.runtimeMs).toBe(5_000);
    expect(child?.spawnedWorkspaceDir).toBe("/tmp/child-workspace");
    expect(child?.spawnedCwd).toBe("/tmp/task-repo");
    expect(child?.forkedFromParent).toBe(true);
    expect(child?.spawnDepth).toBe(2);
    expect(child?.subagentRole).toBe("orchestrator");
    expect(child?.subagentControlScope).toBe("children");
    expect(child?.childSessions).toBeUndefined();

    const failed = result.sessions.find((session) => session.key === "agent:main:subagent:failed");
    expect(failed?.status).toBe("failed");
    expect(failed?.runtimeMs).toBe(5_000);

    const interrupted = result.sessions.find(
      (session) => session.key === "agent:main:subagent:interrupted",
    );
    expect(interrupted?.status).toBe("interrupted");
  });

  test.each([
    { lifecycleRunId: "restart-run", status: "failed" },
    { lifecycleRunId: "replacement-run", status: "interrupted" },
  ] as const)(
    "surfaces exhausted parent recovery only for its owning session run ($lifecycleRunId)",
    async ({ lifecycleRunId, status }) => {
      const now = Date.now();
      const childSessionKey = "agent:main:subagent:restart-delivery";
      addSubagentRunForTests({
        runId: "restart-run",
        childSessionKey,
        controllerSessionKey: "agent:main:main",
        createdAt: now - 2_000,
        execution: {
          status: "terminal",
          startedAt: now - 1_000,
          endedAt: now - 500,
          outcome: { status: "error" },
          interruptionReason: "gateway-restart",
        },
        delivery: { status: "failed" },
      });
      const result = await listSubagentSessions({
        [childSessionKey]: {
          sessionId: "restart-delivery-session",
          updatedAt: now,
          spawnedBy: "agent:main:main",
          status: "interrupted",
          lifecycleRunId,
        },
      });
      const row = result.sessions.find((session) => session.key === childSessionKey);
      expect(row?.status).toBe(status);
      expect(row?.lastRunError).toBe(
        status === "failed"
          ? "Restart recovery could not reach the parent. Inspect the child session before continuing."
          : undefined,
      );
    },
  );
}
