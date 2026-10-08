import { DEFAULT_RESTART_HEALTH_DELAY_MS } from "../cli/daemon-cli/restart-health.constants.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import { sleep } from "../utils/sleep.js";
import { resolveGatewayServiceProbeHosts } from "./gateway-service-probe-hosts.js";
import { assertDaemonRuntimePinDefinition } from "./runtime-pin-state.js";
import { readScheduledTaskCommand } from "./schtasks-layout.js";
import {
  findInstalledProcessPid,
  readWindowsProcessSnapshot,
} from "./schtasks-process-snapshot.js";
import {
  resolveScheduledTaskCommandPort,
  shouldManageGatewayListenerPort,
  terminateScheduledTaskGatewayListeners,
} from "./schtasks-process.js";
import { launchFallbackTaskScript, resolveFallbackRuntime } from "./schtasks-runtime.js";
import { mergeGatewayServiceEnv } from "./service-env-merge.js";
import type { GatewayServiceDefinitionTransactionHooks } from "./service-stage.js";
import type { GatewayServiceCommandConfig, GatewayServiceEnv } from "./service-types.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";
import { getWindowsServiceRegistrationKind } from "./windows-service-registration.js";

// Matches the desktop receipt's cold Windows startup allowance.
const WINDOWS_REGISTRATION_READINESS_MS = 600_000;

