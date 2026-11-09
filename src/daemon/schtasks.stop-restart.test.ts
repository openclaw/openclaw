import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, vi } from "vitest";
import {
  expectForcedTermination,
  expectNoTermination,
  expectTasklistProbe,
  installedGateway,
  mockGatewayProcess,
  powershellProcess,
  taskTest,
  taskkillCalls,
} from "./schtasks.stop-cleanup.test-support.js";
import {
  GATEWAY_OWNER,
  INSTALLED_GATEWAY_COMMAND_LINE,
  expectTaskkill,
  findVerifiedGatewayListenerPidsOnPortSync,
  mockWindowsTaskkillSuccess,
  mockSettledSchedulerSupervision,
  mockLingeringGatewayListener,
  pushSuccessfulSchtasksResponses,
  readGatewayOwnerLease,
  restartScheduledTask,
  setTaskStateProbeResult,
  spawnSync,
  spawnSyncResult,
  startScheduledTask,
  stopScheduledTask,
  taskkillPids,
  terminateScheduledTaskGatewayListeners,
  busyPortUsage,
  freePortUsage,
} from "./schtasks.stop.test-support.js";
import {
  inspectPortUsageMock,
  killProcessTreeMock,
  schtasksCalls,
} from "./test-helpers/schtasks-fixtures.js";

