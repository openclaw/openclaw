import fs from "node:fs/promises";
import path from "node:path";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { classifyOpenClawArgv } from "../infra/gateway-process-argv.js";
import { sleep } from "../utils.js";
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
  findInstalledProcessPid,
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
  readScheduledTaskRuntime,
  removeStartupEntries,
  resolveFallbackRuntime,
  restartStartupEntry,
  startStartupEntry,
  stopStartupEntry,
  SCHEDULED_TASK_FALLBACK_POLL_MS,
  SCHEDULED_TASK_FALLBACK_TIMEOUT_MS,
  terminateInstalledStartupRuntime,
  waitForScheduledTaskRunningEvidence,
} from "./schtasks-runtime.js";
import { probeScheduledTaskExists, type ScheduledTaskSettlement } from "./schtasks-state-probe.js";
import { ScheduledTaskAutoStartRecoveryError } from "./schtasks-update-recovery.js";
import { createGatewayLifecycleMutationReporter } from "./service-mutation.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import type {
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceRestartResult,
} from "./service-types.js";

type ScheduledTaskRestartResult = GatewayServiceRestartResult & {
  taskSettlement?: ScheduledTaskSettlement;
  restartRecovery?: "sqlite-owner-read";
};
export type ScheduledTaskActivation = "scheduled-task" | "direct-fallback";

function runtimeSignature(runtime: Awaited<ReturnType<typeof readScheduledTaskRuntime>> | null) {
  return [runtime?.state, runtime?.lastRunTime, runtime?.lastRunResult, runtime?.detail]
    .filter(Boolean)
    .join("|");
}

