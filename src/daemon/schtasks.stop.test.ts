import fs from "node:fs/promises";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { describe, expect, it, vi } from "vitest";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import * as gatewayStateOwner from "../infra/gateway-state-owner.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  expectForcedTermination,
  expectNoTermination,
  installedGateway,
  mockGatewayProcess,
  prepareDoctorAdmission,
  snapshotResult,
  taskTest,
  taskkillCalls,
} from "./schtasks.stop-cleanup.test-support.js";
import {
  GATEWAY_OWNER,
  GATEWAY_PORT,
  INSTALLED_GATEWAY_COMMAND_LINE,
  expectGatewayTermination,
  expectTaskkill,
  findVerifiedGatewayListenerPidsOnPortSync,
  mockWindowsTaskkillSuccess,
  mockLingeringGatewayListener,
  probeProcessState,
  pushSuccessfulSchtasksResponses,
  readGatewayOwnerLease,
  readWindowsProcessStartTimeSync,
  resolveScheduledTaskOwnedGatewayPids,
  resolveTaskScriptPath,
  restartScheduledTask,
  setTaskStateProbeResult,
  spawnSync,
  spawnSyncResult,
  stopScheduledTask,
  terminateScheduledTaskGatewayListeners,
  withPreparedGatewayTask,
  busyPortUsage,
} from "./schtasks.stop.test-support.js";
import { withGatewayServiceUpdateAuthority } from "./service-update-authority.js";
import {
  gatewayServiceProbeHostsMock,
  inspectPortUsageMock,
  killProcessTreeMock,
  schtasksCalls,
  schtasksResponses,
} from "./test-helpers/schtasks-fixtures.js";

