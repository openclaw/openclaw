import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveGatewayServiceDescription } from "./constants.js";
import { formatLine, writeFormattedLines } from "./output.js";
import {
  restartRegisteredScheduledTask,
  runScheduledTaskOrThrow,
  type ScheduledTaskActivation,
} from "./schtasks-control.js";
import { execSchtasks } from "./schtasks-exec.js";
import {
  backupScheduledTaskDefinition,
  publishScheduledTaskFiles,
} from "./schtasks-install-files.js";
import {
  buildHiddenLauncherScript,
  buildScheduledTaskXml,
  buildStartupLauncherScript,
  buildTaskScript,
  encodeWindowsLauncherScript,
  quoteSchtasksArg,
  readScheduledTaskCommand,
  resolveStartupEntryPath,
  resolveTaskLauncherScriptPath,
  resolveTaskName,
  resolveTaskScriptPath,
  resolveTaskUser,
  shouldFallbackToStartupEntry,
  shouldUseHiddenWindowsTaskLauncher,
  writeTaskXmlTempFile,
} from "./schtasks-layout.js";
import {
  assertReplacementPortAvailableForTakeover,
  terminateGatewayProcessTree,
} from "./schtasks-process.js";
import {
  assertSchtasksAvailable,
  isStartupEntryInstalled,
  launchFallbackTaskScript,
  removeStartupEntries,
  resolveFallbackRuntime,
  waitForFallbackTakeoverRuntime,
  waitForScheduledTaskRunningEvidence,
} from "./schtasks-runtime.js";
import { probeScheduledTaskExists } from "./schtasks-state-probe.js";
import type {
  GatewayServiceEnv,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
} from "./service-types.js";
import {
  assertGatewayServiceUpdateCurrent,
  GatewayServiceAuthorityError,
  isUpdateOwnedGatewayServiceCommand,
  withGatewayServiceInstallationRecovery,
} from "./service-update-authority.js";

const CALLER_OWNED_SERVICE_IDENTITY_KEYS = [
  "OPENCLAW_LAUNCHD_LABEL",
  "OPENCLAW_SYSTEMD_UNIT",
  "OPENCLAW_WINDOWS_TASK_NAME",
] as const;

function resolveScheduledTaskRenderEnv(
  env: GatewayServiceEnv,
  environment: GatewayServiceEnv | undefined,
): GatewayServiceEnv {
  if (!environment) {
    return env;
  }
  const merged = { ...env, ...environment };
  for (const key of CALLER_OWNED_SERVICE_IDENTITY_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      merged[key] = value;
    }
  }
  return merged;
}

function resolveScheduledTaskScriptEnvironment(
  taskEnv: GatewayServiceEnv,
  environment: GatewayServiceEnv | undefined,
): GatewayServiceEnv | undefined {
  const scriptEnv = environment ? { ...environment } : {};
  for (const key of CALLER_OWNED_SERVICE_IDENTITY_KEYS) {
    const value = taskEnv[key]?.trim();
    if (value) {
      scriptEnv[key] = value;
    }
  }
  return Object.keys(scriptEnv).length > 0 ? scriptEnv : undefined;
}

const SCHEDULED_TASK_ACTIVATION_KEYS = [
  "OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER",
  "OPENCLAW_TASK_SCRIPT_NAME",
  "OPENCLAW_TASK_SCRIPT",
  "OPENCLAW_SERVICE_KIND",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_PROFILE",
] as const;

function resolveScheduledTaskActivationEnv(
  env: GatewayServiceEnv,
  environment: GatewayServiceEnv | undefined,
): GatewayServiceEnv {
  if (!environment) {
    return env;
  }
  const activationEnv = { ...env };
  for (const key of SCHEDULED_TASK_ACTIVATION_KEYS) {
    const value = environment[key];
    if (value !== undefined) {
      activationEnv[key] = value;
    }
  }
  return activationEnv;
}

