import { afterEach, describe, expect, it, vi } from "vitest";
import { markExited } from "../../agents/bash-process-registry.js";
import { registerProcessSessionFixture } from "../../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../../agents/bash-process-registry.test-support.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const pids: number[] = [];

describe("isolated cron run session processes", () => {
  setupRunCronIsolatedAgentTurnSuite();
  afterEach(() => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already stopped.
      }
    }
    resetProcessRegistryForTests();
  });

  it.runIf(process.platform !== "win32")("an ended run session's service stops", async () => {
    mockRunCronFallbackPassthrough();
    let runSessionKey = "";
    runEmbeddedAgentMock.mockImplementationOnce(async (params: { sessionKey: string }) => {
      runSessionKey = params.sessionKey;
      // A real `background: true` service of the run session, owned by the supervisor.
      const run = await getProcessSupervisor().spawn({
        runId: "cron-run-service",
        mode: "child",
        argv: ["sleep", "60"],
        scopeKey: runSessionKey,
        executionIntent: "agent-tool",
        stdinMode: "pipe-closed",
      });
      pids.push(run.pid!);
      const session = registerProcessSessionFixture({
        id: run.runId,
        scopeKey: runSessionKey,
        backgrounded: true,
        independentService: true,
        pid: run.pid,
        processActivity: run.activity,
      });
      void run.wait().then((exit) => markExited(session, exit.exitCode, exit.exitSignal, "killed"));
      return { payloads: [{ text: "done" }], meta: { agentMeta: {} } };
    });

    await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(runSessionKey).toMatch(/:cron:.+:run:/u);
    await vi.waitFor(() => expect(isPidAlive(pids[0]!)).toBe(false), { timeout: 10_000 });
  });
});
