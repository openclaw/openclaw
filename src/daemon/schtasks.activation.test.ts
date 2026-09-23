import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  runScheduledTaskOrThrow,
  timeState,
  sleepMock,
  spawn,
  spawnSync,
  taskProbe,
  installScheduledTask,
  resolveTaskScriptPath,
  NODE_PROCESS_QUERY,
  makeNodeServiceEnv,
  makeSpawnSyncResult,
  expectNoGatewayTermination,
  addMissingTaskInstallResponses,
  installGatewayScheduledTask,
  fastForwardTaskStartWait,
  addAcceptedRunNeverStartsResponses,
  type TaskSnapshot,
  notYetRunTaskSnapshot,
  cleanExitTaskSnapshot,
  runningTaskSnapshot,
} from "./schtasks.startup-fallback.test-support.js";
import {
  gatewayServiceProbeHostsMock,
  inspectPortUsageMock,
  schtasksCalls,
  withWindowsEnv,
  writeGatewayScript,
  writeNodeScript,
} from "./test-helpers/schtasks-fixtures.js";

const { getWindowsPowerShellExePath } = await import("../infra/windows-install-roots.js");

describe("Windows activation ownership", () => {
  it("does not treat a pre-existing gateway listener as Scheduled Task launch evidence", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      fastForwardTaskStartWait();
      // A foreground `openclaw gateway` already owns the managed port before `schtasks /Run`.
      inspectPortUsageMock.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [
          {
            pid: 4242,
            command: "node.exe",
            commandLine: "node gateway.js --port 18789",
          },
        ],
        hints: [],
      });
      addAcceptedRunNeverStartsResponses();

      await expect(installGatewayScheduledTask(env)).rejects.toThrow("refusing a direct fallback");

      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it("does not treat a pre-existing task-script wrapper as Scheduled Task launch evidence", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const taskScriptPath = resolveTaskScriptPath(env);
      fastForwardTaskStartWait();
      // A wrapper left over from an earlier run already holds the task script before
      // `/Run`, so it cannot be evidence that this run started anything.
      spawnSync.mockImplementation((command, args) =>
        command === getWindowsPowerShellExePath() &&
        Array.isArray(args) &&
        args.includes(NODE_PROCESS_QUERY)
          ? makeSpawnSyncResult({
              stdout: JSON.stringify([
                { ProcessId: 4242, CommandLine: `cmd.exe /d /s /c "${taskScriptPath}"` },
                { ProcessId: 9999, CommandLine: "powershell.exe" },
              ]),
            })
          : makeSpawnSyncResult(),
      );
      addAcceptedRunNeverStartsResponses();

      await expect(installGatewayScheduledTask(env)).rejects.toThrow("refusing a direct fallback");

      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it("does not treat a task wrapper started during launch preparation as new launch evidence", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const taskScriptPath = resolveTaskScriptPath(env);
      fastForwardTaskStartWait();
      let wrapperStarted = false;
      let signalPreparationStarted!: () => void;
      let releasePreparation!: () => void;
      const preparationStarted = new Promise<void>((resolve) => {
        signalPreparationStarted = resolve;
      });
      const preparationRelease = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      gatewayServiceProbeHostsMock.mockImplementationOnce(async () => {
        signalPreparationStarted();
        await preparationRelease;
        return ["127.0.0.1"];
      });
      spawnSync.mockImplementation((command, args) => {
        if (
          command === getWindowsPowerShellExePath() &&
          Array.isArray(args) &&
          args.includes(NODE_PROCESS_QUERY)
        ) {
          return makeSpawnSyncResult({
            stdout: JSON.stringify(
              wrapperStarted
                ? [
                    { ProcessId: 4242, CommandLine: `cmd.exe /d /s /c "${taskScriptPath}"` },
                    { ProcessId: 9999, CommandLine: "powershell.exe" },
                  ]
                : [{ ProcessId: 9999, CommandLine: "powershell.exe" }],
            ),
          });
        }
        return makeSpawnSyncResult();
      });
      addAcceptedRunNeverStartsResponses();

      const activation = installGatewayScheduledTask(env);
      await preparationStarted;
      wrapperStarted = true;
      releasePreparation();

      await expect(activation).rejects.toThrow("refusing a direct fallback");
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it("does not treat a pre-existing Windows gateway process as Scheduled Task launch evidence", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      fastForwardTaskStartWait();
      const installedGatewayCommandLine =
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789';
      // A foreground gateway started from the same install already owns the port before
      // `schtasks /Run`, so it matches the persisted task argv for the whole launch window.
      spawnSync.mockImplementation((command, args) =>
        command === getWindowsPowerShellExePath() &&
        Array.isArray(args) &&
        args.includes(NODE_PROCESS_QUERY)
          ? makeSpawnSyncResult({
              stdout: JSON.stringify([
                { ProcessId: 4242, CommandLine: installedGatewayCommandLine },
                { ProcessId: 9999, CommandLine: "powershell.exe" },
              ]),
            })
          : makeSpawnSyncResult(),
      );
      addAcceptedRunNeverStartsResponses();

      await expect(
        installScheduledTask({
          env,
          stdout: new PassThrough(),
          programArguments: [
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js",
            "gateway",
            "--port",
            "18789",
          ],
          environment: { OPENCLAW_GATEWAY_PORT: "18789" },
        }),
      ).rejects.toThrow("refusing a direct fallback");

      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it("waits through transient Task Scheduler activity before rejecting a failed launch", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      fastForwardTaskStartWait();
      const installedGatewayCommandLine =
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\openclaw\\dist\\index.js" gateway --port 18789';
      spawnSync.mockImplementation((command, args) =>
        command === getWindowsPowerShellExePath() &&
        Array.isArray(args) &&
        args.includes(NODE_PROCESS_QUERY)
          ? makeSpawnSyncResult({
              stdout: JSON.stringify([
                { ProcessId: 4242, CommandLine: installedGatewayCommandLine },
              ]),
            })
          : makeSpawnSyncResult(),
      );
      addMissingTaskInstallResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        runningTaskSnapshot(),
        {
          state: 3,
          lastRunTime: "2026-09-05T03:14:00.0000000Z",
          lastRunResult: 1,
        },
      ]);

      await expect(
        installScheduledTask({
          env,
          stdout: new PassThrough(),
          programArguments: [
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\openclaw\\dist\\index.js",
            "gateway",
            "--port",
            "18789",
          ],
          environment: { OPENCLAW_GATEWAY_PORT: "18789" },
        }),
      ).rejects.toThrow("refusing a direct fallback");

      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it("accepts an already-running Scheduled Task with its original wrapper", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const taskScriptPath = resolveTaskScriptPath(env);
      const installedGatewayCommandLine =
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\openclaw\\dist\\index.js" gateway --port 18789';
      spawnSync.mockImplementation((command, args) =>
        command === getWindowsPowerShellExePath() &&
        Array.isArray(args) &&
        args.includes(NODE_PROCESS_QUERY)
          ? makeSpawnSyncResult({
              stdout: JSON.stringify([
                { ProcessId: 4242, CommandLine: installedGatewayCommandLine },
                {
                  ProcessId: 4243,
                  CommandLine: `cmd.exe /d /s /c "${taskScriptPath}"`,
                },
              ]),
            })
          : makeSpawnSyncResult(),
      );
      addMissingTaskInstallResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        runningTaskSnapshot(),
      ]);

      await installScheduledTask({
        env,
        stdout: new PassThrough(),
        programArguments: [
          "C:\\Program Files\\nodejs\\node.exe",
          "C:\\openclaw\\dist\\index.js",
          "gateway",
          "--port",
          "18789",
        ],
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      });

      expect(sleepMock).toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it("accepts settled Scheduler supervision after the pre-launch process probe fails", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const installedGatewayCommandLine =
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\openclaw\\dist\\index.js" gateway --port 18789';
      let snapshotQueries = 0;
      spawnSync.mockImplementation((command, args) => {
        if (
          command !== getWindowsPowerShellExePath() ||
          !Array.isArray(args) ||
          !args.includes(NODE_PROCESS_QUERY)
        ) {
          return makeSpawnSyncResult();
        }
        if (snapshotQueries++ < 2) {
          return makeSpawnSyncResult({ status: 1, stderr: "CIM unavailable" });
        }
        return makeSpawnSyncResult({
          stdout: JSON.stringify([{ ProcessId: 4242, CommandLine: installedGatewayCommandLine }]),
        });
      });
      addMissingTaskInstallResponses([
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        runningTaskSnapshot(),
      ]);

      await expect(
        installScheduledTask({
          env,
          stdout: new PassThrough(),
          programArguments: [
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\openclaw\\dist\\index.js",
            "gateway",
            "--port",
            "18789",
          ],
          environment: { OPENCLAW_GATEWAY_PORT: "18789" },
        }),
      ).resolves.toBeDefined();

      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it("refuses process-only activation despite a new exact-argv gateway", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      fastForwardTaskStartWait();
      const installedGatewayCommandLine =
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\openclaw\\dist\\index.js" gateway --port 18789';
      spawnSync.mockImplementation((command, args) =>
        command === getWindowsPowerShellExePath() &&
        Array.isArray(args) &&
        args.includes(NODE_PROCESS_QUERY)
          ? makeSpawnSyncResult({
              stdout: JSON.stringify(
                schtasksCalls.some((call) => call[0] === "/Run")
                  ? [
                      { ProcessId: 4242, CommandLine: installedGatewayCommandLine },
                      { ProcessId: 5353, CommandLine: installedGatewayCommandLine },
                    ]
                  : [{ ProcessId: 4242, CommandLine: installedGatewayCommandLine }],
              ),
            })
          : makeSpawnSyncResult(),
      );
      addAcceptedRunNeverStartsResponses();

      await expect(
        installScheduledTask({
          env,
          stdout: new PassThrough(),
          programArguments: [
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\openclaw\\dist\\index.js",
            "gateway",
            "--port",
            "18789",
          ],
          environment: { OPENCLAW_GATEWAY_PORT: "18789" },
        }),
      ).rejects.toThrow("refusing a direct fallback");

      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it("does not treat a surviving pre-launch task supervisor as launch evidence", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      fastForwardTaskStartWait();
      const installedGatewayCommandLine =
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\openclaw\\dist\\index.js" gateway --port 18789';
      let snapshotQueries = 0;
      spawnSync.mockImplementation((command, args) => {
        if (
          command !== getWindowsPowerShellExePath() ||
          !Array.isArray(args) ||
          !args.includes(NODE_PROCESS_QUERY)
        ) {
          return makeSpawnSyncResult();
        }
        // The stopped task left both its gateway child and its supervisor alive; the child
        // exits after the pre-launch baseline, so the supervisor becomes the resolver's answer.
        const processes =
          snapshotQueries++ === 0
            ? [
                { ProcessId: 4242, CommandLine: installedGatewayCommandLine },
                {
                  ProcessId: 4243,
                  CommandLine: `${installedGatewayCommandLine} --task-supervisor`,
                },
              ]
            : [
                {
                  ProcessId: 4243,
                  CommandLine: `${installedGatewayCommandLine} --task-supervisor`,
                },
              ];
        return makeSpawnSyncResult({ stdout: JSON.stringify(processes) });
      });
      addAcceptedRunNeverStartsResponses();

      await expect(
        installScheduledTask({
          env,
          stdout: new PassThrough(),
          programArguments: [
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\openclaw\\dist\\index.js",
            "gateway",
            "--port",
            "18789",
          ],
          environment: { OPENCLAW_GATEWAY_PORT: "18789" },
        }),
      ).rejects.toThrow("refusing a direct fallback");

      expect(spawn).not.toHaveBeenCalled();
    });
  });

  it("refuses process-only activation while a pre-existing listener keeps running", async () => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env }) => {
      fastForwardTaskStartWait();
      const listener = (pid: number) => ({
        pid,
        command: "node.exe",
        commandLine: "node gateway.js --port 18789",
      });
      let portInspections = 0;
      inspectPortUsageMock.mockImplementation(async (port) => ({
        port,
        status: "busy",
        // The task really starts and adds its own process next to the foreground gateway.
        listeners: portInspections++ === 0 ? [listener(4242)] : [listener(4242), listener(5353)],
        hints: [],
      }));
      addAcceptedRunNeverStartsResponses();

      await expect(installGatewayScheduledTask(env)).rejects.toThrow("refusing a direct fallback");

      expect(spawn).not.toHaveBeenCalled();
    });
  });
});

