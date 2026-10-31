import { readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GatewayProtocolRequestError,
  retainGatewayResponsePayload,
} from "../../packages/gateway-client/src/protocol-request.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import {
  GATEWAY_OWNER,
  SUCCESS_RESPONSE,
  INSTALLED_GATEWAY_COMMAND_LINE,
  formatWindowsTaskSupervisorChildArgument,
  callGatewayCli,
  mockWindowsTaskkillSuccess,
  mockLingeringGatewayListener,
  readActiveGatewayLockIdentity,
  readGatewayOwnerLease,
  readWindowsProcessStartTimeSync,
  restartScheduledTask,
  resumeScheduledTaskAutoStartAfterUpdate,
  resolveTaskScriptPath,
  spawnSync,
  spawnSyncResult,
  scheduledTaskProbeResult,
  stopScheduledTask,
  suspendScheduledTaskAutoStartForUpdate,
  withPreparedGatewayTask,
} from "./schtasks.stop.test-support.js";
import {
  inspectPortUsageMock,
  resolveStartupFixturePath,
  schtasksCalls,
  schtasksResponses,
} from "./test-helpers/schtasks-fixtures.js";

type GatewayFixture = Parameters<Parameters<typeof withPreparedGatewayTask>[0]>[0];
const test = it.extend<GatewayFixture & { gateway: GatewayFixture }>({
  gateway: async ({ task: _task }, use) => withPreparedGatewayTask(use),
  env: async ({ gateway }, use) => use(gateway.env),
  stdout: async ({ gateway }, use) => use(gateway.stdout),
});

const taskAction = (...actions: string[]) =>
  schtasksCalls.some(([action]) => action !== undefined && actions.includes(action));
