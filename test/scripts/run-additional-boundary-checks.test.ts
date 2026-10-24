import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BOUNDARY_CHECKS,
  parseCliArgs,
  parseShardSelection,
  parseShardSpec,
  resolveConcurrency,
  runChecks,
  runSingleCheck,
  selectChecksForShard,
} from "../../scripts/run-additional-boundary-checks.mts";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { startProcessWatchdogFixture } from "../helpers/process-watchdog.js";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import {
  fixtureReadyBeforeSettlement,
  isProcessPresent as isProcessAlive,
  waitForProcessObservation,
} from "./run-process.test-support.js";

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

function runCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/run-additional-boundary-checks.mts", ...args],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
    },
  );
}

function nodeCheck(label: string, script: string) {
  return { label, command: process.execPath, args: ["-e", script] };
}

function runNodeCheck(
  label: string,
  script: string,
  options: Partial<Parameters<typeof runSingleCheck>[1]> = {},
) {
  return runSingleCheck(nodeCheck(label, script), {
    checkTimeoutMs: 2_000,
    cwd: process.cwd(),
    env: process.env,
    outputMaxBytes: 4096,
    ...options,
  });
}

function killRecordedChild(pid: number | undefined, pidFile: string) {
  const childPid =
    pid ?? (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : undefined);
  if (childPid !== undefined && isProcessAlive(childPid)) {
    process.kill(childPid, "SIGKILL");
  }
}

function isProcessZombie(pid: number): boolean {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim().startsWith("Z");
}

const waitForReady = (file: string, operation: PromiseLike<unknown>) =>
  fixtureReadyBeforeSettlement(
    receipts,
    file,
    operation,
    () => fs.existsSync(file) && fs.readFileSync(file, "utf8").length > 0,
  );

