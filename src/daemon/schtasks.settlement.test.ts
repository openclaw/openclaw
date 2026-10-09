import { readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
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

describe("Scheduled Task shutdown and SQLite handle release", () => {
  it("refuses restart without an inspectable Gateway identity", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      delete env.OPENCLAW_GATEWAY_PORT;
      await fs.rm(resolveTaskScriptPath(env));
      const onMutation = vi.fn();

      await expect(restartScheduledTask({ env, stdout, onMutation })).rejects.toThrow(
        "Gateway identity unavailable",
      );
      expect(onMutation).not.toHaveBeenCalled();
      expect(callGatewayCli).not.toHaveBeenCalled();
      expect(spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"))).toBe(false);
      expect(schtasksCalls.some(([action]) => action === "/End" || action === "/Run")).toBe(false);
    });
  });

  it.each(["still alive", "unverified"])(
    "refuses lease-read recovery for a captured process that is %s",
    async (state) => {
      await withPreparedGatewayTask(async ({ env, stdout }) => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        let attempted = false;
        let reads = 0;
        readGatewayOwnerLease.mockImplementation(() => {
          const unavailable =
            state === "unverified"
              ? ++reads > 1
              : attempted || schtasksCalls.some(([action]) => action === "/End");
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
            if (
              args?.includes("-EncodedCommand") ||
              (args?.join(" ") ?? "").includes("Schedule.Service")
            ) {
              return scheduledTaskProbeResult();
            }
            attempted ||= exe.endsWith("taskkill.exe");
            return spawnSyncResult(
              exe.endsWith("tasklist.exe") ? '"node.exe","4242","Console","1","1 K"' : "",
            );
          });
        }
        await expect(restartScheduledTask({ env, stdout })).rejects.toThrow(
          state === "unverified" ? "disk I/O error" : "state writer",
        );
        expect(schtasksCalls.some(([action]) => action === "/Run")).toBe(false);
        if (state === "unverified") {
          expect(schtasksCalls.some(([action]) => action === "/End")).toBe(false);
          expect(spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"))).toBe(false);
        }
      });
    },
  );

  it.each([true])(
    "stops pre-existing children without adopting a replacement (published owner=%s)",
    async (publishedOwner) => {
      await withPreparedGatewayTask(async ({ env, stdout }) => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        const killed = new Set<number>();
        readGatewayOwnerLease.mockImplementation(() =>
          publishedOwner
            ? { ...GATEWAY_OWNER, state: killed.has(4242) ? "dead" : "live" }
            : undefined,
        );
        readWindowsProcessStartTimeSync.mockImplementation((pid) => (pid === 5151 ? 200 : 100));
        spawnSync.mockImplementation((exe, args) => {
          if (
            args?.includes("-EncodedCommand") ||
            (args?.join(" ") ?? "").includes("Schedule.Service")
          ) {
            return scheduledTaskProbeResult(killed.has(4242) ? 3 : 4);
          }
          if (exe.endsWith("taskkill.exe")) {
            killed.add(Number(args?.[args.indexOf("/PID") + 1]));
            return spawnSyncResult("");
          }
          if (exe.endsWith("tasklist.exe")) {
            const pid = Number(args?.[1]?.split(" ").at(-1));
            return spawnSyncResult(
              killed.has(pid) ? "No tasks" : `"node.exe","${pid}","Console","1","1 K"`,
            );
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
        expect(schtasksCalls.some(([action]) => action === "/End" || action === "/Run")).toBe(
          false,
        );
      });
    },
  );

  it("preserves a reused legacy PID before native task termination", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mockLingeringGatewayListener(4242);
      readWindowsProcessStartTimeSync.mockReturnValueOnce(100).mockReturnValue(200);
      spawnSync.mockImplementation((exe, args) =>
        args?.includes("-EncodedCommand") || (args?.join(" ") ?? "").includes("Schedule.Service")
          ? scheduledTaskProbeResult()
          : spawnSyncResult(
              exe.endsWith("tasklist.exe")
                ? '"node.exe","4242","Console","1","1 K"'
                : JSON.stringify([
                    { ProcessId: 4242, CommandLine: INSTALLED_GATEWAY_COMMAND_LINE },
                  ]),
            ),
      );
      const warn = vi.fn();

      await expect(restartScheduledTask({ env, stdout, warn })).rejects.toThrow(
        "Gateway ownership changed; restart unverified",
      );

      expect(schtasksCalls.some(([action]) => action === "/End" || action === "/Run")).toBe(false);
      expect(spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"))).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("replacement"));
    });
  });

  it.each([
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
    async ({ control, pid, startedAt }) => {
      await withPreparedGatewayTask(async ({ env, stdout }) => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        const warn = vi.fn();
        readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
        mockWindowsTaskkillSuccess();
        mockLingeringGatewayListener(pid);
        callGatewayCli.mockImplementation(async (options) => {
          options.assertDispatchCurrent();
          readGatewayOwnerLease.mockReturnValue(undefined);
          let replacementStarted = false;
          spawnSync.mockImplementation((exe, args) => {
            if (
              args?.includes("-EncodedCommand") ||
              (args?.join(" ") ?? "").includes("Schedule.Service")
            ) {
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
                ? '"node.exe","4242","Console","1","1 K"'
                : "No tasks",
            );
          });
          return { ok: true, pid: GATEWAY_OWNER.pid, status: "scheduled" };
        });

        const operation = control({ env, stdout, warn });
        if (control === restartScheduledTask) {
          await expect(operation).rejects.toThrow("Gateway ownership changed; restart unverified");
        } else {
          await operation;
        }

        expect(spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"))).toBe(false);
        expect(schtasksCalls.some(([action]) => action === "/End" || action === "/Run")).toBe(
          false,
        );
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("replacement"));
      });
    },
  );

  it.each([{ name: "restart", control: restartScheduledTask }])(
    "$name falls back promptly after a definitive stop rejection",
    async ({ control }) => {
      await withPreparedGatewayTask(async ({ env, stdout }) => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        const ended = () => spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"));
        readGatewayOwnerLease.mockImplementation(() => (ended() ? undefined : GATEWAY_OWNER));
        spawnSync.mockImplementation((exe, args) => {
          if (
            args?.includes("-EncodedCommand") ||
            (args?.join(" ") ?? "").includes("Schedule.Service")
          ) {
            return scheduledTaskProbeResult();
          }
          if (exe.toLowerCase().endsWith("tasklist.exe")) {
            return spawnSyncResult(ended() ? "No tasks" : '"node.exe","4242","Console","1","1 K"');
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

        await control({ env, stdout });

        expect(ended()).toBe(true);
        expect(Date.now() - started).toBeLessThan(15_000);
        expect(schtasksCalls.some(([action]) => action === "/Run")).toBe(
          control === restartScheduledTask,
        );
      });
    },
  );

  it("preserves a replacement owner when the captured PID exits during the RPC", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mockWindowsTaskkillSuccess();
      readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
      callGatewayCli.mockImplementation(async () => {
        readGatewayOwnerLease.mockReturnValue({
          ...GATEWAY_OWNER,
          owner: "replacement",
          pid: 5252,
        });
        spawnSync.mockImplementation((_exe, args) =>
          args?.includes("-EncodedCommand") || (args?.join(" ") ?? "").includes("Schedule.Service")
            ? scheduledTaskProbeResult()
            : spawnSyncResult("No tasks"),
        );
        throw new Error("connection closed");
      });
      const warn = vi.fn();
      await expect(restartScheduledTask({ env, stdout, warn })).rejects.toThrow(
        "Gateway ownership changed; restart unverified",
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("replacement"));
      expect(schtasksCalls.some(([action]) => action === "/End" || action === "/Run")).toBe(false);
    });
  });

  it.each([
    { name: "restart", control: restartScheduledTask },
    { name: "stop after lost reply", control: stopScheduledTask, lostReply: true },
  ])("$name requests graceful exit before ending the task", async ({ control, lostReply }) => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mockWindowsTaskkillSuccess();
      readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
      const onMutation = vi.fn();
      callGatewayCli.mockImplementation(async (options) => {
        if (lostReply) {
          options.assertDispatchCurrent();
        }
        expect(schtasksCalls.some(([action]) => action === "/End")).toBe(false);
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
      expect(schtasksCalls.some(([action]) => action === "/End")).toBe(false);
      expect(spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"))).toBe(false);
      expect(schtasksCalls.some(([action]) => action === "/Run")).toBe(
        control === restartScheduledTask,
      );
    });
  });

  it.each([
    { mode: "graceful", errcode: 1546, exhausted: true },
    { mode: "native", errcode: 1546, exhausted: false },
    { mode: "native", errcode: 1546, exhausted: true },
  ])(
    "recovers SQLite sharing error $errcode after $mode stop (exhausted=$exhausted)",
    async ({ mode, errcode, exhausted }) => {
      await withPreparedGatewayTask(async ({ env, stdout }) => {
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
          const stopped = spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"));
          if (stopped && (exhausted || !failed)) {
            failRead();
          }
          return stopped ? undefined : GATEWAY_OWNER;
        });
        if (mode === "graceful") {
          callGatewayCli.mockImplementation(async (options) => {
            options.assertDispatchCurrent();
            readGatewayOwnerLease.mockImplementation(failRead);
            spawnSync.mockImplementation((exe, args) =>
              args?.includes("-EncodedCommand") ||
              (args?.join(" ") ?? "").includes("Schedule.Service")
                ? scheduledTaskProbeResult()
                : spawnSyncResult(exe.endsWith("tasklist.exe") ? "No tasks" : ""),
            );
            return { ok: true, pid: GATEWAY_OWNER.pid, status: "scheduled" };
          });
        }
        await expect(restartScheduledTask({ env, stdout, warn })).resolves.toEqual({
          outcome: "completed",
          ...(exhausted ? { restartRecovery: "sqlite-owner-read" } : {}),
          taskSettlement: {
            status: "settled",
            taskName: "OpenClaw Gateway",
            lastRunResult: "0",
            ended: false,
          },
        });
        expect(failed).toBe(true);
        if (exhausted) {
          expect(warn).toHaveBeenCalledWith(expect.stringContaining("SQLite"));
        }
        expect(schtasksCalls).toContainEqual(["/Run", "/TN", "OpenClaw Gateway"]);
      });
    },
  );
});