const killedOwner = () => spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"));
const processList = (pid = 4242) => `"node.exe","${pid}","Console","1","1 K"`;
const jsonResult = (value: object) => spawnSyncResult(JSON.stringify(value));
function mockGracefulStop(stop: () => void) {
  callGatewayCli.mockImplementation(async (options) => {
    options.assertDispatchCurrent();
    stop();
    return { ok: true, pid: GATEWAY_OWNER.pid, status: "scheduled" };
  });
}
type ProcessCommand = Parameters<typeof spawnSync.mockImplementation>[0];
function mockProcessCommands(
  command: ProcessCommand,
  probe: ProcessCommand = () => scheduledTaskProbeResult(),
) {
  spawnSync.mockImplementation((exe, args, options) =>
    (args?.includes("-EncodedCommand") ? probe : command)(exe, args, options),
  );
}
function mockOwnerlessInstalledGateway() {
  readGatewayOwnerLease.mockReturnValue(undefined);
  mockProcessCommands((exe) => {
    if (exe.endsWith("taskkill.exe")) {
      return spawnSyncResult("");
    }
    if (exe.endsWith("tasklist.exe")) {
      return spawnSyncResult(killedOwner() ? "No tasks" : processList());
    }
    return jsonResult(
      killedOwner()
        ? []
        : [{ ProcessId: GATEWAY_OWNER.pid, CommandLine: INSTALLED_GATEWAY_COMMAND_LINE }],
    );
  });
}
const gatewayFileLock = {
  pid: GATEWAY_OWNER.pid,
  ownerId: GATEWAY_OWNER.owner,
  port: GATEWAY_OWNER.port,
  createdAt: "2026-10-25T00:00:00.000Z",
  startTime: GATEWAY_OWNER.startedAt ?? undefined,
};
function expectNoNativeMutation() {
  expect(taskAction("/End", "/Run")).toBe(false);
  expect(killedOwner()).toBe(false);
}
function expectTaskCommands(...commands: string[][]) {
  expect(schtasksCalls).toEqual(
    commands.map(([action, ...args]) => [action, "/TN", "OpenClaw Gateway"].concat(args)),
  );
}
function queueTaskXml(xml: string, ...responses: typeof schtasksResponses) {
  schtasksResponses.push({ ...SUCCESS_RESPONSE, stdout: xml }, ...responses);
}
function settledTask(ended: boolean, restartRecovery?: "sqlite-owner-read") {
  return {
    outcome: "completed",
    ...(restartRecovery ? { restartRecovery } : {}),
    taskSettlement: {
      status: "settled",
      taskName: "OpenClaw Gateway",
      lastRunResult: "0",
      ended,
    },
  };
}
describe("Scheduled Task shutdown and SQLite handle release", () => {
  test("refuses restart without an inspectable Gateway identity", async ({ env, stdout }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    delete env.OPENCLAW_GATEWAY_PORT;
    await fs.rm(resolveTaskScriptPath(env));
    const onMutation = vi.fn();

    await expect(restartScheduledTask({ env, stdout, onMutation })).rejects.toThrow(
      "Gateway identity unavailable",
    );
    expect(onMutation).not.toHaveBeenCalled();
    expect(callGatewayCli).not.toHaveBeenCalled();
    expectNoNativeMutation();
  });

  test.for(["still alive", "unverified"])(
    "refuses lease-read recovery for a captured process that is %s",
    async (state, { env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      let attempted = false;
      let reads = 0;
      readGatewayOwnerLease.mockImplementation(() => {
        const unavailable = state === "unverified" ? ++reads > 1 : attempted || taskAction("/End");
        if (unavailable) {
          throw Object.assign(new Error("disk I/O error"), { errcode: 1546 });
        }
        return state === "unverified"
          ? { ...GATEWAY_OWNER, state: "unknown", startedAt: null }
          : GATEWAY_OWNER;
      });
      if (state === "unverified") {
        mockWindowsTaskkillSuccess();
      } else {
        mockProcessCommands((exe) => {
          attempted ||= exe.endsWith("taskkill.exe");
          return spawnSyncResult(exe.endsWith("tasklist.exe") ? processList() : "");
        });
      }
      await expect(restartScheduledTask({ env, stdout })).rejects.toThrow(
        state === "unverified" ? "disk I/O error" : "state writer",
      );
      expect(taskAction("/Run")).toBe(false);
      if (state === "unverified") {
        expect(taskAction("/End")).toBe(false);
        expect(killedOwner()).toBe(false);
      }
    },
  );

  test("stops the published owner and pre-existing children without adopting a replacement", async ({
    env,
    stdout,
  }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const killed = new Set<number>();
    readGatewayOwnerLease.mockImplementation(() => ({
      ...GATEWAY_OWNER,
      state: killed.has(4242) ? "dead" : "live",
    }));
    readWindowsProcessStartTimeSync.mockImplementation((pid) => (pid === 5151 ? 200 : 100));
    spawnSync.mockImplementation((exe, args) => {
      if (args?.includes("-EncodedCommand")) {
        return scheduledTaskProbeResult(killed.has(4242) ? 3 : 4);
      }
      if (exe.endsWith("taskkill.exe")) {
        killed.add(Number(args?.[args.indexOf("/PID") + 1]));
        return spawnSyncResult("");
      }
      if (exe.endsWith("tasklist.exe")) {
        const pid = Number(args?.[1]?.split(" ").at(-1));
        return spawnSyncResult(killed.has(pid) ? "No tasks" : processList(pid));
      }
      const children = [
        { ProcessId: 5151, CommandLine: INSTALLED_GATEWAY_COMMAND_LINE },
        {
          ProcessId: 4242,
          CommandLine: `${INSTALLED_GATEWAY_COMMAND_LINE} ${formatWindowsTaskSupervisorChildArgument(305419896)}`,
        },
        ...(killed.has(4242)
          ? [{ ProcessId: 6262, CommandLine: INSTALLED_GATEWAY_COMMAND_LINE }]
          : []),
      ].filter(({ ProcessId }) => !killed.has(ProcessId));
      return jsonResult(children);
    });
    inspectPortUsageMock.mockImplementation(async () => ({
      port: 18789,
      status: killed.has(5151) ? "free" : "busy",
      hints: [],
      listeners: killed.has(5151)
        ? []
        : [{ pid: 5151, command: "node.exe", commandLine: INSTALLED_GATEWAY_COMMAND_LINE }],
    }));

    await stopScheduledTask({ env, stdout });

    expect([...killed]).toEqual([4242, 5151]);
    expect(killed.has(6262)).toBe(false);
    expect(taskAction("/End", "/Run")).toBe(false);
  });

  test("preserves a reused legacy PID before native task termination", async ({ env, stdout }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockLingeringGatewayListener(4242);
    readWindowsProcessStartTimeSync.mockReturnValueOnce(100).mockReturnValue(200);
    mockProcessCommands((exe) =>
      spawnSyncResult(
        exe.endsWith("tasklist.exe")
          ? processList()
          : JSON.stringify([{ ProcessId: 4242, CommandLine: INSTALLED_GATEWAY_COMMAND_LINE }]),
      ),
    );
    const warn = vi.fn();

    await expect(restartScheduledTask({ env, stdout, warn })).rejects.toThrow(
      "Gateway ownership changed; restart unverified",
    );

    expectNoNativeMutation();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("replacement"));
  });

  test.for([
    { name: "stop", control: stopScheduledTask, pid: 5252, startedAt: 200 },
    { name: "restart with PID reuse", control: restartScheduledTask, pid: 4242, startedAt: 200 },
    {
      name: "restart with a new task instance",
      control: restartScheduledTask,
      pid: 4242,
      startedAt: 100,
    },
  ])(
    "$name preserves a replacement started between stop and cleanup",
    async ({ control, pid, startedAt }, { env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const warn = vi.fn();
      readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
      mockWindowsTaskkillSuccess();
      mockLingeringGatewayListener(pid);
      mockGracefulStop(() => {
        readGatewayOwnerLease.mockReturnValue(undefined);
        let replacementStarted = false;
        mockProcessCommands((exe) => {
          if (exe.endsWith("tasklist.exe") && !replacementStarted) {
            replacementStarted = true;
            readGatewayOwnerLease.mockReturnValue({
              ...GATEWAY_OWNER,
              owner: "replacement",
              pid,
              startedAt,
            });
            readWindowsProcessStartTimeSync.mockReturnValue(startedAt);
            return spawnSyncResult("No tasks");
          }
          return spawnSyncResult(
            exe.endsWith("tasklist.exe") && replacementStarted && pid === GATEWAY_OWNER.pid
              ? processList()
              : "No tasks",
          );
        });
      });

      const operation = control({ env, stdout, warn });
      if (control === restartScheduledTask) {
        await expect(operation).rejects.toThrow("Gateway ownership changed; restart unverified");
      } else {
        await operation;
      }

      expectNoNativeMutation();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("replacement"));
    },
  );

  test("restart falls back promptly after a definitive stop rejection", async ({ env, stdout }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const ended = killedOwner;
    readGatewayOwnerLease.mockImplementation(() => (ended() ? undefined : GATEWAY_OWNER));
    mockProcessCommands((exe) => {
      if (exe.toLowerCase().endsWith("tasklist.exe")) {
        return spawnSyncResult(ended() ? "No tasks" : processList());
      }
      return spawnSyncResult("", exe.endsWith("taskkill.exe") ? 0 : 1);
    });
    callGatewayCli.mockImplementation(async (options) => {
      options.assertDispatchCurrent();
      const error = new GatewayProtocolRequestError({
        code: "UNAVAILABLE",
        message: "Host refused stop",
      });
      retainGatewayResponsePayload(error, undefined);
      throw error;
    });
    const started = Date.now();

    await restartScheduledTask({ env, stdout });

    expect(ended()).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(taskAction("/Run")).toBe(true);
  });

  test("preserves a replacement owner when the captured PID exits during the RPC", async ({
    env,
    stdout,
  }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockWindowsTaskkillSuccess();
    readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
    callGatewayCli.mockImplementation(async () => {
      readGatewayOwnerLease.mockReturnValue({
        ...GATEWAY_OWNER,
        owner: "replacement",
        pid: 5252,
      });
      mockProcessCommands(() => spawnSyncResult("No tasks"));
      throw new Error("connection closed");
    });
    const warn = vi.fn();
    await expect(restartScheduledTask({ env, stdout, warn })).rejects.toThrow(
      "Gateway ownership changed; restart unverified",
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("replacement"));
    expect(taskAction("/End", "/Run")).toBe(false);
  });

  test.for([
    { name: "restart", control: restartScheduledTask },
    { name: "stop after lost reply", control: stopScheduledTask, lostReply: true },
    { name: "stop without a database owner", control: stopScheduledTask, fileLock: true },
  ])(
    "$name requests graceful exit before ending the task",
    async ({ control, lostReply, fileLock }, { env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mockWindowsTaskkillSuccess();
      readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
      if (fileLock) {
        mockOwnerlessInstalledGateway();
        readActiveGatewayLockIdentity.mockResolvedValue(gatewayFileLock);
      }
      const onMutation = vi.fn();
      callGatewayCli.mockImplementation(async (options) => {
        options.assertDispatchCurrent();
        expect(taskAction("/End")).toBe(false);
        readGatewayOwnerLease.mockReturnValue(undefined);
        spawnSync.mockImplementation((exe) =>
          spawnSyncResult(
            exe.endsWith("tasklist.exe") ? "No tasks" : scheduledTaskProbeResult().stdout,
          ),
        );
        if (lostReply) {
          throw new Error("connection closed after dispatch");
        }
        return { ok: true, pid: GATEWAY_OWNER.pid, status: "scheduled", timeoutMs: 330_000 };
      });

      await control({ env, stdout, onMutation });
      if (lostReply) {
        expect(onMutation).toHaveBeenCalledExactlyOnceWith({ mode: "schtasks-stop" });
      }

      expect(callGatewayCli).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "gateway.stop.request",
          params: {
            target: { pid: GATEWAY_OWNER.pid, ownerId: GATEWAY_OWNER.owner, port: 18789 },
          },
        }),
      );
      expect(taskAction("/End")).toBe(false);
      expect(killedOwner()).toBe(false);
      expect(taskAction("/Run")).toBe(control === restartScheduledTask);
    },
  );

  test.for([
    { name: "another process", lock: { ...gatewayFileLock, pid: 5252 } },
    { name: "another port", lock: { ...gatewayFileLock, port: 18790 } },
    { name: "an uncorrelated owner", lock: { ...gatewayFileLock, ownerId: undefined } },
  ])(
    "keeps native stop recovery when the file lock belongs to $name",
    async ({ lock }, { env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mockOwnerlessInstalledGateway();
      readActiveGatewayLockIdentity.mockResolvedValue(lock);

      await stopScheduledTask({ env, stdout });

      expect(callGatewayCli).not.toHaveBeenCalled();
      expect(killedOwner()).toBe(true);
      expect(taskAction("/Run")).toBe(false);
    },
  );

  test.for([
    { mode: "graceful", errcode: 1546, exhausted: true },
    { mode: "native", errcode: 1546, exhausted: false },
    { mode: "native", errcode: 1546, exhausted: true },
  ])(
    "recovers SQLite sharing error $errcode after $mode stop (exhausted=$exhausted)",
    async ({ mode, errcode, exhausted }, { env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mockWindowsTaskkillSuccess();
      const warn = vi.fn();
      let failed = false;
      const failRead = () => {
        failed = true;
        throw Object.assign(new Error("disk I/O error"), {
          errcode,
          ...(exhausted ? {} : { code: "ERR_SQLITE_ERROR" }),
        });
      };
      readGatewayOwnerLease.mockImplementation(() => {
        const stopped = killedOwner();
        if (stopped && (exhausted || !failed)) {
          failRead();
        }
        return stopped ? undefined : GATEWAY_OWNER;
      });
      if (mode === "graceful") {
        mockGracefulStop(() => {
          readGatewayOwnerLease.mockImplementation(failRead);
          mockProcessCommands((exe) =>
            spawnSyncResult(exe.endsWith("tasklist.exe") ? "No tasks" : ""),
          );
        });
      }
      await expect(restartScheduledTask({ env, stdout, warn })).resolves.toEqual(
        settledTask(false, exhausted ? "sqlite-owner-read" : undefined),
      );
      expect(failed).toBe(true);
      if (exhausted) {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("SQLite"));
      }
      expect(schtasksCalls).toContainEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    },
  );
});

