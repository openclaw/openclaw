import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  GatewayProtocolRequestError,
  retainGatewayResponsePayload,
} from "../../packages/gateway-client/src/protocol-request.js";
import {
  GATEWAY_OWNER,
  INSTALLED_GATEWAY_COMMAND_LINE,
  formatWindowsTaskSupervisorChildArgument,
  callGatewayCli,
  mockWindowsTaskkillSuccess,
  mockLingeringGatewayListener,
  readGatewayOwnerLease,
  readWindowsProcessStartTimeSync,
  restartScheduledTask,
  resolveTaskScriptPath,
  spawnSync,
  spawnSyncResult,
  scheduledTaskProbeResult,
  stopScheduledTask,
  withPreparedGatewayTask,
} from "./schtasks.stop.test-support.js";
import { inspectPortUsageMock, schtasksCalls } from "./test-helpers/schtasks-fixtures.js";

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
            if (args?.includes("-EncodedCommand")) {
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

  it.each([false, true])(
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
          if (args?.includes("-EncodedCommand")) {
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
        args?.includes("-EncodedCommand")
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
    { name: "restart", control: restartScheduledTask, pid: 5252, startedAt: 200 },
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

  it.each([
    { name: "stop", control: stopScheduledTask },
    { name: "restart", control: restartScheduledTask },
  ])("$name falls back promptly after a definitive stop rejection", async ({ control }) => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const ended = () => spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"));
      readGatewayOwnerLease.mockImplementation(() => (ended() ? undefined : GATEWAY_OWNER));
      spawnSync.mockImplementation((exe, args) => {
        if (args?.includes("-EncodedCommand")) {
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
  });

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
          args?.includes("-EncodedCommand")
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
    { name: "stop", control: stopScheduledTask },
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
    { mode: "native", errcode: 4618, exhausted: false },
    { mode: "native", errcode: 4874, exhausted: false },
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
              args?.includes("-EncodedCommand")
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
