import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { getSession, listRunningSessions } from "../agents/bash-process-registry.js";
import { createExecTool } from "../agents/bash-tools.exec-run.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { withEnvAsync } from "../test-utils/env.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
  writeSingleLineSession,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const started: number[] = [];
afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const sleeper = `${quote(process.execPath)} -e 'setTimeout(() => {}, 60000)'`;

async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !check()) {
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return check();
}

it.skipIf(process.platform === "win32")(
  "sessions.reset stops the session's background services and the processes its commands left running",
  async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await writeSessionStore({ entries: { main: sessionStoreEntry("sess-main") } });
    const cwd = mkdtempSync(path.join(os.tmpdir(), "reset-exec-"));
    await withEnvAsync(
      {
        // Own each command's process tree, as a service-managed Gateway does.
        OPENCLAW_SERVICE_MARKER: "reset-exec-test",
        OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
        SHELL: "/bin/sh",
      },
      async () => {
        const exec = createExecTool({
          host: "gateway",
          mode: "full",
          ask: "off",
          allowBackground: true,
          notifyOnExit: false,
          scopeKey: "agent:main:main",
          cwd,
        });
        const service = await exec.execute("service", {
          command: `echo PID=$$; exec ${sleeper}`,
          background: true,
        });
        const { sessionId } = service.details as { sessionId: string };
        await waitFor(() => /PID=\d+/.test(getSession(sessionId)?.aggregated ?? ""));
        const servicePid = Number(/PID=(\d+)/.exec(getSession(sessionId)!.aggregated)![1]);
        const left = await exec.execute("left-running", {
          command: `${sleeper} >/dev/null 2>&1 & echo PID=$!`,
        });
        const leftPid = Number(
          /PID=(\d+)/.exec((left.details as { aggregated: string }).aggregated)![1],
        );
        started.push(servicePid, leftPid);
        expect(isPidAlive(servicePid)).toBe(true);
        expect(isPidAlive(leftPid)).toBe(true);
        // Both are tracked services of this session.
        expect(
          listRunningSessions()
            .filter((session) => session.scopeKey === "agent:main:main")
            .map((session) => session.pid),
        ).toEqual(expect.arrayContaining([leftPid]));

        const reset = await directSessionReq("sessions.reset", { key: "main" });
        expect(reset.ok).toBe(true);
        expect(await waitFor(() => !isPidAlive(servicePid) && !isPidAlive(leftPid))).toBe(true);
        expect(
          listRunningSessions().filter((session) => session.scopeKey === "agent:main:main"),
        ).toEqual([]);
      },
    );
  },
  60_000,
);
