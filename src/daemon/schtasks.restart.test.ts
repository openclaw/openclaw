import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execSchtasksMock = vi.hoisted(() => vi.fn());

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: (...args: unknown[]) => execSchtasksMock(...args),
}));

import { restartScheduledTask } from "./schtasks.js";

function renderTaskQuery(params: { status: string; lastRunResult: string }): string {
  return [
    "TaskName: \\OpenClaw Gateway",
    `Status: ${params.status}`,
    "Last Run Time: 3/11/2026 9:41:00 AM",
    `Last Run Result: ${params.lastRunResult}`,
  ].join("\r\n");
}

beforeEach(() => {
  execSchtasksMock.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("restartScheduledTask", () => {
  it("waits for the previous task instance to stop before issuing /Run", async () => {
    const calls: string[][] = [];
    let taskQueryCount = 0;

    execSchtasksMock.mockImplementation(async (argv: string[]) => {
      calls.push(argv);
      if (argv.length === 1 && argv[0] === "/Query") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "/End") {
        return { code: 0, stdout: "SUCCESS", stderr: "" };
      }
      if (argv[0] === "/Query" && argv.includes("/TN")) {
        taskQueryCount += 1;
        if (taskQueryCount === 1) {
          return {
            code: 0,
            stdout: renderTaskQuery({ status: "Running", lastRunResult: "0x41301" }),
            stderr: "",
          };
        }
        return {
          code: 0,
          stdout: renderTaskQuery({ status: "Ready", lastRunResult: "0x0" }),
          stderr: "",
        };
      }
      if (argv[0] === "/Run") {
        return { code: 0, stdout: "SUCCESS", stderr: "" };
      }
      throw new Error(`Unexpected schtasks call: ${argv.join(" ")}`);
    });

    const restart = restartScheduledTask({
      env: { USERNAME: "tester" },
      stdout: new PassThrough(),
    });

    await vi.runAllTimersAsync();
    await expect(restart).resolves.toBeUndefined();
    expect(calls).toEqual([
      ["/Query"],
      ["/End", "/TN", "OpenClaw Gateway"],
      ["/Query", "/TN", "OpenClaw Gateway", "/V", "/FO", "LIST"],
      ["/Query", "/TN", "OpenClaw Gateway", "/V", "/FO", "LIST"],
      ["/Run", "/TN", "OpenClaw Gateway"],
    ]);
  });

  it("treats a queued task as still active before re-running it", async () => {
    let taskQueryCount = 0;

    execSchtasksMock.mockImplementation(async (argv: string[]) => {
      if (argv.length === 1 && argv[0] === "/Query") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "/End") {
        return { code: 0, stdout: "SUCCESS", stderr: "" };
      }
      if (argv[0] === "/Query" && argv.includes("/TN")) {
        taskQueryCount += 1;
        return taskQueryCount === 1
          ? {
              code: 0,
              stdout: renderTaskQuery({ status: "Queued", lastRunResult: "0x41325" }),
              stderr: "",
            }
          : {
              code: 0,
              stdout: renderTaskQuery({ status: "Ready", lastRunResult: "0x0" }),
              stderr: "",
            };
      }
      if (argv[0] === "/Run") {
        return { code: 0, stdout: "SUCCESS", stderr: "" };
      }
      throw new Error(`Unexpected schtasks call: ${argv.join(" ")}`);
    });

    const restart = restartScheduledTask({
      env: { USERNAME: "tester" },
      stdout: new PassThrough(),
    });

    await vi.runAllTimersAsync();
    await expect(restart).resolves.toBeUndefined();
    expect(taskQueryCount).toBe(2);
  });

  it("keeps waiting when status is Running but the task has not written a numeric result code yet", async () => {
    const calls: string[][] = [];
    let taskQueryCount = 0;

    execSchtasksMock.mockImplementation(async (argv: string[]) => {
      calls.push(argv);
      if (argv.length === 1 && argv[0] === "/Query") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "/End") {
        return { code: 0, stdout: "SUCCESS", stderr: "" };
      }
      if (argv[0] === "/Query" && argv.includes("/TN")) {
        taskQueryCount += 1;
        if (taskQueryCount === 1) {
          return {
            code: 0,
            stdout: renderTaskQuery({ status: "Running", lastRunResult: "N/A" }),
            stderr: "",
          };
        }
        return {
          code: 0,
          stdout: renderTaskQuery({ status: "Ready", lastRunResult: "0x0" }),
          stderr: "",
        };
      }
      if (argv[0] === "/Run") {
        return { code: 0, stdout: "SUCCESS", stderr: "" };
      }
      throw new Error(`Unexpected schtasks call: ${argv.join(" ")}`);
    });

    const restart = restartScheduledTask({
      env: { USERNAME: "tester" },
      stdout: new PassThrough(),
    });

    await vi.runAllTimersAsync();
    await expect(restart).resolves.toBeUndefined();
    expect(taskQueryCount).toBe(2);
    expect(calls).toEqual([
      ["/Query"],
      ["/End", "/TN", "OpenClaw Gateway"],
      ["/Query", "/TN", "OpenClaw Gateway", "/V", "/FO", "LIST"],
      ["/Query", "/TN", "OpenClaw Gateway", "/V", "/FO", "LIST"],
      ["/Run", "/TN", "OpenClaw Gateway"],
    ]);
  });

  it("re-checks once more before timing out when the task stops in the final delay window", async () => {
    const terminalPolls = 40;
    let taskQueryCount = 0;

    execSchtasksMock.mockImplementation(async (argv: string[]) => {
      if (argv.length === 1 && argv[0] === "/Query") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "/End") {
        return { code: 0, stdout: "SUCCESS", stderr: "" };
      }
      if (argv[0] === "/Query" && argv.includes("/TN")) {
        taskQueryCount += 1;
        return taskQueryCount <= terminalPolls
          ? {
              code: 0,
              stdout: renderTaskQuery({ status: "Running", lastRunResult: "0x41301" }),
              stderr: "",
            }
          : {
              code: 0,
              stdout: renderTaskQuery({ status: "Ready", lastRunResult: "0x0" }),
              stderr: "",
            };
      }
      if (argv[0] === "/Run") {
        return { code: 0, stdout: "SUCCESS", stderr: "" };
      }
      throw new Error(`Unexpected schtasks call: ${argv.join(" ")}`);
    });

    const restart = restartScheduledTask({
      env: { USERNAME: "tester" },
      stdout: new PassThrough(),
    });

    await vi.runAllTimersAsync();
    await expect(restart).resolves.toBeUndefined();
    expect(taskQueryCount).toBe(terminalPolls + 1);
  });

  it("still starts the task immediately when /End reports it was not running", async () => {
    const calls: string[][] = [];

    execSchtasksMock.mockImplementation(async (argv: string[]) => {
      calls.push(argv);
      if (argv.length === 1 && argv[0] === "/Query") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "/End") {
        return { code: 1, stdout: "", stderr: "ERROR: The task is not running." };
      }
      if (argv[0] === "/Run") {
        return { code: 0, stdout: "SUCCESS", stderr: "" };
      }
      throw new Error(`Unexpected schtasks call: ${argv.join(" ")}`);
    });

    await expect(
      restartScheduledTask({
        env: { USERNAME: "tester" },
        stdout: new PassThrough(),
      }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([
      ["/Query"],
      ["/End", "/TN", "OpenClaw Gateway"],
      ["/Run", "/TN", "OpenClaw Gateway"],
    ]);
  });
});
