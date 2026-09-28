import { describe, expect, it, vi } from "vitest";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import {
  GATEWAY_OWNER,
  callGatewayCli,
  mockWindowsTaskkillSuccess,
  readGatewayOwnerLease,
  restartScheduledTask,
  spawnSync,
  spawnSyncResult,
  scheduledTaskProbeResult,
  stopScheduledTask,
  withPreparedGatewayTask,
} from "./schtasks.stop.test-support.js";
import { schtasksCalls, schtasksResponses } from "./test-helpers/schtasks-fixtures.js";

describe("Scheduled Task settlement", () => {
  it.each([
    { name: "graceful shutdown", native: false, end: false, delayedResult: false, settles: true },
    {
      name: "Ready before its result is recorded",
      native: false,
      end: false,
      delayedResult: true,
      settles: true,
    },
    { name: "native fallback", native: true, end: false, delayedResult: false, settles: true },
    {
      name: "an unsettled supervisor",
      native: false,
      end: true,
      delayedResult: false,
      settles: true,
    },
    {
      name: "a task that stays Running after End",
      native: false,
      end: true,
      delayedResult: false,
      settles: false,
    },
  ])(
    "requires task settlement before Run after $name",
    async ({ native, end, delayedResult, settles }) => {
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
          if (args?.includes("-EncodedCommand")) {
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
          if (native) {
            throw new Error("unsupported method");
          }
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
    },
  );

  it("settles a Disabled update task without overriding its stale result or enabled policy", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mockWindowsTaskkillSuccess();
      readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
      callGatewayCli.mockImplementation(async (options) => {
        options.assertDispatchCurrent();
        readGatewayOwnerLease.mockReturnValue(undefined);
        spawnSync.mockImplementation((_exe, args) =>
          args?.includes("-EncodedCommand")
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
        if (args?.includes("-EncodedCommand")) {
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

  it.each([
    "transient",
    "persistent",
    "run-denied",
    "end-unavailable",
    "stop",
    "no-owner",
  ] as const)(
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
          if (
            calls.some(
              ([action]) =>
                (failure === "run-denied" && action === "/Run") ||
                (failure === "end-unavailable" && action === "/End"),
            )
          ) {
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
              !schtasksCalls.some(([action]) => action === "/Run") &&
              (failure !== "transient" || failedProbes === 0)
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
        if (failure === "transient") {
          await expect(operation).resolves.toMatchObject({
            outcome: "completed",
            taskSettlement: { status: "settled" },
          });
          expect(failedProbes).toBe(1);
        } else {
          const error = await operation.catch((caughtError: unknown) => caughtError);
          expect(error).toBeInstanceOf(Error);
          const fact = {
            status: "unavailable",
            taskName: "OpenClaw Gateway",
            ended: failure === "end-unavailable",
          };
          expect(error).toMatchObject(noRun ? { cause: fact } : { taskSettlement: fact });
          expect(String(error)).toContain(
            failure === "run-denied"
              ? "Access denied"
              : noRun
                ? "stop unverified"
                : "restart unverified",
          );
          expect(failedProbes).toBeGreaterThan(1);
          expect(now).toBe(GATEWAY_SERVICE_STOP_TIMEOUT_MS);
          expect(stdout.read()?.toString() ?? "").not.toContain("Restarted Scheduled Task");
        }
        expect(schtasksCalls.some(([action]) => action === "/Run")).toBe(!noRun);
        if (!noRun && failure !== "run-denied") {
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