const { stopRegisteredScheduledTask } = await import("./schtasks-control.js");

describe("Scheduled Task settlement", () => {
  test("preserves a node-host replacement published during End", async ({ env, stdout }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    env.OPENCLAW_SERVICE_KIND = "node";
    env.OPENCLAW_WINDOWS_TASK_NAME = "OpenClaw Node";
    env.OPENCLAW_TASK_SCRIPT_NAME = "node.cmd";
    const scriptPath = resolveTaskScriptPath(env);
    const original =
      "@echo off\r\nC:\\node-a.exe C:\\openclaw\\entry.js node run --host 127.0.0.1 --port 18789\r\n";
    const replacement = original.replace("node-a.exe", "node-b.exe");
    writeFileSync(scriptPath, original);
    const push = schtasksCalls.push.bind(schtasksCalls);
    vi.spyOn(schtasksCalls, "push").mockImplementation((...calls) => {
      if (calls.some(([action]) => action === "/End")) {
        writeFileSync(scriptPath, replacement);
      }
      return push(...calls);
    });
    let killed = false;
    spawnSync.mockImplementation((exe) => {
      if (exe.endsWith("taskkill.exe")) {
        killed = true;
        return spawnSyncResult("");
      }
      if (exe.endsWith("tasklist.exe")) {
        return spawnSyncResult(killed ? "No tasks" : '"node.exe","5151","Console","1","1 K"');
      }
      return jsonResult([{ ProcessId: 5151, CommandLine: replacement.split("\r\n")[1] }]);
    });
    await expect(
      stopRegisteredScheduledTask({
        env,
        stdout,
        assertCurrent: () => {},
        beforeMutation: async () => {
          if (readFileSync(scriptPath, "utf8") !== original) {
            throw new Error("Original node definition changed");
          }
        },
      }),
    ).rejects.toThrow("Original node definition changed");
    expect(killed).toBe(false);
    expect(readFileSync(scriptPath, "utf8")).toBe(replacement);
  });
  test.for(["capture", "end"])(
    "preserves a registration changed during native %s",
    async (phase, { env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      let changed = false;
      let exited = false;
      readGatewayOwnerLease.mockImplementation(() => (exited ? undefined : GATEWAY_OWNER));
      mockProcessCommands(
        (exe) =>
          spawnSyncResult(exe.endsWith("tasklist.exe") && !exited ? processList() : "No tasks"),
        () => {
          if (phase === "capture") {
            changed = true;
          }
          return scheduledTaskProbeResult(taskAction("/End") ? 3 : 4);
        },
      );
      mockGracefulStop(() => {
        exited = true;
        if (phase === "end") {
          changed = true;
        }
      });
      await expect(
        stopRegisteredScheduledTask({
          env,
          stdout,
          beforeMutation: async () => {
            if (changed) {
              throw new Error("Original registration changed");
            }
          },
        }),
      ).rejects.toThrow("Original registration changed");
      expect(taskAction("/End", "/Run")).toBe(false);
      if (phase === "capture") {
        expect(callGatewayCli).not.toHaveBeenCalled();
      }
    },
  );
  test.for([
    {
      name: "Ready before its result is recorded",
      end: false,
      delayedResult: true,
      settles: true,
    },
    {
      name: "an unsettled supervisor",
      end: true,
      delayedResult: false,
      settles: true,
    },
    {
      name: "a task that stays Running after End",
      end: true,
      delayedResult: false,
      settles: false,
    },
  ])(
    "requires task settlement before Run after $name",
    async ({ end, delayedResult, settles }, { env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      let exited = false;
      let ready = false;
      const events: string[] = [];
      const push = schtasksCalls.push.bind(schtasksCalls);
      vi.spyOn(schtasksCalls, "push").mockImplementation((...calls) => {
        for (const [action] of calls) {
          if (action === "/End") {
            events.push("end");
          }
          if (action === "/Run") {
            expect(ready).toBe(true);
            events.push("run");
          }
        }
        return push(...calls);
      });
      readGatewayOwnerLease.mockImplementation(() => (exited ? undefined : GATEWAY_OWNER));
      spawnSync.mockImplementation((exe, args) => {
        if (exe.endsWith("taskkill.exe")) {
          exited = true;
        }
        if (args?.includes("-EncodedCommand")) {
          ready = settles && exited && (end ? events.includes("end") : Date.now() >= 200);
          if (ready) {
            events.push("ready");
          }
          return jsonResult({
            state: events.includes("run") ? 4 : ready ? 3 : 4,
            lastRunResult: events.includes("run")
              ? 267009
              : delayedResult && Date.now() < 500
                ? undefined
                : ready
                  ? 0
                  : 267009,
            lastRunTime: "2026-09-27T00:00:00.0000000Z",
          });
        }
        return spawnSyncResult(
          exe.endsWith("tasklist.exe") && !exited ? processList() : "No tasks",
        );
      });
      mockGracefulStop(() => {
        exited = true;
      });

      const operation = restartScheduledTask({ env, stdout });
      if (!settles) {
        await expect(operation).rejects.toThrow("did not settle; /Run refused");
        expect(events).toEqual(["end"]);
        expect(Date.now()).toBeLessThanOrEqual(GATEWAY_SERVICE_STOP_TIMEOUT_MS);
        return;
      }
      const result = await operation;

      expect(events.indexOf("ready")).toBeLessThan(events.indexOf("run"));
      expect(Date.now()).toBeGreaterThanOrEqual(500);
      expect(events.includes("end")).toBe(end);
      expect(killedOwner()).toBe(false);
      expect(result).toEqual(settledTask(end));
    },
  );

  test("settles a Disabled update task without overriding its stale result or enabled policy", async ({
    env,
    stdout,
  }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockWindowsTaskkillSuccess();
    readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
    mockGracefulStop(() => {
      readGatewayOwnerLease.mockReturnValue(undefined);
      spawnSync.mockImplementation((_exe, args) =>
        args?.includes("-EncodedCommand")
          ? jsonResult({
              state: 1,
              enabled: false,
              lastRunResult: 267009,
              lastRunTime: "2026-09-27T00:00:00.0000000Z",
            })
          : spawnSyncResult("No tasks"),
      );
    });

    await stopScheduledTask({ env, stdout });

    expect(taskAction("/End", "/Run", "/Change")).toBe(false);
    expect(stdout.read()?.toString()).toContain("Stopped Scheduled Task");
  });

  test("does not end a replacement task instance during native fallback", async ({
    env,
    stdout,
  }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    let originalAlive = true;
    let replacementAlive = true;
    const push = schtasksCalls.push.bind(schtasksCalls);
    vi.spyOn(schtasksCalls, "push").mockImplementation((...calls) => {
      if (calls.some(([action]) => action === "/End")) {
        originalAlive = false;
        replacementAlive = false;
      }
      return push(...calls);
    });
    readGatewayOwnerLease.mockImplementation(() => (originalAlive ? GATEWAY_OWNER : undefined));
    spawnSync.mockImplementation((exe, args) => {
      if (args?.includes("-EncodedCommand")) {
        return jsonResult({
          state: 4,
          lastRunResult: 267009,
          lastRunTime: originalAlive ? "original" : "replacement",
        });
      }
      if (exe.endsWith("taskkill.exe") && args?.includes("4242")) {
        originalAlive = false;
      }
      return spawnSyncResult(
        exe.endsWith("tasklist.exe") && originalAlive ? processList() : "No tasks",
      );
    });

    await expect(restartScheduledTask({ env, stdout })).rejects.toMatchObject({
      message: "Gateway ownership changed; restart unverified.",
      taskSettlement: {
        status: "replaced",
        taskName: "OpenClaw Gateway",
        lastRunTime: "replacement",
      },
    });

    expect(originalAlive).toBe(false);
    expect(replacementAlive).toBe(true);
    expect(taskAction("/End", "/Run")).toBe(false);
  });

  test.for(["end-unavailable", "stop", "no-owner"] as const)(
    "handles %s settlement inspection without reporting a false restart",
    async (failure, { env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      let now = 0;
      let exited = false;
      let failedProbes = 0;
      let prepared = false;
      const noRun = failure === "stop" || failure === "no-owner";
      const onMutation = vi.fn();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      readGatewayOwnerLease.mockImplementation(() =>
        exited || failure === "no-owner" ? undefined : GATEWAY_OWNER,
      );
      mockGracefulStop(() => {
        exited = true;
      });
      const push = schtasksCalls.push.bind(schtasksCalls);
      vi.spyOn(schtasksCalls, "push").mockImplementation((...calls) => {
        if (calls.some(([action]) => failure === "end-unavailable" && action === "/End")) {
          schtasksResponses.push({ code: 1, stdout: "", stderr: "Access denied" });
        }
        return push(...calls);
      });
      spawnSync.mockImplementation((exe, args, options) => {
        if (args?.includes("-EncodedCommand")) {
          if (!prepared) {
            prepared = true;
            return scheduledTaskProbeResult(4);
          }
          if (failure === "end-unavailable" && exited && !taskAction("/End")) {
            now += Math.min(
              Number(options?.timeout),
              GATEWAY_SERVICE_STOP_TIMEOUT_MS - 135_000 - now,
            );
            return scheduledTaskProbeResult(4);
          }
          if ((exited || failure === "no-owner") && !taskAction("/Run")) {
            failedProbes++;
            now += Number(options?.timeout);
            return {
              ...spawnSyncResult("", 1),
              error: Object.assign(new Error("probe timed out"), { code: "ETIMEDOUT" }),
            };
          }
          return scheduledTaskProbeResult(exited ? undefined : 4);
        }
        return spawnSyncResult(
          exe.endsWith("tasklist.exe") && !exited && failure !== "no-owner"
            ? processList()
            : "No tasks",
        );
      });
      const control = failure === "stop" ? stopScheduledTask : restartScheduledTask;
      const operation = control({ env, stdout, onMutation });
      const error = await operation.catch((caughtError: unknown) => caughtError);
      expect(error).toBeInstanceOf(Error);
      const fact = {
        status: "unavailable",
        taskName: "OpenClaw Gateway",
        ended: failure === "end-unavailable",
      };
      expect(error).toMatchObject(noRun ? { cause: fact } : { taskSettlement: fact });
      expect(String(error)).toContain(noRun ? "stop unverified" : "restart unverified");
      expect(failedProbes).toBeGreaterThan(1);
      expect(now).toBe(GATEWAY_SERVICE_STOP_TIMEOUT_MS);
      expect(stdout.read()?.toString() ?? "").not.toContain("Restarted Scheduled Task");
      expect(taskAction("/Run")).toBe(!noRun);
      if (!noRun) {
        expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-restart" });
      } else {
        expect(onMutation).not.toHaveBeenCalledWith({ mode: "schtasks-restart" });
      }
      expect(taskAction("/End")).toBe(failure === "end-unavailable");
      expect(killedOwner()).toBe(false);
    },
  );
});

describe("Scheduled Task stop/restart cleanup", () => {
  test("suspends a task whose Settings.Enabled value uses the default", async ({ env }) => {
    queueTaskXml(
      "<Task><Settings><StartWhenAvailable>true</StartWhenAvailable></Settings></Task>",
      { ...SUCCESS_RESPONSE },
    );

    await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(true);

    expectTaskCommands(["/Query", "/XML"], ["/Change", "/DISABLE"]);
  });

  test("preserves an already-disabled task", async ({ env }) => {
    queueTaskXml(
      "<Task><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><Enabled>false</Enabled></Settings></Task>",
    );

    await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(false);

    expectTaskCommands(["/Query", "/XML"]);
  });

  test("fails closed when task absence cannot be confirmed", async ({ env }) => {
    schtasksResponses.push({
      code: 1,
      stdout: "",
      stderr: "ERROR: The system cannot find the file specified.",
    });

    await expect(suspendScheduledTaskAutoStartForUpdate(env)).rejects.toThrow(
      "schtasks XML query failed: ERROR: The system cannot find the file specified.",
    );

    expectTaskCommands(["/Query", "/XML"]);
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  test("fails closed when the task enabled state is missing", async ({ env }) => {
    queueTaskXml("<Task><Triggers /></Task>");

    await expect(suspendScheduledTaskAutoStartForUpdate(env)).rejects.toThrow(
      "schtasks XML query did not expose the task enabled state",
    );
  });

  test("restores an enabled task after an ambiguous disable failure", async ({ env }) => {
    queueTaskXml(
      "<Task><Settings><Enabled>true</Enabled></Settings></Task>",
      { code: 124, stdout: "", stderr: "schtasks timed out after 15000ms" },
      { ...SUCCESS_RESPONSE },
    );

    await expect(suspendScheduledTaskAutoStartForUpdate(env)).rejects.toThrow(
      "Scheduled Task disable failed: schtasks timed out after 15000ms",
    );

    expectTaskCommands(["/Query", "/XML"], ["/Change", "/DISABLE"], ["/Change", "/ENABLE"]);
  });

  test("leaves startup-folder fallback installs unchanged when the task is absent", async ({
    env,
  }) => {
    const startupEntry = resolveStartupFixturePath(env);
    await fs.mkdir(path.dirname(startupEntry), { recursive: true });
    await fs.writeFile(startupEntry, "@echo off\r\n", "utf8");
    schtasksResponses.push({
      code: 1,
      stdout: "",
      stderr: "FEHLER: Die angegebene Datei wurde nicht gefunden.",
    });
    spawnSync.mockReturnValueOnce(spawnSyncResult("-2147024894", 1));

    await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(false);

    expectTaskCommands(["/Query", "/XML"]);
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  test("surfaces a failed task reenable", async ({ env }) => {
    schtasksResponses.push({ code: 1, stdout: "", stderr: "ERROR: Access is denied." });

    await expect(resumeScheduledTaskAutoStartAfterUpdate(env)).rejects.toThrow(
      "Scheduled Task enable failed: ERROR: Access is denied.",
    );
  });
});
