import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { expect, it, onTestFinished, vi, type TestContext } from "vitest";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { shouldEnableNodeDiagnosticReports } from "../../scripts/lib/node-diagnostic-report.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { waitForPidFile } from "../../test/helpers/process-wait.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  formatCliProcessFailure,
  runCliProcessChild,
  waitForCliProcessStderrMarker,
} from "./cli-process-child.test-helpers.js";

type ReportCleanup = Parameters<TestContext["onTestFinished"]>[0];
function reportHooks(context: TestContext) {
  const callbacks: ReportCleanup[] = [];
  return {
    onTestFinished: (callback: ReportCleanup) => {
      callbacks.push(callback);
      context.onTestFinished(callback);
    },
    async clean() {
      for (const callback of callbacks) {
        await callback(context);
      }
    },
  };
}

const DETACHED_GRANDCHILD_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  "const descendant = `",
  "const fs = require('node:fs');",
  "const receipt = process.argv[1];",
  "process.stdout.on('error', () => {}); process.stderr.on('error', () => {});",
  "const stop = setInterval(() => { if (fs.existsSync(receipt + '.stop')) process.exit(0); }, 10);",
  "fs.writeFileSync(receipt, String(process.pid));",
  "if (process.argv[2] === 'finite') {",
  "  const ready = setInterval(() => {",
  "    if (fs.existsSync(receipt + '.release')) { clearInterval(ready); clearInterval(stop); process.stdout.write('finite-output'); }",
  "  }, 10);",
  "} else {",
  "  setTimeout(() => { process.stdout.write('after-guard'); fs.writeFileSync(receipt + '.wrote', 'yes'); }, 800);",
  "  setInterval(() => {}, 1_000);",
  "}`;",
  "spawn(process.execPath, ['-e', descendant, process.argv[2], process.argv[1]],",
  "  { detached: true, stdio: ['ignore', 1, 2] }).unref();",
  "process.stdout.write('launcher');",
  "if (process.argv[1] === 'launcher-alive') setInterval(() => {}, 1_000);",
].join("\n");

function runScript({
  script,
  args = [],
  ...options
}: Omit<Parameters<typeof runCliProcessChild>[0], "nodeArgs" | "env"> & {
  script: string | string[];
  args?: string[];
}) {
  return runCliProcessChild({
    env: process.env,
    nodeArgs: ["-e", Array.isArray(script) ? script.join("\n") : script, ...args],
    ...options,
  });
}

const captureFailure = (error: unknown) => error;
const closedPipes = { stdin: { closed: true }, stdout: { closed: true }, stderr: { closed: true } };

