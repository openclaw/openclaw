import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveGatewayServiceProbeHosts } from "./gateway-service-probe-hosts.js";
import { formatLine } from "./output.js";
import { execSchtasks } from "./schtasks-exec.js";
import {
  readScheduledTaskCommand,
  resolveTaskName,
  resolveTaskScriptPath,
  writeTaskXmlTempFile,
} from "./schtasks-layout.js";
import {
  describeUnverifiedPortListeners,
  findInstalledProcessPids,
  findInstalledGatewayChildPids,
  isNodeHostArgv,
  readWindowsProcessSnapshot,
  resolveScheduledTaskCommandPort,
  resolveScheduledTaskGatewayContext,
  resolveScheduledTaskOwnedGatewayPids,
  shouldManageGatewayListenerPort,
  terminateGatewayProcessTree,
  terminateScheduledTaskGatewayListeners,
  terminateScheduledTaskNodeHost,
  waitForGatewayPortRelease,
} from "./schtasks-process.js";
import {
  assertSchtasksAvailable,
  isRegisteredScheduledTask,
  isScheduledTaskDefinitelyNotRunning,
  isStartupEntryInstalled,
  launchFallbackTaskScript,
  removeStartupEntries,
  resolveFallbackRuntime,
  restartStartupEntry,
  startStartupEntry,
  stopStartupEntry,
  SCHEDULED_TASK_FALLBACK_TIMEOUT_MS,
  terminateInstalledStartupRuntime,
  waitForScheduledTaskRunningEvidence,
} from "./schtasks-runtime.js";
import { probeScheduledTaskExists, probeScheduledTaskState } from "./schtasks-state-probe.js";
import { ScheduledTaskAutoStartRecoveryError } from "./schtasks-update-recovery.js";
import { createGatewayLifecycleMutationReporter } from "./service-mutation.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import type {
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceRestartResult,
} from "./service-types.js";
import { WINDOWS_TASK_SUPERVISOR_FLAG } from "./windows-task-supervisor-contract.js";

export type ScheduledTaskActivation = "scheduled-task" | "direct-fallback";

/** Capture every pre-activation owner so a direct fallback cannot duplicate it. */
async function readPreLaunchTaskPids(
  env: GatewayServiceEnv,
  scriptPath: string,
): Promise<{
  pids: ReadonlySet<number>;
  complete: boolean;
}> {
  const pids = new Set<number>();
  try {
    const command = await readScheduledTaskCommand(env);
    if (!command) {
      return { pids, complete: false };
    }
    const port = resolveScheduledTaskCommandPort(env, command);
    const manageGatewayPort = shouldManageGatewayListenerPort(env);
    if (port && manageGatewayPort) {
      const probeHosts = await resolveGatewayServiceProbeHosts({ env, command });
      for (const pid of await resolveScheduledTaskOwnedGatewayPids(
        env,
        { port, probeHosts },
        command,
      )) {
        pids.add(pid);
      }
    }
    // All asynchronous command, probe-host, and ownership preparation must finish before this
    // final snapshot. A wrapper that starts during that preparation is still pre-`/Run` state.
    const snapshot = readWindowsProcessSnapshot();
    if (!snapshot && process.platform === "win32") {
      return { pids, complete: false };
    }
    const snapshotEntries = snapshot ?? [];
    const scriptPathNeedle = normalizeLowercaseStringOrEmpty(scriptPath.replaceAll("/", "\\"));
    if (scriptPathNeedle) {
      for (const entry of snapshotEntries) {
        const pid = entry.ProcessId;
        if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
          continue;
        }
        if (
          normalizeLowercaseStringOrEmpty(entry.CommandLine ?? "")
            .replaceAll("/", "\\")
            .includes(scriptPathNeedle)
        ) {
          pids.add(pid);
        }
      }
    }
    const installedArguments = command.programArguments;
    if (snapshot && installedArguments?.length) {
      if (port && manageGatewayPort) {
        for (const pid of findInstalledGatewayChildPids(snapshot, port, installedArguments)) {
          pids.add(pid);
        }
      }
      const candidates = manageGatewayPort
        ? [installedArguments, [...installedArguments, WINDOWS_TASK_SUPERVISOR_FLAG]]
        : [installedArguments];
      const matchesProcess = manageGatewayPort ? () => true : isNodeHostArgv;
      // A stopped task can leave multiple exact children or its supervisor alive.
      // A preferred-PID query alone cannot establish that direct fallback is safe.
      // Node commands may use a default port or inherit it from their environment;
      // any exact installed argv match blocks duplication, regardless of port.
      const matchPort = manageGatewayPort ? port : null;
      for (const argv of candidates) {
        for (const pid of findInstalledProcessPids(snapshot, matchPort, argv, matchesProcess)) {
          pids.add(pid);
        }
      }
    }
  } catch {
    return { pids, complete: false };
  }
  return { pids, complete: true };
}

