import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/schtasks-base-mocks.js";
import {
  inspectPortUsage,
  killProcessTree,
  resetSchtasksBaseMocks,
  schtasksCalls,
  schtasksResponses,
  withWindowsEnv,
  writeGatewayScript,
} from "./test-helpers/schtasks-fixtures.js";
const findVerifiedGatewayListenerPidsOnPortSync = vi.hoisted(() =>
  vi.fn<(port: number) => number[]>(() => []),
);
const timeState = vi.hoisted(() => ({ now: 0 }));
const sleepMock = vi.hoisted(() =>
  vi.fn(async (ms: number) => {
    timeState.now += ms;
  }),
);

vi.mock("../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: (port: number) =>
    findVerifiedGatewayListenerPidsOnPortSync(port),
}));
vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...actual,
    sleep: (ms: number) => sleepMock(ms),
  };
});

const {
  restartScheduledTask,
  resumeScheduledTaskAutoStartAfterUpdate,
  stopScheduledTask,
  suspendScheduledTaskAutoStartForUpdate,
} = await import("./schtasks.js");
const GATEWAY_PORT = 18789;
const SUCCESS_RESPONSE = { code: 0, stdout: "", stderr: "" } as const;

function pushSuccessfulSchtasksResponses(count: number) {
  for (let i = 0; i < count; i += 1) {
    schtasksResponses.push({ ...SUCCESS_RESPONSE });
  }
}

function freePortUsage() {
  return {
    port: GATEWAY_PORT,
    status: "free" as const,
    listeners: [],
    hints: [],
  };
}

function busyPortUsage(
  pid: number,
  options: {
    command?: string;
    commandLine?: string;
  } = {},
) {
  return {
    port: GATEWAY_PORT,
    status: "busy" as const,
    listeners: [
      {
        pid,
        command: options.command ?? "node.exe",
        ...(options.commandLine ? { commandLine: options.commandLine } : {}),
      },
    ],
    hints: [],
  };
}

function expectGatewayTermination(pid: number) {
  if (process.platform === "win32") {
    expect(killProcessTree).not.toHaveBeenCalled();
    return;
  }
  expect(killProcessTree).toHaveBeenCalledWith(pid, { graceMs: 300 });
}

async function withPreparedGatewayTask(
  run: (context: { env: Record<string, string>; stdout: PassThrough }) => Promise<void>,
) {
  await withWindowsEnv("openclaw-win-stop-", async ({ env }) => {
    await writeGatewayScript(env, GATEWAY_PORT);
    const stdout = new PassThrough();
    await run({ env, stdout });
  });
}