it("keeps the end of streams longer than the output tail cap", () => {
  const message = formatCliProcessFailure({
    reason: "wrong exit code",
    stderr: "",
    stdout: `${"x".repeat(8_005)}END`,
  });

  expect(message).toContain("[... truncated 8 chars ...]");
  expect(message).toMatch(/xEND$/u);
});
it("names the live handle and keeps partial output when a child never exits", async (context) => {
  let child: ChildProcessWithoutNullStreams | undefined;
  const reports = reportHooks(context);
  const childRun = runScript({
    script: [
      "process.stdout.write('partial');",
      "globalThis.pending = new Promise(() => {});",
      "require('node:net').createServer().listen(0, '127.0.0.1');",
      "process.on('SIGQUIT', () => process.stderr.write('x'.repeat(8_100) + '\\nlast-stderr-line\\n'));",
      "setInterval(() => {}, 1_000);",
    ],
    timeoutMs: 500,
    onTestFinished: reports.onTestFinished,
    interact: (runningChild) => {
      child = runningChild;
      onTestFinished(() => stopChildProcess(runningChild, 1_000));
      runningChild.stdin.end();
    },
  });
  const reportCleanup = reports.clean();
  const failure = await childRun.catch(captureFailure);
  await reportCleanup;

  expect(child).toMatchObject({ ...closedPipes, signalCode: "SIGKILL" });
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toMatch(/500ms deadlock guard[\s\S]*partial/u);
  if (shouldEnableNodeDiagnosticReports()) {
    expect(String(failure)).toContain('"Timeout":1');
    expect(String(failure)).toContain('"activeHandles"');
    expect(String(failure)).toMatch(/"pendingPromises":\{"tracked":[1-9]/u);
    expect(String(failure)).toContain("last-stderr-line");
    const report = String(failure)
      .split("--- Node diagnostic report ---\n")[1]
      ?.split("\n--- child diagnostics ---")[0];
    expect(report).toBeDefined();
    expect(JSON.parse(report!)).toMatchObject({
      javascriptStack: expect.any(Object),
      nativeStack: expect.any(Array),
      libuv: expect.arrayContaining([
        expect.objectContaining({ type: "timer", is_active: true, is_referenced: true }),
        expect.objectContaining({ type: "tcp", is_active: true, is_referenced: true }),
      ]),
    });
    expect(report).not.toMatch(/"(?:local|remote)Endpoint"\s*:/u);
  }
});

it.skipIf(!shouldEnableNodeDiagnosticReports())(
  "keeps a timeout failure when the child exits during diagnostic grace",
  async () => {
    await expect(
      runScript({
        script: "process.on('SIGQUIT', () => process.exit(0)); setInterval(() => {}, 1_000);",
        timeoutMs: 500,
      }),
    ).rejects.toThrow(
      /500ms deadlock guard[\s\S]*Child diagnostics: SIGQUIT requested;[^\n]*; received\./u,
    );
  },
);

it.skipIf(process.platform === "win32").each([
  { label: "busy", block: "while (true) {}", state: "R" },
  { label: "stopped", block: "process.kill(process.pid, 'SIGSTOP')", state: "T" },
])(
  "captures OS state when the child is $label and cannot answer signals",
  async ({ block, state }) => {
    let pid: number | undefined;
    const failure = await runScript({
      script: `process.title = 'fixture-private-thread'; process.stdout.write('blocked'); ${block}`,
      timeoutMs: 500,
      interact: (child) => {
        pid = child.pid;
        child.stdin.end();
      },
    }).catch(captureFailure);
    expect(String(failure)).toMatch(/500ms deadlock guard[\s\S]*no response[\s\S]*blocked/u);
    expect(String(failure)).toContain(`root pid=${pid}`);
    expect(String(failure)).not.toContain("fixture-private");
    expect(String(failure)).toMatch(new RegExp(`"pid":${pid},"ppid":\\d+,"state":"${state}`));
    if (process.platform === "linux") {
      expect(String(failure)).toContain(`"tid":${pid}`);
      expect(String(failure)).toContain(`"tid":${pid},"role":"main"`);
      expect(String(failure)).toContain('"stack":');
      expect(String(failure)).toContain('"wchan":');
    }
  },
);

it.for([false, true])(
  "preserves input failure, joins pipes, and retains unjoined reports (kill fails=%s)",
  async (killFails, context) => {
    const inputFailure = new Error("CLI interaction failed");
    const fixture = createFixtureLifetime();
    const root = fixture.createTempDir("cli-report-owner-");
    const owner = createVitestResourceOwner(root);
    const reports = reportHooks(context);
    let child: ChildProcessWithoutNullStreams | undefined;
    let reportDir: string | undefined;
    let restoreKill: (() => void) | undefined;
    try {
      const failure = await withEnvAsync({ TMPDIR: root, TMP: root, TEMP: root }, () =>
        runScript({
          onTestFinished: reports.onTestFinished,
          script:
            "const directory = process.report?.reportOnSignal ? process.report.directory : undefined; if (directory) process.report.writeReport(); process.stdout.write(JSON.stringify({ directory })); setInterval(() => {}, 1_000);",
          interact: async (runningChild) => {
            child = runningChild;
            const [chunk] = await once(runningChild.stdout, "data");
            reportDir = JSON.parse(String(chunk)).directory;
            if (killFails) {
              const kill = runningChild.kill.bind(runningChild);
              restoreKill = () => {
                runningChild.kill = kill;
              };
              runningChild.kill = () => {
                throw new Error("cleanup kill failed");
              };
            }
            throw inputFailure;
          },
        }).catch(captureFailure),
      );
      expect(String(failure)).toContain("CLI interaction failed");
      expect(child).toMatchObject({ ...closedPipes, killed: !killFails });
      if (reportDir) {
        expect(fs.existsSync(path.join(reportDir, "diagnostic.json"))).toBe(true);
      }
      await reports.clean();
      if (reportDir) {
        expect(fs.existsSync(reportDir)).toBe(killFails);
      }
      if (killFails) {
        expect(failure).toMatchObject({ cause: inputFailure });
        expect(String(failure)).toContain("Cleanup failures: Error: cleanup kill failed");
        expect(child).toMatchObject({ exitCode: null, signalCode: null });
        if (reportDir) {
          expect(fs.existsSync(path.join(reportDir, "diagnostic.json"))).toBe(true);
          expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
        }
      } else {
        expect(failure).toBe(inputFailure);
        expect(child?.signalCode).toBe("SIGKILL");
        expect(() => owner.assertReleased()).not.toThrow();
      }
    } finally {
      restoreKill?.();
      if (child) {
        await stopChildProcess(child, 1_000);
      }
      await fixture.cleanup();
    }
  },
);

it("preserves a launch failure and closes its pipes without a live child", async () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  const failure = await runCliProcessChild({
    nodeExecutable: "/openclaw-test-missing-executable",
    nodeArgs: [],
    env: process.env,
    interact: (runningChild) => {
      child = runningChild;
      runningChild.stdin.end();
    },
  }).catch(captureFailure);

  expect(failure).toMatchObject({ code: "ENOENT" });
  expect(child).toMatchObject({ ...closedPipes, pid: undefined });
});