export async function runScheduledTaskOrThrow(params: {
  taskName: string;
  env: GatewayServiceEnv;
  scriptPath: string;
  onMutation?: () => void;
  assertCurrent?: () => void;
  allowFallback?: boolean;
}): Promise<ScheduledTaskActivation> {
  params.assertCurrent?.();
  const preLaunch = await readPreLaunchTaskPids(params.env, params.scriptPath);
  params.assertCurrent?.();
  const run = await execSchtasks(["/Run", "/TN", params.taskName]);
  if (run.code !== 0) {
    throw new Error(`schtasks run failed: ${run.stderr || run.stdout}`.trim());
  }
  params.onMutation?.();
  params.assertCurrent?.();
  // Runtime status can be promoted by an unrelated foreground process. Only the
  // registered Scheduler owner can attest supervision, including when CIM fails.
  if (
    await waitForScheduledTaskRunningEvidence(params.env, {
      settleAfterRun: true,
      assertCurrent: params.assertCurrent,
    })
  ) {
    params.assertCurrent?.();
    return "scheduled-task";
  }
  if (
    params.allowFallback !== false &&
    !shouldManageGatewayListenerPort(params.env) &&
    preLaunch.complete &&
    preLaunch.pids.size === 0
  ) {
    const current = await readPreLaunchTaskPids(params.env, params.scriptPath);
    params.assertCurrent?.();
    const scheduler = probeScheduledTaskState(params.taskName);
    // Preserve node-only direct fallback, but never duplicate a pre-existing or
    // newly observed host, an uninspectable process, or a queued Scheduler run.
    if (
      current.complete &&
      current.pids.size === 0 &&
      scheduler.status === "found" &&
      (scheduler.state === 1 || scheduler.state === 3) &&
      (scheduler.lastRunResult === "267011" || scheduler.lastRunResult === "0")
    ) {
      params.assertCurrent?.();
      await launchFallbackTaskScript(params.env, undefined, params.assertCurrent);
      return "direct-fallback";
    }
  }
  throw new Error(
    `Scheduled Task ${params.taskName} did not sustain Running for ${SCHEDULED_TASK_FALLBACK_TIMEOUT_MS / 1000}s after schtasks /Run; refusing a direct fallback because the queued task could still start.`,
  );
}

function parseScheduledTaskXmlEnabled(output: string): boolean | null {
  const normalized = output.replace(/^\uFEFF/u, "").replaceAll(String.fromCharCode(0), "");
  const settings = /<Settings(?:\s[^>]*)?>([\s\S]*?)<\/Settings>/iu.exec(normalized)?.[1];
  if (settings === undefined) {
    return null;
  }
  const enabled = /<Enabled>\s*(true|false)\s*<\/Enabled>/iu.exec(settings)?.[1];
  // Task Scheduler's schema defaults a missing Settings.Enabled value to true.
  return enabled === undefined ? true : enabled.toLowerCase() === "true";
}

export function setScheduledTaskXmlEnabled(xml: string, enabled: boolean): string {
  if (parseScheduledTaskXmlEnabled(xml) === null) {
    throw new Error("Scheduled Task enabled state could not be inspected.");
  }
  return xml.replace(
    /(<Settings(?:\s[^>]*)?>)([\s\S]*?)(<\/Settings>)/iu,
    (_match, open: string, body: string, close: string) => {
      const value = `<Enabled>${enabled}</Enabled>`;
      const field = /<Enabled>\s*(true|false)\s*<\/Enabled>/iu;
      return `${open}${field.test(body) ? body.replace(field, value) : `${value}${body}`}${close}`;
    },
  );
}

export async function readScheduledTaskDefinition(env: GatewayServiceEnv): Promise<string> {
  const result = await execSchtasks(["/Query", "/TN", resolveTaskName(env), "/XML"]);
  const xml = result.stdout.replace(/^\uFEFF/u, "").replaceAll(String.fromCharCode(0), "");
  if (result.code !== 0 || !/<Task[\s>]/u.test(xml)) {
    throw new Error("Scheduled Task definition could not be inspected.");
  }
  return xml;
}

