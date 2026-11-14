import { expect, it, vi } from "vitest";
import type { createSessionsSpawnTool as SpawnToolFactory } from "./sessions-spawn-tool.js";

export function registerSessionsSpawnVisibleCleanupTests({
  createTool,
}: {
  createTool: typeof SpawnToolFactory;
}) {
  const key = "agent:main:dashboard:child";
  const receipt = {
    key,
    sessionId: "created-child",
    entry: { lifecycleRevision: "birth-revision" },
  };
  const gateway = (overrides: Record<string, unknown>) =>
    vi.fn().mockResolvedValueOnce({ ...receipt, ...overrides });
  const registerRun = () => {
    throw new Error("registry unavailable");
  };
  async function executeVisible(
    callGateway: NonNullable<Parameters<typeof createTool>[0]>["callGateway"],
    options: NonNullable<Parameters<typeof createTool>[0]> = {},
  ) {
    return (
      await createTool({
        agentSessionKey: "agent:main:main",
        config: { agents: { entries: { main: {} } } },
        countActiveRuns: () => 0,
        callGateway,
        ...options,
      }).execute("visible-failure", { task: "inspect", visible: true })
    ).details;
  }
  function expectError(details: unknown, error: string, extra: Record<string, unknown> = {}) {
    expect(details).toMatchObject({
      status: "error",
      error: expect.stringContaining(error),
      childSessionKey: key,
      ...extra,
    });
  }

  it.each(["not-started", "missing-run-id", "registration"] as const)(
    "cleans up the created visible session after %s failure",
    async (failure) => {
      const callGateway = gateway({
        runStarted: failure !== "not-started",
        ...(failure === "registration" ? { runId: "child-run" } : {}),
        runError: "startup failed",
      }).mockResolvedValueOnce({ deleted: true });
      const details = await executeVisible(callGateway, { registerRun });

      expectError(details, "Session removed.");
      if (failure === "registration") {
        expect(details).toMatchObject({ runId: "child-run" });
      }
      expect(callGateway).toHaveBeenNthCalledWith(2, "sessions.delete", {
        key,
        agentId: "main",
        expectedSessionId: "created-child",
        expectedLifecycleRevision: "birth-revision",
        deleteTranscript: true,
        emitLifecycleHooks: false,
      });
    },
  );

  it("reports the retained child and startup error when cleanup fails", async () => {
    const startError = "child chat.send rejected before input admission";
    const callGateway = gateway({
      runStarted: false,
      runError: { code: "UNAVAILABLE", message: startError },
    }).mockRejectedValueOnce(new Error("lifecycle drain unavailable"));
    const details = await executeVisible(callGateway);
    expectError(details, startError);
    expectError(details, "Session cleanup unconfirmed.");
    expect(callGateway).toHaveBeenCalledTimes(2);
  });

  it.each(["sessionId", "lifecycleRevision"] as const)(
    "keeps a failed visible child when its creation receipt omits %s",
    async (missing) => {
      const callGateway = vi.fn().mockResolvedValueOnce({
        key,
        ...(missing === "sessionId" ? {} : { sessionId: "created-child" }),
        entry: missing === "lifecycleRevision" ? {} : { lifecycleRevision: "birth-revision" },
        runStarted: false,
        runError: "startup failed",
      });
      const details = await executeVisible(callGateway);

      expectError(details, "Session cleanup unconfirmed.");
      expect(callGateway).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, "", " \t\n "])(
    "refuses a started visible run with missing or blank session identity %j",
    async (sessionId) => {
      const callGateway = gateway({
        sessionId,
        runStarted: true,
        runId: "child-run",
      });
      const register = vi.fn();
      const details = await executeVisible(callGateway, { registerRun: register });

      expectError(details, "sessions.create did not return its sessionId");
      expect(details).toMatchObject({
        runId: "child-run",
        error: expect.stringContaining("inspect this child session and run before retrying"),
      });
      expect(register).not.toHaveBeenCalled();
      expect(callGateway).toHaveBeenCalledTimes(1);
    },
  );
}
