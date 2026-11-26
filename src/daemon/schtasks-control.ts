import fs from "node:fs/promises";
import path from "node:path";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { getRootOptionAwareCommandPath } from "../infra/cli-root-options.js";
import { classifyOpenClawArgv } from "../infra/gateway-process-argv.js";
import { resolveEnvironmentValue } from "../infra/process-env.js";
import { formatLine } from "./output.js";
import { OPENCLAW_WRAPPER_ENV_KEY, resolveOpenClawWrapperPath } from "./program-args.js";
import { runScheduledTaskOrThrow, type ScheduledTaskActivation } from "./schtasks-activation.js";
import { execScheduledTaskEnabledChange, execSchtasks } from "./schtasks-exec.js";
import {
  readScheduledTaskCommand,
  resolveTaskName,
  resolveTaskScriptPath,
} from "./schtasks-layout.js";
import {
  describeUnverifiedPortListeners,
  waitForGatewayPortRelease,
} from "./schtasks-port-diagnostics.js";
import {
  resolveScheduledTaskGatewayContext,
  shouldManageGatewayListenerPort,
  terminateGatewayProcessTree,
  terminateScheduledTaskGatewayListeners,
  terminateScheduledTaskNodeHost,
} from "./schtasks-process.js";
import {
  assertSchtasksAvailable,
  isRegisteredScheduledTask,
  isScheduledTaskDefinitelyNotRunning,
  isStartupEntryInstalled,
  removeStartupEntries,
  resolveFallbackRuntime,
  restartStartupEntry,
  startStartupEntry,
  stopStartupEntry,
  terminateInstalledStartupRuntime,
  waitForScheduledTaskRunningEvidence,
} from "./schtasks-runtime.js";
import {
  probeScheduledTaskExists,
  probeScheduledTaskState,
  ScheduledTaskInspectionError,
  type ScheduledTaskSettlement,
} from "./schtasks-state-probe.js";
import { ScheduledTaskAutoStartRecoveryError } from "./schtasks-update-recovery.js";
import {
  parseScheduledTaskXmlEnabled,
  setScheduledTaskXmlEnabled,
} from "./schtasks-xml-enabled.js";
import { writeTaskXmlTempFile } from "./schtasks-xml.js";
import { createGatewayLifecycleMutationReporter } from "./service-mutation.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import { fingerprintGatewayServiceDefinition } from "./service-rebind.js";
import type {
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceRestartResult,
} from "./service-types.js";
import { isUpdateOwnedGatewayServiceCommand } from "./service-update-authority.js";