describe("run-additional-boundary-checks", () => {
  it("normalizes concurrency input", () => {
    expect(resolveConcurrency("6")).toBe(6);
    expect(resolveConcurrency(undefined, 2)).toBe(2);
    expect(() => resolveConcurrency("0")).toThrow("concurrency must be a positive integer; got: 0");
    expect(() => resolveConcurrency("6x", 2)).toThrow(
      "concurrency must be a positive integer; got: 6x",
    );
  });

  it("covers every check once across eight shards", () => {
    expect(parseShardSpec("2/4")).toEqual({ count: 4, index: 1, label: "2/4" });
    expect(parseShardSelection("2/4,3/4")).toEqual([
      { count: 4, index: 1, label: "2/4" },
      { count: 4, index: 2, label: "3/4" },
    ]);
    expect(selectChecksForShard(BOUNDARY_CHECKS, "2/4,3/4")).toEqual(
      BOUNDARY_CHECKS.filter((_check, index) => index % 4 === 1 || index % 4 === 2),
    );
    const count = 8;
    const indices = Array.from({ length: count }, (_, index) => index + 1);
    const shardedLabels = indices.flatMap((index) =>
      selectChecksForShard(BOUNDARY_CHECKS, `${index}/${count}`).map((check) => check.label),
    );
    expect(shardedLabels.toSorted((a, b) => a.localeCompare(b))).toEqual(
      BOUNDARY_CHECKS.map((check) => check.label).toSorted((a, b) => a.localeCompare(b)),
    );
    expect(new Set(shardedLabels).size).toBe(BOUNDARY_CHECKS.length);
    const transferred = indices.flatMap((index) => {
      const full = selectChecksForShard(BOUNDARY_CHECKS, `${index}/${count}`);
      const selected = selectChecksForShard(BOUNDARY_CHECKS, `${index}/${count}`, "test-types");
      expect(selected).toEqual(
        full.filter((check) => check.label !== "lint:tmp:tsgo-core-boundary"),
      );
      return selected;
    });
    expect(transferred).toHaveLength(BOUNDARY_CHECKS.length - 1);

    expect(() => parseShardSpec("5/4")).toThrow("Invalid shard spec");
    expect(() => parseShardSpec("9007199254740993/9007199254740994")).toThrow("Invalid shard spec");
  });

  it("parses CLI help and shard args before running checks", () => {
    const parsed = (overrides: Partial<ReturnType<typeof parseCliArgs>>) => ({
      help: false,
      shardSpec: "",
      coreTestBoundaryOwner: "additional",
      ...overrides,
    });
    expect(parseCliArgs(["--shard", "2/4"], {})).toEqual(parsed({ shardSpec: "2/4" }));
    expect(parseCliArgs(["--shard=3/4"], {})).toEqual(parsed({ shardSpec: "3/4" }));
    expect(parseCliArgs([], { OPENCLAW_ADDITIONAL_BOUNDARY_SHARD: "4/4" })).toEqual(
      parsed({ shardSpec: "4/4" }),
    );
    expect(parseCliArgs(["--core-test-boundary-owner=test-types"], {})).toEqual(
      parsed({ coreTestBoundaryOwner: "test-types" }),
    );
    expect(() => parseCliArgs(["--core-test-boundary-owner=none"], {})).toThrow("Unknown argument");
    expect(() => parseCliArgs(["--shard"], {})).toThrow("--shard requires a value");
    expect(() => parseCliArgs(["--shard", "-h"], {})).toThrow("--shard requires a value");
  });

  it("does not start checks for CLI help or invalid arguments", () => {
    const help = runCli("--help");
    expect(help.status).toBe(0);
    expect(help.stdout).toContain(
      "Usage: node --import tsx scripts/run-additional-boundary-checks.mts",
    );
    expect(help.stdout).not.toContain("::group::");
    expect(help.stderr).toBe("");

    const unknown = runCli("--wat");
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain("Unknown argument: --wat");
    expect(unknown.stderr).toContain(
      "Usage: node --import tsx scripts/run-additional-boundary-checks.mts",
    );
    expect(unknown.stderr).not.toContain("::group::");
    expect(unknown.stderr).not.toContain("pnpm");
  });

  it("retains the dependency pin guard in CI boundary checks", () => {
    expect(BOUNDARY_CHECKS).toContainEqual({
      label: "deps:pins:check",
      command: "pnpm",
      args: ["deps:pins:check"],
    });
  });

  it("buffers grouped output and reports aggregate failures", async () => {
    let text = "";
    const failures = await runChecks(
      [
        nodeCheck("passes", "console.log('ok-out')"),
        nodeCheck("fails", "console.error('bad-out'); process.exit(7)"),
      ],
      {
        concurrency: 2,
        output: {
          write(chunk: string) {
            text += chunk;
            return true;
          },
        },
      },
    );

    expect(failures).toBe(1);
    for (const part of [
      "::group::passes",
      "ok-out",
      "[ok] passes in ",
      "::group::fails",
      "bad-out",
      `$ ${process.execPath} -e console.log('ok-out')`,
      "::error title=fails failed::fails failed (exit 7)",
      "Additional boundary check timings:",
    ]) {
      expect(text).toContain(part);
    }
  });

  it("preserves UTF-8 split across process output chunks before trimming the byte tail", async () => {
    const script = [
      'const bytes = Buffer.from("old😀new");',
      "process.stdout.write(bytes.subarray(0, 5));",
      "setTimeout(() => process.stdout.end(bytes.subarray(5)), 20);",
    ].join("");
    const result = await runNodeCheck("split-utf8", script, { outputMaxBytes: 5 });

    expect(result).toMatchObject({ code: 0, output: "[output truncated to last 5 bytes]\nnew" });
  });

  it("clamps oversized check timers before scheduling", async () => {
    const result = await runNodeCheck("slow-pass", "setTimeout(() => process.exit(0), 25)", {
      checkTimeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(result).toMatchObject({ code: 0, timedOut: false });
  });

  it.skipIf(process.platform === "win32")(
    "waits for timed-out process groups after the wrapper exits",
    async ({ signal }) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-timeout-"));
      const childPidPath = path.join(tempDir, "child.pid");
      let childPid: number | undefined;
      let releaseAndWait: (() => ReturnType<typeof runSingleCheck>) | undefined;
      let completion!: ReturnType<typeof runSingleCheck>;
      await runQaGatewayFixture(
        async () => {
          const childScript = [
            "import fs from 'node:fs';",
            fixtureReceiptClientSource(receipts.endpoint),
            "process.on('SIGTERM', () => {});",
            "setInterval(() => {}, 1000);",
            "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID + '.tmp', String(process.pid));",
            "fs.renameSync(process.env.OPENCLAW_TEST_CHILD_PID + '.tmp', process.env.OPENCLAW_TEST_CHILD_PID);",
            "sendReceipt(process.env.OPENCLAW_TEST_CHILD_PID, 'ready');",
          ].join("\n");
          const parentScript = [
            "const { spawn } = require('node:child_process');",
            `spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
            "setInterval(() => {}, 1000);",
          ].join("");

          releaseAndWait = startProcessWatchdogFixture(
            () =>
              (completion = runNodeCheck("wrapper-exits", parentScript, {
                checkTimeoutMs: 100,
                env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
              })),
          );

          await withinTest(waitForReady(childPidPath, completion), signal);
          childPid = Number(fs.readFileSync(childPidPath, "utf8"));
          expect(isProcessAlive(childPid)).toBe(true);
          const result = await withinTest(releaseAndWait(), signal);

          expect(result).toMatchObject({ code: 1, timedOut: true });
          const pid = childPid;
          await waitForProcessObservation(
            () => !isProcessAlive(pid),
            `process ${pid} reaping`,
            signal,
          );
        },
        () => releaseAndWait?.(),
        () => killRecordedChild(childPid, childPidPath),
        () => fs.rmSync(tempDir, { force: true, recursive: true }),
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans active check descendants on parent signal",
    async ({ signal }) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-signal-"));
      const readyPath = path.join(tempDir, "ready");
      const childPidPath = path.join(tempDir, "child.pid");
      let childPid: number | undefined;
      let runner: ReturnType<typeof spawn> | undefined;
      let closed: Promise<unknown[]> | undefined;
      try {
        const childScript = [
          "process.on('SIGTERM', () => {});",
          "process.send(process.pid);",
          "setInterval(() => {}, 1000);",
        ].join("");
        const parentScript = [
          "import { spawn } from 'node:child_process';",
          "import fs from 'node:fs';",
          fixtureReceiptClientSource(receipts.endpoint),
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
          "child.once('message', (pid) => {",
          "  fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(pid));",
          "  fs.writeFileSync(process.env.OPENCLAW_TEST_READY, 'ready');",
          "  sendReceipt(process.env.OPENCLAW_TEST_READY, 'ready');",
          "});",
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const runnerScript = `
import { runChecks } from ${JSON.stringify(
          new URL("../../scripts/run-additional-boundary-checks.mts", import.meta.url).href,
        )};

const completion = runChecks(
  [{
    label: "parent-signal",
    command: process.execPath,
    args: ["--input-type=module", "-e", ${JSON.stringify(parentScript)}],
  }],
  {
    checkTimeoutMs: 30000,
    concurrency: 1,
    output: { write() { return true; } },
  },
);
process.once("SIGTERM", () => process.send("stopping"));
await completion;
`;

        runner = spawn(process.execPath, ["--input-type=module", "--eval", runnerScript], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            OPENCLAW_TEST_CHILD_PID: childPidPath,
            OPENCLAW_TEST_READY: readyPath,
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        closed = once(runner, "close");

        await withinTest(waitForReady(readyPath, closed), signal);
        childPid = Number(fs.readFileSync(childPidPath, "utf8"));
        expect(Number.isInteger(childPid)).toBe(true);
        expect(isProcessAlive(childPid)).toBe(true);

        const stopping = once(runner, "message");
        runner.kill("SIGTERM");
        await withinTest(
          awaitGateBeforeSettlement(stopping, closed, "child did not close before timeout"),
          signal,
        );
        runner.kill("SIGTERM");

        await expect(withinTest(closed, signal)).resolves.toEqual([null, "SIGTERM"]);
        // runChecks reraises only after joining group shutdown; zombies are already terminal.
        expect(!isProcessAlive(childPid) || isProcessZombie(childPid)).toBe(true);
      } finally {
        killRecordedChild(childPid, childPidPath);
        if (runner?.pid && isProcessAlive(runner.pid)) {
          runner.kill("SIGTERM");
        }
        await closed;
        fs.rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );
});
