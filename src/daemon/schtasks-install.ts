import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { hasErrnoCode } from "../infra/errno.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import { WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS } from "../infra/windows-powershell-spawn.js";
import { resolveGatewayServiceDescription } from "./constants.js";
import { resolveGatewayServiceProbeHosts } from "./gateway-service-probe-hosts.js";
import { formatLine, writeFormattedLines } from "./output.js";
import {
  readScheduledTaskDefinition,
  restartRegisteredScheduledTask,
  runScheduledTaskOrThrow,
  stopRegisteredScheduledTask,
  type ScheduledTaskActivation,
} from "./schtasks-control.js";
import { execSchtasks } from "./schtasks-exec.js";
import {
  backupScheduledTaskDefinition,
  publishScheduledTaskFiles,
  type ScheduledTaskFileRecovery,
} from "./schtasks-install-files.js";
import {
  buildHiddenLauncherScript,
  buildStartupLauncherScript,
  buildTaskScript,
  encodeWindowsLauncherScript,
  quoteSchtasksArg,
  readScheduledTaskCommand,
  resolveStartupEntryPath,
  resolveTaskLauncherScriptPath,
  resolveTaskName,
  resolveTaskScriptPath,
  shouldFallbackToStartupEntry,
  shouldUseHiddenWindowsTaskLauncher,
} from "./schtasks-layout.js";
import {
  findInstalledProcessPid,
  readWindowsProcessSnapshot,
} from "./schtasks-process-snapshot.js";
import {
  resolveScheduledTaskCommandPort,
  shouldManageGatewayListenerPort,
  terminateGatewayProcessTree,
} from "./schtasks-process.js";
import {
  assertSchtasksAvailable,
  isRegisteredScheduledTask,
  isScheduledTaskDefinitelyNotRunning,
  isStartupEntryInstalled,
  launchFallbackTaskScript,
  removeStartupEntries,
  resolveFallbackRuntime,
  waitForFallbackTakeoverRuntime,
  waitForScheduledTaskRunningEvidence,
} from "./schtasks-runtime.js";
import { probeScheduledTaskExists } from "./schtasks-state-probe.js";
import { buildScheduledTaskXml, writeTaskXmlTempFile } from "./schtasks-xml.js";
import { preserveServicePolicyXml } from "./service-policy-xml.js";
import { resolveTaskUser } from "./service-process-env.js";
import { publishServiceFile } from "./service-stage.js";
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

async function writeScheduledTaskScript(
  {
    env,
    programArguments,
    workingDirectory,
    environment,
    description,
    definitionTransaction,
  }: Omit<GatewayServiceInstallArgs, "stdout">,
  beforePublish?: (recovery?: ScheduledTaskFileRecovery) => Promise<void>,
): Promise<{
  scriptPath: string;
  taskLaunchPath: string;
  taskDescription: string;
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
  await publishScheduledTaskFiles(files, definitionTransaction, beforePublish);
  return { scriptPath, taskLaunchPath, taskDescription };
}

export async function stageScheduledTask({
  stdout,
  ...args
}: GatewayServiceInstallArgs): Promise<{ scriptPath: string }> {
  const { scriptPath } = await writeScheduledTaskScript(args);
  writeFormattedLines(stdout, [{ label: "Staged task script", value: scriptPath }]);
  return { scriptPath };
}

type ScheduledTaskInstallRecovery = {
  registration?: Awaited<ReturnType<typeof backupScheduledTaskDefinition>>;
  onActivation?: () => void;
};