describe("Scheduled Task activation provenance", () => {
  const cases = [
    {
      name: "failed CIM with settled Scheduler supervision",
      cim: "failed",
      scheduler: "healthy",
      process: "none",
      kind: "gateway",
      expected: "scheduled-task",
    },
    {
      name: "timed-out CIM with settled Scheduler supervision",
      cim: "timeout",
      scheduler: "healthy",
      process: "none",
      kind: "gateway",
      expected: "scheduled-task",
    },
    {
      name: "empty CIM with settled Scheduler supervision",
      cim: "empty",
      scheduler: "healthy",
      process: "none",
      kind: "gateway",
      expected: "scheduled-task",
    },
    {
      name: "failed CIM with transient queued/running then error",
      cim: "failed",
      scheduler: "transient",
      process: "none",
      kind: "gateway",
      expected: "refuse",
    },
    {
      name: "successful CIM with transient running then error",
      cim: "healthy",
      scheduler: "transient",
      process: "none",
      kind: "gateway",
      expected: "refuse",
    },
    {
      name: "old wrapper with transient running then error",
      cim: "healthy",
      scheduler: "transient",
      process: "wrapper",
      kind: "gateway",
      expected: "refuse",
    },
    {
      name: "old supervisor with transient running then error",
      cim: "healthy",
      scheduler: "transient",
      process: "supervisor",
      kind: "gateway",
      expected: "refuse",
    },
    {
      name: "new process without Scheduler evidence",
      cim: "healthy",
      scheduler: "unknown",
      process: "new",
      kind: "gateway",
      expected: "refuse",
    },
    {
      name: "old wrapper with already-running Scheduler",
      cim: "healthy",
      scheduler: "already-running",
      process: "wrapper",
      kind: "gateway",
      expected: "scheduled-task",
    },
    {
      name: "late transient Scheduler run must not establish activation",
      cim: "healthy",
      scheduler: "late-transient",
      process: "none",
      kind: "gateway",
      expected: "refuse",
    },
    {
      name: "late healthy Scheduler run receives its complete settling interval",
      cim: "healthy",
      scheduler: "late-healthy",
      process: "none",
      kind: "gateway",
      expected: "scheduled-task",
    },
    {
      name: "old node host without Scheduler activation",
      cim: "healthy",
      scheduler: "never",
      process: "node",
      kind: "node",
      expected: "refuse",
    },
    {
      name: "unstarted node host with complete empty baseline",
      cim: "healthy",
      scheduler: "never",
      process: "none",
      kind: "node",
      expected: "direct-fallback",
    },
    {
      name: "failed node CIM with Scheduler supervision",
      cim: "failed",
      scheduler: "healthy",
      process: "none",
      kind: "node",
      expected: "scheduled-task",
    },
  ] as const;

  it.each(cases)("$name", async (scenario) => {
    await withWindowsEnv("openclaw-activation-provenance-", async ({ env: gatewayEnv }) => {
      const env = scenario.kind === "node" ? makeNodeServiceEnv(gatewayEnv) : gatewayEnv;
      if (scenario.kind === "node") {
        await writeNodeScript(env);
      } else {
        await writeGatewayScript(env);
      }
      const scriptPath = resolveTaskScriptPath(env);
      const hasRun = () => schtasksCalls.some((call) => call[0] === "/Run");
      spawnSync.mockImplementation((command, args) => {
        if (command !== getWindowsPowerShellExePath() || !args?.includes(NODE_PROCESS_QUERY)) {
          return makeSpawnSyncResult();
        }
        if (scenario.cim === "failed") {
          return makeSpawnSyncResult({ status: 1, stderr: "fixture CIM unavailable" });
        }
        if (scenario.cim === "timeout") {
          return {
            ...makeSpawnSyncResult(),
            error: Object.assign(new Error("fixture timeout"), { code: "ETIMEDOUT" }),
          };
        }
        if (scenario.cim === "empty") {
          return makeSpawnSyncResult({ stdout: "" });
        }
        const commandLine =
          scenario.process === "wrapper"
            ? `cmd.exe /d /s /c "${scriptPath}"`
            : scenario.process === "node"
              ? '"C:\\bin\\openclaw.cmd" node run --host 127.0.0.1 --port 18789'
              : '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789' +
                (scenario.process === "supervisor" ? " --task-supervisor" : "");
        const present = scenario.process !== "none" && (scenario.process !== "new" || hasRun());
        return makeSpawnSyncResult({
          stdout: JSON.stringify([
            { ProcessId: 9999, CommandLine: "powershell.exe" },
            ...(present ? [{ ProcessId: 4242, CommandLine: commandLine }] : []),
          ]),
        });
      });
      taskProbe.mockImplementation(() => {
        let snapshot: TaskSnapshot = notYetRunTaskSnapshot();
        if (scenario.scheduler === "already-running") {
          snapshot = runningTaskSnapshot();
        } else if (hasRun()) {
          if (scenario.scheduler === "healthy") {
            snapshot = { ...runningTaskSnapshot(), lastRunTime: "2026-09-17T09:00:00.0000000Z" };
          } else if (
            scenario.scheduler === "late-transient" ||
            scenario.scheduler === "late-healthy"
          ) {
            snapshot =
              timeState.now < 14_750
                ? { ...notYetRunTaskSnapshot(), state: 2 }
                : scenario.scheduler === "late-transient" && timeState.now >= 15_250
                  ? { ...cleanExitTaskSnapshot(), lastRunResult: 1 }
                  : { ...runningTaskSnapshot(), lastRunTime: "2026-09-17T09:00:00.0000000Z" };
          } else if (scenario.scheduler === "transient") {
            snapshot =
              timeState.now < 750
                ? { ...runningTaskSnapshot(), state: timeState.now === 0 ? 2 : 4 }
                : { ...cleanExitTaskSnapshot(), lastRunResult: 1 };
          } else if (scenario.scheduler === "unknown") {
            return { status: 2, stdout: "", stderr: "fixture Scheduler unavailable" };
          }
        }
        return { status: 0, stdout: JSON.stringify(snapshot) };
      });
      const activation = runScheduledTaskOrThrow({
        taskName: env.OPENCLAW_WINDOWS_TASK_NAME ?? "OpenClaw Gateway",
        env,
        scriptPath,
      });
      if (scenario.expected === "refuse") {
        await expect(activation).rejects.toThrow();
        expect(spawn).not.toHaveBeenCalled();
      } else {
        await expect(activation).resolves.toBe(scenario.expected);
        if (scenario.expected === "scheduled-task") {
          expect(spawn).not.toHaveBeenCalled();
        }
      }
      if (scenario.scheduler === "late-healthy") {
        expect(timeState.now).toBeGreaterThanOrEqual(29_750);
        expect(timeState.now).toBeLessThanOrEqual(30_000);
      }
      expectNoGatewayTermination();
    });
  });

  it.each([
    {
      name: "live default-port node",
      running: false,
      present: true,
      port: undefined,
      expected: "refuse",
    },
    {
      name: "live node with inherited CLI port",
      running: false,
      present: true,
      port: "18789",
      expected: "refuse",
    },
    {
      name: "empty default-port ownership scan",
      running: false,
      present: false,
      port: undefined,
      expected: "direct-fallback",
    },
    {
      name: "supervised default-port node",
      running: true,
      present: true,
      port: undefined,
      expected: "scheduled-task",
    },
  ])("handles a portless node command: $name", async ({ running, present, port, expected }) => {
    await withWindowsEnv("openclaw-node-default-port-", async ({ env: gatewayEnv }) => {
      const env = makeNodeServiceEnv(gatewayEnv);
      if (port) {
        env.OPENCLAW_GATEWAY_PORT = port;
      } else {
        delete env.OPENCLAW_GATEWAY_PORT;
      }
      await writeNodeScript(env);
      const scriptPath = resolveTaskScriptPath(env);
      const commandLine = '"C:\\bin\\openclaw.cmd" node run --host 127.0.0.1';
      await fs.writeFile(
        scriptPath,
        ["@echo off", 'set "OPENCLAW_SERVICE_KIND=node"', commandLine, ""].join("\r\n"),
        "utf8",
      );
      spawnSync.mockImplementation((command, args) =>
        command === getWindowsPowerShellExePath() && args?.includes(NODE_PROCESS_QUERY)
          ? makeSpawnSyncResult({
              stdout: JSON.stringify([
                { ProcessId: 9999, CommandLine: "powershell.exe" },
                ...(present ? [{ ProcessId: 4242, CommandLine: commandLine }] : []),
              ]),
            })
          : makeSpawnSyncResult(),
      );
      taskProbe.mockReturnValue({
        status: 0,
        stdout: JSON.stringify(running ? runningTaskSnapshot() : notYetRunTaskSnapshot()),
      });
      const activation = runScheduledTaskOrThrow({
        taskName: "OpenClaw Node",
        env,
        scriptPath,
      });
      if (expected === "refuse") {
        await expect(activation).rejects.toThrow("refusing a direct fallback");
      } else {
        await expect(activation).resolves.toBe(expected);
      }
      if (expected === "direct-fallback") {
        expect(spawn).toHaveBeenCalledOnce();
      } else {
        expect(spawn).not.toHaveBeenCalled();
      }
      expectNoGatewayTermination();
    });
  });

  it("stops verification when operation authority is revoked during polling", async () => {
    await withWindowsEnv("openclaw-activation-cancel-", async ({ env }) => {
      await writeGatewayScript(env);
      taskProbe.mockReturnValue({ status: 0, stdout: JSON.stringify(notYetRunTaskSnapshot()) });
      let current = true;
      sleepMock.mockImplementation(async (ms) => {
        timeState.now += ms;
        current = false;
      });
      const revoked = new Error("activation authority revoked");
      await expect(
        runScheduledTaskOrThrow({
          taskName: "OpenClaw Gateway",
          env,
          scriptPath: resolveTaskScriptPath(env),
          assertCurrent: () => {
            if (!current) {
              throw revoked;
            }
          },
        }),
      ).rejects.toBe(revoked);
      expect(spawn).not.toHaveBeenCalled();
      expectNoGatewayTermination();
    });
  });
});