describe("Scheduled Task stop/restart cleanup", () => {
  taskTest("avoids forced termination after exit despite stale CIM", async ({ env }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    inspectPortUsageMock.mockResolvedValue(freePortUsage());
    let removed = false;
    mockGatewayProcess(
      () => !removed,
      () => {
        removed = true;
      },
      // Model the lagging CIM result from the packaged Windows failure.
      () => [installedGateway, powershellProcess],
    );

    await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([4242]);

    expect(taskkillCalls()).toEqual([["/T", "/PID", "4242"]]);
    expectTasklistProbe();
  });

  taskTest("waits beyond five seconds for forced termination", async ({ env }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    let forced = false;
    let tasklistCallsAfterForce = 0;
    readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
    mockGatewayProcess(
      () => {
        if (forced) {
          tasklistCallsAfterForce += 1;
        }
        return !forced || tasklistCallsAfterForce <= 75;
      },
      (force) => {
        forced = force;
      },
      () => [installedGateway],
    );

    await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([4242]);

    expect(taskkillPids()).toEqual([4242, 4242]);
    expect(tasklistCallsAfterForce).toBe(76);
  });

  taskTest("stops the exact installed task-supervisor before it binds", async ({ env, stdout }) => {
    vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    pushSuccessfulSchtasksResponses(3);
    inspectPortUsageMock.mockResolvedValue(freePortUsage());
    let forced = false;
    mockGatewayProcess(
      () => !forced,
      (force) => {
        if (force) {
          forced = true;
        }
      },
      () => [
        {
          ProcessId: 3131,
          CommandLine:
            '"C:\\Program Files\\nodejs\\node.exe" "C:\\other-openclaw.cjs" gateway --port 18789',
        },
        ...(!forced
          ? [
              {
                ...installedGateway,
                CommandLine: `${INSTALLED_GATEWAY_COMMAND_LINE} --task-supervisor`,
              },
            ]
          : []),
        powershellProcess,
      ],
      { taskProbe: true, closedEnv: true, failGraceful: true },
    );

    await stopScheduledTask({ env, stdout });

    expectForcedTermination();
    expectTasklistProbe();
    expect(taskkillCalls().flat()).not.toContain("3131");
    expect(taskkillCalls().flat()).not.toContain("4141");
    expect(killProcessTreeMock).not.toHaveBeenCalled();
  });

  taskTest("starts despite audit observer failure", async ({ env }) => {
    pushSuccessfulSchtasksResponses(3);
    mockSettledSchedulerSupervision();
    spawnSync.mockReturnValueOnce(spawnSyncResult(JSON.stringify({ state: 4, enabled: true })));
    setTaskStateProbeResult(4);
    const write = vi.fn();
    const onMutation = vi.fn(() => {
      throw new Error("audit failed");
    });

    await expect(
      startScheduledTask({
        env,
        stdout: { write } as unknown as NodeJS.WritableStream,
        onMutation,
      }),
    ).resolves.toBeUndefined();

    expect(schtasksCalls).toContainEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-start" });
    expect(
      expectDefined(onMutation.mock.invocationCallOrder[0], "start audit call order"),
    ).toBeLessThan(expectDefined(write.mock.invocationCallOrder[0], "start output call order"));
  });

  taskTest("audits stop before output failure", async ({ env }) => {
    pushSuccessfulSchtasksResponses(3);
    setTaskStateProbeResult(() => (schtasksCalls.some(([action]) => action === "/End") ? 3 : 4));
    const onMutation = vi.fn();
    const stdout = {
      write: vi.fn(() => {
        throw new Error("output failed");
      }),
    } as unknown as NodeJS.WritableStream;

    await expect(stopScheduledTask({ env, stdout, onMutation })).rejects.toThrow("output failed");

    expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-stop" });
  });

  taskTest("preserves another listener after the owned process exits", async ({ env, stdout }) => {
    pushSuccessfulSchtasksResponses(3);
    mockWindowsTaskkillSuccess();
    mockLingeringGatewayListener(4242, busyPortUsage(5252));

    const failure = await stopScheduledTask({ env, stdout }).catch((err: unknown) => err);

    expect(String(failure)).toContain("remaining listener ownership could not be verified");
    expect(String(failure)).toContain("pid 5252");
    if (process.platform !== "win32") {
      expect(killProcessTreeMock).toHaveBeenCalledOnce();
      expect(killProcessTreeMock).toHaveBeenCalledWith(4242, { graceMs: 300 });
    } else {
      expect(killProcessTreeMock).not.toHaveBeenCalled();
      expectTaskkill(4242);
    }
    expect(killProcessTreeMock).not.toHaveBeenCalledWith(5252, { graceMs: 300 });
    expect(taskkillPids()).not.toContain(5252);
  });

  taskTest("rejects another checkout on the same port without CIM", async ({ env, stdout }) => {
    pushSuccessfulSchtasksResponses(3);
    mockWindowsTaskkillSuccess();
    const foreignRoot = path.join(expectDefined(env.USERPROFILE, "fixture home"), "other-%%-^!");
    const foreignScript = path.join(foreignRoot, "dist", "index.js");
    await fs.mkdir(path.dirname(foreignScript), { recursive: true });
    await fs.writeFile(path.join(foreignRoot, "package.json"), '{"name":"openclaw"}');
    await fs.writeFile(foreignScript, "");
    const foreignGatewayCommandLine = `"C:\\Program Files\\nodejs\\node.exe" "${foreignScript}" gateway --port 18789`;
    inspectPortUsageMock.mockResolvedValue(
      busyPortUsage(6262, { commandLine: foreignGatewayCommandLine }),
    );

    const failure = await stopScheduledTask({ env, stdout }).catch((err: unknown) => err);

    expect(String(failure)).toContain("remaining listener ownership could not be verified");
    expect(String(failure)).toContain("pid 6262");
    expect(String(failure)).toContain("pid 6262 (node.exe, openclaw gateway)");
    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expect(taskkillPids()).not.toContain(6262);
  });

  taskTest("reports remaining listeners before restart", async ({ env, stdout }) => {
    pushSuccessfulSchtasksResponses(3);
    inspectPortUsageMock.mockResolvedValue(busyPortUsage(5151));

    const failure = await restartScheduledTask({ env, stdout }).catch((err: unknown) => err);

    expect(String(failure)).toContain("is still busy before restart");
    expect(String(failure)).toContain("pid 5151");
    expectNoTermination();
  });

  taskTest("preserves gateway listeners during node task restart", async ({ env, stdout }) => {
    pushSuccessfulSchtasksResponses(4);
    mockSettledSchedulerSupervision();
    env.OPENCLAW_SERVICE_KIND = "node";
    env.OPENCLAW_WINDOWS_TASK_NAME = "OpenClaw Node";
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
    inspectPortUsageMock.mockResolvedValue(busyPortUsage(4242));

    await expect(restartScheduledTask({ env, stdout })).resolves.toEqual({
      outcome: "completed",
    });

    expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
    expect(inspectPortUsageMock).not.toHaveBeenCalled();
    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expect(schtasksCalls).toEqual([
      ["/Query"],
      ["/Query", "/TN", "OpenClaw Node"],
      ["/End", "/TN", "OpenClaw Node"],
      ["/Run", "/TN", "OpenClaw Node"],
    ]);
  });

  taskTest("rejects restart after losing authority during activation", async ({ env, stdout }) => {
    pushSuccessfulSchtasksResponses(4);
    let current = true;
    inspectPortUsageMock.mockImplementation(async () => {
      if (inspectPortUsageMock.mock.calls.length > 1) {
        current = false;
      }
      return freePortUsage();
    });

    await expect(
      restartScheduledTask({
        env,
        stdout,
        assertCurrent: () => {
          if (!current) {
            throw new Error("repair continuation retired");
          }
        },
      }),
    ).rejects.toThrow("repair continuation retired");

    expect(schtasksCalls.filter(([action]) => action === "/End" || action === "/Run")).toEqual(
      process.platform === "win32" ? [] : [["/End", "/TN", "OpenClaw Gateway"]],
    );
    expect(killProcessTreeMock).not.toHaveBeenCalled();
  });
});