async function writeScheduledTaskScript({
  env,
  programArguments,
  workingDirectory,
  environment,
  description,
}: Omit<GatewayServiceInstallArgs, "stdout">): Promise<{
  scriptPath: string;
  taskLaunchPath: string;
  taskDescription: string;
  restore: () => Promise<boolean>;
  assertPublished: () => Promise<void>;
}> {
  const taskEnv = resolveScheduledTaskRenderEnv(env, environment);
  const scriptPath = resolveTaskScriptPath(taskEnv);
  const taskLaunchPath = resolveTaskLauncherScriptPath(taskEnv, scriptPath);
  const taskDescription = resolveGatewayServiceDescription({
    env: taskEnv,
    description,
  });
  const script = buildTaskScript({
    description: taskDescription,
    programArguments,
    workingDirectory,
    environment: resolveScheduledTaskScriptEnvironment(taskEnv, environment),
  });
  const files = [
    { path: scriptPath, contents: encodeWindowsLauncherScript({ format: "cmd", content: script }) },
  ];
  if (taskLaunchPath !== scriptPath) {
    const launcher = buildHiddenLauncherScript({
      description: taskDescription,
      scriptPath,
      taskSupervisor: environment?.OPENCLAW_SERVICE_KIND === "gateway",
    });
    files.push({
      path: taskLaunchPath,
      contents: encodeWindowsLauncherScript({ format: "vbs", content: launcher }),
    });
  }
  const published = await publishScheduledTaskFiles(files);
  return { scriptPath, taskLaunchPath, taskDescription, ...published };
}

export async function stageScheduledTask({
  stdout,
  ...args
}: GatewayServiceInstallArgs): Promise<{ scriptPath: string }> {
  const { scriptPath } = await writeScheduledTaskScript(args);
  writeFormattedLines(stdout, [{ label: "Staged task script", value: scriptPath }], {
    leadingBlankLine: true,
  });
  return { scriptPath };
}

async function activateScheduledTask(params: {
  env: GatewayServiceEnv;
  stdout: NodeJS.WritableStream;
  warn: (message: string) => void;
  scriptPath: string;
  taskLaunchPath: string;
  description?: string;
  retainRecovery: () => void;
  recordRegistration: () => Promise<void>;
  onActivation: () => void;
  registered: boolean;
}): Promise<ScheduledTaskActivation | "startup-fallback"> {
  const taskDescription = params.description ?? "OpenClaw Gateway";
  const taskName = resolveTaskName(params.env);
  let updated = false;
  if (params.registered) {
    assertGatewayServiceUpdateCurrent();
    const change = await execSchtasks([
      "/Change",
      "/TN",
      taskName,
      "/TR",
      quoteSchtasksArg(params.taskLaunchPath),
    ]);
    if (change.code === 124) {
      params.retainRecovery();
      throw new Error("Scheduled Task registration change did not confirm completion.");
    }
    updated = change.code === 0;
  }

  const taskUser = resolveTaskUser(params.env);
  // Use `schtasks /Create /XML` so the task carries explicit battery settings.
  // The CLI flag form cannot set these and kills the Gateway when a laptop unplugs (#59299).
  const xmlPath = await writeTaskXmlTempFile(
    buildScheduledTaskXml({ taskDescription, taskUser, launchPath: params.taskLaunchPath }),
  );
  let create: Awaited<ReturnType<typeof execSchtasks>>;
  try {
    const xmlArgs = ["/Create", "/F", "/TN", taskName, "/XML", xmlPath];
    // The XML owns UserId and InteractiveToken. `/NP` overrides that principal
    // with a non-interactive S4U logon, so a successful task never starts here.
    assertGatewayServiceUpdateCurrent();
    create = await execSchtasks(xmlArgs);
  } finally {
    await fs.rm(path.dirname(xmlPath), { recursive: true, force: true }).catch(() => {});
  }
  if (create.code !== 0) {
    if (create.code === 124) {
      params.retainRecovery();
      throw new Error("Scheduled Task registration did not confirm completion.");
    }
    const detail = create.stderr || create.stdout;
    if (!updated && shouldFallbackToStartupEntry({ code: create.code, detail })) {
      if (isUpdateOwnedGatewayServiceCommand()) {
        throw new Error(
          "UPDATE_NATIVE_AUTHORITY: update-owned native commands require Task Scheduler; startup fallback is unsupported.",
        );
      }
      const startupEntryPath = resolveStartupEntryPath(params.env);
      assertGatewayServiceUpdateCurrent();
      await fs.mkdir(path.dirname(startupEntryPath), { recursive: true });
      const useHiddenLauncher = shouldUseHiddenWindowsTaskLauncher(params.env);
      const launcher = useHiddenLauncher
        ? buildHiddenLauncherScript({
            description: taskDescription,
            scriptPath: params.scriptPath,
            taskSupervisor: params.env.OPENCLAW_SERVICE_KIND === "gateway",
          })
        : buildStartupLauncherScript({
            description: taskDescription,
            scriptPath: params.scriptPath,
          });
      assertGatewayServiceUpdateCurrent();
      await fs.writeFile(
        startupEntryPath,
        encodeWindowsLauncherScript({
          format: useHiddenLauncher ? "vbs" : "cmd",
          content: launcher,
        }),
      );
      params.retainRecovery();
      await launchFallbackTaskScript(params.env);
      writeFormattedLines(
        params.stdout,
        [
          { label: "Installed Windows login item", value: startupEntryPath },
          { label: "Task script", value: params.scriptPath },
        ],
        { leadingBlankLine: true },
      );
      return "startup-fallback";
    }
    if (!updated) {
      throw new Error(`schtasks create failed: ${detail}`.trim());
    }
    params.warn(
      `Scheduled Task ${taskName} launch command was refreshed, but XML settings (including battery settings) were not: ${detail.trim() || "unknown error"}. Inspect Task Scheduler and retry the service installation to refresh those settings.`,
    );
  }

  await params.recordRegistration();
  assertGatewayServiceUpdateCurrent();
  params.onActivation();
  const activation = await runScheduledTaskOrThrow({
    taskName,
    env: params.env,
    scriptPath: params.scriptPath,
  });
  // Ensure we don't end up writing to a clack spinner line (wizards show progress without a newline).
  writeFormattedLines(
    params.stdout,
    [
      { label: updated ? "Updated Scheduled Task" : "Installed Scheduled Task", value: taskName },
      { label: "Task script", value: params.scriptPath },
    ],
    { leadingBlankLine: true },
  );
  return activation;
}

