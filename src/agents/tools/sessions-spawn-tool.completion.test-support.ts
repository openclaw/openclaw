import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { mergeAcceptedSessionSpawnsForRun } from "../accepted-session-spawn.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { expectRegisteredSubagentRun } from "../subagents/spawn/subagent-spawn.test-helpers.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import type { createSessionsSpawnTool as SpawnToolFactory } from "./sessions-spawn-tool.js";

export function registerSessionsSpawnCompletionTests(setup: {
  createTool: typeof SpawnToolFactory;
  registerAcpBackendForTest: () => void;
  mocks: { spawnSubagentDirectMock: Mock; spawnAcpDirectMock: Mock };
  mockCallArg: (...args: [unknown, number, number, string]) => Record<string, unknown>;
}) {
  function expectCompletion(mock: Mock, label: string) {
    const params = setup.mockCallArg(mock, 0, 0, label);
    expect([params.expectsCompletionMessage, params.completionTarget]).toEqual([false, undefined]);
  }

  it("declares completion policy and forwards quiet to hidden, ACP, and visible spawns", async () => {
    const input = { expectsCompletionMessage: false };
    setup.registerAcpBackendForTest();
    await withTestDir({ prefix: "openclaw-spawn-completion-" }, async (dir) => {
      const callGateway = vi.fn(async () => ({
        key: "agent:main:dashboard:child",
        sessionId: "visible-child",
        runStarted: true,
        runId: "run-visible",
      }));
      const registerRun = vi.fn();
      const tool = setup.createTool({
        agentSessionKey: "agent:main:main",
        config: { session: { store: path.join(dir, "sessions.json") } },
        callGateway: callGateway as never,
        registerRun,
        countActiveRuns: () => 0,
      });
      expect(tool.parameters).toHaveProperty("properties.expectsCompletionMessage.type", "boolean");

      await tool.execute("hidden", { task: "hidden child", ...input });
      expectCompletion(setup.mocks.spawnSubagentDirectMock, "spawnSubagentDirect");

      await tool.execute("acp", { task: "ACP child", runtime: "acp", ...input });
      expectCompletion(setup.mocks.spawnAcpDirectMock, "spawnAcpDirect");

      const visible = await tool.execute("visible", {
        task: "visible child",
        visible: true,
        ...input,
      });
      expect(visible.details).toMatchObject(input);
      expectRegisteredSubagentRun(registerRun, input);
      expect(setup.mockCallArg(registerRun, 0, 0, "registerRun").completionTarget).toBeUndefined();
    });
  });

  it("retains committed child acceptance when the caller loses its result", async () => {
    const child = {
      childSessionKey: "agent:main:subagent:child",
      runId: "child-run",
      expectsCompletionMessage: true,
    };
    setup.mocks.spawnSubagentDirectMock.mockResolvedValueOnce({
      status: "accepted",
      context: "isolated",
      ...child,
    });
    const instance = createOperationalRunInstanceRef("spawn-parent");
    await expect(
      withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "agent:main:main", operationalRunInstance: instance },
        async () => {
          const tool = setup.createTool({ agentSessionKey: "agent:main:main" });
          await tool.execute("spawn-before-failure", { task: "finish the work" });
          throw new Error("provider transport failed after acceptance");
        },
      ),
    ).rejects.toThrow("provider transport failed");
    expect(mergeAcceptedSessionSpawnsForRun(instance)).toEqual([child]);
    expect(
      mergeAcceptedSessionSpawnsForRun(createOperationalRunInstanceRef("spawn-parent")),
    ).toEqual([]);
  });
}
