import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sleep } from "../utils/sleep.js";
import {
  disposeActiveTuiFixtures,
  startTuiFixture,
} from "./tui-pty-harness-fixture-test-support.js";

const STARTUP_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 4_000;
const tempDirs: string[] = [];

async function startAuth(exitMs?: number, exitCode = 0) {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-tui-auth-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, "codex-fixture.cjs");
  await writeFile(
    scriptPath,
    `console.log("AUTH_CHILD_STARTED:" + process.pid);\n${
      exitMs === undefined
        ? "setInterval(() => {}, 1000);"
        : `setTimeout(() => process.exit(${String(exitCode)}), ${String(exitMs)});`
    }`,
    "utf8",
  );
  const windows = process.platform === "win32";
  const launcherPath = path.join(dir, windows ? "codex.cmd" : "codex");
  await writeFile(
    launcherPath,
    windows
      ? `@"${process.execPath}" "${scriptPath}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
    "utf8",
  );
  if (!windows) {
    await chmod(launcherPath, 0o755);
  }
  const { run } = await startTuiFixture({
    env: { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  const wait = (text: string) => run.waitForOutput(text, STARTUP_TIMEOUT_MS);
  await wait("local ready");
  await run.write("/auth openai\r", { delay: false });
  return { run, wait };
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(10);
  }
  throw new Error(`auth child ${String(pid)} remained alive`);
}

describe("TUI auth child lifecycle", { concurrent: false }, () => {
  afterEach(async () => {
    await disposeActiveTuiFixtures();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it.skipIf(process.platform === "win32")(
    "terminates the foreground auth child when SIGTERM exits the TUI",
    async () => {
      const { run, wait } = await startAuth();
      await wait("AUTH_CHILD_STARTED:");
      const pidMatch = run.visibleOutput().match(/AUTH_CHILD_STARTED:(\d+)/u);
      expect(pidMatch).not.toBeNull();
      const authPid = Number(pidMatch?.[1]);
      process.kill(run.pid, "SIGTERM");
      await expect(run.waitForExit(EXIT_TIMEOUT_MS)).resolves.toBeDefined();
      await expect(waitForProcessExit(authPid, 750)).resolves.toBeUndefined();
    },
    STARTUP_TIMEOUT_MS + EXIT_TIMEOUT_MS,
  );

  it.each([0, 1])(
    "resumes the TUI after auth exit %i, preserving failure guidance",
    async (exitCode) => {
      const { run, wait } = await startAuth(50, exitCode);
      await wait(`auth flow ${exitCode ? "failed (exit 1)" : "finished for openai"}`);
      if (!exitCode) {
        await run.write("/gateway-status\r", { delay: false });
      }
      await wait(exitCode ? "in a regular terminal to see its output" : "fixture gateway ok");
    },
    STARTUP_TIMEOUT_MS * 2,
  );
});