beforeEach(() => {
  resetSchtasksBaseMocks();
  findVerifiedGatewayListenerPidsOnPortSync.mockReset();
  findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
  timeState.now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => timeState.now);
  sleepMock.mockReset();
  sleepMock.mockImplementation(async (ms: number) => {
    timeState.now += ms;
  });
  inspectPortUsage.mockResolvedValue(freePortUsage());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Scheduled Task stop/restart cleanup", () => {
  it("can suspend and resume Scheduled Task autostart without stopping the running task", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push(
        { ...SUCCESS_RESPONSE },
        {
          ...SUCCESS_RESPONSE,
          stdout: "<Task><Settings><StartWhenAvailable>true</StartWhenAvailable></Settings></Task>",
        },
        { ...SUCCESS_RESPONSE },
      );

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(true);

      pushSuccessfulSchtasksResponses(3);

      await expect(resumeScheduledTaskAutoStartAfterUpdate(env)).resolves.toBe(true);

      expect(schtasksCalls).toEqual([
        ["/Query"],
        ["/Query", "/TN", "OpenClaw Gateway", "/XML"],
        ["/Change", "/TN", "OpenClaw Gateway", "/DISABLE"],
        ["/Query"],
        ["/Query", "/TN", "OpenClaw Gateway"],
        ["/Change", "/TN", "OpenClaw Gateway", "/ENABLE"],
      ]);
      expect(killProcessTree).not.toHaveBeenCalled();
      expect(inspectPortUsage).not.toHaveBeenCalled();
    });
  });

  it("does not change Scheduled Task state when the task is not registered", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push(
        { ...SUCCESS_RESPONSE },
        {
          code: 1,
          stdout: "",
          stderr: "ERROR: The system cannot find the file specified.",
        },
      );

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(false);

      expect(schtasksCalls).toEqual([["/Query"], ["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
    });
  });

  it("does not change Scheduled Task state when schtasks is unavailable", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({
        code: 1,
        stdout: "",
        stderr: "ERROR: Access is denied.",
      });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(false);

      expect(schtasksCalls).toEqual([["/Query"]]);
    });
  });

  it("does not resume a Scheduled Task that was already disabled", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push(
        { ...SUCCESS_RESPONSE },
        {
          ...SUCCESS_RESPONSE,
          stdout:
            "<Task><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><Enabled>false</Enabled></Settings></Task>",
        },
      );

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(false);

      expect(schtasksCalls).toEqual([["/Query"], ["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
    });
  });

  it("does not resume when Scheduled Task enabled state is unavailable", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({ ...SUCCESS_RESPONSE }, { ...SUCCESS_RESPONSE, stdout: "<Task />" });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(false);

      expect(schtasksCalls).toEqual([["/Query"], ["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
    });
  });

  it("treats omitted Settings Enabled state as enabled", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push(
        { ...SUCCESS_RESPONSE },
        {
          ...SUCCESS_RESPONSE,
          stdout:
            "<Task><Triggers><LogonTrigger><Enabled>false</Enabled></LogonTrigger></Triggers><Settings><Hidden>false</Hidden></Settings></Task>",
        },
        { ...SUCCESS_RESPONSE },
      );

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(true);

      expect(schtasksCalls).toEqual([
        ["/Query"],
        ["/Query", "/TN", "OpenClaw Gateway", "/XML"],
        ["/Change", "/TN", "OpenClaw Gateway", "/DISABLE"],
      ]);
    });
  });

  it("reads NUL-separated Scheduled Task XML enabled state", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      const xml = "<Task><Settings><Enabled>true</Enabled></Settings></Task>";
      schtasksResponses.push(
        { ...SUCCESS_RESPONSE },
        { ...SUCCESS_RESPONSE, stdout: `\uFEFF${xml.split("").join("\u0000")}` },
        { ...SUCCESS_RESPONSE },
      );

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(true);

      expect(schtasksCalls).toEqual([
        ["/Query"],
        ["/Query", "/TN", "OpenClaw Gateway", "/XML"],
        ["/Change", "/TN", "OpenClaw Gateway", "/DISABLE"],
      ]);
    });
  });

  it("kills lingering verified gateway listeners after schtasks stop", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(3);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      inspectPortUsage
        .mockResolvedValueOnce(busyPortUsage(4242))
        .mockResolvedValueOnce(freePortUsage());

      await stopScheduledTask({ env, stdout });

      expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(GATEWAY_PORT);
      expectGatewayTermination(4242);
      expect(inspectPortUsage).toHaveBeenCalledTimes(2);
    });
  });

  it("force-kills remaining busy port listeners when the first stop pass does not free the port", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(3);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      inspectPortUsage.mockResolvedValueOnce(busyPortUsage(4242));
      for (let i = 0; i < 19; i += 1) {
        inspectPortUsage.mockResolvedValueOnce(busyPortUsage(4242));
      }
      inspectPortUsage
        .mockResolvedValueOnce(busyPortUsage(5252))
        .mockResolvedValueOnce(freePortUsage());

      await stopScheduledTask({ env, stdout });

      if (process.platform !== "win32") {
        expect(killProcessTree).toHaveBeenNthCalledWith(1, 4242, { graceMs: 300 });
        expect(killProcessTree).toHaveBeenNthCalledWith(2, 5252, { graceMs: 300 });
      } else {
        expect(killProcessTree).not.toHaveBeenCalled();
      }
      expect(inspectPortUsage.mock.calls.length).toBeGreaterThanOrEqual(22);
    });
  });

  it("falls back to inspected gateway listeners when sync verification misses on Windows", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(3);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
      inspectPortUsage
        .mockResolvedValueOnce(
          busyPortUsage(6262, {
            commandLine:
              '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789',
          }),
        )
        .mockResolvedValueOnce(freePortUsage());

      await stopScheduledTask({ env, stdout });

      expectGatewayTermination(6262);
      expect(inspectPortUsage).toHaveBeenCalledTimes(2);
    });
  });

  it("does not reclaim gateway listeners when stopping a node Scheduled Task", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(3);
      env.OPENCLAW_SERVICE_KIND = "node";
      env.OPENCLAW_WINDOWS_TASK_NAME = "OpenClaw Node";
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      inspectPortUsage.mockResolvedValue(busyPortUsage(4242));

      await stopScheduledTask({ env, stdout });

      expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
      expect(inspectPortUsage).not.toHaveBeenCalled();
      expect(killProcessTree).not.toHaveBeenCalled();
      expect(schtasksCalls).toEqual([
        ["/Query"],
        ["/Query", "/TN", "OpenClaw Node"],
        ["/End", "/TN", "OpenClaw Node"],
      ]);
    });
  });

  it("kills lingering verified gateway listeners and waits for port release before restart", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(4);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([5151]);
      inspectPortUsage
        .mockResolvedValueOnce(busyPortUsage(5151))
        .mockResolvedValueOnce(freePortUsage());

      await expect(restartScheduledTask({ env, stdout })).resolves.toEqual({
        outcome: "completed",
      });

      expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(GATEWAY_PORT);
      expectGatewayTermination(5151);
      expect(inspectPortUsage).toHaveBeenCalledTimes(2);
      expect(schtasksCalls).toEqual([
        ["/Query"],
        ["/Query", "/TN", "OpenClaw Gateway"],
        ["/End", "/TN", "OpenClaw Gateway"],
        ["/Run", "/TN", "OpenClaw Gateway"],
        ["/Query"],
        ["/Query", "/TN", "OpenClaw Gateway", "/V", "/FO", "LIST"],
      ]);
    });
  });

  it("does not wait on or force-kill the gateway port when restarting a node Scheduled Task", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(4);
      env.OPENCLAW_SERVICE_KIND = "node";
      env.OPENCLAW_WINDOWS_TASK_NAME = "OpenClaw Node";
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([5151]);
      inspectPortUsage.mockResolvedValue(busyPortUsage(5151));

      await expect(restartScheduledTask({ env, stdout })).resolves.toEqual({
        outcome: "completed",
      });

      expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
      expect(inspectPortUsage).not.toHaveBeenCalled();
      expect(killProcessTree).not.toHaveBeenCalled();
      expect(schtasksCalls).toEqual([
        ["/Query"],
        ["/Query", "/TN", "OpenClaw Node"],
        ["/End", "/TN", "OpenClaw Node"],
        ["/Run", "/TN", "OpenClaw Node"],
        ["/Query"],
        ["/Query", "/TN", "OpenClaw Node", "/V", "/FO", "LIST"],
      ]);
    });
  });

  it("throws when /Run fails during restart", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      schtasksResponses.push(
        { ...SUCCESS_RESPONSE },
        { ...SUCCESS_RESPONSE },
        { ...SUCCESS_RESPONSE },
        { code: 1, stdout: "", stderr: "ERROR: Access is denied." },
      );

      await expect(restartScheduledTask({ env, stdout })).rejects.toThrow(
        "schtasks run failed: ERROR: Access is denied.",
      );
      expect(schtasksCalls.at(-1)).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });
});
