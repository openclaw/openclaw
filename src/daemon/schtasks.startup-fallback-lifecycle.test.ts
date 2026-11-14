import "./schtasks.startup-fallback-mocks.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, vi } from "vitest";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import {
  restartScheduledTask,
  stopScheduledTask,
  uninstallScheduledTask,
  resolveTaskScriptPath,
  queueNativeResponses,
  readScheduledTaskRuntime,
  INSTALLED_GATEWAY_COMMAND,
  NODE_HOST_COMMAND,
  addAcceptedRunNeverStartsResponses,
  addMissingTaskInstallResponses,
  addStartupFallbackMissingResponses,
  addSuccessfulScheduledTaskRestartResponses,
  childUnref,
  expectGatewayTermination,
  expectMissing,
  expectNoGatewayTermination,
  expectStartupFallbackSpawn,
  expectTaskkillPid,
  fastForwardTaskStartWait,
  holdCurrentTaskProbe,
  installGateway,
  installNodeScheduledTask,
  it,
  makeNodeServiceEnv,
  mockProcesses,
  mockTerminatingProcess,
  portUsage,
  prepareFallbackRestart,
  processEntry,
  processListener,
  processSnapshot,
  sleepMock,
  spawn,
  spawnSync,
  successfulResponses,
  taskProbe,
  timeState,
  verifiedGatewayPids,
  writeGatewayPackageCommand,
  writeNodeScript,
  writeRunningGatewayScript,
} from "./schtasks.startup-fallback-fixture.test-support.js";
import {
  createSpawnChild,
  notYetRunTaskSnapshot,
  cleanExitTaskSnapshot,
  runningTaskSnapshot,
  inspectPortUsageMock,
  isProcessSnapshotQuery,
  makeSpawnSyncResult,
  resolveStartupFixturePath,
  schtasksCalls,
  schtasksRegistration,
  writeGatewayScript,
  writeStartupFallbackEntry,
} from "./test-helpers/schtasks-fixtures.js";