it.for(["launcher-alive", "launcher-exited", "finite", "identity-unavailable"])(
  "requires inherited output EOF before releasing a detached handoff (%s)",
  async (shape, context) => {
    const { signal } = context;
    const launcherShape = shape === "identity-unavailable" ? "launcher-alive" : shape;
    const fixture = createFixtureLifetime();
    const root = fixture.createTempDir("cli-inherited-output-");
    const owner = createVitestResourceOwner(root);
    const receipt = path.join(root, "descendant.pid");
    const reports = reportHooks(context);
    const chunks: string[] = [];
    let child: ChildProcessWithoutNullStreams | undefined;
    let descendantPid: number | undefined;
    let descendantStart: number | null = null;
    let identityReady: Promise<void> | undefined;
    const identityFailure = new Error("Descendant start identity unavailable");
    const identityProbe =
      shape === "identity-unavailable"
        ? vi
            .spyOn(await import("../shared/pid-alive.js"), "getFileLockProcessStartTime")
            .mockReturnValueOnce(null)
        : undefined;
    try {
      const result = await withEnvAsync({ TMPDIR: root, TMP: root, TEMP: root }, () =>
        runScript({
          onTestFinished: reports.onTestFinished,
          script: DETACHED_GRANDCHILD_SCRIPT,
          args: [launcherShape, receipt],
          onStdout: (stdout) => chunks.push(stdout),
          timeoutMs: shape === "finite" ? 2_000 : 400,
          interact: (runningChild) => {
            child = runningChild;
            runningChild.stdin.end();
            identityReady = (async () => {
              descendantPid = await waitForPidFile(receipt, signal);
              descendantStart = getFileLockProcessStartTime(descendantPid);
              if (descendantStart === null) {
                throw identityFailure;
              }
              if (shape === "finite") {
                fs.writeFileSync(`${receipt}.release`, "release");
              }
            })();
            return identityReady;
          },
        }).catch(captureFailure),
      );
      if (shape === "finite") {
        expect(result).toMatchObject({
          code: 0,
          signal: null,
          stdout: expect.stringContaining("finite-output"),
        });
      } else {
        if (shape === "identity-unavailable") {
          expect(result).toMatchObject({ cause: identityFailure });
        } else {
          expect(String(result)).toContain("400ms deadlock guard");
        }
        expect(hasUnjoinedWork(result)).toBe(true);
        expect(isPidAlive(descendantPid!)).toBe(true);
        if (descendantStart !== null) {
          expect(getFileLockProcessStartTime(descendantPid!)).toBe(descendantStart);
        }
        expect(fs.readFileSync(`${receipt}.wrote`, "utf8")).toBe("yes");
        expect(chunks.join("")).not.toContain("after-guard");
        expect(child).toMatchObject({
          exitCode: launcherShape === "launcher-exited" ? 0 : null,
          signalCode: launcherShape === "launcher-alive" ? "SIGKILL" : null,
        });
      }
      await reports.clean();
      if (shape === "finite" || !shouldEnableNodeDiagnosticReports()) {
        expect(() => owner.assertReleased()).not.toThrow();
      } else {
        expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      }
    } finally {
      identityProbe?.mockRestore();
      await fixture.verifyCleanup(async () => {
        try {
          // The private control path can stop this fixture even if PID identity discovery failed.
          fs.writeFileSync(`${receipt}.stop`, "stop");
          await Promise.allSettled([identityReady]);
          if (descendantPid === undefined) {
            throw new Error("Cannot verify descendant termination without its PID receipt");
          }
          const pid = descendantPid;
          await expect
            .poll(() => {
              const started = getFileLockProcessStartTime(pid);
              return (
                !isPidAlive(pid) ||
                (descendantStart !== null && started !== null && started !== descendantStart)
              );
            })
            .toBe(true);
        } finally {
          if (child) {
            await stopChildProcess(child, 1_000);
          }
        }
      });
      await reports.clean();
      await fixture.cleanup();
    }
  },
);
it("reports missing markers and captured stderr when the child exits", async () => {
  await expect(
    runScript({
      script: "process.stderr.write('failed before ready'); process.exitCode = 1;",
      timeoutMs: 2_000,
      interact: async (child) => {
        child.stdin.end();
        await waitForCliProcessStderrMarker(child, "phase entered");
      },
    }),
  ).rejects.toThrow(/stderr ended before marker "phase entered"[\s\S]*failed before ready/u);
});

it("matches split markers, removes its listeners, and retains trailing stderr", async () => {
  const result = await runScript({
    script: [
      "process.stderr.write('phase ');",
      "process.stdin.once('data', () => {",
      "  process.stderr.write('entered');",
      "  process.stdin.once('end', () => process.stderr.write(' after marker'));",
      "});",
    ],
    interact: async (child) => {
      const events = ["data", "end", "close", "error"] as const;
      const listeners = events.map((event) => child.stderr.listeners(event));
      const childErrorListeners = child.listeners("error");
      const marker = waitForCliProcessStderrMarker(child, "phase entered");
      await once(child.stderr, "data");
      child.stdin.write("continue\n");
      await marker;
      for (const [index, event] of events.entries()) {
        expect(child.stderr.listeners(event)).toEqual(listeners[index]);
      }
      expect(child.listeners("error")).toEqual(childErrorListeners);
      expect(child.stderr.destroyed).toBe(false);
      child.stdin.end();
    },
  });

  expect(result).toEqual({
    code: 0,
    signal: null,
    stdout: "",
    stderr: "phase entered after marker",
  });
});