export async function restoreScheduledTaskDefinition(params: {
  env: GatewayServiceEnv;
  xml: string;
  beforeWrite: () => Promise<void>;
  assertCurrent: () => void;
}): Promise<void> {
  const current = await readScheduledTaskDefinition(params.env);
  const enabled = parseScheduledTaskXmlEnabled(current);
  if (enabled === null) {
    throw new Error("Scheduled Task enabled state could not be preserved.");
  }
  const temporary = await writeTaskXmlTempFile(setScheduledTaskXmlEnabled(params.xml, enabled));
  try {
    await params.beforeWrite();
    if ((await readScheduledTaskDefinition(params.env)) !== current) {
      throw new Error("Scheduled Task changed before restoration.");
    }
    params.assertCurrent();
    const result = await execSchtasks([
      "/Create",
      "/F",
      "/TN",
      resolveTaskName(params.env),
      "/XML",
      temporary,
    ]);
    if (result.code !== 0) {
      throw new Error("Scheduled Task definition could not be restored.");
    }
  } finally {
    await fs.rm(path.dirname(temporary), { recursive: true, force: true });
  }
}

async function changeScheduledTaskEnabledState(params: {
  env: GatewayServiceEnv;
  enabled: boolean;
  beforeMutation?: () => Promise<void>;
  assertCurrent?: () => void;
  restoreOnFailure?: boolean;
}): Promise<boolean> {
  const taskName = resolveTaskName(params.env);
  if (!params.enabled) {
    const query = await execSchtasks(["/Query", "/TN", taskName, "/XML"]);
    if (query.code !== 0) {
      const taskExists = probeScheduledTaskExists(taskName);
      if (taskExists === false) {
        return false;
      }
      const detail = (query.stderr || query.stdout).trim() || "unknown error";
      throw new Error(`schtasks XML query failed: ${detail}`);
    }
    const enabled = parseScheduledTaskXmlEnabled(query.stdout);
    if (enabled === null) {
      throw new Error("schtasks XML query did not expose the task enabled state");
    }
    if (!enabled) {
      return false;
    }
  }

  const action = params.enabled ? "/ENABLE" : "/DISABLE";
  await params.beforeMutation?.();
  params.assertCurrent?.();
  const result = await execSchtasks(["/Change", "/TN", taskName, action]);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim() || "unknown error";
    const changeError = new Error(
      `schtasks ${params.enabled ? "enable" : "disable"} failed: ${detail}`,
    );
    if (!params.enabled && params.restoreOnFailure !== false) {
      // A timeout can follow a committed /DISABLE, so restore the proven prior state.
      try {
        await params.beforeMutation?.();
        params.assertCurrent?.();
        const restore = await execSchtasks(["/Change", "/TN", taskName, "/ENABLE"]);
        if (restore.code !== 0) {
          const restoreDetail = (restore.stderr || restore.stdout).trim() || "unknown error";
          throw new Error(`schtasks enable failed: ${restoreDetail}`);
        }
      } catch (restoreError) {
        throw new ScheduledTaskAutoStartRecoveryError(
          [changeError, restoreError],
          `Scheduled Task disable failed and its enabled state could not be restored: ${changeError.message}; ${String(restoreError)}`,
          params.env,
        );
      }
    }
    throw changeError;
  }
  return true;
}

export async function suspendScheduledTaskAutoStartForUpdate(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
  options?: {
    beforeMutation?: () => Promise<void>;
    assertCurrent?: () => void;
    restoreOnFailure?: boolean;
  },
): Promise<boolean> {
  const assertCaller = options?.assertCurrent;
  return withGatewayServiceOperationLock(env, async (assertNative) =>
    changeScheduledTaskEnabledState({
      env,
      enabled: false,
      ...options,
      assertCurrent: () => {
        assertNative();
        assertCaller?.();
      },
    }),
  );
}

export async function resumeScheduledTaskAutoStartAfterUpdate(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
  options?: { beforeMutation?: () => Promise<void>; assertCurrent?: () => void },
): Promise<boolean> {
  const assertCaller = options?.assertCurrent;
  return withGatewayServiceOperationLock(env, async (assertNative) =>
    changeScheduledTaskEnabledState({
      env,
      enabled: true,
      ...options,
      assertCurrent: () => {
        assertNative();
        assertCaller?.();
      },
    }),
  );
}