export async function installScheduledTask(
  args: GatewayServiceInstallArgs,
): Promise<{ scriptPath: string }> {
  if (args.beforeLoad) {
    throw new Error("Deferred native service load is not supported on this platform.");
  }
  let restoreTask: Awaited<ReturnType<typeof backupScheduledTaskDefinition>> | undefined;
  let staged: Awaited<ReturnType<typeof writeScheduledTaskScript>> | undefined;
  const warn = args.warn ?? ((message: string) => args.stdout.write(`${message}\n`));
  let activationAttempted = false;
  return withGatewayServiceInstallationRecovery(
    async () => {
      const installedCommand = await readScheduledTaskCommand(args.env).catch(() => null);
      const fallbackEnv = resolveScheduledTaskActivationEnv(
        args.env,
        installedCommand?.environment,
      );
      // Capture ownership before repair changes the port/profile that locates the old process.
      const startupEntryInstalled = await isStartupEntryInstalled(fallbackEnv);
      let startupRuntime = startupEntryInstalled
        ? await resolveFallbackRuntime(fallbackEnv, installedCommand, "control").catch(() => null)
        : null;
      if (
        startupEntryInstalled &&
        args.startupFallbackTakeoverRuntime?.status === "running" &&
        startupRuntime?.status !== "running"
      ) {
        startupRuntime = await waitForFallbackTakeoverRuntime(
          fallbackEnv,
          installedCommand,
          startupRuntime ?? { status: "unknown" },
          args.startupFallbackTakeoverRuntime,
        );
      }
      if (startupEntryInstalled && (!startupRuntime || startupRuntime.status === "unknown")) {
        throw new Error(
          startupRuntime?.detail ??
            "Could not verify the existing Windows login item before Scheduled Task migration.",
        );
      }
      const activationEnv = resolveScheduledTaskActivationEnv(args.env, args.environment);
      if (startupRuntime) {
        const fallbackPid = startupRuntime.status === "running" ? startupRuntime.pid : undefined;
        if (startupRuntime.status === "running" && !fallbackPid) {
          throw new Error("Could not verify the existing Windows login item process.");
        }
        await assertReplacementPortAvailableForTakeover({
          env: activationEnv,
          programArguments: args.programArguments,
          ...(args.environment ? { environment: args.environment } : {}),
          ...(fallbackPid ? { fallbackPid } : {}),
        });
      }
      restoreTask = await backupScheduledTaskDefinition(
        activationEnv,
        resolveTaskScriptPath(resolveScheduledTaskRenderEnv(args.env, args.environment)),
      );
      staged = await writeScheduledTaskScript(args);
      const activation = await activateScheduledTask({
        env: activationEnv,
        stdout: args.stdout,
        warn,
        scriptPath: staged.scriptPath,
        taskLaunchPath: staged.taskLaunchPath,
        description: staged.taskDescription,
        registered: restoreTask.registered,
        retainRecovery: restoreTask.retainRecovery,
        recordRegistration: restoreTask.recordRegistration,
        onActivation: () => {
          activationAttempted = true;
        },
      });
      assertGatewayServiceUpdateCurrent();
      if (activation !== "scheduled-task") {
        return { scriptPath: staged.scriptPath };
      }
      // Re-probe the captured command so a config-reload fallback is not hidden by the staged script.
      const takeoverRuntime =
        startupRuntime?.status === "stopped"
          ? await resolveFallbackRuntime(fallbackEnv, installedCommand, "control").catch(
              () => startupRuntime,
            )
          : startupRuntime;
      if (takeoverRuntime?.status === "running" && takeoverRuntime.pid) {
        // The old launcher can still own the listener; terminate it and prove the replacement.
        await terminateGatewayProcessTree(takeoverRuntime.pid, 300);
        let scheduledTaskRunAccepted = false;
        try {
          // Re-reading ownership now would inspect the replacement command, not the captured fallback.
          await restartRegisteredScheduledTask({
            env: activationEnv,
            stdout: args.stdout,
            mode: { kind: "fallback-takeover" },
            onRunMutation: () => {
              scheduledTaskRunAccepted = true;
            },
          });
        } catch (err) {
          // An accepted /Run can still start later. Replacing it with a detached Gateway
          // would defeat Scheduler's single-instance policy and create a duplicate listener.
          if (!scheduledTaskRunAccepted) {
            await launchFallbackTaskScript(fallbackEnv, installedCommand);
          }
          throw err;
        }
      } else if (
        takeoverRuntime?.status === "stopped" &&
        (await waitForScheduledTaskRunningEvidence(activationEnv))
      ) {
        await removeStartupEntries(activationEnv, args.stdout);
      }
      return { scriptPath: staged.scriptPath };
    },
    async () => {
      if (!staged || !restoreTask) {
        return false;
      }
      return restoreTask.restore(staged, activationAttempted);
    },
  ).catch((error: unknown) => {
    if (
      (error instanceof GatewayServiceAuthorityError && error.outcome === "recovery-pending") ||
      error instanceof AggregateError
    ) {
      warn(
        "Scheduled Task recovery did not confirm completion; a queued task may still start. Inspect Task Scheduler before restoring any .bak launcher or task XML files beside the task script.",
      );
    }
    throw error;
  });
}