const { stopRegisteredScheduledTask } = await import("./schtasks-control.js");

describe("Scheduled Task settlement", () => {
  it("preserves a node-host replacement published during End", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
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
        return spawnSyncResult(
          JSON.stringify([{ ProcessId: 5151, CommandLine: replacement.split("\r\n")[1] }]),
        );
      });
      let failure: unknown;
      try {
        await stopRegisteredScheduledTask({
          env,
          stdout,
          assertCurrent: () => {},
          beforeMutation: async () => {
            if (readFileSync(scriptPath, "utf8") !== original) {
              throw new Error("Original node definition changed");
            }
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(killed).toBe(false);
      expect(String(failure)).toContain("Original node definition changed");
      expect(readFileSync(scriptPath, "utf8")).toBe(replacement);
    });
  });
  it.each(["capture", "end"])(
    "preserves a registration changed during native %s",
    async (phase) => {
      await withPreparedGatewayTask(async ({ env, stdout }) => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        let changed = false;
        let exited = false;
        readGatewayOwnerLease.mockImplementation(() => (exited ? undefined : GATEWAY_OWNER));
        spawnSync.mockImplementation((exe, args) => {
          if (
            args?.includes("-EncodedCommand") ||
            (args?.join(" ") ?? "").includes("Schedule.Service")
          ) {
            if (phase === "capture") {
              changed = true;
            }
            return scheduledTaskProbeResult(
              schtasksCalls.some(([action]) => action === "/End") ? 3 : 4,
            );
          }
          return spawnSyncResult(
            exe.endsWith("tasklist.exe") && !exited
              ? '"node.exe","4242","Console","1","1 K"'
              : "No tasks",
          );
        });
        callGatewayCli.mockImplementation(async (options) => {
          options.assertDispatchCurrent();
          exited = true;
          if (phase === "end") {
            changed = true;
          }
          return { ok: true, pid: GATEWAY_OWNER.pid, status: "scheduled" };
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
        expect(schtasksCalls.some(([action]) => action === "/End" || action === "/Run")).toBe(
          false,
        );
        if (phase === "capture") {
          expect(callGatewayCli).not.toHaveBeenCalled();
        }
      });
    },
  );
  it.each([
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
  ])("requires task settlement before Run after $name", async ({ end, delayedResult, settles }) => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
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
        if (
          args?.includes("-EncodedCommand") ||
          (args?.join(" ") ?? "").includes("Schedule.Service")
        ) {
          ready =
            settles &&
            exited &&
            (end ? events.includes("end") : Date.now() >= (delayedResult ? 200 : 500));
          if (ready) {
            events.push("ready");
          }
          return spawnSyncResult(
            JSON.stringify({
              state: events.includes("run") ? 4 : ready ? 3 : 4,
              lastRunResult: events.includes("run")
                ? 267009
                : delayedResult && Date.now() < 500
                  ? undefined
                  : ready
                    ? 0
                    : 267009,
              lastRunTime: "2026-09-27T00:00:00.0000000Z",
            }),
          );
        }
        return spawnSyncResult(
          exe.endsWith("tasklist.exe") && !exited
            ? '"node.exe","4242","Console","1","1 K"'
            : "No tasks",
        );
      });
      callGatewayCli.mockImplementation(async (options) => {
        options.assertDispatchCurrent();
        exited = true;
        return { ok: true, pid: GATEWAY_OWNER.pid, status: "scheduled" };
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
      expect(spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"))).toBe(false);
      expect(result).toEqual({
        outcome: "completed",
        taskSettlement: {
          status: "settled",
          taskName: "OpenClaw Gateway",
          lastRunResult: "0",
          ended: end,
        },
      });
    });
  });

  it("settles a Disabled update task without overriding its stale result or enabled policy", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mockWindowsTaskkillSuccess();
      readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
      callGatewayCli.mockImplementation(async (options) => {
        options.assertDispatchCurrent();
        readGatewayOwnerLease.mockReturnValue(undefined);
        spawnSync.mockImplementation((_exe, args) =>
          args?.includes("-EncodedCommand") || (args?.join(" ") ?? "").includes("Schedule.Service")
            ? spawnSyncResult(
                JSON.stringify({
                  state: 1,
                  enabled: false,
                  lastRunResult: 267009,
                  lastRunTime: "2026-09-27T00:00:00.0000000Z",
                }),
              )
            : spawnSyncResult("No tasks"),
        );
        return { ok: true, pid: GATEWAY_OWNER.pid, status: "scheduled" };
      });

      await stopScheduledTask({ env, stdout });

      expect(
        schtasksCalls.some(
          ([action]) => action === "/End" || action === "/Run" || action === "/Change",
        ),
      ).toBe(false);
      expect(stdout.read()?.toString()).toContain("Stopped Scheduled Task");
    });
  });

  it("does not end a replacement task instance during native fallback", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
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
        if (
          args?.includes("-EncodedCommand") ||
          (args?.join(" ") ?? "").includes("Schedule.Service")
        ) {
          return spawnSyncResult(
            JSON.stringify({
              state: 4,
              lastRunResult: 267009,
              lastRunTime: originalAlive ? "original" : "replacement",
            }),
          );
        }
        if (exe.endsWith("taskkill.exe") && args?.includes("4242")) {
          originalAlive = false;
        }
        return spawnSyncResult(
          exe.endsWith("tasklist.exe") && originalAlive
            ? '"node.exe","4242","Console","1","1 K"'
            : "No tasks",
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
      expect(schtasksCalls.some(([action]) => action === "/End" || action === "/Run")).toBe(false);
    });
  });

  it.each(["end-unavailable", "stop", "no-owner"] as const)(
    "handles %s settlement inspection without reporting a false restart",
    async (failure) => {
      await withPreparedGatewayTask(async ({ env, stdout }) => {
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
        callGatewayCli.mockImplementation(async (options) => {
          options.assertDispatchCurrent();
          exited = true;
          return { ok: true, pid: GATEWAY_OWNER.pid, status: "scheduled" };
        });
        const push = schtasksCalls.push.bind(schtasksCalls);
        vi.spyOn(schtasksCalls, "push").mockImplementation((...calls) => {
          if (calls.some(([action]) => failure === "end-unavailable" && action === "/End")) {
            schtasksResponses.push({ code: 1, stdout: "", stderr: "Access denied" });
          }
          return push(...calls);
        });
        spawnSync.mockImplementation((exe, args, options) => {
          if (
            args?.includes("-EncodedCommand") ||
            (args?.join(" ") ?? "").includes("Schedule.Service")
          ) {
            if (!prepared) {
              prepared = true;
              return scheduledTaskProbeResult(4);
            }
            if (
              failure === "end-unavailable" &&
              exited &&
              !schtasksCalls.some(([action]) => action === "/End")
            ) {
              now += Math.min(
                Number(options?.timeout),
                GATEWAY_SERVICE_STOP_TIMEOUT_MS - 135_000 - now,
              );
              return scheduledTaskProbeResult(4);
            }
            if (
              (exited || failure === "no-owner") &&
              !schtasksCalls.some(([action]) => action === "/Run")
            ) {
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
              ? '"node.exe","4242","Console","1","1 K"'
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
        expect(schtasksCalls.some(([action]) => action === "/Run")).toBe(!noRun);
        if (!noRun) {
          expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-restart" });
        } else {
          expect(onMutation).not.toHaveBeenCalledWith({ mode: "schtasks-restart" });
        }
        expect(schtasksCalls.some(([action]) => action === "/End")).toBe(
          failure === "end-unavailable",
        );
        expect(spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"))).toBe(false);
      });
    },
  );
});

describe("Scheduled Task stop/restart cleanup", () => {
  it("suspends a task whose Settings.Enabled value uses the default", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push(
        {
          ...SUCCESS_RESPONSE,
          stdout: "<Task><Settings><StartWhenAvailable>true</StartWhenAvailable></Settings></Task>",
        },
        { ...SUCCESS_RESPONSE },
      );

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(true);

      expect(schtasksCalls).toEqual([
        ["/Query", "/TN", "OpenClaw Gateway", "/XML"],
        ["/Change", "/TN", "OpenClaw Gateway", "/DISABLE"],
      ]);
    });
  });

  it("preserves an already-disabled task", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({
        ...SUCCESS_RESPONSE,
        stdout:
          "<Task><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><Enabled>false</Enabled></Settings></Task>",
      });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(false);

      expect(schtasksCalls).toEqual([["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
    });
  });

  it("fails closed when task absence cannot be confirmed", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({
        code: 1,
        stdout: "",
        stderr: "ERROR: The system cannot find the file specified.",
      });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).rejects.toThrow(
        "schtasks XML query failed: ERROR: The system cannot find the file specified.",
      );

      expect(schtasksCalls).toEqual([["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
      expect(spawnSync).toHaveBeenCalledOnce();
    });
  });

  it("fails closed when the task enabled state is missing", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({ ...SUCCESS_RESPONSE, stdout: "<Task><Triggers /></Task>" });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).rejects.toThrow(
        "schtasks XML query did not expose the task enabled state",
      );
    });
  });

  it("restores an enabled task after an ambiguous disable failure", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push(
        {
          ...SUCCESS_RESPONSE,
          stdout: "<Task><Settings><Enabled>true</Enabled></Settings></Task>",
        },
        { code: 124, stdout: "", stderr: "schtasks timed out after 15000ms" },
        { ...SUCCESS_RESPONSE },
      );

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).rejects.toThrow(
        "schtasks disable failed: schtasks timed out after 15000ms",
      );

      expect(schtasksCalls).toEqual([
        ["/Query", "/TN", "OpenClaw Gateway", "/XML"],
        ["/Change", "/TN", "OpenClaw Gateway", "/DISABLE"],
        ["/Change", "/TN", "OpenClaw Gateway", "/ENABLE"],
      ]);
    });
  });

  it("leaves startup-folder fallback installs unchanged when the task is absent", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      const startupEntry = path.join(
        expectDefined(env.APPDATA, "env.APPDATA test invariant"),
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
        "OpenClaw Gateway.cmd",
      );
      await fs.mkdir(path.dirname(startupEntry), { recursive: true });
      await fs.writeFile(startupEntry, "@echo off\r\n", "utf8");
      schtasksResponses.push({
        code: 1,
        stdout: "",
        stderr: "FEHLER: Die angegebene Datei wurde nicht gefunden.",
      });
      spawnSync.mockReturnValueOnce({
        pid: 0,
        output: [null, "-2147024894", ""],
        stdout: "-2147024894",
        stderr: "",
        status: 1,
        signal: null,
      });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(false);

      expect(schtasksCalls).toEqual([["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
      expect(spawnSync).toHaveBeenCalledOnce();
    });
  });

  it("surfaces a failed task reenable", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({ code: 1, stdout: "", stderr: "ERROR: Access is denied." });

      await expect(resumeScheduledTaskAutoStartAfterUpdate(env)).rejects.toThrow(
        "schtasks enable failed: ERROR: Access is denied.",
      );
    });
  });
});