describe("Scheduled Task stop/restart cleanup", () => {
  it("restores an ownerless task in state 4 while revalidating Doctor's state admission", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      const admission = prepareDoctorAdmission(env);
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      let clock = 0;
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      setTaskStateProbeResult(() => {
        if (schtasksCalls.some(([action]) => action === "/Run")) {
          return 4;
        }
        if (schtasksCalls.some(([action]) => action === "/End")) {
          return 3;
        }
        clock += GATEWAY_SERVICE_STOP_TIMEOUT_MS / 4;
        return 4;
      });
      pushSuccessfulSchtasksResponses(4);

      await expect(
        withGatewayServiceUpdateAuthority(admission.assertCurrent, (assertCurrent) =>
          restartScheduledTask({ env, stdout, assertCurrent, preserveDefinition: true }),
        ),
      ).resolves.toMatchObject({ outcome: "completed" });

      expect(schtasksCalls).toContainEqual(["/Run", "/TN", "OpenClaw Gateway"]);
      expect(schtasksCalls.filter(([action]) => action === "/End")).toHaveLength(1);
      expect(() => admission.assertCurrent()).not.toThrow();
    });
  });

  it.each([
    ["cleanup", false],
    ["stop and cleanup", true],
  ] as const)("preserves %s failures without activating the task", async (_name, failStop) => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      const admission = prepareDoctorAdmission(env);
      const acquire = gatewayStateOwner.tryAcquireGatewayStateOwner;
      const captured: { exclusion: ReturnType<typeof acquire> } = { exclusion: null };
      vi.spyOn(gatewayStateOwner, "tryAcquireGatewayStateOwner").mockImplementation(
        (databasePath) => {
          captured.exclusion = acquire(databasePath);
          return captured.exclusion;
        },
      );
      let resources: ReturnType<typeof getOpenClawDatabaseMaintenanceScope>;
      let failCleanup = true;
      const stopFailure = new Error("native stop authority refused");
      const cleanupFailure = new Error("native state close failed");
      const assertCurrent = () => {
        admission.assertCurrent();
        const currentScope = getOpenClawDatabaseMaintenanceScope();
        if (currentScope && !resources) {
          resources = currentScope;
          resources.own({}, "shared-resources", () => {
            if (failCleanup) {
              throw cleanupFailure;
            }
          });
        }
        if (currentScope && failStop) {
          throw stopFailure;
        }
      };
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      setTaskStateProbeResult(3);
      pushSuccessfulSchtasksResponses(4);
      try {
        const failure = await withGatewayServiceUpdateAuthority(assertCurrent, (current) =>
          restartScheduledTask({ env, stdout, assertCurrent: current, preserveDefinition: true }),
        ).catch((error: unknown) => error);
        const errors = collectNestedErrorCandidates(failure);
        if (failStop) {
          expect(errors).toContain(stopFailure);
        }
        expect(errors).toContain(cleanupFailure);
        expect(schtasksCalls).not.toContainEqual(["/Run", "/TN", "OpenClaw Gateway"]);
        expect(() => admission.assertCurrent()).toThrow(
          "without an active schema lease or maintenance scope",
        );
      } finally {
        // The test retains handles only to clean its fixture; production retires the CLI process.
        failCleanup = false;
        await resources?.close();
        captured.exclusion?.release();
      }
    });
  });

  it("keeps an unknown tasklist fallback verdict with a closed environment", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
    spawnSync.mockReturnValueOnce(spawnSyncResult("", 1));
    spawnSync.mockReturnValueOnce(spawnSyncResult("", 1));
    expect(probeProcessState(4242)).toBe("unknown");
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(spawnSync.mock.calls[1]).toEqual([
      expect.stringMatching(/tasklist\.exe$/i),
      ["/FI", "PID eq 4242", "/FO", "CSV", "/NH"],
      expect.objectContaining({
        env: expect.not.objectContaining({ BOUNDARY_PARENT_ONLY: "synthetic" }),
        timeout: 1_500,
      }),
    ]);
  });

  taskTest.for([
    { state: 3, error: "FEHLER: Die Aufgabe wird derzeit nicht ausgeführt." },
    { state: null, error: "FEHLER: Der Aufgabenstatus ist nicht verfügbar." },
  ])(
    "settles a localized /End failure only when COM proves ready (state=$state)",
    async ({ state, error }, { env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const onMutation = vi.fn();
      pushSuccessfulSchtasksResponses(2);
      schtasksResponses.push({ code: 1, stdout: "", stderr: error });
      setTaskStateProbeResult(() =>
        schtasksCalls.some(([action]) => action === "/End") ? state : 4,
      );
      const stopped = stopScheduledTask({ env, stdout, onMutation });
      if (state === 3) {
        await expect(stopped).resolves.toBeUndefined();
        expect(schtasksCalls).toEqual([
          ["/Query"],
          ["/Query", "/TN", "OpenClaw Gateway"],
          ["/End", "/TN", "OpenClaw Gateway"],
        ]);
        expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-stop" });
      } else {
        await expect(stopped).rejects.toThrow(`schtasks end failed: ${error}`);
        expect(onMutation).not.toHaveBeenCalled();
      }
    },
  );

  it("kills the lingering gateway owned by the redirected persisted task", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      const onMutation = vi.fn();
      pushSuccessfulSchtasksResponses(3);
      mockWindowsTaskkillSuccess();
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      mockLingeringGatewayListener(4242);

      await stopScheduledTask({ env, stdout, onMutation });

      expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
      expectGatewayTermination(4242);
      expectTaskkill(4242);
      expect(inspectPortUsageMock).toHaveBeenCalledWith(GATEWAY_PORT, {
        probeHosts: ["127.0.0.1"],
      });
      expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-stop" });
    }, '< NUL >> "gateway output.log" 2>&1');
  });

  taskTest("does not adopt a portless arbitrary task action", async ({ env }) => {
    delete env.OPENCLAW_GATEWAY_PORT;
    const scriptPath = resolveTaskScriptPath(env);
    await fs.writeFile(
      scriptPath,
      '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "C:\\probe.cjs"\r\n',
      "utf8",
    );

    await expect(resolveScheduledTaskOwnedGatewayPids(env)).resolves.toEqual([]);

    expect(inspectPortUsageMock).not.toHaveBeenCalled();
    expect(gatewayServiceProbeHostsMock).not.toHaveBeenCalled();
  });

  taskTest.for([
    { kind: "external", name: null },
    { kind: "schtasks", name: "Another Gateway Task" },
  ] as const)("preserves a live owner supervised by $kind $name", async (supervisor, { env }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    readGatewayOwnerLease.mockReturnValue({ ...GATEWAY_OWNER, supervisor });
    mockWindowsTaskkillSuccess();

    await expect(resolveScheduledTaskOwnedGatewayPids(env)).resolves.toEqual([]);
    await expect(terminateScheduledTaskGatewayListeners(env)).rejects.toThrow(
      supervisor.name ?? "external supervisor",
    );

    expectNoTermination();
  });

  taskTest("rejects matching argv for a dead supervised owner", async ({ env }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    readGatewayOwnerLease.mockReturnValue({
      ...GATEWAY_OWNER,
      mode: "supervised",
      state: "dead",
    });
    spawnSync.mockReturnValue(snapshotResult([installedGateway]));

    await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([]);

    expectNoTermination();
  });

  taskTest.for([
    { phase: "before graceful stop", change: "replacement" },
    { phase: "before forced stop", change: "replacement" },
    { phase: "before forced stop", change: "dead" },
  ])("refuses a $change recorded owner $phase", async ({ phase, change }, { env }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    let changed = false;
    let killed = false;
    readGatewayOwnerLease.mockImplementation(() =>
      !changed
        ? GATEWAY_OWNER
        : {
            ...GATEWAY_OWNER,
            ...(change === "dead"
              ? { state: "dead" as const }
              : { owner: "gateway-owner-2", startedAt: 200 }),
          },
    );
    if (phase === "before graceful stop") {
      readGatewayOwnerLease.mockImplementationOnce(() => {
        changed = true;
        return GATEWAY_OWNER;
      });
    }
    mockGatewayProcess(
      () => !killed,
      (forced) => {
        changed = true;
        killed = forced;
      },
    );

    await expect(terminateScheduledTaskGatewayListeners(env)).rejects.toThrow(
      "Gateway owner changed",
    );

    expect(taskkillCalls()).toEqual(
      phase === "before graceful stop" ? [] : [["/T", "/PID", "4242"]],
    );
  });

  taskTest.for(["becomes unknown", "loses its lease"] as const)(
    "finishes terminating the validated owner after it $0",
    async (change, { env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      let changed = false;
      let forced = false;
      readGatewayOwnerLease.mockImplementation(() =>
        !changed
          ? GATEWAY_OWNER
          : change === "loses its lease"
            ? undefined
            : { ...GATEWAY_OWNER, state: "unknown" },
      );
      if (change === "loses its lease") {
        readWindowsProcessStartTimeSync.mockReturnValue(GATEWAY_OWNER.startedAt);
      }
      mockGatewayProcess(
        () => !forced,
        (force) => {
          changed = true;
          forced = force;
        },
      );

      await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([4242]);

      // The installed launcher declares its port, not the inspecting CLI's profile.
      expect(readWindowsProcessStartTimeSync).toHaveBeenCalledWith(4242, 5_000, {
        USERPROFILE: env.USERPROFILE,
        APPDATA: env.APPDATA,
        OPENCLAW_GATEWAY_PORT: String(GATEWAY_PORT),
      });

      expectForcedTermination();
      expect(taskkillCalls().flat()).not.toContain("9999");
      expect(killProcessTreeMock).not.toHaveBeenCalled();
    },
  );

  taskTest.for([
    { label: "belongs to another host", owner: { host: "another-host" }, currentStart: 100 },
    { label: "has no recorded process identity", owner: { startedAt: null }, currentStart: 100 },
    { label: "has reused its pid", owner: {}, currentStart: 101 },
  ] as const)(
    "does not terminate an unknown owner that $label",
    async ({ owner, currentStart }, { env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      readGatewayOwnerLease.mockReturnValue({ ...GATEWAY_OWNER, ...owner, state: "unknown" });
      readWindowsProcessStartTimeSync.mockReturnValue(currentStart);
      mockWindowsTaskkillSuccess();

      await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([]);

      expectNoTermination();
    },
  );

  taskTest("rejects legacy cleanup when a foreground owner appears", async ({ env }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockWindowsTaskkillSuccess();
    inspectPortUsageMock.mockImplementation(async () => {
      readGatewayOwnerLease.mockReturnValue({
        ...GATEWAY_OWNER,
        mode: "foreground",
        supervisor: null,
      });
      return busyPortUsage(4242, { commandLine: INSTALLED_GATEWAY_COMMAND_LINE });
    });

    await expect(terminateScheduledTaskGatewayListeners(env)).rejects.toThrow(
      "Gateway owner changed",
    );

    expectNoTermination();
  });
});
