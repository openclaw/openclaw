import "./schtasks.startup-fallback-mocks.test-support.js";
import fs from "node:fs/promises";
import { describe, expect } from "vitest";
import {
  getWindowsCmdExePath,
  getWindowsPowerShellExePath,
} from "../infra/windows-install-roots.js";
import {
  it,
  installGateway,
  fastForwardTaskStartWait,
  addAcceptedRunNeverStartsResponses,
  mockProcesses,
  processEntry,
  POWERSHELL_PROCESS,
  runScheduledTaskOrThrow,
  timeState,
  sleepMock,
  spawn,
  spawnSync,
  taskProbe,
  resolveTaskScriptPath,
  makeNodeServiceEnv,
  expectNoGatewayTermination,
} from "./schtasks.startup-fallback-fixture.test-support.js";
import {
  schtasksCalls,
  gatewayServiceProbeHostsMock,
  inspectPortUsageMock,
  writeGatewayScript,
  writeNodeScript,
  isProcessSnapshotQuery,
  makeSpawnSyncResult,
  notYetRunTaskSnapshot,
  cleanExitTaskSnapshot,
  runningTaskSnapshot,
  type TaskSnapshot,
} from "./test-helpers/schtasks-fixtures.js";

function taskScriptAction(scriptPath: string) {
  return {
    type: 0,
    path: getWindowsCmdExePath(),
    arguments: `/d /s /c ""${scriptPath}""`,
    workingDirectory: "",
  };
}

