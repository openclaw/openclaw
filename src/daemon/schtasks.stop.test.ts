import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { describe, expect, it, vi } from "vitest";
import { resolveDoctorUpdateAdmission } from "../commands/doctor-maintenance-admission.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import * as gatewayStateOwner from "../infra/gateway-state-owner.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
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
  scheduledTaskProbeResult,
  startScheduledTask,
  stopScheduledTask,
  taskkillPids,
  terminateScheduledTaskGatewayListeners,
  withPreparedGatewayTask,
  busyPortUsage,
  freePortUsage,
} from "./schtasks.stop.test-support.js";
import { withGatewayServiceUpdateAuthority } from "./service-update-authority.js";
import {
  gatewayServiceProbeHostsMock,
  inspectPortUsageMock,
  killProcessTreeMock,
  schtasksCalls,
  schtasksResponses,
} from "./test-helpers/schtasks-fixtures.js";

type GatewayFixture = Parameters<Parameters<typeof withPreparedGatewayTask>[0]>[0];
const taskTest = it.extend<GatewayFixture & { gateway: GatewayFixture }>({
  gateway: async ({ task: _task }, use) => withPreparedGatewayTask(use),
  env: async ({ gateway }, use) => use(gateway.env),
  stdout: async ({ gateway }, use) => use(gateway.stdout),
});

function taskkillCalls() {
  return spawnSync.mock.calls
    .filter(([command]) => command.toLowerCase().endsWith("taskkill.exe"))
    .map(([, args]) => args);
}

const installedGateway = { ProcessId: 4242, CommandLine: INSTALLED_GATEWAY_COMMAND_LINE };
const powershellProcess = { ProcessId: 9999, CommandLine: "powershell.exe" };
const snapshotResult = (processes: Array<{ ProcessId: number; CommandLine: string }>) =>
  spawnSyncResult(JSON.stringify(processes));
const tasklistResult = (alive: boolean) =>
  spawnSyncResult(alive ? '"node.exe","4242","Console","1","1 K"' : "No tasks");

function mockGatewayProcess(alive: () => boolean, onKill: (forced: boolean) => void) {
  spawnSync.mockImplementation((command, args) => {
    const executable = command.toLowerCase();
    if (executable.endsWith("taskkill.exe")) {
      onKill(args?.includes("/F") ?? false);
      return spawnSyncResult("");
    }
    if (executable.endsWith("tasklist.exe")) {
      return tasklistResult(alive());
    }
    return snapshotResult([...(alive() ? [installedGateway] : []), powershellProcess]);
  });
}