async function shouldControlStartupEntry(env: GatewayServiceEnv): Promise<boolean> {
  try {
    await assertSchtasksAvailable();
  } catch (err) {
    if (!(await isStartupEntryInstalled(env))) {
      throw err;
    }
    return true;
  }
  return !(await isRegisteredScheduledTask(env)) && (await isStartupEntryInstalled(env));
}

export async function stopScheduledTask({
  stdout,
  env,
  onMutation,
  assertCurrent,
}: GatewayServiceControlArgs): Promise<void> {
  const effectiveEnv = env ?? (process.env as GatewayServiceEnv);
  const reportMutation = createGatewayLifecycleMutationReporter(onMutation);
  if (await shouldControlStartupEntry(effectiveEnv)) {
    await stopStartupEntry(
      effectiveEnv,
      stdout,
      () => reportMutation("startup-entry-stop"),
      assertCurrent,
    );
    return;
  }
  const taskName = resolveTaskName(effectiveEnv);
  assertCurrent?.();
  const res = await execSchtasks(["/End", "/TN", taskName]);
  if (res.code !== 0 && !isScheduledTaskDefinitelyNotRunning(taskName)) {
    throw new Error(`schtasks end failed: ${res.stderr || res.stdout}`.trim());
  }
  reportMutation("schtasks-stop");
  const manageGatewayPort = shouldManageGatewayListenerPort(effectiveEnv);
  const stopContext = manageGatewayPort
    ? await resolveScheduledTaskGatewayContext(effectiveEnv)
    : null;
  const stopPort = stopContext?.port ?? null;
  if (manageGatewayPort) {
    await terminateScheduledTaskGatewayListeners(
      effectiveEnv,
      stopContext ?? undefined,
      assertCurrent,
    );
  } else {
    await terminateScheduledTaskNodeHost(effectiveEnv, assertCurrent);
  }
  await terminateInstalledStartupRuntime(effectiveEnv, assertCurrent);
  if (stopPort) {
    const probeHosts = stopContext?.probeHosts ?? [];
    const released = await waitForGatewayPortRelease(stopPort, 5_000, { probeHosts });
    if (!released) {
      const listenerDetails = await describeUnverifiedPortListeners(stopPort, probeHosts);
      throw new Error(
        `gateway port ${stopPort} is still busy after stop; remaining listener ownership could not be verified.${listenerDetails}`,
      );
    }
  }
  stdout.write(`${formatLine("Stopped Scheduled Task", taskName)}\n`);
}

export async function startScheduledTask({
  stdout,
  env,
  onMutation,
  assertCurrent,
  preserveAutoStart,
}: GatewayServiceControlArgs): Promise<void> {
  const effectiveEnv = env ?? (process.env as GatewayServiceEnv);
  const reportMutation = createGatewayLifecycleMutationReporter(onMutation);
  if (await shouldControlStartupEntry(effectiveEnv)) {
    if (preserveAutoStart) {
      throw new Error(
        "Captured Scheduled Task registration is unavailable; refusing login-item fallback.",
      );
    }
    await startStartupEntry(
      effectiveEnv,
      stdout,
      () => reportMutation("startup-entry-start"),
      assertCurrent,
    );
    return;
  }
  const taskName = resolveTaskName(effectiveEnv);
  await runScheduledTaskOrThrow({
    taskName,
    assertCurrent,
    allowFallback: preserveAutoStart !== true,
    env: effectiveEnv,
    scriptPath: resolveTaskScriptPath(effectiveEnv),
    onMutation: () => reportMutation("schtasks-start"),
  });
  stdout.write(`${formatLine("Started Scheduled Task", taskName)}\n`);
}

