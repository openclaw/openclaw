import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { stageLaunchAgent } from "./launchd-install.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import {
  resolveLaunchAgentEnvFilePath,
  resolveLaunchAgentEnvWrapperPath,
  resolveLaunchAgentPlistPath,
} from "./launchd-service-files.js";
import { installScheduledTask } from "./schtasks-install.js";
import { buildScheduledTaskXml, resolveTaskScriptPath } from "./schtasks-layout.js";
import { captureGatewayServiceDefinitionBackup } from "./service-definition-backup.js";
import { native } from "./service-definition-backup.mocks.test-support.js";
import { GatewayServiceDefinitionBackupReceiptSchema } from "./service-stage.js";
import type { GatewayServiceCommandConfig, GatewayServiceEnv } from "./service-types.js";
import { stageSystemdService } from "./systemd-install.js";
import { resolveSystemdUnitPath } from "./systemd-service-files.js";
import { buildSystemdUnit } from "./systemd-unit.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  native.command.mockReset();
  native.task.mockReset();
  native.transport.mockReset().mockResolvedValue(undefined);
  native.launchctl.mockReset().mockResolvedValue({
    code: 113,
    stdout: "",
    stderr: "Could not find service",
    termination: "exit",
  });
  native.identity.mockReset().mockResolvedValue({
    code: 0,
    stdout: "S-1-5-21-1-2-3-1001\n",
    stderr: "",
    termination: "exit",
  });
});

async function fixture(
  platform: "linux" | "darwin" | "win32",
  ancillary = false,
  originalDefinition?: Buffer,
  originalMode = 0o600,
) {
  const root = await fs.realpath(dirs.make("service-definition-backup-"));
  const env: GatewayServiceEnv = {
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_SYSTEMD_UNIT: "openclaw-owned",
    OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.receipt-fixture",
    USERNAME: "operator",
    OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
  };
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  const readFile = fs.readFile.bind(fs);
  if (platform === "linux") {
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (typeof args[0] === "string" && args[0].startsWith("/proc/self/fdinfo/")) {
        return "mnt_id:\t1\n";
      }
      if (args[0] === "/proc/self/mountinfo") {
        return "1 0 0:1 / / rw - tmpfs tmpfs rw\n";
      }
      return readFile(...args);
    });
  }
  const sourcePath =
    platform === "linux"
      ? resolveSystemdUnitPath(env)
      : platform === "darwin"
        ? resolveLaunchAgentPlistPath(env)
        : resolveTaskScriptPath(env);
  const command: GatewayServiceCommandConfig = {
    programArguments: ["/usr/bin/node", "/old/index.js", "gateway"],
    sourcePath,
    definitionPaths: [sourcePath],
    environment: { OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR! },
  };
  native.command.mockImplementation(async () => command);
  const original =
    originalDefinition ??
    (platform === "linux"
      ? Buffer.from(buildSystemdUnit(command).replace("KillMode=mixed\n", ""))
      : platform === "darwin"
        ? Buffer.from([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30, 0xff, 0x81])
        : Buffer.from("@echo off\r\nnode old.js gateway\r\n"));
  const files = [
    sourcePath,
    ...(platform === "linux"
      ? [path.join(env.OPENCLAW_STATE_DIR!, "gateway.systemd.env")]
      : platform === "darwin"
        ? [
            resolveLaunchAgentEnvFilePath(env, resolveLaunchAgentLabel(env)),
            resolveLaunchAgentEnvWrapperPath(env, resolveLaunchAgentLabel(env)),
          ]
        : [sourcePath.replace(/\.cmd$/, ".vbs")]),
  ];
  for (const file of files) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  await fs.writeFile(sourcePath, original, { mode: originalMode });
  await fs.chmod(sourcePath, originalMode);
  if (ancillary) {
    for (const file of files.slice(1)) {
      await fs.writeFile(file, "OPERATOR_SETTING=old-value\n", { mode: 0o600 });
    }
  }
  let task = buildScheduledTaskXml({
    taskDescription: "old",
    launchPath: sourcePath,
    taskUser: "operator",
  })
    .replace("<Count>3</Count>", "<Count>0</Count>")
    .replace("<RunLevel>LeastPrivilege</RunLevel>", "");
  const originalTask = task;
  native.task.mockImplementation(async (args: string[]) => {
    if (args[0] === "/Query") {
      return { code: 0, stderr: "", stdout: args.includes("/XML") ? task : "" };
    }
    if (args[0] === "/Create") {
      task = (await fs.readFile(args[args.indexOf("/XML") + 1]!)).subarray(2).toString("utf16le");
    }
    return { code: 0, stderr: "", stdout: "" };
  });
  let current = true;
  const context = {
    env,
    command,
    assertCurrent: () => {
      if (!current) {
        throw new Error("expired authority");
      }
    },
  };
  const capture = await captureGatewayServiceDefinitionBackup(context);
  const install = async (hooks = capture.hooks) => {
    const args = {
      env,
      programArguments: ["/usr/bin/node", "/new/index.js", "gateway"],
      environment: { OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR, OPERATOR_SETTING: "new-value" },
      stdout: new PassThrough(),
      definitionTransaction: hooks,
    };
    if (platform === "linux") {
      await stageSystemdService(args);
    } else if (platform === "darwin") {
      await stageLaunchAgent(args);
    } else {
      await installScheduledTask(args);
    }
  };
  return {
    ...context,
    capture,
    install,
    sourcePath,
    files,
    original,
    originalTask,
    task: () => task,
    setTask: (value: string) => {
      task = value;
    },
    expire: () => {
      current = false;
    },
  };
}

export { fixture, native };

export async function readRetainedReceipt(backupPaths: readonly string[]) {
  const checkpoint = backupPaths.find((file) => file.endsWith(".receipt.bak"));
  if (!checkpoint) {
    throw new Error("The service definition receipt was not retained.");
  }
  return GatewayServiceDefinitionBackupReceiptSchema.parse(
    JSON.parse(await fs.readFile(checkpoint, "utf8")),
  );
}