describe("Windows startup fallback", () => {
  it("preserves Startup definition bytes and modes when requested", async ({ env }) => {
    const files = [
      await writeStartupFallbackEntry(env),
      await writeStartupFallbackEntry(env, "vbs"),
    ];
    const snapshot = () =>
      Promise.all(
        files.map(async (file) => ({
          bytes: await fs.readFile(file),
          mode: (await fs.stat(file)).mode,
        })),
      );
    const before = await snapshot();
    await writeGatewayScript(env);
    queueNativeResponses(cleanExitTaskSnapshot(), cleanExitTaskSnapshot());
    addSuccessfulScheduledTaskRestartResponses([notYetRunTaskSnapshot(), runningTaskSnapshot()]);
    holdCurrentTaskProbe();

    await restartScheduledTask({ env, stdout: new PassThrough(), preserveDefinition: true });

    expect(await snapshot()).toEqual(before);
    expect(sleepMock).toHaveBeenCalled();
    expect(schtasksCalls.filter(([action]) => action === "/Run")).toHaveLength(1);
  });

  it("does not mistake launcher exit for task supervision", async ({ env }) => {
    const hiddenEnv = { ...env, OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" };
    const startupEntryPath = await writeStartupFallbackEntry(hiddenEnv);
    await writeGatewayScript(hiddenEnv);
    verifiedGatewayPids.mockReturnValue([4242]);
    inspectPortUsageMock.mockImplementation(async () =>
      schtasksCalls.some((call) => call[0] === "/Run")
        ? portUsage("busy", [processListener(4242, INSTALLED_GATEWAY_COMMAND)])
        : portUsage("free"),
    );
    mockProcesses(() =>
      schtasksCalls.some(([action]) => action === "/Run") ? [processEntry(4242)] : [],
    );
    queueNativeResponses(cleanExitTaskSnapshot(), cleanExitTaskSnapshot());
    addSuccessfulScheduledTaskRestartResponses([cleanExitTaskSnapshot()], cleanExitTaskSnapshot());

    await expect(
      restartScheduledTask({ env: hiddenEnv, stdout: new PassThrough() }),
    ).rejects.toThrow("refusing a direct fallback");

    await fs.access(startupEntryPath);
  });

  it("rejects fallback after uncertain registration", async ({ env }) => {
    addMissingTaskInstallResponses([
      { code: 124, stdout: "", stderr: "schtasks timed out after 15000ms" },
    ]);

    await expect(installGateway(env)).rejects.toThrow(
      "Scheduled Task registration did not confirm completion",
    );

    await expectMissing(resolveStartupFixturePath(env));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects publication when task presence is unknown", async ({ env }) => {
    schtasksRegistration.response = {
      code: 124,
      stdout: "",
      stderr: "schtasks produced no output for 30000ms",
    };
    taskProbe.mockReturnValue({ status: 2, stdout: "-2147024891" });

    await expect(installGateway(env)).rejects.toThrow(
      "Could not back up Scheduled Task OpenClaw Gateway before replacement",
    );

    await expectMissing(resolveTaskScriptPath(env));
    await expectMissing(resolveStartupFixturePath(env));
    expect(spawn).not.toHaveBeenCalled();
    expect(schtasksCalls).toEqual([["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
  });

  it("avoids fallback when a listener appears after task exit", async ({ env }) => {
    spawnSync.mockImplementation((command, args) =>
      command === getWindowsPowerShellExePath() && isProcessSnapshotQuery(args)
        ? makeSpawnSyncResult({ status: 1 })
        : makeSpawnSyncResult(),
    );
    fastForwardTaskStartWait();
    verifiedGatewayPids.mockReturnValue([4242]);
    inspectPortUsageMock.mockImplementation(async (port) =>
      timeState.now === 0
        ? portUsage("free", [], port)
        : portUsage("busy", [processListener(4242, "node gateway.js --port 18789")], port),
    );
    addMissingTaskInstallResponses([
      ...successfulResponses(2),
      cleanExitTaskSnapshot(),
      cleanExitTaskSnapshot(),
    ]);

    await expect(installGateway(env)).rejects.toThrow("refusing a direct fallback");

    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not treat gateway liveness as node launch evidence", async ({ env }) => {
    fastForwardTaskStartWait();
    verifiedGatewayPids.mockReturnValue([4242]);
    addAcceptedRunNeverStartsResponses();

    await installNodeScheduledTask(env);

    expect(verifiedGatewayPids).not.toHaveBeenCalled();
    expectStartupFallbackSpawn();
  });

  it("does not relaunch an already-starting task script", async ({ env }) => {
    const taskScriptPath = resolveTaskScriptPath(env);
    fastForwardTaskStartWait();
    mockProcesses(() => [processEntry(4242, `cmd.exe /d /s /c "${taskScriptPath}"`)]);

    addAcceptedRunNeverStartsResponses();

    await expect(installGateway(env)).rejects.toThrow("refusing a direct fallback");

    expect(spawn).not.toHaveBeenCalled();
  });

  it("uninstalls both Startup formats after hidden opt-in", async ({ env }) => {
    queueNativeResponses({ code: 0, stdout: "", stderr: "" });
    const entries = [
      await writeStartupFallbackEntry(env),
      await writeStartupFallbackEntry(env, "vbs"),
    ];

    await uninstallScheduledTask({
      env: { ...env, OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" },
      stdout: new PassThrough(),
    });

    for (const entry of entries) {
      await expectMissing(entry);
    }
  });

  it("reports the verified Startup listener", async ({ env, tmpDir }) => {
    taskProbe.mockReturnValue({ status: 1, stdout: "-2147024894" });
    await writeStartupFallbackEntry(env);
    const commandLine = await writeGatewayPackageCommand(path.join(tmpDir, "listener-install"));
    inspectPortUsageMock.mockResolvedValue(
      portUsage("busy", [{ pid: 4242, command: "node.exe", commandLine }]),
    );

    expect(await readScheduledTaskRuntime(env)).toMatchObject({ status: "running", pid: 4242 });
  });

  it("awaits listener ownership before reporting fallback runtime", async ({ env }) => {
    taskProbe.mockReturnValue({ status: 1, stdout: "-2147024894" });
    await writeStartupFallbackEntry(env);
    inspectPortUsageMock.mockResolvedValue(portUsage("busy", [{ pid: 4242, command: "node.exe" }]));
    verifiedGatewayPids.mockReturnValue([4242]);

    expect(await readScheduledTaskRuntime(env)).toMatchObject({ status: "running", pid: 4242 });
    expect(verifiedGatewayPids).toHaveBeenCalledWith(18789);
  });

  it("preserves gateway listeners when stopping a node", async ({ env }) => {
    const nodeEnv = makeNodeServiceEnv(env);
    addStartupFallbackMissingResponses();
    await writeStartupFallbackEntry(nodeEnv);
    inspectPortUsageMock.mockResolvedValue(
      portUsage("busy", [
        processListener(5151, 'node "C:\\openclaw\\dist\\index.js" gateway --port 18789'),
      ]),
    );

    spawnSync.mockReturnValueOnce(
      processSnapshot([
        processEntry(5151, 'node "C:\\openclaw\\dist\\index.js" gateway --port 18789'),
      ]),
    );

    await stopScheduledTask({ env: nodeEnv, stdout: new PassThrough() });

    expect(inspectPortUsageMock).not.toHaveBeenCalled();
    expectNoGatewayTermination();
  });

  it.for([false, true])(
    "stops the matching node Startup host (Scheduled Task registered: %s)",
    async (registered, { env }) => {
      const nodeEnv = makeNodeServiceEnv(env);
      if (registered) {
        queueNativeResponses(...successfulResponses(3));
      } else {
        addStartupFallbackMissingResponses();
      }
      await writeStartupFallbackEntry(nodeEnv);
      await writeNodeScript(nodeEnv);
      mockTerminatingProcess(NODE_HOST_COMMAND, 5151);
      await stopScheduledTask({ env: nodeEnv, stdout: new PassThrough() });
      expect(inspectPortUsageMock).not.toHaveBeenCalled();
      expectTaskkillPid(5151);
    },
  );

  it("restarts the owned Startup process", async ({ env }) => {
    await prepareFallbackRestart(env);
    await expect(restartScheduledTask({ env, stdout: new PassThrough() })).resolves.toEqual({
      outcome: "completed",
    });
    expectGatewayTermination(5151);
    expectStartupFallbackSpawn();
  });

  it.for(["termination", "activation"] as const)(
    "refuses restart after losing authority before %s",
    async (stage, { env }) => {
      addStartupFallbackMissingResponses();
      await writeStartupFallbackEntry(env);
      let current = true;
      await writeRunningGatewayScript(env, 5151, () => {
        current = false;
        return stage === "termination";
      });

      await expect(
        restartScheduledTask({
          env,
          stdout: new PassThrough(),
          assertCurrent: () => {
            if (!current) {
              throw new Error("repair continuation retired");
            }
          },
        }),
      ).rejects.toThrow("repair continuation retired");

      expectNoGatewayTermination();
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("audits Startup fallback termination when relaunch fails", async ({ env }) => {
    await prepareFallbackRestart(env);
    spawn.mockImplementationOnce(() => createSpawnChild(childUnref, new Error("spawn failed")));
    const onMutation = vi.fn();

    await expect(
      restartScheduledTask({ env, stdout: new PassThrough(), onMutation }),
    ).rejects.toThrow("spawn failed");

    expectGatewayTermination(5151);
    expect(childUnref).not.toHaveBeenCalled();
    expect(onMutation).toHaveBeenCalledWith({ mode: "startup-entry-stop" });
    expect(onMutation).not.toHaveBeenCalledWith({ mode: "startup-entry-restart" });
  });

  it("rejects restart with an unverified busy-port owner", async ({ env }) => {
    await writeGatewayScript(env);
    addStartupFallbackMissingResponses();
    await writeStartupFallbackEntry(env);
    inspectPortUsageMock.mockResolvedValue(
      portUsage("busy", [{ pid: 5151, command: "other.exe" }]),
    );

    await expect(restartScheduledTask({ env, stdout: new PassThrough() })).rejects.toThrow(
      "not a verified gateway process",
    );
    expectNoGatewayTermination();
    expect(spawn).not.toHaveBeenCalled();
  });
});
