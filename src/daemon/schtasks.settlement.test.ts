import { readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it as baseIt, vi } from "vitest";
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
  schtasksCalls,
  schtasksResponses,
} from "./test-helpers/schtasks-fixtures.js";

type TaskFixture = Parameters<Parameters<typeof withPreparedGatewayTask>[0]>[0];
const it = baseIt.extend<TaskFixture & { taskFixture: TaskFixture }>({
  taskFixture: async ({ task: _task }, use) => withPreparedGatewayTask(use),
  env: async ({ taskFixture }, use) => use(taskFixture.env),
  stdout: async ({ taskFixture }, use) => use(taskFixture.stdout),
});
const taskAction = (...actions: string[]) =>
  schtasksCalls.some(([action]) => actions.includes(action));
const taskKilled = () => spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"));
const taskList = (alive: boolean, pid = 4242) =>
  alive ? `"node.exe","${pid}","Console","1","1 K"` : "No tasks";
const stopReply = () => ({ ok: true, pid: GATEWAY_OWNER.pid, status: "scheduled" });
const settledResult = (ended = false) => ({
  outcome: "completed",
  taskSettlement: {
    status: "settled",
    taskName: "OpenClaw Gateway",
    lastRunResult: "0",
    ended,
  },
});
type NativeProbe = NonNullable<ReturnType<typeof spawnSync.getMockImplementation>>;
function mockNativeProbes(probe: NativeProbe, processes: NativeProbe) {
  spawnSync.mockImplementation((exe, args, options) =>
    (args?.includes("-EncodedCommand") ? probe : processes)(exe, args, options),
  );
}
function probeResult(facts: Record<string, unknown>) {
  return spawnSyncResult(JSON.stringify(facts));
}
function mockTasklist(isAlive: () => boolean, probe: NativeProbe) {
  mockNativeProbes(probe, (exe) =>
    spawnSyncResult(taskList(exe.endsWith("tasklist.exe") && isAlive())),
  );
}
function onTaskAction(onAction: (action: string) => void) {
  const push = schtasksCalls.push.bind(schtasksCalls);
  vi.spyOn(schtasksCalls, "push").mockImplementation((...calls) => {
    calls.forEach(([action]) => onAction(action));
    return push(...calls);
  });
}
function mockGracefulStop(onStop: () => void) {
  callGatewayCli.mockImplementation(async (options) => {
    options.assertDispatchCurrent();
    onStop();
    return stopReply();
  });
}
function expectNoNativeMutation() {
  expect(taskKilled()).toBe(false);
  expect(taskAction("/End", "/Run")).toBe(false);
}
const taskXml = (contents: string) => ({ ...SUCCESS_RESPONSE, stdout: `<Task>${contents}</Task>` });
const taskFailure = (stderr: string, code = 1) => ({ code, stdout: "", stderr });
const queryCall = ["/Query", "/TN", "OpenClaw Gateway", "/XML"];
const changeCall = (enabled: boolean) => [
  "/Change",
  "/TN",
  "OpenClaw Gateway",
  enabled ? "/ENABLE" : "/DISABLE",
];

