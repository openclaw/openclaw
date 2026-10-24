import { ChildProcess } from "node:child_process";
import { constants } from "node:os";
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
import { withinTest } from "../../../helpers/promise.js";

type ExecTool = ReturnType<typeof createExecTool>;
type ProcessTool = ReturnType<typeof createProcessTool>;
type ToolResult = Awaited<ReturnType<ExecTool["execute"]>>;
type ProcessAction = ReturnType<typeof processActions>;
type ProcessDetails = {
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

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Process removal does not expose an extinction join, and its owner may remove child listeners.
async function waitForExitedPids(pids: readonly number[], signal?: AbortSignal): Promise<void> {
  const check = async () => {
    while (pids.some(pidExists)) {
      await delay(25, undefined, { signal });
    }
  };
  await (signal ? withinTest(check(), signal) : check()).catch((cause: unknown) => {
    throw new Error("tracked process PIDs did not exit before test cancellation", { cause });
  });
}

function injectKillPermissionError(child: ChildProcess): void {
  if (process.versions.bun) {
    // Bun keeps its native handle private; inject the public, nonterminal error event.
    expect(
      child.emit(
        "error",
        Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" }),
      ),
    ).toBe(true);
    return;
  }
  const handle = (child as ChildProcess & { _handle: { kill: (signal: number) => number } })
    // oxlint-disable-next-line eslint/no-underscore-dangle -- Native kill errno exercises Node's real error path without ending the child.
    ._handle;
  const originalKill = handle.kill;
  try {
    handle.kill = () => -constants.errno.EPERM;
    expect(child.kill("SIGTERM")).toBe(false);
  } finally {
    handle.kill = originalKill;
  }
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

test("real child kill errors stay nonterminal until cancellation disposes its listeners", async ({
  signal,
  onTestFinished,
}) => {
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
      for (const session of listRunningSessions().filter((entry) => entry.scopeKey === scopeKey)) {
        await action("remove", session.id);
      }
      for (const pid of cleanupPids) {
        if (pidExists(pid)) {
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
    const spawnedChildren = new Map<number, ChildProcess>();
    // oxlint-disable-next-line typescript/unbound-method -- Forward with each child's receiver via originalEmit.call(this, ...).
    const originalEmit = ChildProcess.prototype.emit;
    const captureSpawn = vi.spyOn(ChildProcess.prototype, "emit").mockImplementation(function (
      this: ChildProcess,
      event,
      ...args
    ) {
      if (event === "spawn" && this.pid !== undefined) {
        spawnedChildren.set(this.pid, this);
      }
      return originalEmit.call(this, event, ...args);
    });
    let killTarget: ToolResult;
    try {
      const childCommand = nodeCommand("setInterval(() => {}, 1000);");
      killTarget = await execTool.execute("kill-background", {
        command: process.platform === "win32" ? childCommand : `exec ${childCommand}`,
        background: true,
      });
    } finally {
      captureSpawn.mockRestore();
    }
    const killedSession = track(killTarget);
    const child = spawnedChildren.get(killedSession.pid);
    if (!child) {
      throw new Error(`missing spawned child ${killedSession.pid}`);
    }
    expect(child.listenerCount("error")).toBeGreaterThan(0);
    const observedErrors: Array<NodeJS.ErrnoException> = [];
    child.on("error", (error) => {
      observedErrors.push(error);
    });
    const errorListenerCount = child.listenerCount("error");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      injectKillPermissionError(child);
      expect(child.listenerCount("error")).toBe(errorListenerCount);
      expect(observedErrors[attempt]).toMatchObject({ code: "EPERM", syscall: "kill" });
      await Promise.resolve();
      expect(listRunningSessions()).toContainEqual(
        expect.objectContaining({ id: killedSession.sessionId, exited: false }),
      );
      expect(getActiveBackgroundExecSessionCount()).toBe(1);
      expect(pidExists(killedSession.pid)).toBe(true);
    }

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
    expect(pidExists(killedSession.pid)).toBe(false);
    for (const event of ["error", "exit", "close"]) {
      expect(child.listenerCount(event)).toBe(0);
    }
    cleanupPids.delete(killedSession.pid);
    const finalList = await action("list");
    expect((finalList.details as ProcessDetails).sessions).toEqual([]);
    expect(listRunningSessions().filter((session) => session.scopeKey === scopeKey)).toEqual([]);
    expect(getActiveBackgroundExecSessionCount()).toBe(0);
  } finally {
    await cleanup();
  }
}, 30_000);
