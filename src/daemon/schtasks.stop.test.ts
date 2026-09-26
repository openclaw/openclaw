import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { quoteCmdScriptArg } from "./cmd-argv.js";
import {
  GATEWAY_OWNER,
  GATEWAY_PORT,
  INSTALLED_GATEWAY_COMMAND_LINE,
  SUCCESS_RESPONSE,
  expectGatewayTermination,
  expectTaskkill,
  findVerifiedGatewayListenerPidsOnPortSync,
  formatWindowsTaskSupervisorChildArgument,
  mockWindowsTaskkillSuccess,
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
  startScheduledTask,
  stopScheduledTask,
  taskkillPids,
  terminateScheduledTaskGatewayListeners,
  withPreparedGatewayTask,
  busyPortUsage,
  freePortUsage,
} from "./schtasks.stop.test-support.js";
import {
  gatewayServiceProbeHostsMock,
  inspectPortUsageMock,
  killProcessTreeMock,
  schtasksCalls,
  schtasksResponses,
} from "./test-helpers/schtasks-fixtures.js";

describe("Scheduled Task stop/restart cleanup", () => {
  it.each([
    { stdout: '"node.exe","4242","Console","1","1,024 K"', status: 0, result: "alive" },
    { stdout: "No tasks", status: 0, result: "missing" },
    { stdout: "", status: 1, result: "unknown" },
  ])(
    "keeps the tasklist fallback verdict $result with a closed environment",
    ({ stdout, status, result }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
      // The default CIM failure reaches the independent PID-only tasklist probe.
      spawnSync.mockReturnValueOnce({
        pid: 0,
        output: [],
        stdout: "",
        stderr: "",
        status: 1,
        signal: null,
      });
      spawnSync.mockReturnValueOnce({
        pid: 0,
        output: [],
        stdout,
        stderr: "",
        status,
        signal: null,
      });
      expect(probeProcessState(4242)).toBe(result);
      expect(spawnSync).toHaveBeenCalledTimes(2);
      expect(spawnSync.mock.calls[1]).toEqual([
        expect.stringMatching(/tasklist\.exe$/i),
        ["/FI", "PID eq 4242", "/FO", "CSV", "/NH"],
        expect.objectContaining({
          env: expect.not.objectContaining({ BOUNDARY_PARENT_ONLY: "synthetic" }),
          timeout: 1_500,
        }),
      ]);
    },
  );

  it.each([
    { state: 1, label: "disabled" },
    { state: 3, label: "ready" },
  ])("accepts a localized /End failure when COM proves the task is $label", async ({ state }) => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      const onMutation = vi.fn();
      schtasksResponses.push(
        { ...SUCCESS_RESPONSE },
        { ...SUCCESS_RESPONSE },
        {
          code: 1,
          stdout: "",
          stderr: "FEHLER: Die Aufgabe wird derzeit nicht ausgeführt.",
        },
      );
      setTaskStateProbeResult(state);

      await expect(stopScheduledTask({ env, stdout, onMutation })).resolves.toBeUndefined();

      expect(schtasksCalls).toEqual([
        ["/Query"],
        ["/Query", "/TN", "OpenClaw Gateway"],
        ["/End", "/TN", "OpenClaw Gateway"],
      ]);
      // Native Windows cleanup adds a CIM ownership snapshot; portable lanes
      // exercise only the locale-independent COM state probe here.
      expect(spawnSync).toHaveBeenCalledTimes(process.platform === "win32" ? 2 : 1);
      expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-stop" });
    });
  });

  it.each([
    { state: 0, label: "unknown" },
    { state: 2, label: "queued" },
    { state: 4, label: "running" },
  ])("fails closed after a localized /End failure when the task is $label", async ({ state }) => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      const onMutation = vi.fn();
      schtasksResponses.push(
        { ...SUCCESS_RESPONSE },
        { ...SUCCESS_RESPONSE },
        {
          code: 1,
          stdout: "",
          stderr: "FEHLER: Die Aufgabe konnte nicht beendet werden.",
        },
      );
      setTaskStateProbeResult(state);

      await expect(stopScheduledTask({ env, stdout, onMutation })).rejects.toThrow(
        "schtasks end failed: FEHLER: Die Aufgabe konnte nicht beendet werden.",
      );

      expect(spawnSync).toHaveBeenCalledOnce();
      expect(onMutation).not.toHaveBeenCalled();
    });
  });

  it.each([
    { label: "malformed", status: 0, probeOutput: "3 trailing output" },
    { label: "missing", status: 1, probeOutput: "-2147024894" },
    { label: "unavailable", status: 1, probeOutput: "-2147024891" },
  ])(
    "fails closed after a localized /End failure when the state probe is $label",
    async ({ status, probeOutput }) => {
      await withPreparedGatewayTask(async ({ env, stdout }) => {
        const onMutation = vi.fn();
        schtasksResponses.push(
          { ...SUCCESS_RESPONSE },
          { ...SUCCESS_RESPONSE },
          {
            code: 1,
            stdout: "",
            stderr: "FEHLER: Der Aufgabenstatus ist nicht verfügbar.",
          },
        );
        spawnSync.mockReturnValueOnce({
          pid: 0,
          output: [null, probeOutput, ""],
          stdout: probeOutput,
          stderr: "",
          status,
          signal: null,
        });

        await expect(stopScheduledTask({ env, stdout, onMutation })).rejects.toThrow(
          "schtasks end failed: FEHLER: Der Aufgabenstatus ist nicht verfügbar.",
        );

        expect(spawnSync).toHaveBeenCalledOnce();
        expect(onMutation).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["", '< NUL >> "gateway output.log" 2>&1'])(
    "kills the lingering gateway owned by the persisted task with suffix %s",
    async (launcherSuffix) => {
      await withPreparedGatewayTask(async ({ env, stdout }) => {
        const onMutation = vi.fn();
        pushSuccessfulSchtasksResponses(3);
        mockWindowsTaskkillSuccess();
        findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
        inspectPortUsageMock
          .mockResolvedValueOnce(
            busyPortUsage(4242, { commandLine: INSTALLED_GATEWAY_COMMAND_LINE }),
          )
          .mockResolvedValueOnce(freePortUsage());

        await stopScheduledTask({ env, stdout, onMutation });

        expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
        expectGatewayTermination(4242);
        expectTaskkill(4242);
        expect(inspectPortUsageMock).toHaveBeenCalledTimes(2);
        expect(inspectPortUsageMock).toHaveBeenCalledWith(GATEWAY_PORT, {
          probeHosts: ["127.0.0.1"],
        });
        expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-stop" });
      }, launcherSuffix);
    },
  );

  it("does not adopt a portless arbitrary task action", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
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
  });

  it("prefers the supervised Gateway child over its task supervisor", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      spawnSync.mockImplementation(() => {
        const output = JSON.stringify([
          {
            ProcessId: 4141,
            CommandLine: `${INSTALLED_GATEWAY_COMMAND_LINE} --task-supervisor`,
          },
          {
            ProcessId: 4242,
            CommandLine: `${INSTALLED_GATEWAY_COMMAND_LINE} ${formatWindowsTaskSupervisorChildArgument(305419896)}`,
          },
        ]);
        return spawnSyncResult(output);
      });

      await expect(resolveScheduledTaskOwnedGatewayPids(env)).resolves.toEqual([4242]);
    });
  });

  it.each([false, true])(
    "finds a live supervised owner before it binds despite stale installed argv (expired=%s)",
    async (expired) => {
      await withPreparedGatewayTask(async ({ env }) => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        readGatewayOwnerLease.mockReturnValue({ ...GATEWAY_OWNER, expired });

        await expect(resolveScheduledTaskOwnedGatewayPids(env)).resolves.toEqual([4242]);

        expect(inspectPortUsageMock).not.toHaveBeenCalled();
        expect(spawnSync).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    { kind: "external", name: null },
    { kind: "schtasks", name: "Another Gateway Task" },
  ] as const)("preserves a live owner supervised by $kind $name", async (supervisor) => {
    await withPreparedGatewayTask(async ({ env }) => {
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
  });

  it.each([
    { mode: "foreground", state: "live" },
    { mode: "supervised", state: "dead" },
  ] as const)(
    "does not adopt a $state $mode recorded owner through matching task argv",
    async ({ mode, state }) => {
      await withPreparedGatewayTask(async ({ env }) => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        readGatewayOwnerLease.mockReturnValue({
          ...GATEWAY_OWNER,
          mode,
          state,
          supervisor: mode === "foreground" ? null : GATEWAY_OWNER.supervisor,
        });
        const output = JSON.stringify([
          { ProcessId: 4242, CommandLine: INSTALLED_GATEWAY_COMMAND_LINE },
        ]);
        spawnSync.mockReturnValue(spawnSyncResult(output));

        await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([]);

        expect(taskkillPids()).toEqual([]);
        expect(killProcessTreeMock).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["before ownership discovery", "before graceful stop", "before forced stop"])(
    "refuses a recorded owner that changes %s",
    async (phase) => {
      await withPreparedGatewayTask(async ({ env }) => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        let changed = false;
        let killed = false;
        readGatewayOwnerLease.mockImplementation(() =>
          changed ? { ...GATEWAY_OWNER, owner: "gateway-owner-2", startedAt: 200 } : GATEWAY_OWNER,
        );
        if (phase === "before graceful stop") {
          readGatewayOwnerLease.mockImplementationOnce(() => {
            changed = true;
            return GATEWAY_OWNER;
          });
        }
        spawnSync.mockImplementation((command, args) => {
          const executable = command.toLowerCase();
          if (executable.endsWith("taskkill.exe")) {
            changed = true;
            killed = args?.includes("/F") ?? false;
            return {
              pid: 0,
              output: [null, "", ""],
              stdout: "",
              stderr: "",
              status: 0,
              signal: null,
            };
          }
          if (executable.endsWith("tasklist.exe")) {
            const output = killed ? "No tasks" : '"node.exe","4242","Console","1","1 K"';
            return spawnSyncResult(output);
          }
          const output = JSON.stringify([
            ...(!killed ? [{ ProcessId: 4242, CommandLine: INSTALLED_GATEWAY_COMMAND_LINE }] : []),
            { ProcessId: 9999, CommandLine: "powershell.exe" },
          ]);
          return spawnSyncResult(output);
        });

        await expect(terminateScheduledTaskGatewayListeners(env)).rejects.toThrow(
          "Gateway owner changed before terminating process 4242",
        );

        const taskkillCalls = spawnSync.mock.calls
          .filter(([command]) => command.toLowerCase().endsWith("taskkill.exe"))
          .map(([, args]) => args);
        expect(taskkillCalls).toEqual(
          phase === "before graceful stop" ? [] : [["/T", "/PID", "4242"]],
        );
      });
    },
  );

  it.each(["before ownership discovery", "before graceful stop", "before forced stop"])(
    "keeps terminating the same Scheduled Task owner after it becomes unknown %s",
    async (phase) => {
      await withPreparedGatewayTask(async ({ env }) => {
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
        spawnSync.mockImplementation((command, args) => {
          const executable = command.toLowerCase();
          if (executable.endsWith("taskkill.exe")) {
            unknown = true;
            forced = args?.includes("/F") ?? false;
            return {
              pid: 0,
              output: [null, "", ""],
              stdout: "",
              stderr: "",
              status: 0,
              signal: null,
            };
          }
          if (executable.endsWith("tasklist.exe")) {
            const alive = phase === "before forced stop" && !forced;
            const output = alive ? '"node.exe","4242","Console","1","1 K"' : "No tasks";
            return spawnSyncResult(output);
          }
          const keepGateway = phase === "before forced stop" && !forced;
          const output = JSON.stringify([
            ...(keepGateway
              ? [{ ProcessId: 4242, CommandLine: INSTALLED_GATEWAY_COMMAND_LINE }]
              : []),
            { ProcessId: 9999, CommandLine: "powershell.exe" },
          ]);
          return spawnSyncResult(output);
        });

        await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([4242]);

        expect(readWindowsProcessStartTimeSync).toHaveBeenCalledWith(4242, 5_000, env);

        const taskkillCalls = spawnSync.mock.calls
          .filter(([command]) => command.toLowerCase().endsWith("taskkill.exe"))
          .map(([, args]) => args);
        expect(taskkillCalls).toEqual(
          phase !== "before forced stop"
            ? [["/T", "/PID", "4242"]]
            : [
                ["/T", "/PID", "4242"],
                ["/F", "/T", "/PID", "4242"],
              ],
        );
        expect(taskkillCalls.flat()).not.toContain("9999");
        expect(killProcessTreeMock).not.toHaveBeenCalled();
      });
    },
  );

  it("keeps terminating the validated owner after graceful shutdown removes its lease", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      let leaseRemoved = false;
      let forced = false;
      readGatewayOwnerLease.mockImplementation(() => (leaseRemoved ? undefined : GATEWAY_OWNER));
      readWindowsProcessStartTimeSync.mockReturnValue(GATEWAY_OWNER.startedAt);
      spawnSync.mockImplementation((command, args) => {
        const executable = command.toLowerCase();
        if (executable.endsWith("taskkill.exe")) {
          leaseRemoved = true;
          forced = args?.includes("/F") ?? false;
          return {
            pid: 0,
            output: [null, "", ""],
            stdout: "",
            stderr: "",
            status: 0,
            signal: null,
          };
        }
        if (executable.endsWith("tasklist.exe")) {
          const output = forced ? "No tasks" : '"node.exe","4242","Console","1","1 K"';
          return spawnSyncResult(output);
        }
        const output = JSON.stringify([
          ...(!forced ? [{ ProcessId: 4242, CommandLine: INSTALLED_GATEWAY_COMMAND_LINE }] : []),
          { ProcessId: 9999, CommandLine: "powershell.exe" },
        ]);
        return spawnSyncResult(output);
      });

      await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([4242]);

      expect(readWindowsProcessStartTimeSync).toHaveBeenCalledWith(4242, 5_000, env);
      expect(taskkillPids()).toEqual([4242, 4242]);
    });
  });

  it.each([
    { label: "belongs to another host", owner: { host: "another-host" }, currentStart: 100 },
    { label: "has no recorded process identity", owner: { startedAt: null }, currentStart: 100 },
    { label: "cannot read its current process identity", owner: {}, currentStart: null },
    { label: "has reused its pid", owner: {}, currentStart: 101 },
  ] as const)(
    "does not terminate an unknown owner that $label",
    async ({ owner, currentStart }) => {
      await withPreparedGatewayTask(async ({ env }) => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        readGatewayOwnerLease.mockReturnValue({ ...GATEWAY_OWNER, ...owner, state: "unknown" });
        readWindowsProcessStartTimeSync.mockReturnValue(currentStart);
        mockWindowsTaskkillSuccess();

        await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([]);

        expect(taskkillPids()).toEqual([]);
        expect(killProcessTreeMock).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["before graceful stop", "before forced stop"])(
    "refuses a dead or reused recorded owner %s",
    async (phase) => {
      await withPreparedGatewayTask(async ({ env }) => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        let dead = false;
        let forced = false;
        readGatewayOwnerLease.mockImplementation(() =>
          dead ? { ...GATEWAY_OWNER, state: "dead" } : GATEWAY_OWNER,
        );
        if (phase === "before graceful stop") {
          readGatewayOwnerLease.mockImplementationOnce(() => {
            dead = true;
            return GATEWAY_OWNER;
          });
        }
        spawnSync.mockImplementation((command, args) => {
          const executable = command.toLowerCase();
          if (executable.endsWith("taskkill.exe")) {
            dead = true;
            forced = args?.includes("/F") ?? false;
            return {
              pid: 0,
              output: [null, "", ""],
              stdout: "",
              stderr: "",
              status: 0,
              signal: null,
            };
          }
          if (executable.endsWith("tasklist.exe")) {
            const output = forced ? "No tasks" : '"node.exe","4242","Console","1","1 K"';
            return spawnSyncResult(output);
          }
          const output = JSON.stringify([
            ...(!forced ? [{ ProcessId: 4242, CommandLine: INSTALLED_GATEWAY_COMMAND_LINE }] : []),
            { ProcessId: 9999, CommandLine: "powershell.exe" },
          ]);
          return spawnSyncResult(output);
        });

        await expect(terminateScheduledTaskGatewayListeners(env)).rejects.toThrow(
          "Gateway owner changed before terminating process 4242",
        );

        const taskkillCalls = spawnSync.mock.calls
          .filter(([command]) => command.toLowerCase().endsWith("taskkill.exe"))
          .map(([, args]) => args);
        expect(taskkillCalls).toEqual(
          phase === "before graceful stop" ? [] : [["/T", "/PID", "4242"]],
        );
      });
    },
  );

  it("refuses legacy cleanup when a recorded foreground owner appears during discovery", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
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
        "Gateway owner changed before terminating process 4242",
      );

      expect(taskkillPids()).toEqual([]);
      expect(killProcessTreeMock).not.toHaveBeenCalled();
    });
  });

  it("does not force a gracefully removed owner when the CIM snapshot is stale", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      inspectPortUsageMock.mockResolvedValue(freePortUsage());
      let removed = false;
      spawnSync.mockImplementation((command) => {
        const executable = command.toLowerCase();
        if (executable.endsWith("taskkill.exe")) {
          removed = true;
          return {
            pid: 0,
            output: [null, "", ""],
            stdout: "",
            stderr: "",
            status: 0,
            signal: null,
          };
        }
        if (executable.endsWith("tasklist.exe")) {
          const output = removed ? "No tasks" : '"node.exe","4242","Console","1","1 K"';
          return spawnSyncResult(output);
        }
        // Model the lagging CIM result from the packaged Windows failure.
        const output = JSON.stringify([
          { ProcessId: 4242, CommandLine: INSTALLED_GATEWAY_COMMAND_LINE },
          { ProcessId: 9999, CommandLine: "powershell.exe" },
        ]);
        return spawnSyncResult(output);
      });

      await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([4242]);

      const taskkillCalls = spawnSync.mock.calls
        .filter(([command]) => command.toLowerCase().endsWith("taskkill.exe"))
        .map(([, args]) => args);
      expect(taskkillCalls).toEqual([["/T", "/PID", "4242"]]);
      expect(spawnSync.mock.calls).toContainEqual([
        expect.stringMatching(/tasklist\.exe$/i),
        ["/FI", "PID eq 4242", "/FO", "CSV", "/NH"],
        expect.objectContaining({ timeout: 1_500 }),
      ]);
    });
  });

  it("allows forced taskkill process teardown to settle beyond five seconds", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
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
          const output =
            forced && tasklistCallsAfterForce > 75
              ? "No tasks"
              : '"node.exe","4242","Console","1","1 K"';
          return spawnSyncResult(output);
        }
        const output = JSON.stringify([
          { ProcessId: 4242, CommandLine: INSTALLED_GATEWAY_COMMAND_LINE },
        ]);
        return spawnSyncResult(output);
      });

      await expect(terminateScheduledTaskGatewayListeners(env)).resolves.toEqual([4242]);

      expect(taskkillPids()).toEqual([4242, 4242]);
      expect(tasklistCallsAfterForce).toBe(76);
    });
  });

  it.each(["gateway", "task-supervisor", "gateway-with-supervisor"])(
    "stops the exact installed Windows %s even before its port is bound",
    async (owner) => {
      vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
      await withPreparedGatewayTask(async ({ env, stdout }) => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        pushSuccessfulSchtasksResponses(3);
        inspectPortUsageMock.mockResolvedValue(freePortUsage());
        let forced = false;
        spawnSync.mockImplementation((command, args, options) => {
          expect(options?.env).toBeDefined();
          expect(options?.env).not.toHaveProperty("BOUNDARY_PARENT_ONLY");
          const executable = command.toLowerCase();
          if (executable.endsWith("taskkill.exe")) {
            const argv = Array.isArray(args) ? args.map(String) : [];
            if (argv.includes("/F")) {
              forced = true;
              return {
                pid: 0,
                output: [null, "", ""],
                stdout: "",
                stderr: "",
                status: 0,
                signal: null,
              };
            }
            return {
              pid: 0,
              output: [null, "", ""],
              stdout: "",
              stderr: "",
              status: 1,
              signal: null,
            };
          }
          if (executable.endsWith("tasklist.exe")) {
            const output = forced ? "No tasks" : '"node.exe","4242","Console","1","1 K"';
            return spawnSyncResult(output);
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
            { ProcessId: 9999, CommandLine: "powershell.exe" },
          ];
          const output = JSON.stringify(processes);
          return spawnSyncResult(output);
        });

        await stopScheduledTask({ env, stdout });

        const taskkillCalls = spawnSync.mock.calls
          .filter(([command]) => command.toLowerCase().endsWith("taskkill.exe"))
          .map(([, args]) => args);
        expect(taskkillCalls).toEqual([
          ["/T", "/PID", "4242"],
          ["/F", "/T", "/PID", "4242"],
        ]);
        expect(spawnSync.mock.calls).toContainEqual([
          expect.stringMatching(/tasklist\.exe$/i),
          ["/FI", "PID eq 4242", "/FO", "CSV", "/NH"],
          expect.objectContaining({ timeout: 1_500 }),
        ]);
        expect(taskkillCalls.flat()).not.toContain("3131");
        expect(taskkillCalls.flat()).not.toContain("4141");
        expect(killProcessTreeMock).not.toHaveBeenCalled();
      });
    },
  );

  it("starts a registered task and ignores audit observer failures", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push(
        { ...SUCCESS_RESPONSE },
        { ...SUCCESS_RESPONSE },
        { ...SUCCESS_RESPONSE },
      );
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
  });

  it("audits a successful task stop before a later output failure", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      pushSuccessfulSchtasksResponses(3);
      const onMutation = vi.fn();
      const stdout = {
        write: vi.fn(() => {
          throw new Error("output failed");
        }),
      } as unknown as NodeJS.WritableStream;

      await expect(stopScheduledTask({ env, stdout, onMutation })).rejects.toThrow("output failed");

      expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-stop" });
    });
  });

  it("does not kill an unrelated listener when the owned process leaves another required host busy", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(3);
      mockWindowsTaskkillSuccess();
      inspectPortUsageMock.mockResolvedValueOnce(
        busyPortUsage(4242, { commandLine: INSTALLED_GATEWAY_COMMAND_LINE }),
      );
      inspectPortUsageMock.mockResolvedValue(busyPortUsage(5252));

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
  });

  it("refuses a same-port gateway from another checkout when the CIM snapshot is unavailable", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(3);
      mockWindowsTaskkillSuccess();
      const foreignGatewayCommandLine =
        '"C:\\Program Files\\nodejs\\node.exe" "D:\\other-checkout\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789';
      inspectPortUsageMock.mockResolvedValue(
        busyPortUsage(6262, { commandLine: foreignGatewayCommandLine }),
      );

      const failure = await stopScheduledTask({ env, stdout }).catch((err: unknown) => err);

      expect(String(failure)).toContain("remaining listener ownership could not be verified");
      expect(String(failure)).toContain("pid 6262");
      expect(String(failure)).toContain("openclaw gateway");
      expect(killProcessTreeMock).not.toHaveBeenCalled();
      expect(taskkillPids()).not.toContain(6262);
    });
  });

  it("reports remaining listeners when the port stays busy before restart", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(3);
      inspectPortUsageMock.mockResolvedValue(busyPortUsage(5151));

      const failure = await restartScheduledTask({ env, stdout }).catch((err: unknown) => err);

      expect(String(failure)).toContain("is still busy before restart");
      expect(String(failure)).toContain("pid 5151");
      expect(killProcessTreeMock).not.toHaveBeenCalled();
      expect(taskkillPids()).toEqual([]);
    });
  });

  it("preserves literal CMD escapes when stopping an inspected Windows gateway listener", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const argv = [
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\OpenClaw %% ^! A\\dist\\index.js",
        "gateway",
        "--port",
        "18789",
      ];
      await fs.writeFile(
        resolveTaskScriptPath(env),
        `@echo off\r\n${argv.map((arg) => quoteCmdScriptArg(arg)).join(" ")}\r\n`,
      );
      pushSuccessfulSchtasksResponses(3);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
      mockWindowsTaskkillSuccess();
      inspectPortUsageMock
        .mockResolvedValueOnce(
          busyPortUsage(6262, {
            commandLine: argv.map((arg) => `"${arg}"`).join(" "),
          }),
        )
        .mockResolvedValueOnce(freePortUsage());

      await stopScheduledTask({ env, stdout });

      expectGatewayTermination(6262);
      expectTaskkill(6262);
      expect(inspectPortUsageMock).toHaveBeenCalledTimes(2);
    });
  });

  it("does not reclaim gateway listeners when stopping a node Scheduled Task", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(3);
      env.OPENCLAW_SERVICE_KIND = "node";
      env.OPENCLAW_WINDOWS_TASK_NAME = "OpenClaw Node";
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4242]);
      inspectPortUsageMock.mockResolvedValue(busyPortUsage(4242));

      await stopScheduledTask({ env, stdout });

      expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
      expect(inspectPortUsageMock).not.toHaveBeenCalled();
      expect(killProcessTreeMock).not.toHaveBeenCalled();
      expect(schtasksCalls).toEqual([
        ["/Query"],
        ["/Query", "/TN", "OpenClaw Node"],
        ["/End", "/TN", "OpenClaw Node"],
      ]);
    });
  });

  it.each(["", '2>&1 >> "gateway output.log" < NUL'])(
    "waits for the owned gateway port before restart with suffix %s",
    async (launcherSuffix) => {
      await withPreparedGatewayTask(async ({ env, stdout }) => {
        const onMutation = vi.fn();
        pushSuccessfulSchtasksResponses(4);
        mockWindowsTaskkillSuccess();
        findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([5151]);
        inspectPortUsageMock
          .mockResolvedValueOnce(
            busyPortUsage(5151, { commandLine: INSTALLED_GATEWAY_COMMAND_LINE }),
          )
          .mockResolvedValueOnce(freePortUsage());

        await expect(restartScheduledTask({ env, stdout, onMutation })).resolves.toEqual({
          outcome: "completed",
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
          ["/End", "/TN", "OpenClaw Gateway"],
          ["/Run", "/TN", "OpenClaw Gateway"],
        ]);
      }, launcherSuffix);
    },
  );

  it.each(["routing", "activation"] as const)(
    "refuses Scheduled Task restart after losing continuation authority during %s",
    async (stage) => {
      await withPreparedGatewayTask(async ({ env, stdout }) => {
        pushSuccessfulSchtasksResponses(4);
        let current = stage !== "routing";
        inspectPortUsageMock.mockImplementation(async () => {
          current = false;
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
          stage === "routing" ? [] : [["/End", "/TN", "OpenClaw Gateway"]],
        );
        expect(killProcessTreeMock).not.toHaveBeenCalled();
      });
    },
  );

  it("does not wait on or force-kill the gateway port when restarting a node Scheduled Task", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      pushSuccessfulSchtasksResponses(4);
      env.OPENCLAW_SERVICE_KIND = "node";
      env.OPENCLAW_WINDOWS_TASK_NAME = "OpenClaw Node";
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([5151]);
      inspectPortUsageMock.mockResolvedValue(busyPortUsage(5151));

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
  });

  it("throws when /Run fails during restart", async () => {
    await withPreparedGatewayTask(async ({ env, stdout }) => {
      const onMutation = vi.fn();
      schtasksResponses.push(
        { ...SUCCESS_RESPONSE },
        { ...SUCCESS_RESPONSE },
        { ...SUCCESS_RESPONSE },
        { code: 1, stdout: "", stderr: "ERROR: Access is denied." },
      );

      await expect(restartScheduledTask({ env, stdout, onMutation })).rejects.toThrow(
        "schtasks run failed: ERROR: Access is denied.",
      );
      expect(onMutation).toHaveBeenCalledWith({ mode: "schtasks-end" });
      expect(onMutation).not.toHaveBeenCalledWith({ mode: "schtasks-restart" });
      expect(schtasksCalls.at(-1)).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });
});