describe("Scheduled Task activation provenance", () => {
  const cases = [
    ["failed CIM, healthy Scheduler", "failed", "healthy", "none", "gateway", "scheduled-task"],
    ["timed-out CIM, healthy Scheduler", "timeout", "healthy", "none", "gateway", "scheduled-task"],
    ["empty CIM, healthy Scheduler", "empty", "healthy", "none", "gateway", "scheduled-task"],
    ["failed CIM, transient Scheduler", "failed", "transient", "none", "gateway", "refuse"],
    ["healthy CIM, transient Scheduler", "healthy", "transient", "none", "gateway", "refuse"],
    ["old wrapper, transient Scheduler", "healthy", "transient", "wrapper", "gateway", "refuse"],
    [
      "old supervisor, transient Scheduler",
      "healthy",
      "transient",
      "supervisor",
      "gateway",
      "refuse",
    ],
    ["new process without Scheduler evidence", "healthy", "unknown", "new", "gateway", "refuse"],
    ["old + new exact argv", "healthy", "never", "old-new", "gateway", "refuse"],
    [
      "child exits, old supervisor survives",
      "healthy",
      "never",
      "child-supervisor",
      "gateway",
      "refuse",
    ],
    [
      "old wrapper, running Scheduler",
      "healthy",
      "already-running",
      "wrapper",
      "gateway",
      "scheduled-task",
    ],
    ["late transient Scheduler", "healthy", "late-transient", "none", "gateway", "refuse"],
    ["late healthy Scheduler", "healthy", "late-healthy", "none", "gateway", "scheduled-task"],
    ["old node host without Scheduler activation", "healthy", "never", "node", "node", "refuse"],
    ["empty node baseline", "healthy", "never", "none", "node", "direct-fallback"],
    ["failed node CIM, healthy Scheduler", "failed", "healthy", "none", "node", "scheduled-task"],
  ] as const;

  it.for(
    cases.map(([name, cim, scheduler, process, kind, expected]) => ({
      name,
      cim,
      scheduler,
      process,
      kind,
      expected,
    })),
  )("$name", async (scenario, { env: gatewayEnv }) => {
    const env = scenario.kind === "node" ? makeNodeServiceEnv(gatewayEnv) : gatewayEnv;
    if (scenario.kind === "node") {
      await writeNodeScript(env);
    } else {
      await writeGatewayScript(env);
    }
    const scriptPath = resolveTaskScriptPath(env);
    const hasRun = () => schtasksCalls.some((call) => call[0] === "/Run");
    let snapshotQueries = 0;
    spawnSync.mockImplementation((command, args) => {
      if (command !== getWindowsPowerShellExePath() || !isProcessSnapshotQuery(args)) {
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
      const gatewayCommand =
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789';
      const commandLine =
        scenario.process === "wrapper"
          ? `cmd.exe /d /s /c "${scriptPath}"`
          : scenario.process === "node"
            ? '"C:\\bin\\openclaw.cmd" node run --host 127.0.0.1 --port 18789'
            : gatewayCommand + (scenario.process === "supervisor" ? " --task-supervisor" : "");
      const processes =
        scenario.process === "none"
          ? []
          : scenario.process === "new"
            ? hasRun()
              ? [{ ProcessId: 5353, CommandLine: gatewayCommand }]
              : []
            : scenario.process === "old-new"
              ? [
                  { ProcessId: 4242, CommandLine: gatewayCommand },
                  ...(hasRun() ? [{ ProcessId: 5353, CommandLine: gatewayCommand }] : []),
                ]
              : scenario.process === "child-supervisor"
                ? snapshotQueries++ === 0
                  ? [
                      { ProcessId: 4242, CommandLine: gatewayCommand },
                      { ProcessId: 4243, CommandLine: `${gatewayCommand} --task-supervisor` },
                    ]
                  : [{ ProcessId: 4243, CommandLine: `${gatewayCommand} --task-supervisor` }]
                : [{ ProcessId: 4242, CommandLine: commandLine }];
      return makeSpawnSyncResult({
        stdout: JSON.stringify([{ ProcessId: 9999, CommandLine: "powershell.exe" }, ...processes]),
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
      return {
        status: 0,
        stdout: JSON.stringify({
          ...snapshot,
          taskPath: `\\${env.OPENCLAW_WINDOWS_TASK_NAME ?? "OpenClaw Gateway"}`,
          actions: [taskScriptAction(scriptPath)],
        }),
      };
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
    if (scenario.scheduler === "already-running") {
      expect(sleepMock).toHaveBeenCalled();
    }
    if (scenario.scheduler === "late-healthy") {
      expect(timeState.now).toBeGreaterThanOrEqual(29_750);
      expect(timeState.now).toBeLessThanOrEqual(30_000);
    }
    expectNoGatewayTermination();
  });

  it.for(
    (
      [
        ["live default-port node", false, true, undefined, "refuse"],
        ["live node with CLI port", false, true, "18789", "refuse"],
        ["empty default-port scan", false, false, undefined, "direct-fallback"],
        ["supervised default-port node", true, true, undefined, "scheduled-task"],
      ] as const
    ).map(([name, running, present, port, expected]) => ({
      name,
      running,
      present,
      port,
      expected,
    })),
  )(
    "handles a portless node command: $name",
    async ({ running, present, port, expected }, { env: gatewayEnv }) => {
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
        command === getWindowsPowerShellExePath() && isProcessSnapshotQuery(args)
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
        stdout: JSON.stringify({
          ...(running ? runningTaskSnapshot() : notYetRunTaskSnapshot()),
          taskPath: "\\OpenClaw Node",
          actions: [taskScriptAction(scriptPath)],
        }),
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
    },
  );

  it("stops verification when operation authority is revoked during polling", async ({ env }) => {
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

  it("does not treat a task wrapper started during launch preparation as new launch evidence", async ({
    env,
  }) => {
    const scriptPath = resolveTaskScriptPath(env);
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
    mockProcesses(() => [
      ...(wrapperStarted ? [processEntry(4242, `cmd.exe /d /s /c "${scriptPath}"`)] : []),
      POWERSHELL_PROCESS,
    ]);
    addAcceptedRunNeverStartsResponses();
    const activation = installGateway(env);
    await preparationStarted;
    wrapperStarted = true;
    releasePreparation();
    await expect(activation).rejects.toThrow("refusing a direct fallback");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.for(["existing", "additional"] as const)(
    "rejects process-only activation with an %s listener",
    async (mode, { env }) => {
      fastForwardTaskStartWait();
      const listener = (pid: number) => ({
        pid,
        command: "node.exe",
        commandLine: "node gateway.js --port 18789",
      });
      let inspections = 0;
      inspectPortUsageMock.mockImplementation(async (port) => ({
        port,
        status: "busy",
        listeners:
          mode === "existing" || inspections++ === 0
            ? [listener(4242)]
            : [listener(4242), listener(5353)],
        hints: [],
      }));
      addAcceptedRunNeverStartsResponses();

      await expect(installGateway(env)).rejects.toThrow("refusing a direct fallback");

      expect(spawn).not.toHaveBeenCalled();
    },
  );
});