export { runScheduledTaskOrThrow, type ScheduledTaskActivation };
type ScheduledTaskRestartResult = GatewayServiceRestartResult & {
  taskSettlement?: ScheduledTaskSettlement;
  restartRecovery?: "sqlite-owner-read";
};
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
  beforeMutation?: (phase?: "restore") => Promise<void>;
  assertCurrent?: (phase?: "restore") => void;
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

  const action = params.enabled ? "enable" : "disable";
  await params.beforeMutation?.();
  params.assertCurrent?.();
  const result = await execScheduledTaskEnabledChange(taskName, params.enabled);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim() || "unknown error";
    const changeError = new Error(`Scheduled Task ${action} failed: ${detail}`);
    if (result.hresult === -2147024891) {
      throw Object.assign(changeError, { code: "EACCES" });
    }
    if (!params.enabled && params.restoreOnFailure !== false) {
      // A timeout can follow a committed /DISABLE, so restore the proven prior state.
      try {
        await params.beforeMutation?.("restore");
        params.assertCurrent?.("restore");
        const restore = await execScheduledTaskEnabledChange(taskName, true);
        if (restore.code !== 0) {
          const restoreDetail = (restore.stderr || restore.stdout).trim() || "unknown error";
          throw new Error(`Scheduled Task enable failed: ${restoreDetail}`);
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
    beforeMutation?: (phase?: "restore") => Promise<void>;
    assertCurrent?: (phase?: "restore") => void;
    restoreOnFailure?: boolean;
  },
): Promise<boolean> {
  const assertCaller = options?.assertCurrent;
  return withGatewayServiceOperationLock(env, async (assertNative) =>
    changeScheduledTaskEnabledState({
      env,
      enabled: false,
      ...options,
      assertCurrent: (phase) => {
        assertNative();
        assertCaller?.(phase);
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

export async function stopRegisteredScheduledTask({
  env,
  stdout,
  assertCurrent,
  beforeMutation,
  warn,
  onEndMutation,
  onProcessStopped,
  restart = false,
  onSettlement,
  onRecovery,
}: GatewayServiceControlArgs & {
  env: GatewayServiceEnv;
  onEndMutation?: () => void;
  onProcessStopped?: () => void;
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
      beforeMutation,
      restart,
      onSettlement,
      onRecovery,
      end: async () => {
        await beforeMutation?.();
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
  if (terminated?.length) {
    onProcessStopped?.();
  }
  if (!manageGatewayPort) {
    if ((await terminateScheduledTaskNodeHost(env, assertCurrent, beforeMutation)).length) {
      onProcessStopped?.();
    }
    await terminateInstalledStartupRuntime(env, assertCurrent, beforeMutation);
  }
  if (terminated !== null && stopPort) {
    const probeHosts = stopContext?.probeHosts ?? [];
    if (!(await waitForGatewayPortRelease(stopPort, probeHosts))) {
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
  const policy = preserveAutoStart ? null : probeScheduledTaskState(taskName);
  if (policy?.status === "unknown") {
    throw new ScheduledTaskInspectionError(policy);
  }
  if (policy?.status === "missing") {
    throw new Error("Selected Scheduled Task registration is unavailable.");
  }
  if (policy?.status === "found" && policy.enabled === false) {
    const serviceKind = shouldManageGatewayListenerPort(effectiveEnv) ? "gateway" : "node";
    const readSelectedCommand = async () => {
      const paths: string[] = [];
      const command = await readScheduledTaskCommand(effectiveEnv, {
        requireEffective: true,
        requireLoaded: true,
        onLauncherContent: (_content, sourcePath) => paths.push(sourcePath),
      });
      if (!command) {
        throw new Error("Selected Scheduled Task command is unavailable; refusing to enable it.");
      }
      const classified = classifyOpenClawArgv(command.programArguments, {
        command: serviceKind,
        cwd: command.workingDirectory,
        requirePackageIdentity: true,
      });
      if (classified.kind === "openclaw" && classified.packageIdentity) {
        paths.push(
          classified.packageIdentity.entrypoint,
          path.join(classified.packageIdentity.root, "package.json"),
        );
      } else {
        // Installed wrappers carry explicit operator intent in the launcher, not the caller's shell.
        const wrapper = resolveEnvironmentValue(
          command.environment,
          OPENCLAW_WRAPPER_ENV_KEY,
          "win32",
        )?.trim();
        const executable = command.programArguments[0] ?? "";
        const selectedCommand = getRootOptionAwareCommandPath(
          ["node", ...command.programArguments],
          1,
        )[0];
        if (
          !wrapper ||
          !path.win32.isAbsolute(wrapper) ||
          path.win32.parse(wrapper).root.length === 1 ||
          path.win32.normalize(wrapper).toLowerCase() !==
            path.win32.normalize(executable).toLowerCase() ||
          selectedCommand !== serviceKind
        ) {
          throw new Error(
            "Selected Scheduled Task is not the requested OpenClaw service; refusing to enable it.",
          );
        }
        await resolveOpenClawWrapperPath(wrapper);
        paths.push(wrapper);
      }
      // Stronger local start evidence must not change old drivers' serialized command fingerprints.
      return {
        ...command,
        definitionPaths: [...new Set([...(command.definitionPaths ?? []), ...paths])],
      };
    };
    const before = await fingerprintGatewayServiceDefinition(await readSelectedCommand());
    const assertSelected = async () => {
      if ((await fingerprintGatewayServiceDefinition(await readSelectedCommand())) !== before) {
        throw new Error("Selected Scheduled Task command changed before start.");
      }
      assertCurrent?.();
    };
    await changeScheduledTaskEnabledState({
      env: effectiveEnv,
      enabled: true,
      beforeMutation: assertSelected,
      assertCurrent,
    });
    reportMutation("enable");
    await assertSelected();
  }
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
  prepareEffect?: GatewayServiceControlArgs["prepareEffect"];
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
      await terminateGatewayProcessTree(replacementRuntime.pid, params.assertCurrent);
    }
    if (port && !(await waitForGatewayPortRelease(port, probeHosts))) {
      throw new Error(`replacement gateway port ${port} is occupied by an unverified process`);
    }
  }
  const activation = await runScheduledTaskOrThrow({
    taskName,
    assertCurrent: params.assertCurrent,
    prepareEffect: params.prepareEffect,
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
    !params.prepareEffect &&
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
        await terminateGatewayProcessTree(failedRuntime.pid, params.assertCurrent);
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
  prepareEffect,
  updateHandoff,
  warn,
}: GatewayServiceControlArgs): Promise<ScheduledTaskRestartResult> {
  const effectiveEnv = env ?? (process.env as GatewayServiceEnv);
  const reportMutation = createGatewayLifecycleMutationReporter(onMutation);
  const updateOwnsGateway =
    isUpdateOwnedGatewayServiceCommand() && shouldManageGatewayListenerPort(effectiveEnv);
  const prepareActivation = updateOwnsGateway
    ? async () => {
        const state = await import("../state/openclaw-state-db-cache.js");
        await state.joinOpenClawStateDatabaseBorrowers();
        await state.releaseOpenClawStateDatabaseCustody();
        await prepareEffect?.();
      }
    : prepareEffect;
  if (await shouldControlStartupEntry(effectiveEnv)) {
    if (prepareActivation || updateHandoff) {
      throw new Error("Update-owned Scheduled Task restart cannot use the Startup fallback.");
    }
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
    prepareEffect: prepareActivation,
    env: effectiveEnv,
    stdout,
    mode: { kind: "standard" },
    onEndMutation: () => reportMutation("schtasks-end"),
    onRunMutation: () => reportMutation("schtasks-restart"),
  });
}