async function activateScheduledTask(
  params: {
    env: GatewayServiceEnv;
    stdout: NodeJS.WritableStream;
    warn?: GatewayServiceInstallArgs["warn"];
    scriptPath: string;
    taskLaunchPath: string;
    description?: string;
    definitionTransaction?: GatewayServiceInstallArgs["definitionTransaction"];
  } & ScheduledTaskInstallRecovery,
): Promise<ScheduledTaskActivation | "startup-fallback"> {
  const taskDescription = params.description ?? "OpenClaw Gateway";
  const taskName = resolveTaskName(params.env);
  const quotedLaunchPath = quoteSchtasksArg(params.taskLaunchPath);
  let expectedXml = buildScheduledTaskXml({
    taskDescription,
    taskUser: resolveTaskUser(params.env),
    launchPath: params.taskLaunchPath,
  });
  if (params.definitionTransaction?.preservePolicy?.length) {
    expectedXml = preserveServicePolicyXml(
      expectedXml,
      await readScheduledTaskDefinition(params.env),
      params.definitionTransaction.preservePolicy,
      "Task",
    );
  }
  let updating = params.registration?.registered ?? (await isRegisteredScheduledTask(params.env));
  if (updating && !params.definitionTransaction) {
    // Ordinary installs retain their existing /Change failure and Startup fallback contract.
    assertGatewayServiceUpdateCurrent();
    const change = await execSchtasks(["/Change", "/TN", taskName, "/TR", quotedLaunchPath]);
    if (change.code === 124) {
      params.registration?.retainRecovery();
      throw new Error("Scheduled Task registration change did not confirm completion.");
    }
    updating = change.code === 0;
  }

  // Re-apply the full XML so existing tasks inherit both false battery flags (#59299).
  // The CLI flag form cannot set these and kills the Gateway when a laptop unplugs (#59299).
  const xmlPath = await writeTaskXmlTempFile(expectedXml);
  let create: Awaited<ReturnType<typeof execSchtasks>>;
  try {
    const xmlArgs = ["/Create", "/F", "/TN", taskName, "/XML", xmlPath];
    // The XML owns UserId and InteractiveToken. `/NP` overrides that principal
    // with a non-interactive S4U logon, so a successful task never starts here.
    await params.definitionTransaction?.taskPrepared(expectedXml);
    params.definitionTransaction?.assertCurrent();
    assertGatewayServiceUpdateCurrent();
    create = await execSchtasks(xmlArgs);
    if (create.code === 124) {
      params.registration?.retainRecovery();
      throw new Error("Scheduled Task registration did not confirm completion.");
    }
    if (create.code !== 0 && updating) {
      const detail = (create.stderr || create.stdout).trim() || "unknown error";
      // Transactional repair must compensate; ordinary installs keep best-effort activation.
      if (params.definitionTransaction) {
        throw new Error(`Scheduled Task definition upgrade failed: ${detail}`);
      }
      params.warn?.(
        `Scheduled Task ${taskName} launch command was refreshed, but XML settings (including battery settings) were not: ${detail}. Inspect Task Scheduler and retry the service installation to refresh those settings.`,
      );
    } else if (create.code === 0) {
      await params.definitionTransaction?.taskWritten(expectedXml);
    }
  } finally {
    await fs.rm(path.dirname(xmlPath), { recursive: true, force: true }).catch(() => {});
  }
  if (create.code !== 0 && !updating) {
    const detail = create.stderr || create.stdout;
    if (shouldFallbackToStartupEntry({ code: create.code, detail })) {
      if (isUpdateOwnedGatewayServiceCommand() || params.definitionTransaction) {
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
      await publishServiceFile({
        filePath: startupEntryPath,
        contents: encodeWindowsLauncherScript({
          format: useHiddenLauncher ? "vbs" : "cmd",
          content: launcher,
        }),
        mode: 0o600,
      });
      params.registration?.retainRecovery();
      await launchFallbackTaskScript(params.env);
      writeFormattedLines(params.stdout, [
        { label: "Installed Windows login item", value: startupEntryPath },
        { label: "Task script", value: params.scriptPath },
      ]);
      return "startup-fallback";
    }
    throw new Error(`schtasks create failed: ${detail}`.trim());
  }

  await params.registration?.recordRegistration();
  await params.definitionTransaction?.beforeWrite();
  assertGatewayServiceUpdateCurrent();
  params.onActivation?.();
  const activation = await runScheduledTaskOrThrow({
    taskName,
    env: params.env,
    scriptPath: params.scriptPath,
    assertCurrent: params.definitionTransaction?.assertCurrent,
    allowFallback: params.definitionTransaction ? false : undefined,
  });
  // Ensure we don't end up writing to a clack spinner line (wizards show progress without a newline).
  writeFormattedLines(params.stdout, [
    { label: updating ? "Updated Scheduled Task" : "Installed Scheduled Task", value: taskName },
    { label: "Task script", value: params.scriptPath },
  ]);
  return activation;
}

export async function installScheduledTask(
  args: GatewayServiceInstallArgs,
): Promise<{ scriptPath: string }> {
  let restoreTask: Awaited<ReturnType<typeof backupScheduledTaskDefinition>> | undefined;
  let staged: Awaited<ReturnType<typeof writeScheduledTaskScript>> | undefined;
  let recovery: ScheduledTaskFileRecovery | undefined;
  const warn = args.warn ?? ((message: string) => args.stdout.write(`${message}\n`));
  let activationAttempted = false;
  const install = async () => {
    const installedCommand = await readScheduledTaskCommand(args.env).catch(() => null);
    const fallbackEnv = resolveScheduledTaskActivationEnv(args.env, installedCommand?.environment);
    // Capture ownership before repair changes the port/profile that locates the old process.
    const startupEntryInstalled =
      !args.definitionTransaction && (await isStartupEntryInstalled(fallbackEnv));
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
    if (!args.definitionTransaction) {
      restoreTask = await backupScheduledTaskDefinition(
        activationEnv,
        resolveTaskScriptPath(resolveScheduledTaskRenderEnv(args.env, args.environment)),
      );
    }
    staged = await writeScheduledTaskScript(args, async (files) => {
      recovery = files;
      const assertOriginal = async () => {
        await files?.assertPublished();
        await restoreTask?.assertCurrent();
        await args.definitionTransaction?.beforeWrite();
        args.assertCurrent?.();
      };
      await assertOriginal();
      const registered =
        restoreTask?.registered ?? probeScheduledTaskExists(resolveTaskName(args.env));
      if (registered === null) {
        throw new Error("Scheduled Task registration could not be verified before replacement.");
      }
      if (!registered) {
        return;
      }
      if (
        isScheduledTaskDefinitelyNotRunning(resolveTaskName(fallbackEnv)) &&
        (
          await resolveFallbackRuntime(
            fallbackEnv,
            installedCommand,
            "control",
            performance.now() + WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS,
          )
        ).status === "stopped"
      ) {
        // An update may already own stopped-state custody. Observation must not reacquire it.
        await assertOriginal();
        return;
      }
      try {
        // Stop against the original command; IgnoreNew cannot activate a rewritten running task.
        const replaced = await stopRegisteredScheduledTask({
          env: fallbackEnv,
          stdout: args.stdout,
          assertCurrent: args.assertCurrent,
          beforeMutation: assertOriginal,
          onProcessStopped: restoreTask?.recordStoppedProcess,
          warn,
          onEndMutation: () => {
            activationAttempted = true;
          },
        });
        if (replaced) {
          throw new Error("Gateway ownership changed before Scheduled Task replacement.");
        }
      } catch (error) {
        // A changed or unsettled task is not ours to end again during compensation.
        restoreTask?.retainRecovery();
        throw error;
      }
      await assertOriginal();
    });
    const activation = await activateScheduledTask({
      env: activationEnv,
      stdout: args.stdout,
      warn,
      scriptPath: staged.scriptPath,
      taskLaunchPath: staged.taskLaunchPath,
      description: staged.taskDescription,
      definitionTransaction: args.definitionTransaction,
      registration: restoreTask,
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
      await terminateGatewayProcessTree(takeoverRuntime.pid);
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
    assertGatewayServiceUpdateCurrent();
    return { scriptPath: staged.scriptPath };
  };
  if (args.definitionTransaction) {
    // The caller's definition transaction owns rollback and native lifecycle recovery.
    return install();
  }
  return withGatewayServiceInstallationRecovery(install, async () => {
    if (!recovery || !restoreTask) {
      return false;
    }
    return restoreTask.restore(recovery, activationAttempted);
  }).catch((error: unknown) => {
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
  const launcherPath = path.join(parsedScriptPath.dir, `${parsedScriptPath.name}.vbs`);
  if (launcherPath !== scriptPath) {
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
    `${launcherPath}.bak`,
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

async function assertReplacementPortAvailableForTakeover(params: {
  env: GatewayServiceEnv;
  programArguments: string[];
  environment?: GatewayServiceEnv;
  fallbackPid?: number;
}): Promise<void> {
  if (!shouldManageGatewayListenerPort(params.env)) {
    return;
  }
  const command = {
    programArguments: params.programArguments,
    environment: Object.fromEntries(
      Object.entries(params.environment ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  };
  const port = resolveScheduledTaskCommandPort(params.env, command);
  if (!port) {
    throw new Error("Could not verify the replacement Windows Scheduled Task port.");
  }
  const probeHosts = await resolveGatewayServiceProbeHosts({ env: params.env, command });
  const diagnostics = await inspectPortUsage(port, { probeHosts }).catch(() => null);
  if (!diagnostics) {
    throw new Error(`Could not inspect replacement gateway port ${port}.`);
  }
  if (diagnostics.status === "free") {
    return;
  }
  if (diagnostics.status !== "busy") {
    throw new Error(`Could not verify replacement gateway port ${port}.`);
  }

  const allowedPids = new Set<number>();
  if (params.fallbackPid) {
    allowedPids.add(params.fallbackPid);
  }
  if (process.platform === "win32") {
    const snapshot = readWindowsProcessSnapshot();
    if (snapshot) {
      const replacementPid = findInstalledProcessPid(
        snapshot,
        port,
        params.programArguments,
        () => true,
      );
      if (replacementPid) {
        allowedPids.add(replacementPid);
      }
    }
  }
  const listenerPids = diagnostics.listeners.map((listener) => listener.pid);
  if (
    listenerPids.length > 0 &&
    listenerPids.every((pid) => typeof pid === "number" && pid > 0 && allowedPids.has(pid))
  ) {
    return;
  }
  throw new Error(`replacement gateway port ${port} is occupied by an unverified process`);
}
