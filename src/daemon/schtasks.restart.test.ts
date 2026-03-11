import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execSchtasksMock = vi.hoisted(() => vi.fn());
const relaunchGatewayScheduledTaskMock = vi.hoisted(() => vi.fn());

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: (...args: unknown[]) => execSchtasksMock(...args),
}));

vi.mock("../infra/windows-task-restart.js", () => ({
  relaunchGatewayScheduledTask: (...args: unknown[]) => relaunchGatewayScheduledTaskMock(...args),
}));

import { restartScheduledTask } from "./schtasks.js";

describe("restartScheduledTask", () => {
  const env = {
    USERPROFILE: "C:\\Users\\tester",
    OPENCLAW_PROFILE: "default",
  };

  beforeEach(() => {
    execSchtasksMock.mockReset();
    relaunchGatewayScheduledTaskMock.mockReset();
    execSchtasksMock.mockImplementation(async (argv: string[]) => {
      if (argv[0] === "/Query") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "/End") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "/Run") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    relaunchGatewayScheduledTaskMock.mockReturnValue({
      ok: true,
      method: "schtasks",
      tried: ['schtasks /Run /TN "OpenClaw Gateway"'],
    });
  });

  it("uses the detached relaunch helper after ending the task", async () => {
    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on("data", (chunk) => chunks.push(String(chunk)));

    await restartScheduledTask({ env, stdout });

    expect(execSchtasksMock.mock.calls.map((call) => call[0])).toEqual([
      ["/Query"],
      ["/End", "/TN", "OpenClaw Gateway"],
    ]);
    expect(relaunchGatewayScheduledTaskMock).toHaveBeenCalledWith(env);
    expect(chunks.join("")).toContain("Restarted Scheduled Task");
  });

  it("falls back to direct /Run when the relaunch helper fails", async () => {
    relaunchGatewayScheduledTaskMock.mockReturnValue({
      ok: false,
      method: "schtasks",
      detail: "spawn failed",
      tried: ['schtasks /Run /TN "OpenClaw Gateway"'],
    });

    await restartScheduledTask({ env, stdout: new PassThrough() });

    expect(execSchtasksMock.mock.calls.map((call) => call[0])).toEqual([
      ["/Query"],
      ["/End", "/TN", "OpenClaw Gateway"],
      ["/Run", "/TN", "OpenClaw Gateway"],
    ]);
  });

  it("ignores not-running /End errors before relaunching", async () => {
    execSchtasksMock.mockImplementation(async (argv: string[]) => {
      if (argv[0] === "/Query") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "/End") {
        return { code: 1, stdout: "", stderr: "ERROR: The task is not running." };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await restartScheduledTask({ env, stdout: new PassThrough() });

    expect(relaunchGatewayScheduledTaskMock).toHaveBeenCalledWith(env);
  });

  it("throws when both helper relaunch and direct /Run fail", async () => {
    relaunchGatewayScheduledTaskMock.mockReturnValue({
      ok: false,
      method: "schtasks",
      detail: "spawn failed",
      tried: ['schtasks /Run /TN "OpenClaw Gateway"'],
    });
    execSchtasksMock.mockImplementation(async (argv: string[]) => {
      if (argv[0] === "/Query") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "/End") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "/Run") {
        return { code: 1, stdout: "", stderr: "Last Result: 1" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await expect(restartScheduledTask({ env, stdout: new PassThrough() })).rejects.toThrow(
      "schtasks run failed: helper=spawn failed; Last Result: 1",
    );
  });
});