export async function uninstallScheduledTask({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<void> {
  await assertSchtasksAvailable();
  const taskName = resolveTaskName(env);
  const query = await execSchtasks(["/Query", "/TN", taskName]);
  const queryDetail = normalizeLowercaseStringOrEmpty(query.stderr || query.stdout);
  const exists =
    query.code === 0
      ? true
      : queryDetail.includes("cannot find the file")
        ? false
        : probeScheduledTaskExists(taskName);
  if (exists === null) {
    throw new Error(`Could not verify whether Scheduled Task ${taskName} exists.`);
  }
  if (exists) {
    const deletion = await execSchtasks(["/Delete", "/F", "/TN", taskName]);
    if (deletion.code !== 0) {
      const detail = (deletion.stderr || deletion.stdout).trim() || "unknown error";
      throw new Error(`schtasks delete failed: ${detail}`);
    }
  }
  await removeStartupEntries(env, stdout);

  const scriptPath = resolveTaskScriptPath(env);
  const parsedScriptPath = path.parse(scriptPath);
  const launcherPaths = uniqueStrings([
    resolveTaskLauncherScriptPath(env, scriptPath),
    path.join(parsedScriptPath.dir, `${parsedScriptPath.name}.vbs`),
  ]);
  for (const launcherPath of launcherPaths) {
    if (launcherPath === scriptPath) {
      continue;
    }
    try {
      await fs.unlink(launcherPath);
      stdout.write(`${formatLine("Removed task launcher", launcherPath)}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  for (const backupPath of uniqueStrings([
    `${scriptPath}.bak`,
    `${scriptPath}.task.xml.bak`,
    ...launcherPaths.map((launcherPath) => `${launcherPath}.bak`),
  ])) {
    await fs.unlink(backupPath).catch((error: unknown) => {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
    });
  }
  try {
    await fs.unlink(scriptPath);
    stdout.write(`${formatLine("Removed task script", scriptPath)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    stdout.write(`Task script not found at ${scriptPath}\n`);
  }
}
