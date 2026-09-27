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

  it("does not restart over a non-listening captured process when lease inspection fails", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      let attempted = false;
      readGatewayOwnerLease.mockImplementation(() => {
        if (attempted || schtasksCalls.some(([action]) => action === "/End")) {
          throw Object.assign(new Error("disk I/O error"), { errcode: 1546 });
        }
        return GATEWAY_OWNER;
      });
      spawnSync.mockImplementation((exe, args) => {
        if (args?.includes("-EncodedCommand")) {
          return scheduledTaskProbeResult();
        }
        attempted ||= exe.endsWith("taskkill.exe");
        return spawnSyncResult(
          exe.endsWith("tasklist.exe") ? '"node.exe","4242","Console","1","1 K"' : "",
        );
      });

      await expect(restartScheduledTask({ env, stdout })).rejects.toThrow("state writer");
      expect(schtasksCalls.some(([action]) => action === "/Run")).toBe(false);
    });
  });

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

  it("does not recover a failed lease read without a verified captured process", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      let reads = 0;
      readGatewayOwnerLease.mockImplementation(() => {
        if (++reads > 1) {
          throw Object.assign(new Error("disk I/O error"), { errcode: 1546 });
        }
        return { ...GATEWAY_OWNER, state: "unknown", startedAt: null };
      });
      mockWindowsTaskkillSuccess();

      await expect(restartScheduledTask({ env, stdout })).rejects.toThrow("disk I/O error");
      expect(schtasksCalls.some(([action]) => action === "/End" || action === "/Run")).toBe(false);
      expect(spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"))).toBe(false);
    });
  });

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

  it("restores a gracefully stopped Gateway when lease inspection remains locked", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
      mockWindowsTaskkillSuccess();
      callGatewayCli.mockImplementation(async (options) => {
        options.assertDispatchCurrent();
        readGatewayOwnerLease.mockImplementation(() => {
          throw Object.assign(new Error("disk I/O error"), { errcode: 1546 });
        });
        spawnSync.mockImplementation((exe, args) =>
          args?.includes("-EncodedCommand")
            ? scheduledTaskProbeResult()
            : spawnSyncResult(exe.endsWith("tasklist.exe") ? "No tasks" : ""),
        );
        return { ok: true, pid: GATEWAY_OWNER.pid, status: "scheduled" };
      });
      const warn = vi.fn();

      await expect(restartScheduledTask({ env, stdout, warn })).resolves.toEqual({
        outcome: "completed",
        restartRecovery: "sqlite-owner-read",
        taskSettlement: {
          status: "settled",
          taskName: "OpenClaw Gateway",
          lastRunResult: "0",
          ended: false,
        },
      });

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("SQLite"));
      expect(schtasksCalls).toContainEqual(["/Run", "/TN", "OpenClaw Gateway"]);
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

  it("waits for the task to settle after its Gateway exits gracefully", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
      mockWindowsTaskkillSuccess();
      let stoppedAt = 0;
      callGatewayCli.mockImplementation(async (options) => {
        options.assertDispatchCurrent();
        stoppedAt = Date.now();
        readGatewayOwnerLease.mockReturnValue(undefined);
        spawnSync.mockImplementation((exe, args) =>
          spawnSyncResult(
            args?.includes("-EncodedCommand")
              ? scheduledTaskProbeResult(Date.now() - stoppedAt < 500 ? 4 : undefined).stdout
              : exe.endsWith("tasklist.exe")
                ? "No tasks"
                : "",
          ),
        );
        return { ok: true, pid: GATEWAY_OWNER.pid, status: "scheduled" };
      });

      await restartScheduledTask({ env, stdout });

      expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(500);
      expect(schtasksCalls.some(([action]) => action === "/End")).toBe(false);
      expect(spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"))).toBe(false);
      expect(schtasksCalls).toContainEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });

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

  it("reconciles a lost stop reply and records the completed graceful stop", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mockWindowsTaskkillSuccess();
      readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
      const onMutation = vi.fn();
      callGatewayCli.mockImplementation(async (options) => {
        options.assertDispatchCurrent();
        readGatewayOwnerLease.mockReturnValue(undefined);
        spawnSync.mockImplementation((exe) =>
          spawnSyncResult(
            exe.endsWith("tasklist.exe") ? "No tasks" : scheduledTaskProbeResult().stdout,
          ),
        );
        throw new Error("connection closed after dispatch");
      });
      await stopScheduledTask({ env, stdout, onMutation });
      expect(schtasksCalls.some(([action]) => action === "/End")).toBe(false);
      expect(onMutation).toHaveBeenCalledExactlyOnceWith({ mode: "schtasks-stop" });
    });
  });

  it.each([
    { name: "stop", control: stopScheduledTask },
    { name: "restart", control: restartScheduledTask },
  ])("$name requests graceful exit before ending the task", async ({ control }) => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mockWindowsTaskkillSuccess();
      readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
      callGatewayCli.mockImplementation(async () => {
        expect(schtasksCalls.some(([action]) => action === "/End")).toBe(false);
        readGatewayOwnerLease.mockReturnValue(undefined);
        spawnSync.mockImplementation((exe) =>
          spawnSyncResult(
            exe.endsWith("tasklist.exe") ? "No tasks" : scheduledTaskProbeResult().stdout,
          ),
        );
        return { ok: true, pid: GATEWAY_OWNER.pid, status: "scheduled", timeoutMs: 330_000 };
      });

      await control({ env, stdout });

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

  it.each([1546, 4618, 4874])(
    "retries a post-termination SQLite sharing error (%s)",
    async (errcode) => {
      await withPreparedGatewayTask(async ({ env, stdout }) => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        mockWindowsTaskkillSuccess();
        let failed = false;
        readGatewayOwnerLease.mockImplementation(() => {
          if (!failed && spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"))) {
            failed = true;
            throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode });
          }
          return spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"))
            ? undefined
            : GATEWAY_OWNER;
        });

        await expect(restartScheduledTask({ env, stdout })).resolves.toEqual({
          outcome: "completed",
          taskSettlement: {
            status: "settled",
            taskName: "OpenClaw Gateway",
            lastRunResult: "0",
            ended: false,
          },
        });
        expect(failed).toBe(true);
        expect(schtasksCalls).toContainEqual(["/Run", "/TN", "OpenClaw Gateway"]);
      });
    },
  );

  it("still restarts with a warning when post-termination sharing errors exhaust the retry budget", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mockWindowsTaskkillSuccess();
      const warn = vi.fn();
      readGatewayOwnerLease.mockImplementation(() => {
        if (spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"))) {
          throw Object.assign(new Error("disk I/O error"), { errcode: 1546 });
        }
        return spawnSync.mock.calls.some(([exe]) => exe.endsWith("taskkill.exe"))
          ? undefined
          : GATEWAY_OWNER;
      });

      await expect(restartScheduledTask({ env, stdout, warn })).resolves.toEqual({
        outcome: "completed",
        restartRecovery: "sqlite-owner-read",
        taskSettlement: {
          status: "settled",
          taskName: "OpenClaw Gateway",
          lastRunResult: "0",
          ended: false,
        },
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("SQLite"));
      expect(schtasksCalls).toContainEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });
});
