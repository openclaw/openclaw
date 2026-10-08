import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import * as nativeExec from "./exec-file.js";
import * as schtasks from "./schtasks-exec.js";
import * as inspection from "./schtasks-inspection-deadline.js";
import * as layout from "./schtasks-layout.js";
import * as probe from "./schtasks-state-probe.js";
import { captureGatewayServiceDefinitionBackup } from "./service-definition-backup.js";
import { readServiceFileState } from "./service-stage.js";
import type { GatewayServiceCommandConfig, GatewayServiceEnv } from "./service-types.js";

export async function createWindowsStartupServiceFixture(
  directory: string,
  extension: "cmd" | "vbs" = "cmd",
) {
  const root = await fs.realpath(directory);
  const serviceReadCommand = vi.fn<typeof layout.readScheduledTaskCommand>();
  const env: GatewayServiceEnv = {
    HOME: root,
    USERPROFILE: root,
    APPDATA: path.join(root, "AppData", "Roaming"),
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: extension === "vbs" ? "1" : "0",
    USERNAME: "operator",
  };
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const task = vi
    .spyOn(schtasks, "execSchtasks")
    .mockRejectedValue(new Error("Unexpected Task access"));
  vi.spyOn(nativeExec, "execFileUtf8").mockRejectedValue(new Error("Unexpected native execution"));
  const taskState = vi
    .spyOn(probe, "probeScheduledTaskState")
    .mockReturnValue({ status: "missing" });
  const sourcePath = layout.resolveTaskScriptPath(env);
  const companionPath = layout.resolveTaskLauncherScriptPath(
    { OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1" },
    sourcePath,
  );
  const launcherPath = layout.resolveStartupEntryPath(env, extension);
  const aliasPath = layout.resolveStartupEntryPath(env, extension === "cmd" ? "vbs" : "cmd");
  const virtualEnv = {
    ...env,
    APPDATA: "C:/Startup Fixture/roaming",
    OPENCLAW_TASK_SCRIPT: "C:/Startup Fixture/state/gateway.cmd",
  };
  const virtualScript = layout.resolveTaskScriptPath(virtualEnv);
  const virtualPaths = new Map([
    [virtualScript, sourcePath],
    [layout.resolveStartupEntryPath(virtualEnv, extension), launcherPath],
    [layout.resolveStartupEntryPath(virtualEnv, extension === "cmd" ? "vbs" : "cmd"), aliasPath],
  ]);
  const command: GatewayServiceCommandConfig = {
    programArguments: ["C:\\Node A\\node.exe", "C:\\OpenClaw\\index.js", "gateway"],
    sourcePath,
    startupEntryPaths: [launcherPath],
    environment: { OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR! },
  };
  // Translate filesystem locations at inspection's I/O boundary so the real
  // Windows parser and registration rechecks run on every host.
  const readTaskFile = inspection.readTaskFile;
  vi.spyOn(inspection, "readTaskFile").mockImplementation((file, deadline) =>
    readTaskFile(virtualPaths.get(file) ?? file, deadline),
  );
  const readCommand = layout.readScheduledTaskCommand;
  serviceReadCommand.mockImplementation(async (_env, options) => {
    const observed = await readCommand(virtualEnv, options);
    return (
      observed && {
        ...observed,
        sourcePath:
          observed.sourcePath && (virtualPaths.get(observed.sourcePath) ?? observed.sourcePath),
        ...(observed.startupEntryPaths && {
          startupEntryPaths: observed.startupEntryPaths.map(
            (file) => virtualPaths.get(file) ?? file,
          ),
        }),
      }
    );
  });
  vi.spyOn(layout, "readScheduledTaskCommand").mockImplementation(serviceReadCommand);
  const original = Buffer.from(layout.buildTaskScript(command));
  const launcher =
    extension === "cmd"
      ? Buffer.from(layout.buildStartupLauncherScript({ scriptPath: virtualScript }))
      : layout.encodeWindowsLauncherScript({
          format: "vbs",
          content: layout.buildHiddenLauncherScript({ scriptPath: virtualScript }),
        });
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.mkdir(path.dirname(launcherPath), { recursive: true });
  await fs.writeFile(sourcePath, original);
  await fs.writeFile(launcherPath, launcher);
  const registration = () => Promise.all([launcherPath, aliasPath].map(readServiceFileState));
  const originalRegistration = await registration();
  const context = { env, command, assertCurrent: () => {} };
  return {
    ...context,
    readCommand: serviceReadCommand,
    sourcePath,
    companionPath,
    launcherPath,
    aliasPath,
    original,
    launcher,
    registration,
    originalRegistration,
    task,
    taskState,
    virtualScript,
    registerTask: () =>
      taskState.mockReturnValue({
        status: "found",
        state: 3,
        taskPath: layout.resolveTaskName(env),
        actions: [{ type: 0, path: virtualScript, arguments: "", workingDirectory: "" }],
      }),
    capture: () => captureGatewayServiceDefinitionBackup(context),
  };
}