async function shouldFallbackScheduledTaskLaunch(params: {
  env: GatewayServiceEnv;
  scriptPath: string;
}): Promise<boolean> {
  const readLaunchObservation = async (
    timeoutMs?: number,
  ): Promise<{
    state: "running" | "not-yet-run" | "stopped-success" | "other";
    signature: string;
  }> => {
    const runtime = await readScheduledTaskRuntime(params.env, { timeoutMs }).catch(() => null);
    if (runtime?.status === "running") {
      return { state: "running", signature: runtimeSignature(runtime) };
    }
    if (runtime?.status !== "stopped") {
      return { state: "other", signature: runtimeSignature(runtime) };
    }
    // SCHED_S_TASK_HAS_NOT_RUN is history, and only a stopped task is a fallback candidate.
    if (runtime.lastRunResult === "267011") {
      return { state: "not-yet-run", signature: runtimeSignature(runtime) };
    }
    return runtime.lastRunResult === "0"
      ? { state: "stopped-success", signature: runtimeSignature(runtime) }
      : { state: "other", signature: runtimeSignature(runtime) };
  };

  const hasLaunchEvidence = async (): Promise<boolean> => {
    const command = await readScheduledTaskCommand(params.env).catch(() => null);
    const installedArguments = command?.programArguments;
    const taskPort = resolveScheduledTaskCommandPort(params.env, command);
    const manageGatewayPort = shouldManageGatewayListenerPort(params.env);
    if (manageGatewayPort && taskPort) {
      const probeHosts = await resolveGatewayServiceProbeHosts({ env: params.env, command });
      const ownedPids = await resolveScheduledTaskOwnedGatewayPids(
        params.env,
        { port: taskPort, probeHosts },
        command,
      );
      if (ownedPids.length > 0) {
        return true;
      }
    }

    const scriptPathNeedle = normalizeLowercaseStringOrEmpty(
      params.scriptPath.replaceAll("/", "\\"),
    );
    if (!scriptPathNeedle) {
      return false;
    }
    const entries = readWindowsProcessSnapshot();
    if (!entries) {
      return false;
    }
    if (
      entries.some((entry) =>
        normalizeLowercaseStringOrEmpty(entry.CommandLine ?? "")
          .replaceAll("/", "\\")
          .includes(scriptPathNeedle),
      )
    ) {
      return true;
    }
    if (!taskPort) {
      return false;
    }
    if (!installedArguments?.length) {
      return false;
    }
    return (
      findInstalledProcessPid(
        entries,
        taskPort,
        installedArguments,
        manageGatewayPort
          ? (argv) => classifyOpenClawArgv(argv, { command: "gateway" }).kind === "openclaw"
          : isNodeHostArgv,
      ) != null
    );
  };

  let previous = await readLaunchObservation();
  if (previous.state !== "not-yet-run" && previous.state !== "stopped-success") {
    return false;
  }
  const deadline = Date.now() + SCHEDULED_TASK_FALLBACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(SCHEDULED_TASK_FALLBACK_POLL_MS);
    // Periodic observations keep their existing short budget after the initial cold read.
    const current = await readLaunchObservation(5_000);
    if (current.state !== "not-yet-run" && current.state !== "stopped-success") {
      return false;
    }
    if (
      current.state === "not-yet-run" &&
      previous.state === "not-yet-run" &&
      current.signature !== previous.signature
    ) {
      return false;
    }
    // A queued task may finish before its process is observable; the reverse transition means a new run is starting.
    if (previous.state === "stopped-success" && current.state === "not-yet-run") {
      return false;
    }
    previous = current;
    if (await hasLaunchEvidence()) {
      return false;
    }
  }
  return true;
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
  const run = await execSchtasks(["/Run", "/TN", params.taskName]);
  if (run.code !== 0) {
    throw new Error(`schtasks run failed: ${run.stderr || run.stdout}`.trim());
  }
  params.onMutation?.();
  if (
    !(await shouldFallbackScheduledTaskLaunch({ env: params.env, scriptPath: params.scriptPath }))
  ) {
    return "scheduled-task";
  }
  if (params.allowFallback !== false && !shouldManageGatewayListenerPort(params.env)) {
    await launchFallbackTaskScript(params.env, undefined, params.assertCurrent);
    return "direct-fallback";
  }
  throw new Error(
    `Scheduled Task ${params.taskName} did not start within ${SCHEDULED_TASK_FALLBACK_TIMEOUT_MS / 1000}s after schtasks /Run; refusing a direct fallback because the queued task could still start.`,
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

export async function stopScheduledTask(params: GatewayServiceControlArgs): Promise<void> {
  const env = params.env ?? (process.env as GatewayServiceEnv);
  const reportMutation = createGatewayLifecycleMutationReporter(params.onMutation);
  if (await shouldControlStartupEntry(env)) {
    await stopStartupEntry(
      env,
      params.stdout,
      () => reportMutation("startup-entry-stop"),
      params.assertCurrent,
    );
    return;
  }
  const replaced = await stopRegisteredScheduledTask({
    ...params,
    env,
    onEndMutation: () => reportMutation("schtasks-stop"),
  });
  params.stdout.write(
    `${formatLine(replaced ? "Preserved replacement Gateway" : "Stopped Scheduled Task", resolveTaskName(env))}\n`,
  );
}

async function stopRegisteredScheduledTask({
  env,
  stdout,
  assertCurrent,
  warn,
  onEndMutation,
  restart = false,
  onSettlement,
  onRecovery,
}: GatewayServiceControlArgs & {
  env: GatewayServiceEnv;
  onEndMutation?: () => void;
  restart?: boolean;
  onSettlement?: (fact: ScheduledTaskSettlement) => void;
  onRecovery?: () => void;
}): Promise<boolean> {
  const taskName = resolveTaskName(env);
  const manageGatewayPort = shouldManageGatewayListenerPort(env);
  const stopContext = manageGatewayPort ? await resolveScheduledTaskGatewayContext(env) : null;
  const stopPort = stopContext?.port ?? null;
  const terminated = await terminateScheduledTaskGatewayListeners(
    env,
    stopContext ?? undefined,
    assertCurrent,
    {
      warn: warn ?? ((message) => stdout.write(`Warning: ${message}\n`)),
      onStopped: onEndMutation,
      restart,
      onSettlement,
      onRecovery,
      end: async () => {
        assertCurrent?.();
        const res = await execSchtasks(["/End", "/TN", taskName]);
        if (!restart && res.code !== 0 && !isScheduledTaskDefinitelyNotRunning(taskName)) {
          throw new Error(`schtasks end failed: ${res.stderr || res.stdout}`.trim());
        }
        if (!restart || res.code === 0) {
          onEndMutation?.();
        }
      },
    },
  );
  if (!manageGatewayPort) {
    await terminateScheduledTaskNodeHost(env, assertCurrent);
    await terminateInstalledStartupRuntime(env, assertCurrent);
  }
  if (terminated !== null && stopPort) {
    const probeHosts = stopContext?.probeHosts ?? [];
    if (!(await waitForGatewayPortRelease(stopPort, 5_000, { probeHosts }))) {
      const listenerDetails = await describeUnverifiedPortListeners(stopPort, probeHosts);
      throw new Error(
        `gateway port ${stopPort} is still busy ${restart ? "before restart" : "after stop"}; remaining listener ownership could not be verified.${listenerDetails}`,
      );
    }
  }
  return terminated === null;
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
  warn?: (message: string) => void;
}): Promise<ScheduledTaskRestartResult> {
  const facts: Pick<ScheduledTaskRestartResult, "taskSettlement" | "restartRecovery"> = {};
  const taskName = resolveTaskName(params.env);
  if (params.mode.kind === "standard") {
    if (
      await stopRegisteredScheduledTask({
        ...params,
        restart: true,
        onSettlement: (fact) => (facts.taskSettlement = fact),
        onRecovery: () => (facts.restartRecovery = "sqlite-owner-read"),
      })
    ) {
      throw Object.assign(new Error("Gateway ownership changed; restart unverified."), facts);
    }
  } else {
    const { port, probeHosts } = shouldManageGatewayListenerPort(params.env)
      ? await resolveScheduledTaskGatewayContext(params.env)
      : { port: null, probeHosts: [] };
    params.assertCurrent?.();
    const end = await execSchtasks(["/End", "/TN", taskName]);
    if (end.code === 0) {
      params.onEndMutation?.();
    }
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
    if (port && !(await waitForGatewayPortRelease(port, 5_000, { probeHosts }))) {
      throw new Error(`replacement gateway port ${port} is occupied by an unverified process`);
    }
  }
  const activation = await runScheduledTaskOrThrow({
    taskName,
    assertCurrent: params.assertCurrent,
    env: params.env,
    scriptPath: resolveTaskScriptPath(params.env),
    ...(params.onRunMutation ? { onMutation: params.onRunMutation } : {}),
  }).catch((error: unknown) => {
    throw Object.assign(toErrorObject(error, "Scheduled Task restart failed."), facts);
  });
  if (facts.taskSettlement?.status === "unavailable") {
    throw Object.assign(
      new Error("/Run accepted; restart unverified: task settlement unavailable."),
      facts,
    );
  }
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
  return { outcome: "completed", ...facts };
}

export async function restartScheduledTask({
  preserveDefinition,
  stdout,
  env,
  onMutation,
  assertCurrent,
  warn,
}: GatewayServiceControlArgs): Promise<ScheduledTaskRestartResult> {
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
    warn,
    preserveDefinition,
    assertCurrent,
    env: effectiveEnv,
    stdout,
    mode: { kind: "standard" },
    onEndMutation: () => reportMutation("schtasks-end"),
    onRunMutation: () => reportMutation("schtasks-restart"),
  });
}