export async function restartRegisteredScheduledTask(params: {
  preserveDefinition?: boolean;
  env: GatewayServiceEnv;
  stdout: NodeJS.WritableStream;
  mode: { kind: "standard" } | { kind: "fallback-takeover" };
  onEndMutation?: () => void;
  onRunMutation?: () => void;
  assertCurrent?: () => void;
}): Promise<GatewayServiceRestartResult> {
  const taskName = resolveTaskName(params.env);
  params.assertCurrent?.();
  const end = await execSchtasks(["/End", "/TN", taskName]);
  if (end.code === 0) {
    params.onEndMutation?.();
  }
  const manageGatewayPort = shouldManageGatewayListenerPort(params.env);
  const restartContext = manageGatewayPort
    ? await resolveScheduledTaskGatewayContext(params.env)
    : null;
  const restartPort = restartContext?.port ?? null;
  if (params.mode.kind === "standard") {
    if (manageGatewayPort) {
      await terminateScheduledTaskGatewayListeners(
        params.env,
        restartContext ?? undefined,
        params.assertCurrent,
      );
    } else {
      await terminateScheduledTaskNodeHost(params.env, params.assertCurrent);
    }
    await terminateInstalledStartupRuntime(params.env, params.assertCurrent);
  } else {
    const replacementRuntime = await resolveFallbackRuntime(params.env, undefined, "control");
    if (replacementRuntime.status === "unknown") {
      throw new Error(
        replacementRuntime.detail ??
          "Could not verify the replacement Windows Scheduled Task process.",
      );
    }
    if (replacementRuntime.status === "running" && replacementRuntime.pid) {
      await terminateGatewayProcessTree(replacementRuntime.pid, 300, params.assertCurrent);
    }
  }
  if (restartPort) {
    const probeHosts = restartContext?.probeHosts ?? [];
    const released = await waitForGatewayPortRelease(restartPort, 5_000, { probeHosts });
    if (!released) {
      if (params.mode.kind === "fallback-takeover") {
        throw new Error(
          `replacement gateway port ${restartPort} is occupied by an unverified process`,
        );
      }
      const listenerDetails = await describeUnverifiedPortListeners(restartPort, probeHosts);
      throw new Error(
        `gateway port ${restartPort} is still busy before restart; remaining listener ownership could not be verified.${listenerDetails}`,
      );
    }
  }
  const activation = await runScheduledTaskOrThrow({
    taskName,
    assertCurrent: params.assertCurrent,
    env: params.env,
    scriptPath: resolveTaskScriptPath(params.env),
    ...(params.onRunMutation ? { onMutation: params.onRunMutation } : {}),
  });
  // A direct launch is the replacement fallback; keep it available at the next login.
  const shouldRemoveStartup =
    activation === "scheduled-task" &&
    !params.preserveDefinition &&
    (await isStartupEntryInstalled(params.env));
  if (
    activation === "scheduled-task" &&
    (params.mode.kind === "fallback-takeover" || shouldRemoveStartup)
  ) {
    // Captured takeover owns the settling wait even if Startup vanished or its profile changed.
    const hasRunningEvidence = await waitForScheduledTaskRunningEvidence(params.env);
    if (params.mode.kind === "fallback-takeover" && !hasRunningEvidence) {
      params.assertCurrent?.();
      await execSchtasks(["/End", "/TN", taskName]);
      const failedRuntime = await resolveFallbackRuntime(params.env, undefined, "control").catch(
        () => null,
      );
      if (failedRuntime?.status === "running" && failedRuntime.pid) {
        await terminateGatewayProcessTree(failedRuntime.pid, 300, params.assertCurrent);
      }
      throw new Error("Replacement Windows Scheduled Task did not produce running evidence.");
    }
    if (shouldRemoveStartup && hasRunningEvidence) {
      await removeStartupEntries(params.env, params.stdout, params.assertCurrent);
    }
  }
  params.stdout.write(`${formatLine("Restarted Scheduled Task", taskName)}\n`);
  return { outcome: "completed" };
}

export async function restartScheduledTask({
  preserveDefinition,
  stdout,
  env,
  onMutation,
  assertCurrent,
}: GatewayServiceControlArgs): Promise<GatewayServiceRestartResult> {
  const effectiveEnv = env ?? (process.env as GatewayServiceEnv);
  const reportMutation = createGatewayLifecycleMutationReporter(onMutation);
  if (await shouldControlStartupEntry(effectiveEnv)) {
    return restartStartupEntry(
      effectiveEnv,
      stdout,
      (kind) => reportMutation(kind === "stop" ? "startup-entry-stop" : "startup-entry-restart"),
      assertCurrent,
    );
  }
  return restartRegisteredScheduledTask({
    preserveDefinition,
    assertCurrent,
    env: effectiveEnv,
    stdout,
    mode: { kind: "standard" },
    onEndMutation: () => reportMutation("schtasks-end"),
    onRunMutation: () => reportMutation("schtasks-restart"),
  });
}