describe("Scheduled Task shutdown and SQLite handle release", () => {
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  });
  it("refuses restart without an inspectable Gateway identity", async ({ env, stdout }) => {
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

  it.for(["still alive", "unverified"])(
    "refuses lease-read recovery for a captured process that is %s",
    async (state, { env, stdout }) => {
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
        spawnSync.mockImplementation((exe, args) => {
          if (args?.includes("-EncodedCommand")) {
            return scheduledTaskProbeResult();
          }
          attempted ||= exe.endsWith("taskkill.exe");
          return spawnSyncResult(exe.endsWith("tasklist.exe") ? taskList(true) : "");
        });
      }
      await expect(restartScheduledTask({ env, stdout })).rejects.toThrow(
        state === "unverified" ? "disk I/O error" : "state writer",
      );
      expect(taskAction("/Run")).toBe(false);
      if (state === "unverified") {
        expect(taskAction("/End")).toBe(false);
        expect(taskKilled()).toBe(false);
      }
    },
  );

  it("stops pre-existing children without adopting a replacement", async ({ env, stdout }) => {
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
        return spawnSyncResult(taskList(!killed.has(pid), pid));
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
      return spawnSyncResult(JSON.stringify(children));
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

  it("preserves a reused legacy PID before native task termination", async ({ env, stdout }) => {
    mockLingeringGatewayListener(4242);
    readWindowsProcessStartTimeSync.mockReturnValueOnce(100).mockReturnValue(200);
    spawnSync.mockImplementation((exe, args) =>
      args?.includes("-EncodedCommand")
        ? scheduledTaskProbeResult()
        : spawnSyncResult(
            exe.endsWith("tasklist.exe")
              ? taskList(true)
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

  it.for([
    ["stop", stopScheduledTask, 5252, 200],
    ["restart with PID reuse", restartScheduledTask, 4242, 200],
    ["restart with new task instance", restartScheduledTask, 4242, 100],
  ] as const)(
    "%s preserves a replacement between stop and cleanup",
    async ([_name, control, pid, startedAt], { env, stdout }) => {
      const warn = vi.fn();
      readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
      mockWindowsTaskkillSuccess();
      mockLingeringGatewayListener(pid);
      mockGracefulStop(() => {
        readGatewayOwnerLease.mockReturnValue(undefined);
        let replacementStarted = false;
        spawnSync.mockImplementation((exe, args) => {
          if (args?.includes("-EncodedCommand")) {
            return scheduledTaskProbeResult();
          }
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
              ? taskList(true)
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

  it("restart falls back promptly after a definitive stop rejection", async ({ env, stdout }) => {
    readGatewayOwnerLease.mockImplementation(() => (taskKilled() ? undefined : GATEWAY_OWNER));
    spawnSync.mockImplementation((exe, args) => {
      if (args?.includes("-EncodedCommand")) {
        return scheduledTaskProbeResult();
      }
      if (exe.toLowerCase().endsWith("tasklist.exe")) {
        return spawnSyncResult(taskList(!taskKilled()));
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

    expect(taskKilled()).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(taskAction("/Run")).toBe(true);
  });

  it("preserves a replacement owner when the captured PID exits during the RPC", async ({
    env,
    stdout,
  }) => {
    mockWindowsTaskkillSuccess();
    readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
    callGatewayCli.mockImplementation(async () => {
      readGatewayOwnerLease.mockReturnValue({ ...GATEWAY_OWNER, owner: "replacement", pid: 5252 });
      mockNativeProbes(
        () => scheduledTaskProbeResult(),
        () => spawnSyncResult("No tasks"),
      );
      throw new Error("connection closed");
    });
    const warn = vi.fn();
    await expect(restartScheduledTask({ env, stdout, warn })).rejects.toThrow(
      "Gateway ownership changed; restart unverified",
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("replacement"));
    expect(taskAction("/End", "/Run")).toBe(false);
  });

  it.for([
    { name: "restart", control: restartScheduledTask },
    { name: "stop after lost reply", control: stopScheduledTask, lostReply: true },
  ])(
    "$name requests graceful exit before ending the task",
    async ({ control, lostReply }, { env, stdout }) => {
      mockWindowsTaskkillSuccess();
      readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
      const onMutation = vi.fn();
      callGatewayCli.mockImplementation(async (options) => {
        if (lostReply) {
          options.assertDispatchCurrent();
        }
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
      expect(taskKilled()).toBe(false);
      expect(taskAction("/Run")).toBe(control === restartScheduledTask);
    },
  );

  it.for([
    ["graceful", true],
    ["native", false],
    ["native", true],
  ] as const)(
    "recovers SQLite sharing error after %s stop (exhausted=%s)",
    async ([mode, exhausted], { env, stdout }) => {
      mockWindowsTaskkillSuccess();
      const warn = vi.fn();
      let failed = false;
      const failRead = () => {
        failed = true;
        throw Object.assign(new Error("disk I/O error"), {
          errcode: 1546,
          ...(exhausted ? {} : { code: "ERR_SQLITE_ERROR" }),
        });
      };
      readGatewayOwnerLease.mockImplementation(() => {
        const stopped = taskKilled();
        if (stopped && (exhausted || !failed)) {
          failRead();
        }
        return stopped ? undefined : GATEWAY_OWNER;
      });
      if (mode === "graceful") {
        mockGracefulStop(() => {
          readGatewayOwnerLease.mockImplementation(failRead);
          mockNativeProbes(
            () => scheduledTaskProbeResult(),
            (exe) => spawnSyncResult(exe.endsWith("tasklist.exe") ? "No tasks" : ""),
          );
        });
      }
      await expect(restartScheduledTask({ env, stdout, warn })).resolves.toEqual({
        ...settledResult(),
        ...(exhausted ? { restartRecovery: "sqlite-owner-read" } : {}),
      });
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
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  });
  it("preserves a node-host replacement published during End", async ({ env, stdout }) => {
    env.OPENCLAW_SERVICE_KIND = "node";
    env.OPENCLAW_WINDOWS_TASK_NAME = "OpenClaw Node";
    env.OPENCLAW_TASK_SCRIPT_NAME = "node.cmd";
    const scriptPath = resolveTaskScriptPath(env);
    const original =
      "@echo off\r\nC:\\node-a.exe C:\\openclaw\\entry.js node run --host 127.0.0.1 --port 18789\r\n";
    const replacement = original.replace("node-a.exe", "node-b.exe");
    writeFileSync(scriptPath, original);
    onTaskAction((action) => {
      if (action === "/End") {
        writeFileSync(scriptPath, replacement);
      }
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
      return spawnSyncResult(
        JSON.stringify([{ ProcessId: 5151, CommandLine: replacement.split("\r\n")[1] }]),
      );
    });
    await expect(
      stopRegisteredScheduledTask({
        env,
        stdout,
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
  it.for(["capture", "end"])(
    "preserves a registration changed during native %s",
    async (phase, { env, stdout }) => {
      let changed = false;
      let exited = false;
      readGatewayOwnerLease.mockImplementation(() => (exited ? undefined : GATEWAY_OWNER));
      mockTasklist(
        () => !exited,
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
  it.for([
    ["Ready before result", false, true, true],
    ["unsettled supervisor", true, false, true],
    ["Running after End", true, false, false],
  ] as const)(
    "requires task settlement before Run: %s",
    async ([_name, end, delayedResult, settles], { env, stdout }) => {
      let exited = false;
      let ready = false;
      const events: string[] = [];
      onTaskAction((action) => {
        if (action === "/End") {
          events.push("end");
        }
        if (action === "/Run") {
          expect(ready).toBe(true);
          events.push("run");
        }
      });
      readGatewayOwnerLease.mockImplementation(() => (exited ? undefined : GATEWAY_OWNER));
      spawnSync.mockImplementation((exe, args) => {
        if (exe.endsWith("taskkill.exe")) {
          exited = true;
        }
        if (args?.includes("-EncodedCommand")) {
          ready =
            settles &&
            exited &&
            (end ? events.includes("end") : Date.now() >= (delayedResult ? 200 : 500));
          if (ready) {
            events.push("ready");
          }
          return probeResult({
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
          exe.endsWith("tasklist.exe") && !exited ? taskList(true) : "No tasks",
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
      expect(taskKilled()).toBe(false);
      expect(result).toEqual(settledResult(end));
    },
  );

  it("settles Disabled tasks without overriding result or policy", async ({ env, stdout }) => {
    mockWindowsTaskkillSuccess();
    readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
    mockGracefulStop(() => {
      readGatewayOwnerLease.mockReturnValue(undefined);
      mockNativeProbes(
        () =>
          probeResult({
            state: 1,
            enabled: false,
            lastRunResult: 267009,
            lastRunTime: "2026-09-27T00:00:00.0000000Z",
          }),
        () => spawnSyncResult("No tasks"),
      );
    });

    await stopScheduledTask({ env, stdout });

    expect(taskAction("/End", "/Run", "/Change")).toBe(false);
    expect(stdout.read()?.toString()).toContain("Stopped Scheduled Task");
  });

  it("does not end a replacement task instance during native fallback", async ({ env, stdout }) => {
    let originalAlive = true;
    let replacementAlive = true;
    onTaskAction((action) => {
      if (action === "/End") {
        originalAlive = false;
        replacementAlive = false;
      }
    });
    readGatewayOwnerLease.mockImplementation(() => (originalAlive ? GATEWAY_OWNER : undefined));
    spawnSync.mockImplementation((exe, args) => {
      if (args?.includes("-EncodedCommand")) {
        return probeResult({
          state: 4,
          lastRunResult: 267009,
          lastRunTime: originalAlive ? "original" : "replacement",
        });
      }
      if (exe.endsWith("taskkill.exe") && args?.includes("4242")) {
        originalAlive = false;
      }
      return spawnSyncResult(
        exe.endsWith("tasklist.exe") && originalAlive ? taskList(true) : "No tasks",
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

  it.for(["end-unavailable", "stop", "no-owner"] as const)(
    "handles %s settlement inspection without reporting a false restart",
    async (failure, { env, stdout }) => {
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
      onTaskAction((action) => {
        if (failure === "end-unavailable" && action === "/End") {
          schtasksResponses.push({ code: 1, stdout: "", stderr: "Access denied" });
        }
      });
      mockTasklist(
        () => !exited && failure !== "no-owner",
        (_exe, _args, options) => {
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
        },
      );
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
      expect(taskKilled()).toBe(false);
    },
  );
});

describe("Scheduled Task stop/restart cleanup", () => {
  it.for([
    ["default enabled", "<Settings><StartWhenAvailable>true</StartWhenAvailable></Settings>", true],
    [
      "disabled despite enabled trigger",
      "<Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><Enabled>false</Enabled></Settings>",
      false,
    ],
  ] as const)("suspends only an enabled task: %s", async ([_name, xml, enabled], { env }) => {
    schtasksResponses.push(taskXml(xml), ...(enabled ? [{ ...SUCCESS_RESPONSE }] : []));
    await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(enabled);
    expect(schtasksCalls).toEqual([queryCall, ...(enabled ? [changeCall(false)] : [])]);
  });

  it.for([
    [
      "unconfirmed absence",
      taskFailure("ERROR: The system cannot find the file specified."),
      "schtasks XML query failed: ERROR: The system cannot find the file specified.",
      true,
    ],
    [
      "missing enabled state",
      taskXml("<Triggers />"),
      "schtasks XML query did not expose the task enabled state",
      false,
    ],
  ] as const)("fails closed on %s", async ([_name, response, message, queryOnly], { env }) => {
    schtasksResponses.push(response);
    await expect(suspendScheduledTaskAutoStartForUpdate(env)).rejects.toThrow(message);
    if (queryOnly) {
      expect(schtasksCalls).toEqual([queryCall]);
      expect(spawnSync).toHaveBeenCalledOnce();
    }
  });

  it("restores an enabled task after an ambiguous disable failure", async ({ env }) => {
    schtasksResponses.push(
      taskXml("<Settings><Enabled>true</Enabled></Settings>"),
      taskFailure("schtasks timed out after 15000ms", 124),
      { ...SUCCESS_RESPONSE },
    );

    await expect(suspendScheduledTaskAutoStartForUpdate(env)).rejects.toThrow(
      "schtasks disable failed: schtasks timed out after 15000ms",
    );

    expect(schtasksCalls).toEqual([queryCall, changeCall(false), changeCall(true)]);
  });

  it("preserves startup-folder fallback when the task is absent", async ({ env }) => {
    const startupEntry = path.join(
      expectDefined(env.APPDATA, "env.APPDATA test invariant"),
      "Microsoft/Windows/Start Menu/Programs/Startup/OpenClaw Gateway.cmd",
    );
    await fs.mkdir(path.dirname(startupEntry), { recursive: true });
    await fs.writeFile(startupEntry, "@echo off\r\n", "utf8");
    schtasksResponses.push(taskFailure("FEHLER: Die angegebene Datei wurde nicht gefunden."));
    spawnSync.mockReturnValueOnce(spawnSyncResult("-2147024894", 1));

    await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(false);

    expect(schtasksCalls).toEqual([queryCall]);
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  it("surfaces a failed task reenable", async ({ env }) => {
    schtasksResponses.push(taskFailure("ERROR: Access is denied."));

    await expect(resumeScheduledTaskAutoStartAfterUpdate(env)).rejects.toThrow(
      "schtasks enable failed: ERROR: Access is denied.",
    );
  });
});