describe("Scheduled Task stop/restart cleanup", () => {
  it.each([3, 4])(
    "restores an ownerless task in state %s while revalidating Doctor's state admission",
    async (taskState) => {
      await withPreparedGatewayTask(async ({ env, stdout }) => {
        env.OPENCLAW_STATE_DIR = path.join(
          expectDefined(env.USERPROFILE, "fixture home"),
          ".openclaw",
        );
        openOpenClawStateDatabase({ env });
        closeOpenClawStateDatabaseForTest();
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
        try {
          const admission = resolveDoctorUpdateAdmission(env);
          vi.spyOn(process, "platform", "get").mockReturnValue("win32");
          setTaskStateProbeResult(() => {
            if (schtasksCalls.some(([action]) => action === "/Run")) {
              return 4;
            }
            if (schtasksCalls.some(([action]) => action === "/End")) {
              return 3;
            }
            // Elapsed polling time also runs the retained admission's heartbeat.
            vi.advanceTimersByTime(GATEWAY_SERVICE_STOP_TIMEOUT_MS / 4);
            return taskState;
          });
          pushSuccessfulSchtasksResponses(4);

          await expect(
            withGatewayServiceUpdateAuthority(admission.assertCurrent, (assertCurrent) =>
              restartScheduledTask({ env, stdout, assertCurrent, preserveDefinition: true }),
            ),
          ).resolves.toMatchObject({ outcome: "completed" });

          expect(schtasksCalls).toContainEqual(["/Run", "/TN", "OpenClaw Gateway"]);
          expect(schtasksCalls.filter(([action]) => action === "/End")).toHaveLength(
            taskState === 4 ? 1 : 0,
          );
          expect(() => admission.assertCurrent()).not.toThrow();
        } finally {
          vi.useRealTimers();
        }
      });
    },
  );

  it.each([
    ["cleanup", false, true],
    ["stop", true, false],
    ["stop and cleanup", true, true],
  ] as const)(
    "preserves %s failures without activating the task",
    async (_name, failStop, failClose) => {
      await withPreparedGatewayTask(async ({ env, stdout }) => {
        env.OPENCLAW_STATE_DIR = path.join(
          expectDefined(env.USERPROFILE, "fixture home"),
          ".openclaw",
        );
        openOpenClawStateDatabase({ env });
        closeOpenClawStateDatabaseForTest();
        const admission = resolveDoctorUpdateAdmission(env);
        const acquire = gatewayStateOwner.tryAcquireGatewayStateOwner;
        const captured: { exclusion: ReturnType<typeof acquire> } = { exclusion: null };
        vi.spyOn(gatewayStateOwner, "tryAcquireGatewayStateOwner").mockImplementation(
          (databasePath) => {
            captured.exclusion = acquire(databasePath);
            return captured.exclusion;
          },
        );
        let resources: ReturnType<typeof getOpenClawDatabaseMaintenanceScope>;
        let failCleanup = failClose;
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
          if (failClose) {
            expect(errors).toContain(cleanupFailure);
          }
          expect(schtasksCalls).not.toContainEqual(["/Run", "/TN", "OpenClaw Gateway"]);
          if (failClose) {
            expect(() => admission.assertCurrent()).toThrow("undergoing offline maintenance");
          } else {
            expect(() => admission.assertCurrent()).not.toThrow();
          }
        } finally {
          // The test retains handles only to clean its fixture; production retires the CLI process.
          failCleanup = false;
          await resources?.close();
          captured.exclusion?.release();
        }
      });
    },
  );

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
    { state: 4, error: "FEHLER: Die Aufgabe konnte nicht beendet werden." },
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

  taskTest(
    "finds an unbound live owner despite an expired lease and stale argv",
    async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      readGatewayOwnerLease.mockReturnValue({ ...GATEWAY_OWNER, expired: true });

      await expect(resolveScheduledTaskOwnedGatewayPids(env)).resolves.toEqual([4242]);

      expect(inspectPortUsageMock).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
    },
  );

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

    expect(taskkillPids()).toEqual([]);
    expect(killProcessTreeMock).not.toHaveBeenCalled();
  });

  taskTest.for([
    { mode: "foreground", state: "live" },
    { mode: "supervised", state: "dead" },
  ] as const)(
    "rejects matching argv for a $state $mode owner",
    async ({ mode, state }, { env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      readGatewayOwnerLease.mockReturnValue({
        ...GATEWAY_OWNER,
        mode,
        state,
        supervisor: mode === "foreground" ? null : GATEWAY_OWNER.supervisor,
      });
      spawnSync.mockReturnValue(snapshotResult([installedGateway]));

      await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([]);

      expect(taskkillPids()).toEqual([]);
      expect(killProcessTreeMock).not.toHaveBeenCalled();
    },
  );

  taskTest.for([
    { phase: "before graceful stop", change: "replacement" },
    { phase: "before forced stop", change: "replacement" },
    { phase: "before graceful stop", change: "dead" },
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

  taskTest.for(["before ownership discovery", "before graceful stop", "before forced stop"])(
    "terminates the same owner after it becomes unknown %s",
    async (phase, { env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      let unknown = false;
      let forced = false;
      readGatewayOwnerLease.mockImplementation(() =>
        unknown ? { ...GATEWAY_OWNER, state: "unknown" } : GATEWAY_OWNER,
      );
      if (phase === "before ownership discovery") {
        unknown = true;
      } else if (phase === "before graceful stop") {
        readGatewayOwnerLease.mockImplementationOnce(() => {
          unknown = true;
          return GATEWAY_OWNER;
        });
      }
      mockGatewayProcess(
        () => phase === "before forced stop" && !forced,
        (force) => {
          unknown = true;
          forced = force;
        },
      );

      await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([4242]);

      expect(readWindowsProcessStartTimeSync).toHaveBeenCalledWith(4242, 5_000, env);

      expect(taskkillCalls()).toEqual(
        phase !== "before forced stop"
          ? [["/T", "/PID", "4242"]]
          : [
              ["/T", "/PID", "4242"],
              ["/F", "/T", "/PID", "4242"],
            ],
      );
      expect(taskkillCalls().flat()).not.toContain("9999");
      expect(killProcessTreeMock).not.toHaveBeenCalled();
    },
  );

  taskTest("finishes terminating the validated owner after lease removal", async ({ env }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    let leaseRemoved = false;
    let forced = false;
    readGatewayOwnerLease.mockImplementation(() => (leaseRemoved ? undefined : GATEWAY_OWNER));
    readWindowsProcessStartTimeSync.mockReturnValue(GATEWAY_OWNER.startedAt);
    mockGatewayProcess(
      () => !forced,
      (force) => {
        leaseRemoved = true;
        forced = force;
      },
    );

    await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([4242]);

    expect(readWindowsProcessStartTimeSync).toHaveBeenCalledWith(4242, 5_000, env);
    expect(taskkillPids()).toEqual([4242, 4242]);
  });

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

      expect(taskkillPids()).toEqual([]);
      expect(killProcessTreeMock).not.toHaveBeenCalled();
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

    expect(taskkillPids()).toEqual([]);
    expect(killProcessTreeMock).not.toHaveBeenCalled();
  });

  taskTest("avoids forced termination after exit despite stale CIM", async ({ env }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    inspectPortUsageMock.mockResolvedValue(freePortUsage());
    let removed = false;
    spawnSync.mockImplementation((command) => {
      const executable = command.toLowerCase();
      if (executable.endsWith("taskkill.exe")) {
        removed = true;
        return spawnSyncResult("");
      }
      if (executable.endsWith("tasklist.exe")) {
        return tasklistResult(!removed);
      }
      // Model the lagging CIM result from the packaged Windows failure.
      return snapshotResult([installedGateway, powershellProcess]);
    });

    await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([4242]);

    expect(taskkillCalls()).toEqual([["/T", "/PID", "4242"]]);
    expect(spawnSync.mock.calls).toContainEqual([
      expect.stringMatching(/tasklist\.exe$/i),
      ["/FI", "PID eq 4242", "/FO", "CSV", "/NH"],
      expect.objectContaining({ timeout: 1_500 }),
    ]);
  });

  taskTest("waits beyond five seconds for forced termination", async ({ env }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    let forced = false;
    let tasklistCallsAfterForce = 0;
    readGatewayOwnerLease.mockReturnValue(GATEWAY_OWNER);
    spawnSync.mockImplementation((command, args) => {
      const executable = command.toLowerCase();
      if (executable.endsWith("taskkill.exe")) {
        forced = args?.includes("/F") ?? false;
        return spawnSyncResult("");
      }
      if (executable.endsWith("tasklist.exe")) {
        if (forced) {
          tasklistCallsAfterForce += 1;
        }
        return tasklistResult(!forced || tasklistCallsAfterForce <= 75);
      }
      return snapshotResult([installedGateway]);
    });

    await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([4242]);

    expect(taskkillPids()).toEqual([4242, 4242]);
    expect(tasklistCallsAfterForce).toBe(76);
  });

  taskTest.for(["task-supervisor", "gateway-with-supervisor"])(
    "stops the exact installed %s before it binds",
    async (owner, { env, stdout }) => {
      vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      pushSuccessfulSchtasksResponses(3);
      inspectPortUsageMock.mockResolvedValue(freePortUsage());
      let forced = false;
      spawnSync.mockImplementation((command, args, options) => {
        expect(options?.env).toBeDefined();
        expect(options?.env).not.toHaveProperty("BOUNDARY_PARENT_ONLY");
        if (args?.includes("-EncodedCommand")) {
          return scheduledTaskProbeResult();
        }
        const executable = command.toLowerCase();
        if (executable.endsWith("taskkill.exe")) {
          if (args?.includes("/F")) {
            forced = true;
            return spawnSyncResult("");
          }
          return spawnSyncResult("", 1);
        }
        if (executable.endsWith("tasklist.exe")) {
          return tasklistResult(!forced);
        }
        const processes = [
          ...(owner === "gateway-with-supervisor"
            ? [
                {
                  ProcessId: 4141,
                  CommandLine: `${INSTALLED_GATEWAY_COMMAND_LINE} --task-supervisor`,
                },
              ]
            : []),
          {
            ProcessId: 3131,
            CommandLine:
              '"C:\\Program Files\\nodejs\\node.exe" "C:\\other-openclaw.cjs" gateway --port 18789',
          },
          ...(!forced
            ? [
                {
                  ProcessId: 4242,
                  CommandLine:
                    INSTALLED_GATEWAY_COMMAND_LINE +
                    (owner === "task-supervisor" ? " --task-supervisor" : ""),
                },
              ]
            : []),
          powershellProcess,
        ];
        return snapshotResult(processes);
      });

      await stopScheduledTask({ env, stdout });

      expect(taskkillCalls()).toEqual([
        ["/T", "/PID", "4242"],
        ["/F", "/T", "/PID", "4242"],
      ]);
      expect(spawnSync.mock.calls).toContainEqual([
        expect.stringMatching(/tasklist\.exe$/i),
        ["/FI", "PID eq 4242", "/FO", "CSV", "/NH"],
        expect.objectContaining({ timeout: 1_500 }),
      ]);
      expect(taskkillCalls().flat()).not.toContain("3131");
      expect(taskkillCalls().flat()).not.toContain("4141");
      expect(killProcessTreeMock).not.toHaveBeenCalled();
    },
  );

  taskTest("starts despite audit observer failure", async ({ env }) => {
    pushSuccessfulSchtasksResponses(3);
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
    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expect(taskkillPids()).toEqual([]);
  });

  taskTest.for(["stop", "restart"] as const)(
    "preserves gateway listeners during node task %s",
    async (action, { env, stdout }) => {
      const restart = action === "restart";
      pushSuccessfulSchtasksResponses(restart ? 4 : 3);
      env.OPENCLAW_SERVICE_KIND = "node";
      env.OPENCLAW_WINDOWS_TASK_NAME = "OpenClaw Node";
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      inspectPortUsageMock.mockResolvedValue(busyPortUsage(4242));

      if (restart) {
        await expect(restartScheduledTask({ env, stdout })).resolves.toEqual({
          outcome: "completed",
        });
      } else {
        await stopScheduledTask({ env, stdout });
      }

      expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
      expect(inspectPortUsageMock).not.toHaveBeenCalled();
      expect(killProcessTreeMock).not.toHaveBeenCalled();
      expect(schtasksCalls).toEqual([
        ["/Query"],
        ["/Query", "/TN", "OpenClaw Node"],
        ["/End", "/TN", "OpenClaw Node"],
        ...(restart ? [["/Run", "/TN", "OpenClaw Node"]] : []),
      ]);
    },
  );

  it("waits for the owned gateway port before restarting its redirected task", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const onMutation = vi.fn();
      pushSuccessfulSchtasksResponses(4);
      mockWindowsTaskkillSuccess();
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([5151]);
      mockLingeringGatewayListener(5151);

      await expect(restartScheduledTask({ env, stdout, onMutation })).resolves.toEqual({
        outcome: "completed",
        taskSettlement: {
          status: "settled",
          taskName: "OpenClaw Gateway",
          lastRunResult: "0",
          ended: false,
        },
      });

      expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
      expectGatewayTermination(5151);
      expectTaskkill(5151);
      expect(inspectPortUsageMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(inspectPortUsageMock).toHaveBeenCalledWith(GATEWAY_PORT, {
        probeHosts: ["127.0.0.1"],
      });
      expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-restart" });
      expect(schtasksCalls).toEqual([
        ["/Query"],
        ["/Query", "/TN", "OpenClaw Gateway"],
        ["/Run", "/TN", "OpenClaw Gateway"],
      ]);
    }, '2>&1 >> "gateway output.log" < NUL');
  });

  taskTest.for(["routing", "activation"] as const)(
    "rejects restart after losing authority during %s",
    async (stage, { env, stdout }) => {
      pushSuccessfulSchtasksResponses(4);
      let current = stage !== "routing";
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
        stage === "routing" || process.platform === "win32"
          ? []
          : [["/End", "/TN", "OpenClaw Gateway"]],
      );
      expect(killProcessTreeMock).not.toHaveBeenCalled();
    },
  );

  taskTest("throws when /Run fails during restart", async ({ env, stdout }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const onMutation = vi.fn();
    setTaskStateProbeResult(() => (schtasksCalls.some(([action]) => action === "/End") ? 3 : 4));
    pushSuccessfulSchtasksResponses(3);
    schtasksResponses.push({ code: 1, stdout: "", stderr: "ERROR: Access is denied." });

    await expect(restartScheduledTask({ env, stdout, onMutation })).rejects.toThrow(
      "schtasks run failed: ERROR: Access is denied.",
    );
    expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-end" });
    expect(onMutation).not.toHaveBeenCalledWith({ mode: "schtasks-restart" });
    expect(schtasksCalls.at(-1)).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
  });
});
