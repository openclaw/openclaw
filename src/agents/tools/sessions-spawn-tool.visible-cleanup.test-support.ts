import { expect, it, vi } from "vitest";
import type { createSessionsSpawnTool as SpawnToolFactory } from "./sessions-spawn-tool.js";

/** Visible child rollback tests share the parent suite's spawn entry point and lifecycle. */
export function registerSessionsSpawnVisibleCleanupTests({
  createTool,
}: {
  createTool: typeof SpawnToolFactory;
}) {
  it.each(["not-started", "missing-run-id", "registration"] as const)(
    "cleans up the created visible session after %s failure",
    async (failure) => {
      const callGateway = vi
        .fn()
        .mockResolvedValueOnce({
          key: "agent:main:dashboard:child",
          sessionId: "created-child",
          entry: { lifecycleRevision: "birth-revision" },
          runStarted: failure !== "not-started",
          ...(failure === "registration" ? { runId: "child-run" } : {}),
          runError: "startup failed",
        })
        .mockResolvedValueOnce({ deleted: true });
      const registerRun = vi.fn(() => {
        throw new Error("registry unavailable");
      });
      const tool = createTool({
        agentSessionKey: "agent:main:main",
        config: { agents: { entries: { main: {} } } },
        callGateway,
        registerRun,
        countActiveRuns: () => 0,
      });

      const result = await tool.execute("visible-failure", { task: "inspect", visible: true });

      expect(result.details).toMatchObject({
        status: "error",
        error: expect.stringContaining("Session removed."),
        childSessionKey: "agent:main:dashboard:child",
      });
      expect(callGateway).toHaveBeenCalledTimes(2);
      expect(callGateway).toHaveBeenNthCalledWith(2, "sessions.delete", {
        key: "agent:main:dashboard:child",
        expectedSessionId: "created-child",
        expectedLifecycleRevision: "birth-revision",
        deleteTranscript: true,
        emitLifecycleHooks: false,
      });
      expect(registerRun).toHaveBeenCalledTimes(failure === "registration" ? 1 : 0);
    },
  );

  it.each([
    {
      failure: "initial child start",
      runStarted: false,
      runId: undefined,
      runError: {
        code: "UNAVAILABLE",
        message: "child chat.send rejected before input admission",
      },
      registrationError: undefined,
      expectedError: "child chat.send rejected before input admission",
    },
    {
      failure: "run registration",
      runStarted: true,
      runId: "child-run",
      runError: undefined,
      registrationError: "registry unavailable",
      expectedError: "Session cleanup unconfirmed.",
    },
  ] as const)("reports the retained child when $failure and cleanup fail", async (scenario) => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({
        key: "agent:main:dashboard:child",
        sessionId: "created-child",
        entry: { lifecycleRevision: "birth-revision" },
        runStarted: scenario.runStarted,
        ...(scenario.runId ? { runId: scenario.runId } : {}),
        ...(scenario.runError ? { runError: scenario.runError } : {}),
      })
      .mockRejectedValueOnce(new Error("lifecycle drain unavailable"));
    const tool = createTool({
      agentSessionKey: "agent:main:main",
      config: { agents: { entries: { main: {} } } },
      callGateway,
      ...(scenario.registrationError
        ? {
            registerRun: () => {
              throw new Error(scenario.registrationError);
            },
          }
        : {}),
      countActiveRuns: () => 0,
    });

    const result = await tool.execute("visible-failure", { task: "inspect", visible: true });

    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining(scenario.expectedError),
      childSessionKey: "agent:main:dashboard:child",
      ...(scenario.runId ? { runId: scenario.runId } : {}),
    });
    expect(result.details).toMatchObject({
      error: expect.stringContaining("Session cleanup unconfirmed."),
    });
    expect(callGateway).toHaveBeenCalledTimes(2);
  });

  it.each(["sessionId", "lifecycleRevision"] as const)(
    "keeps a failed visible child when its creation receipt omits %s",
    async (missing) => {
      const callGateway = vi.fn().mockResolvedValueOnce({
        key: "agent:main:dashboard:child",
        ...(missing === "sessionId" ? {} : { sessionId: "created-child" }),
        entry: missing === "lifecycleRevision" ? {} : { lifecycleRevision: "birth-revision" },
        runStarted: false,
        runError: "startup failed",
      });
      const tool = createTool({
        agentSessionKey: "agent:main:main",
        config: { agents: { entries: { main: {} } } },
        callGateway,
        countActiveRuns: () => 0,
      });

      const result = await tool.execute("visible-missing-identity", {
        task: "inspect",
        visible: true,
      });

      expect(result.details).toMatchObject({
        status: "error",
        error: expect.stringContaining("Session cleanup unconfirmed."),
        childSessionKey: "agent:main:dashboard:child",
      });
      expect(callGateway).toHaveBeenCalledTimes(1);
    },
  );
}
