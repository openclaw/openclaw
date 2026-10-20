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
import { getProcessSupervisor } from "../../../../src/process/supervisor/index.js";
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

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
}

function nodeEvalCommand(source: string): string {
  const node = shellQuote(process.execPath);
  const script = shellQuote(source);
  return process.platform === "win32" ? `& ${node} -e ${script}` : `${node} -e ${script}`;
}

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

test("OpenClaw executes and controls the complete real process lifecycle", async ({
  signal,
  onTestFinished,
}) => {
  resetProcessRegistryForTests();
  const scopeKey = `agent:qa:exec-lifecycle-${process.pid}`;
  const execOptions = {
    host: "gateway",
    security: "full",
    ask: "off",
    notifyOnExit: false,
    scopeKey,
  } as const;
  const execTool = createExecTool({ ...execOptions, allowBackground: true, backgroundMs: 20 });
  const foregroundExecTool = createExecTool({ ...execOptions, allowBackground: false });
  const action = processActions(createProcessTool({ scopeKey }));
  const cleanupPids = new Set<number>();
  const track = (result: ToolResult) => {
    const session = requireSession(result);
    cleanupPids.add(session.pid);
    return session;
  };
  const finish = async (session: ReturnType<typeof track>, expected: object, forget = true) => {
    expect((await pollTerminal(action, session.sessionId)).details).toMatchObject(expected);
    expect((await action("clear", session.sessionId)).details).toMatchObject({
      status: "completed",
    });
    if (forget) {
      cleanupPids.delete(session.pid);
    }
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
    await expect(
      getProcessSupervisor().spawn({
        mode: "child",
        argv: ["/definitely/not/a/real-openclaw-command"],
        env: { OPENCLAW_CHILD_OOM_SCORE_ADJ: "0" },
        runId: `missing-command-${process.pid}`,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const foregroundCommand =
      process.platform === "win32"
        ? 'Write-Output -NoNewline shell-route; Write-Output -NoNewline "|$env:OPENCLAW_SHELL"'
        : 'printf shell-route && printf "|%s" "$OPENCLAW_SHELL"';
    const foreground = await foregroundExecTool.execute("foreground-shell", {
      command: foregroundCommand,
    });
    expect(foreground.details).toMatchObject({ status: "completed", exitCode: 0 });
    expect(textOf(foreground)).toContain("shell-route|exec");

    const background = await execTool.execute("explicit-background", {
      command: nodeEvalCommand(
        "console.log('background-start');setTimeout(() => console.log('background-end'), 350);",
      ),
      background: true,
    });
    const backgroundSession = track(background);

    const listed = await action("list");
    expect((listed.details as ProcessDetails).sessions).toContainEqual(
      expect.objectContaining({ sessionId: backgroundSession.sessionId, status: "running" }),
    );

    await expect
      .poll(async () => {
        const log = await action("log", backgroundSession.sessionId);
        return textOf(log);
      }, POLL_OPTIONS)
      .toContain("background-start");

    await finish(backgroundSession, {
      status: "completed",
      exitCode: 0,
      aggregated: expect.stringContaining("background-end"),
    });

    const yielded = await execTool.execute("yielded-background", {
      command: nodeEvalCommand("setTimeout(() => console.log('yielded-terminal'), 350);"),
      yieldMs: 20,
    });
    await finish(track(yielded), {
      status: "completed",
      exitCode: 0,
      aggregated: expect.stringContaining("yielded-terminal"),
    });

    const timedOut = await foregroundExecTool.execute("foreground-timeout", {
      command: nodeEvalCommand("setTimeout(() => {}, 5000);"),
      timeoutSeconds: 0.05,
    });
    expect(timedOut.details).toMatchObject({
      status: "failed",
      exitReason: "overall-timeout",
      timedOut: true,
    });
    expect(textOf(timedOut)).toContain("Command timed out after 0.05 seconds.");

    const pty = await foregroundExecTool.execute("foreground-pty", {
      command: nodeEvalCommand(
        'process.stdout.write("pty-route:" + Boolean(process.stdout.isTTY) + ":" + (process.env.OPENCLAW_SHELL || ""));',
      ),
      pty: true,
    });
    expect(pty.details).toMatchObject({ status: "completed", exitCode: 0 });
    expect(textOf(pty)).toContain("pty-route:true:exec");

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
      const childCommand = nodeEvalCommand("setInterval(() => {}, 1000);");
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
    await finish(killedSession, { status: "completed", exitReason: "manual-cancel" }, false);
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
