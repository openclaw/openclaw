import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import {
  type FixtureReceiptChannel,
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();
const CANDIDATE_SHA = "1".repeat(40);
const TOOLING_SHA = "2".repeat(40);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

// Rescue knows only foreign PIDs after the scanner owner exits; no ChildProcess
// handle remains to join. Bound this last observation to the test, not a deadline.
async function waitForRescuedProcess(pid: number, signal: AbortSignal): Promise<void> {
  try {
    while (isProcessAlive(pid)) {
      await delay(5, undefined, { signal });
    }
  } catch (cause) {
    throw new Error(`process still alive: ${pid}`, { cause });
  }
}

describe.skipIf(process.platform === "win32")("plugin npm security runner RSS samples", () => {
  it.each([
    ["zero", "0", true],
    ["negative", "-1", false],
    ["nonnumeric", "invalid", false],
    ["fractional", "0.5", false],
    ["unsafe integer", "9007199254740992", false],
  ] as const)("handles a non-zombie %s RSS sample", (_label, rss, accepted) => {
    const root = tempDirs.make("openclaw-plugin-npm-security-rss-sample-");
    const childPath = join(root, "child.mjs");
    const pidPath = join(root, "child.pid");
    const samplePath = join(root, "sample.txt");
    const reportPath = join(root, "report.json");
    const binDir = join(root, "bin");
    const childReport = {
      candidateSha: CANDIDATE_SHA,
      errors: [],
      layout: null,
      packages: [],
      scanScope: "supplemental-inert-package-input",
      schemaVersion: 1,
      status: "pass",
      summary: {
        findingCount: 0,
        packageCount: 0,
        reviewedCriticalFindingCount: 0,
        unexpectedCriticalFindingCount: 0,
      },
      toolingSha: TOOLING_SHA,
    };
    // Keep the child alive until ps observes readiness and emits the controlled sample.
    writeFileSync(
      childPath,
      `import { renameSync, writeFileSync } from "node:fs";
const keepAlive = setInterval(() => {}, 1000);
process.once("SIGUSR2", () => clearInterval(keepAlive));
writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(JSON.stringify(childReport))});
writeFileSync(${JSON.stringify(`${pidPath}.ready`)}, String(process.pid));
renameSync(${JSON.stringify(`${pidPath}.ready`)}, ${JSON.stringify(pidPath)});
`,
    );
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, "ps"),
      `#!${testNodeExecPath}
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync, writeSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.join(" ") !== "-A -o pid=,pgid=,rss=,stat=" || !existsSync(${JSON.stringify(pidPath)})) {
  const result = spawnSync("/bin/ps", args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
const pid = Number(readFileSync(${JSON.stringify(pidPath)}, "utf8"));
const row = pid + " " + pid + " " + ${JSON.stringify(rss)} + " S\\n";
writeFileSync(${JSON.stringify(samplePath)}, row);
writeSync(1, row);
process.kill(pid, "SIGUSR2");
`,
      { mode: 0o755 },
    );

    const result = spawnSync(
      testNodeExecPath,
      [
        "scripts/plugin-npm-security-scan-runner.mjs",
        "--artifact-root",
        root,
        "--candidate-sha",
        CANDIDATE_SHA,
        "--tooling-sha",
        TOOLING_SHA,
        "--report",
        reportPath,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          OPENCLAW_PLUGIN_SECURITY_RUNNER_CHILD: childPath,
          OPENCLAW_PLUGIN_SECURITY_RUNNER_TIMEOUT_MS: "5000",
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
        },
        timeout: 10_000,
      },
    );

    const pid = Number(readFileSync(pidPath, "utf8"));
    expect(readFileSync(samplePath, "utf8")).toBe(`${pid} ${pid} ${rss} S\n`);
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toEqual({
      ...childReport,
      errors: accepted ? [] : ["Plugin npm security scanner could not measure RSS."],
      status: accepted ? "pass" : "fail",
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(accepted ? 0 : 1);
  });
});

