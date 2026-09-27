import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_OWNER,
  callGatewayCli,
  mockWindowsTaskkillSuccess,
  readGatewayOwnerLease,
  restartScheduledTask,
  spawnSync,
  spawnSyncResult,
  stopScheduledTask,
  withPreparedGatewayTask,
} from "./schtasks.stop.test-support.js";
import { schtasksCalls } from "./test-helpers/schtasks-fixtures.js";

describe("Scheduled Task shutdown and SQLite handle release", () => {
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
        throw new Error("connection closed");
      });
      await expect(restartScheduledTask({ env, stdout })).rejects.toThrow("Gateway owner changed");
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
          spawnSyncResult(exe.endsWith("tasklist.exe") ? "No tasks" : JSON.stringify({ state: 3 })),
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
          spawnSyncResult(exe.endsWith("tasklist.exe") ? "No tasks" : JSON.stringify({ state: 3 })),
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

  it.each([1546, 4618, 4874])("retries a post-End SQLite sharing error (%s)", async (errcode) => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mockWindowsTaskkillSuccess();
      let failed = false;
      readGatewayOwnerLease.mockImplementation(() => {
        if (!failed && schtasksCalls.some(([action]) => action === "/End")) {
          failed = true;
          throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode });
        }
        return undefined;
      });

      await expect(restartScheduledTask({ env, stdout })).resolves.toEqual({
        outcome: "completed",
      });
      expect(failed).toBe(true);
      expect(schtasksCalls).toContainEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });

  it("still restarts with a warning when post-End sharing errors exhaust the retry budget", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mockWindowsTaskkillSuccess();
      const warn = vi.fn();
      readGatewayOwnerLease.mockImplementation(() => {
        if (schtasksCalls.some(([action]) => action === "/End")) {
          throw Object.assign(new Error("disk I/O error"), { errcode: 1546 });
        }
        return undefined;
      });

      await expect(restartScheduledTask({ env, stdout, warn })).resolves.toEqual({
        outcome: "completed",
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("SQLite"));
      expect(schtasksCalls).toContainEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });
});
