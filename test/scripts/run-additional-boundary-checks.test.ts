// Run Additional Boundary Checks tests cover run additional boundary checks script behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOUNDARY_CHECKS,
  createBoundedOutputBuffer,
  formatCommand,
  parseShardSelection,
  parseShardSpec,
  resolveConcurrency,
  resolvePositiveInteger,
  runChecks,
  runSingleCheck,
  selectChecksForShard,
} from "../../scripts/run-additional-boundary-checks.mjs";

function createOutputBuffer() {
  const chunks: string[] = [];
  return {
    output: {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
    text: () => chunks.join(""),
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${filePath}`);
}

async function waitForDead(pid: number, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`process still alive: ${pid}`);
}

describe("run-additional-boundary-checks", () => {
  it("runs prompt snapshot drift checks in CI", () => {
    expect(BOUNDARY_CHECKS[0]).toEqual({
      label: "prompt:snapshots:check",
      command: "pnpm",
      args: ["prompt:snapshots:check"],
    });
  });

  it("normalizes concurrency input", () => {
    expect(resolveConcurrency("6")).toBe(6);
    expect(resolveConcurrency(undefined, 2)).toBe(2);
    expect(() => resolveConcurrency("0")).toThrow("concurrency must be a positive integer; got: 0");
    expect(() => resolveConcurrency("6x", 2)).toThrow(
      "concurrency must be a positive integer; got: 6x",
    );
  });

  it("rejects malformed timeout and output limit integers", () => {
    expect(resolvePositiveInteger("25", 50, "OPENCLAW_ADDITIONAL_BOUNDARY_TIMEOUT_MS")).toBe(25);
    expect(resolvePositiveInteger(undefined, 50, "OPENCLAW_ADDITIONAL_BOUNDARY_TIMEOUT_MS")).toBe(
      50,
    );
    expect(() =>
      resolvePositiveInteger("1000ms", 50, "OPENCLAW_ADDITIONAL_BOUNDARY_TIMEOUT_MS"),
    ).toThrow("OPENCLAW_ADDITIONAL_BOUNDARY_TIMEOUT_MS must be a positive integer; got: 1000ms");
    expect(() =>
      resolvePositiveInteger("1e3", 50, "OPENCLAW_ADDITIONAL_BOUNDARY_OUTPUT_MAX_BYTES"),
    ).toThrow("OPENCLAW_ADDITIONAL_BOUNDARY_OUTPUT_MAX_BYTES must be a positive integer; got: 1e3");
  });

  it("formats command display text", () => {
    expect(formatCommand({ command: "pnpm", args: ["run", "lint:core"] })).toBe(
      "pnpm run lint:core",
    );
  });

  it("keeps only a bounded tail of command output", () => {
    const output = createBoundedOutputBuffer(12);
    output.append("first-line\n");
    output.append("second-line\n");

    expect(output.read()).toBe("[output truncated to last 12 bytes]\nsecond-line\n");
  });

  it("parses and applies CI shard specs", () => {
    expect(parseShardSpec("2/4")).toEqual({ count: 4, index: 1, label: "2/4" });
    expect(parseShardSelection("2/4,3/4")).toEqual([
      { count: 4, index: 1, label: "2/4" },
      { count: 4, index: 2, label: "3/4" },
    ]);
    expect(selectChecksForShard(BOUNDARY_CHECKS, "1/4")).toEqual(
      BOUNDARY_CHECKS.filter((_check, index) => index % 4 === 0),
    );
    expect(selectChecksForShard(BOUNDARY_CHECKS, "2/4,3/4")).toEqual(
      BOUNDARY_CHECKS.filter((_check, index) => index % 4 === 1 || index % 4 === 2),
    );
    const shardedLabels = [1, 2, 3, 4].flatMap((index) =>
      selectChecksForShard(BOUNDARY_CHECKS, `${index}/4`).map((check) => check.label),
    );
    expect(shardedLabels.toSorted((a, b) => a.localeCompare(b))).toEqual(
      BOUNDARY_CHECKS.map((check) => check.label).toSorted((a, b) => a.localeCompare(b)),
    );
    expect(new Set(shardedLabels).size).toBe(BOUNDARY_CHECKS.length);
    expect(() => parseShardSpec("5/4")).toThrow("Invalid shard spec");
    expect(() => parseShardSpec("9007199254740993/9007199254740994")).toThrow("Invalid shard spec");
  });

  it("keeps the raw HTTP/2 import guard in source boundary checks", () => {
    expect(BOUNDARY_CHECKS).toContainEqual({
      label: "lint:tmp:no-raw-http2-imports",
      command: "pnpm",
      args: ["run", "lint:tmp:no-raw-http2-imports"],
    });
  });

  it("keeps the Telegram grammY type import guard in source boundary checks", () => {
    expect(BOUNDARY_CHECKS).toContainEqual({
      label: "lint:extensions:telegram-grammy-types",
      command: "pnpm",
      args: ["run", "lint:extensions:telegram-grammy-types"],
    });
  });

  it("buffers grouped output and reports aggregate failures", async () => {
    const buffer = createOutputBuffer();
    const failures = await runChecks(
      [
        {
          label: "passes",
          command: process.execPath,
          args: ["-e", "console.log('ok-out')"],
        },
        {
          label: "fails",
          command: process.execPath,
          args: ["-e", "console.error('bad-out'); process.exit(7)"],
        },
      ],
      { concurrency: 2, output: buffer.output },
    );

    const text = buffer.text();
    expect(failures).toBe(1);
    expect(text).toContain("::group::passes");
    expect(text).toContain("ok-out");
    expect(text).toContain("[ok] passes in ");
    expect(text).toContain("::group::fails");
    expect(text).toContain("bad-out");
    expect(text).toContain("::error title=fails failed::fails failed (exit 7)");
    expect(text).toContain("Additional boundary check timings:");
  });

  it("times out hung checks", async () => {
    const result = await runSingleCheck(
      {
        label: "hangs",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      },
      {
        checkTimeoutMs: 50,
        cwd: process.cwd(),
        env: process.env,
        outputMaxBytes: 4096,
      },
    );

    expect(result.code).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(result.output).toContain("timed out after 50ms");
  });

  it.skipIf(process.platform === "win32")(
    "waits for timed-out process groups after the wrapper exits",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-timeout-"));
      const childPidPath = path.join(tempDir, "child.pid");
      let childPid = 0;
      try {
        const childScript = [
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          "const fs = require('node:fs');",
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
          "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(child.pid));",
          "setInterval(() => {}, 1000);",
        ].join("");

        const resultPromise = runSingleCheck(
          {
            label: "wrapper-exits",
            command: process.execPath,
            args: ["-e", parentScript],
          },
          {
            checkTimeoutMs: 100,
            cwd: process.cwd(),
            env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
            outputMaxBytes: 4096,
          },
        );

        await waitForFile(childPidPath, 2000);
        childPid = Number(fs.readFileSync(childPidPath, "utf8"));
        const result = await resultPromise;

        expect(result.code).toBe(1);
        expect(result.timedOut).toBe(true);
        await waitForDead(childPid, 2000);
      } finally {
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
        fs.rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );
});