describe("plugin npm security runner process limits", () => {
  it("writes sanitized exact-identity reports for timeout, heap, and RSS failures", () => {
    const root = tempDirs.make("openclaw-plugin-npm-security-runner-");
    const timeoutChild = join(root, "timeout.mjs");
    const oomChild = join(root, "oom.mjs");
    const rssChild = join(root, "rss.mjs");
    writeFileSync(timeoutChild, "setInterval(() => {}, 1_000);\n", "utf8");
    writeFileSync(
      oomChild,
      "const values = [];\nwhile (true) values.push(new Array(100000).fill(Math.random()));\n",
      "utf8",
    );
    writeFileSync(
      rssChild,
      "globalThis.value = Buffer.alloc(64 * 1024 * 1024, 1);\nsetInterval(() => {}, 1_000);\n",
      "utf8",
    );
    for (const [label, child, timeoutMs, heapMb, rssMb, expectedError] of [
      ["timeout", timeoutChild, "25", "128", "1024", "timed out"],
      ["oom", oomChild, "10000", "16", "1024", "exceeded its process limit"],
      ["rss", rssChild, "10000", "128", "16", "exceeded its RSS limit"],
    ] as const) {
      const reportPath = join(root, `${label}.json`);
      const result = spawnSync(
        testNodeExecPath,
        [
          "scripts/plugin-npm-security-scan-runner.mjs",
          "--artifact-root",
          join(root, "artifacts"),
          "--candidate-sha",
          CANDIDATE_SHA,
          "--expected-packages-json",
          "[]",
          "--tooling-sha",
          TOOLING_SHA,
          "--report",
          reportPath,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_ENV: "test",
            OPENCLAW_PLUGIN_SECURITY_RUNNER_CHILD: child,
            OPENCLAW_PLUGIN_SECURITY_RUNNER_HEAP_MB: heapMb,
            OPENCLAW_PLUGIN_SECURITY_RUNNER_RSS_MB: rssMb,
            OPENCLAW_PLUGIN_SECURITY_RUNNER_TIMEOUT_MS: timeoutMs,
          },
          timeout: 15_000,
        },
      );
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        candidateSha: string;
        errors: string[];
        toolingSha: string;
      };
      expect(result.status).toBe(1);
      expect(report).toMatchObject({
        candidateSha: CANDIDATE_SHA,
        toolingSha: TOOLING_SHA,
      });
      expect(report.errors).toContainEqual(expect.stringContaining(expectedError));
      expect(`${result.stdout}${result.stderr}${JSON.stringify(report)}`).not.toContain(root);
    }
  }, 30_000);

  it.skipIf(process.platform === "win32").for([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "joins scanner descendants and records cancellation on %s",
    async ([signal, exitCode], { signal: testSignal }) => {
      const root = tempDirs.make("openclaw-plugin-npm-security-cancel-");
      const childPath = join(root, "child.mjs");
      const childPidPath = join(root, "child.pid");
      const descendantPidPath = join(root, "descendant.pid");
      const reportPath = join(root, "report.json");
      writeFileSync(
        childPath,
        `${fixtureReceiptClientSource(receipts.endpoint)}
import fs from "node:fs";
import { spawn } from "node:child_process";
setInterval(() => {}, 1000);
fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));
sendReceipt(${JSON.stringify(childPidPath)}, "ready");
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
descendant.once("spawn", () => {
  fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
  sendReceipt(${JSON.stringify(descendantPidPath)}, "ready");
});
descendant.unref();
`,
        "utf8",
      );
      const wrapper = spawn(
        testNodeExecPath,
        [
          "scripts/plugin-npm-security-scan-runner.mjs",
          "--artifact-root",
          root,
          "--candidate-sha",
          CANDIDATE_SHA,
          "--tooling-sha",
          TOOLING_SHA,
          "--report",
          reportPath,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NODE_ENV: "test",
            OPENCLAW_PLUGIN_SECURITY_RUNNER_CHILD: childPath,
          },
          stdio: "ignore",
        },
      );
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          wrapper.once("error", reject);
          wrapper.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal }));
        },
      );
      const readyPid = async (file: string) => {
        // Receipts and wrapper exit travel on different pipes. The fixture writes
        // the PID before sending readiness, so settlement must consult that record.
        await withinTest(
          Promise.race([
            receipts.waitFor(file, "ready"),
            closed.then(() => {
              if (!existsSync(file)) {
                throw new Error(`timeout waiting for pid in ${file}`);
              }
            }),
          ]),
          testSignal,
        );
        return Number(readFileSync(file, "utf8"));
      };
      let childPid: number | undefined;
      let descendantPid: number | undefined;
      try {
        childPid = await readyPid(childPidPath);
        descendantPid = await readyPid(descendantPidPath);
        expect(isProcessAlive(childPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);
        wrapper.kill(signal);
        const result = await withinTest(closed, testSignal);
        expect(isProcessAlive(childPid)).toBe(false);
        expect(isProcessAlive(descendantPid)).toBe(false);
        expect(result).toEqual({ code: exitCode, signal: null });
        expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({
          candidateSha: CANDIDATE_SHA,
          toolingSha: TOOLING_SHA,
          status: "fail",
          errors: [`Plugin npm security scanner cancelled by ${signal}.`],
        });
      } finally {
        if (wrapper.exitCode === null && wrapper.signalCode === null) {
          wrapper.kill("SIGTERM");
        }
        await closed;
        childPid ??= existsSync(childPidPath)
          ? Number(readFileSync(childPidPath, "utf8"))
          : undefined;
        descendantPid ??= existsSync(descendantPidPath)
          ? Number(readFileSync(descendantPidPath, "utf8"))
          : undefined;
        if (childPid) {
          try {
            process.kill(-childPid, "SIGKILL");
          } catch (error) {
            expect(error).toMatchObject({ code: "ESRCH" });
          }
          await waitForRescuedProcess(childPid, testSignal);
        }
        if (descendantPid) {
          await waitForRescuedProcess(descendantPid, testSignal);
        }
      }
    },
  );

  it("fails closed when RSS measurement is unavailable", () => {
    const root = tempDirs.make("openclaw-plugin-npm-security-rss-measurement-");
    const child = join(root, "child.mjs");
    const binDir = join(root, "bin");
    const reportPath = join(root, "report.json");
    mkdirSync(binDir);
    writeFileSync(child, "setInterval(() => {}, 1_000);\n", "utf8");
    writeFileSync(join(binDir, "ps"), "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(join(binDir, "ps"), 0o755);

    const result = spawnSync(
      testNodeExecPath,
      [
        "scripts/plugin-npm-security-scan-runner.mjs",
        "--artifact-root",
        join(root, "artifacts"),
        "--candidate-sha",
        CANDIDATE_SHA,
        "--expected-packages-json",
        "[]",
        "--tooling-sha",
        TOOLING_SHA,
        "--report",
        reportPath,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          OPENCLAW_PLUGIN_SECURITY_RUNNER_CHILD: child,
          OPENCLAW_PLUGIN_SECURITY_RUNNER_TIMEOUT_MS: "5000",
          PATH: `${binDir}:${process.env.PATH}`,
        },
        timeout: 10_000,
      },
    );
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { errors: string[] };
    expect(result.status).toBe(1);
    expect(report.errors).toContain("Plugin npm security scanner could not measure RSS.");
  });
});
