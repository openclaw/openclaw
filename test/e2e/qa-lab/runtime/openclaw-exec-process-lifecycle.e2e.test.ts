import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import {
  getActiveBackgroundExecSessionCount,
  listRunningSessions,
} from "../../../../src/agents/bash-process-registry.js";
import { resetProcessRegistryForTests } from "../../../../src/agents/bash-process-registry.test-support.js";
import { createExecTool, createProcessTool } from "../../../../src/agents/bash-tools.js";
import {
  fullGatewayExec,
  nodeCommand,
} from "../../../../src/agents/bash-tools.lifecycle.test-support.js";
import * as childMemory from "../../../../src/process/child-memory.js";
import { withinTest } from "../../../helpers/promise.js";
import { isProcessPresent } from "../../../scripts/run-process.test-support.js";

type ExecTool = ReturnType<typeof createExecTool>;
type ProcessTool = ReturnType<typeof createProcessTool>;
type ToolResult = Awaited<ReturnType<ExecTool["execute"]>>;
type ProcessAction = ReturnType<typeof processActions>;
type ProcessDetails = {
  output?: string;
  pid?: number;
  sessionId?: string;
  sessions?: Array<{ sessionId: string; status: string }>;
  status?: string;
};

const POLL_OPTIONS = { timeout: 10_000, interval: 25 };

function processActions(tool: ProcessTool) {
  return (action: string, sessionId?: string) =>
    tool.execute(`${action}-${sessionId ?? "all"}`, {
      action,
      sessionId,
      ...(action === "poll" ? { timeout: 250 } : {}),
    });
}
let cleanupProcesses: (() => Promise<void>) | undefined;

afterEach(async () => {
  // Shared runtime hooks run before onTestFinished; join physical cleanup first.
  await cleanupProcesses?.();
  cleanupProcesses = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function requireSession(result: ToolResult): { pid: number; sessionId: string } {
  const details = result.details as ProcessDetails;
  expect(details).toMatchObject({
    status: "running",
    sessionId: expect.any(String),
    pid: expect.any(Number),
  });
  return { pid: details.pid as number, sessionId: details.sessionId as string };
}

// Process removal does not expose an extinction join, and its owner may remove child listeners.
async function waitForExitedPids(pids: readonly number[], signal?: AbortSignal): Promise<void> {
  const check = async () => {
    while (pids.some(isProcessPresent)) {
      await delay(25, undefined, { signal });
    }
  };
  await (signal ? withinTest(check(), signal) : check()).catch((cause: unknown) => {
    throw new Error("tracked process PIDs did not exit before test cancellation", { cause });
  });
}

async function pollTerminal(action: ProcessAction, sessionId: string) {
  let terminal: Awaited<ReturnType<ProcessTool["execute"]>> | undefined;
  await expect
    .poll(async () => {
      terminal = await action("poll", sessionId);
      return (terminal.details as ProcessDetails).status;
    }, POLL_OPTIONS)
    .not.toBe("running");
  if (!terminal) {
    throw new Error(`process ${sessionId} never produced a terminal result`);
  }
  return terminal;
}

test.for([
  { topology: "plain", memoryLimitBytes: undefined },
  { topology: "memory-bounded", memoryLimitBytes: 512 * 1024 * 1024 },
])(
  "$topology exec reports the command PID and joins cancellation",
  { timeout: 30_000 },
  async ({ memoryLimitBytes }, { signal, onTestFinished }) => {
    vi.stubEnv("OPENCLAW_SERVICE_MARKER", "");
    vi.spyOn(childMemory, "resolveHostExecMemoryLimit").mockReturnValue(memoryLimitBytes);
    resetProcessRegistryForTests();
    const scopeKey = `agent:qa:exec-lifecycle-${process.pid}`;
    const execTool = createExecTool({
      ...fullGatewayExec,
      notifyOnExit: false,
      scopeKey,
      allowBackground: true,
      backgroundMs: 20,
    });
    const action = processActions(createProcessTool({ scopeKey }));
    const cleanupPids = new Set<number>();
    const track = (result: ToolResult) => {
      const session = requireSession(result);
      cleanupPids.add(session.pid);
      return session;
    };
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        for (const session of listRunningSessions().filter(
          (entry) => entry.scopeKey === scopeKey,
        )) {
          await action("remove", session.id);
        }
        for (const pid of cleanupPids) {
          if (isProcessPresent(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
        // Body cancellation must not cancel the physical-extinction join or let
        // registry reset forget children whose SIGKILL has not settled yet.
        await waitForExitedPids([...cleanupPids]);
        resetProcessRegistryForTests();
      })());
    cleanupProcesses = cleanup;
    onTestFinished(cleanup);

    try {
      const childCommand = nodeCommand("console.log(process.pid); setInterval(() => {}, 1000);");
      const killedSession = track(
        await execTool.execute("kill-background", {
          // PowerShell remains the command process; POSIX exec replaces the shell.
          command:
            process.platform === "win32"
              ? `Write-Output $PID; ${childCommand}`
              : `exec ${childCommand}`,
          background: true,
        }),
      );
      // The command can belong to an anchor in another process; its output and
      // the exec owner's reported PID establish identity without a local spawn spy.
      await expect
        .poll(async () => {
          const output = await action("log", killedSession.sessionId);
          return (output.details as ProcessDetails).output?.split("\n")[0];
        }, POLL_OPTIONS)
        .toBe(String(killedSession.pid));
      expect(listRunningSessions()).toContainEqual(
        expect.objectContaining({ id: killedSession.sessionId, exited: false }),
      );
      expect(getActiveBackgroundExecSessionCount()).toBe(1);
      expect(isProcessPresent(killedSession.pid)).toBe(true);

      const killed = await action("kill", killedSession.sessionId);
      expect(killed.details).toMatchObject({ status: "completed" });
      expect((await pollTerminal(action, killedSession.sessionId)).details).toMatchObject({
        status: "completed",
        exitReason: "manual-cancel",
      });
      expect((await action("clear", killedSession.sessionId)).details).toMatchObject({
        status: "completed",
      });
      await waitForExitedPids([killedSession.pid], signal);
      expect(isProcessPresent(killedSession.pid)).toBe(false);
      cleanupPids.delete(killedSession.pid);
      const finalList = await action("list");
      expect((finalList.details as ProcessDetails).sessions).toEqual([]);
      expect(listRunningSessions().filter((session) => session.scopeKey === scopeKey)).toEqual([]);
      expect(getActiveBackgroundExecSessionCount()).toBe(0);
    } finally {
      await cleanup();
    }
  },
);