export async function assertReplacementPortAvailableForTakeover(params: {
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

type RegistrationContext = {
  env: GatewayServiceEnv;
  command: GatewayServiceCommandConfig;
  transaction: GatewayServiceDefinitionTransactionHooks;
  assertCurrent?: () => void;
};

function assertCurrent(context: RegistrationContext) {
  assertGatewayServiceUpdateCurrent();
  context.transaction.assertCurrent();
  context.assertCurrent?.();
}

async function beforeMutation(context: RegistrationContext) {
  assertCurrent(context);
  await context.transaction.beforeWrite();
  assertCurrent(context);
}

async function readSelectedCommand(context: RegistrationContext) {
  await beforeMutation(context);
  const command = await readScheduledTaskCommand(context.env, {
    requireEffective: true,
    requireLoaded: true,
  });
  assertCurrent(context);
  if (
    !command ||
    getWindowsServiceRegistrationKind(command) !==
      (context.transaction.windowsRegistration ?? "scheduled-task")
  ) {
    throw new Error("Windows service registration changed during replacement.");
  }
  return command;
}

async function inspectRuntime(context: RegistrationContext, allowPending = false) {
  const command = await readSelectedCommand(context);
  assertDaemonRuntimePinDefinition(context.command, command);
  const runtime = await resolveFallbackRuntime(context.env, command, "control");
  await beforeMutation(context);
  if (
    !allowPending &&
    (runtime.status === "unknown" || (runtime.status === "running" && !runtime.pid))
  ) {
    throw new Error("Windows service process ownership could not be verified.");
  }
  return runtime;
}

/** The native command and process must still be ours on both sides of HTTP readiness. */
export async function verifyWindowsRegistrationReadiness(context: RegistrationContext) {
  const deadlineAt = Date.now() + WINDOWS_REGISTRATION_READINESS_MS;
  const gateway = shouldManageGatewayListenerPort(context.env);
  const port = resolveScheduledTaskCommandPort(context.env, context.command);
  if (gateway && !port) {
    throw new Error("Windows Gateway readiness port is unavailable.");
  }
  const { createConfigIO } = await import("../config/io.runtime.js");
  const { waitForGatewayHttpReadiness } = await import("../cli/daemon-cli/restart-health-probe.js");
  const config = await createConfigIO({
    env: mergeGatewayServiceEnv(context.env, context.command),
    pluginValidation: "skip",
    suppressFutureVersionWarning: true,
  }).readBestEffortConfig();
  let readiness: { healthz: number | null; readyz: number | null } = {
    healthz: null,
    readyz: null,
  };
  while (Date.now() < deadlineAt) {
    // Cold Startup processes can precede their listener or a usable CIM observation.
    const initial = await inspectRuntime(context, true);
    if (gateway && port) {
      readiness = await waitForGatewayHttpReadiness({
        config,
        port,
        attempts: 1,
        deadlineAt,
        delayMs: DEFAULT_RESTART_HEALTH_DELAY_MS,
        onObservation: () => assertCurrent(context),
      });
    }
    assertCurrent(context);
    if (
      (!gateway || (readiness.healthz === 200 && readiness.readyz === 200)) &&
      initial.status === "running" &&
      initial.pid
    ) {
      const final = await inspectRuntime(context, true);
      if (final.status === "running" && final.pid === initial.pid && Date.now() < deadlineAt) {
        return;
      }
    }
    const remaining = deadlineAt - Date.now();
    if (remaining > 0) {
      await sleep(Math.min(DEFAULT_RESTART_HEALTH_DELAY_MS, remaining));
    }
  }
  throw new Error(
    `Windows service readiness could not be verified: /healthz=${readiness.healthz ?? "unreachable"}; /readyz=${readiness.readyz ?? "unreachable"}.`,
  );
}

async function settleStartupRuntime(context: RegistrationContext): Promise<boolean> {
  await inspectRuntime(context);
  const stopped = await terminateScheduledTaskGatewayListeners(
    context.env,
    undefined,
    () => assertCurrent(context),
    undefined,
    () => beforeMutation(context),
  );
  if (stopped === null || (await inspectRuntime(context)).status !== "stopped") {
    throw new Error("Windows Startup process did not settle before replacement.");
  }
  return stopped.length > 0;
}

/** Startup keeps its registration bytes; the caller owns the one file transaction. */
export async function captureStartupRegistrationTransition(params: {
  previous: RegistrationContext;
  candidate: RegistrationContext;
}) {
  const { previous, candidate } = params;
  const registerRecovery = candidate.transaction.registerNativeRecovery;
  if (candidate.transaction.windowsRegistration !== "startup" || !registerRecovery) {
    throw new Error("Startup replacement requires captured native recovery.");
  }
  let restartPrevious = (await inspectRuntime(previous)).status === "running";
  let stoppingStarted = false;
  let originalSettled = false;
  let activationAttempted = false;
  registerRecovery(async (restoreDefinition) => {
    if (originalSettled) {
      const current = await readSelectedCommand(candidate);
      try {
        assertDaemonRuntimePinDefinition(candidate.command, current);
      } catch {
        assertDaemonRuntimePinDefinition(previous.command, current);
      }
      // A preserved Startup entry can launch during publication even before our explicit spawn.
      await settleStartupRuntime({ ...candidate, command: current });
    }
    const restored = await restoreDefinition();
    const runtime = await inspectRuntime(previous);
    if (restartPrevious && stoppingStarted) {
      if (runtime.status !== "running") {
        await launchFallbackTaskScript(
          previous.env,
          previous.command,
          () => assertCurrent(previous),
          previous.transaction,
        );
      }
      await verifyWindowsRegistrationReadiness(previous);
    } else if (originalSettled && runtime.status !== "stopped") {
      throw new Error("Previously stopped Windows Startup process changed during recovery.");
    }
    return restored || activationAttempted || (stoppingStarted && restartPrevious);
  });
  return {
    beforePublish: async () => {
      await beforeMutation(previous);
      stoppingStarted = true;
      restartPrevious = (await settleStartupRuntime(previous)) || restartPrevious;
      originalSettled = true;
    },
    activate: async () => {
      await beforeMutation(candidate);
      activationAttempted = true;
      await launchFallbackTaskScript(
        candidate.env,
        candidate.command,
        () => assertCurrent(candidate),
        candidate.transaction,
      );
    },
  };
}
