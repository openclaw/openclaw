/** Shared native service-state inspection with one caller-owned deadline and binding. */
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { resolveGatewayProfileSuffix } from "./constants.js";
import { mergeGatewayServiceEnv } from "./service-env-merge.js";
import {
  ServiceInspectionError,
  ServiceOwnershipRefusalError,
  findServiceOwnershipRefusal,
} from "./service-inspection-error.js";
import { readGatewayServiceLoadState } from "./service-load-state.js";
import { withSystemdServiceReadBinding } from "./service-operation-lock.js";
import { createServiceRuntimeInspectionFailure } from "./service-runtime.js";
import type {
  GatewayService,
  GatewayServiceCommandInspection,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceLoadState,
  GatewayServiceReadOptions,
  GatewayServiceState,
} from "./service-types.js";
import { getGatewayServiceUpdateNativeCommand } from "./service-update-authority.js";
import { admitSystemdServiceReadBinding } from "./systemd-peer.js";
import { findSystemdGatewayInstallation } from "./systemd-scope.js";
import { readSystemdServiceExecStart } from "./systemd.js";

type ReadGatewayServiceStateArgs = GatewayServiceEnvArgs & {
  systemdReadTarget?: GatewayServiceReadOptions["systemdReadTarget"];
  systemdInstallation?: GatewayServiceState["systemdInstallation"];
  requireEffective?: boolean;
  requireLoadedCommand?: boolean;
  loadForInspection?: GatewayServiceReadOptions["loadForInspection"];
  systemdReadBinding?: GatewayServiceReadOptions["systemdReadBinding"];
  validateEnvBeforeStatusRead?: (env: GatewayServiceEnv) => void;
};

class ServiceInspectionDeadlineError extends Error {
  constructor() {
    super("Service inspection deadline expired.");
  }
}

function deadlineLoadState(error: ServiceInspectionDeadlineError): GatewayServiceLoadState {
  return { status: "unknown", detail: String(error) };
}

/** Expired observations remain diagnostic, never positive liveness or absence evidence. */
function deadlineDiagnosticState(
  state: GatewayServiceState,
  error: ServiceInspectionDeadlineError,
): GatewayServiceState {
  const runtime =
    state.runtime?.status === "unknown"
      ? state.runtime
      : createServiceRuntimeInspectionFailure(error);
  return {
    ...state,
    loadState: state.loadState.status === "unknown" ? state.loadState : deadlineLoadState(error),
    running: false,
    runtime: runtime.missingUnit ? { ...runtime, missingUnit: false } : runtime,
  };
}

export async function readGatewayServiceState(
  service: GatewayService,
  input: ReadGatewayServiceStateArgs = {},
): Promise<GatewayServiceState> {
  const timeoutMs =
    input.timeoutMs ?? (service.readCommand === readSystemdServiceExecStart ? 5000 : undefined);
  const inspectionDeadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
  let args = { ...input, timeoutMs };
  const baseEnv = args.env ?? process.env;
  const supplied = args.systemdInstallation;
  const selected = supplied?.kind === "system" || supplied?.kind === "user" ? supplied : undefined;
  try {
    if (
      !args.systemdReadTarget &&
      (selected || service.readCommand === readSystemdServiceExecStart)
    ) {
      if (inspectionDeadline !== undefined && performance.now() >= inspectionDeadline) {
        throw new ServiceInspectionDeadlineError();
      }
      const installation =
        selected ??
        (await findSystemdGatewayInstallation(baseEnv, {
          requireLoaded: args.requireLoadedCommand,
          loadForInspection: args.loadForInspection,
          timeoutMs:
            inspectionDeadline === undefined ? undefined : inspectionDeadline - performance.now(),
        }));
      if (installation.kind === "dueling" && args.requireEffective && args.requireLoadedCommand) {
        throw new ServiceOwnershipRefusalError("systemd-competing-managers");
      }
      const target =
        installation.kind === "system"
          ? installation.system
          : installation.kind === "user" || installation.kind === "dueling"
            ? installation.user
            : undefined;
      args = { ...args, systemdInstallation: installation, systemdReadTarget: target };
    }
    if (inspectionDeadline !== undefined && performance.now() >= inspectionDeadline) {
      throw new ServiceInspectionDeadlineError();
    }
    if (
      service.readCommand === readSystemdServiceExecStart &&
      args.systemdReadTarget?.scope !== "system" &&
      args.requireEffective &&
      args.requireLoadedCommand &&
      !args.systemdReadBinding
    ) {
      const deadline = inspectionDeadline ?? performance.now() + 5000;
      return await withSystemdServiceReadBinding(
        baseEnv,
        () => admitSystemdServiceReadBinding(baseEnv, deadline, args.systemdReadTarget?.unitName),
        (binding) => {
          const remaining = deadline - performance.now();
          if (remaining <= 0) {
            throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
          }
          return readGatewayServiceStateWithBinding(
            service,
            { ...args, systemdReadBinding: binding, timeoutMs: remaining },
            deadline,
          );
        },
        deadline,
      );
    }
    return await readGatewayServiceStateWithBinding(service, args, inspectionDeadline);
  } catch (error) {
    if (args.requireEffective || !(error instanceof ServiceInspectionDeadlineError)) {
      throw error;
    }
    return deadlineDiagnosticState(
      {
        ...(args.systemdInstallation ? { systemdInstallation: args.systemdInstallation } : {}),
        installed: false,
        loadState: deadlineLoadState(error),
        running: false,
        env: baseEnv,
        command: null,
      },
      error,
    );
  }
}

async function readGatewayServiceStateWithBinding(
  service: GatewayService,
  args: ReadGatewayServiceStateArgs,
  deadline = performance.now() + 5000,
): Promise<GatewayServiceState> {
  const baseEnv = args.env ?? process.env;
  const { timeoutMs, systemdReadBinding, systemdReadTarget } = args;
  const remainingTimeoutMs = () => {
    if (timeoutMs === undefined) {
      return undefined;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new ServiceInspectionDeadlineError();
    }
    return remaining;
  };
  const readDiagnostic = async <T>(
    read: () => Promise<T>,
    onDeadline: (error: ServiceInspectionDeadlineError) => T,
  ): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      if (!args.requireEffective && error instanceof ServiceInspectionDeadlineError) {
        return onDeadline(error);
      }
      throw error;
    }
  };
  systemdReadBinding?.verify();
  let absent = systemdReadTarget
    ? false
    : await service
        .isAbsent?.({ env: baseEnv, timeoutMs: remainingTimeoutMs() })
        .catch((error: unknown) => {
          if (hasCommandProcessCleanupError(error)) {
            throw error;
          }
          const refusal = findServiceOwnershipRefusal(error);
          if (refusal) {
            throw refusal;
          }
          return false;
        });
  // Initial systemd absence proves no manager; strict absence below only proves no unit.
  const managerAbsent = absent && service.readCommand === readSystemdServiceExecStart;
  systemdReadBinding?.verify();
  let commandInspection: GatewayServiceCommandInspection | undefined;
  const command = absent
    ? null
    : args.requireEffective
      ? await service.readCommand(baseEnv, {
          timeoutMs: remainingTimeoutMs(),
          requireEffective: true,
          ...(!args.requireLoadedCommand
            ? {
                onCommandInspection: (inspection: GatewayServiceCommandInspection) => {
                  commandInspection = inspection;
                },
              }
            : {}),
          ...(systemdReadBinding ? { systemdReadBinding } : {}),
          ...(systemdReadTarget ? { systemdReadTarget } : {}),
          ...(args.requireLoadedCommand ? { requireLoaded: true } : {}),
          ...(args.loadForInspection ? { loadForInspection: args.loadForInspection } : {}),
        })
      : await service
          .readCommand(baseEnv, {
            timeoutMs: remainingTimeoutMs(),
            ...(systemdReadTarget ? { systemdReadTarget } : {}),
            onCommandInspection: (inspection) => {
              commandInspection = inspection;
            },
          })
          .catch((error: unknown) => {
            if (hasCommandProcessCleanupError(error)) {
              throw error;
            }
            const refusal = findServiceOwnershipRefusal(error);
            if (refusal) {
              throw refusal;
            }
            return null;
          });
  const mergedEnv = mergeGatewayServiceEnv(
    systemdReadTarget?.scope === "system" && !resolveGatewayProfileSuffix(baseEnv.OPENCLAW_PROFILE)
      ? { ...baseEnv, OPENCLAW_SYSTEMD_UNIT: systemdReadTarget.unitName }
      : baseEnv,
    command,
  );
  const env =
    process.platform === "win32" && args.requireLoadedCommand && command?.sourcePath
      ? { ...mergedEnv, OPENCLAW_TASK_SCRIPT: command.sourcePath }
      : mergedEnv;
  // Reject persisted selector drift before invoking the native service manager.
  args.validateEnvBeforeStatusRead?.(env);
  // Strict user-unit absence still needs the platform owner's system-scope proof.
  if (
    !absent &&
    service.isAbsent &&
    args.requireEffective &&
    args.requireLoadedCommand &&
    command === null
  ) {
    systemdReadBinding?.verify();
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
    }
    absent = await service
      .isAbsent({ env, timeoutMs: remaining, strictCommandAbsent: true })
      .catch((error: unknown) => {
        if (hasCommandProcessCleanupError(error)) {
          throw error;
        }
        const refusal = findServiceOwnershipRefusal(error);
        if (refusal) {
          throw refusal;
        }
        return false;
      });
    systemdReadBinding?.verify();
    if (performance.now() >= deadline) {
      throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
    }
  }
  if (absent) {
    remainingTimeoutMs();
    const inspectionReason = managerAbsent ? "service-manager-unavailable" : undefined;
    return {
      inspectionReason,
      installed: false,
      loadState: { status: "not-loaded" },
      running: false,
      env,
      command: null,
      runtime: { status: "stopped", missingUnit: true, inspectionReason },
    };
  }
  const statusBaseEnv = systemdReadBinding ? baseEnv : env;
  // Reuse the selected unit for native status without changing the installation's selectors.
  const statusEnv = systemdReadTarget
    ? { ...statusBaseEnv, OPENCLAW_SYSTEMD_UNIT: systemdReadTarget.unitName }
    : statusBaseEnv;
  const readInstalled = async () =>
    command !== null
      ? true
      : (service
          .hasInstalledDefinition?.({ env: statusEnv, timeoutMs: remainingTimeoutMs() })
          .catch((error: unknown) => {
            // Strict command absence cannot erase a failed installed-definition read.
            if (args.requireEffective || hasCommandProcessCleanupError(error)) {
              throw error;
            }
            const refusal = findServiceOwnershipRefusal(error);
            if (refusal) {
              throw refusal;
            }
            return false;
          }) ?? false);
  const readLoadState = async () =>
    readGatewayServiceLoadState(service, {
      env: statusEnv,
      timeoutMs: remainingTimeoutMs(),
      ...(args.requireEffective ? { requireEffective: true } : {}),
    });
  const readRuntime = async () =>
    service
      .readRuntime(env, {
        timeoutMs: remainingTimeoutMs(),
        ...(args.requireEffective ? { requireEffective: true } : {}),
        ...(systemdReadTarget ? { systemdReadTarget } : {}),
        ...(commandInspection ? { commandInspection } : {}),
        ...(systemdReadBinding ? { systemdReadBinding } : {}),
        ...(args.requireEffective && args.requireLoadedCommand ? { requireLoaded: true } : {}),
        ...(args.loadForInspection ? { loadForInspection: args.loadForInspection } : {}),
      })
      .catch((error: unknown) => createServiceRuntimeInspectionFailure(error));
  // Update policy needs definition authority; ordinary status/start reads do not.
  const readDefinitionCapability = async () =>
    args.requireEffective
      ? service
          .readDefinitionMutationCapability?.({
            env: baseEnv,
            environment: env,
            timeoutMs: remainingTimeoutMs(),
            ...(systemdReadTarget ? { systemdReadTarget } : {}),
            ...(systemdReadBinding ? { systemdReadBinding } : {}),
            ...(args.requireLoadedCommand ? { requireLoaded: true } : {}),
          })
          .catch((error: unknown) => {
            if (hasCommandProcessCleanupError(error)) {
              throw error;
            }
            const refusal = findServiceOwnershipRefusal(error);
            if (refusal) {
              throw refusal;
            }
            return { kind: "unknown", reason: "inspection-failed" } as const;
          })
      : undefined;
  const readParallel = async () => {
    const results = await Promise.allSettled([
      readDiagnostic(readInstalled, () => command !== null),
      readDiagnostic(readLoadState, deadlineLoadState),
      readDiagnostic(readRuntime, createServiceRuntimeInspectionFailure),
      readDefinitionCapability(),
    ] as const);
    // Join every admitted read before leaving its authority scope. An unsettled
    // native child must not be hidden by an earlier ordinary inspection failure.
    for (const result of results) {
      if (result.status === "rejected" && hasCommandProcessCleanupError(result.reason)) {
        throw result.reason;
      }
    }
    for (const result of results) {
      if (result.status === "rejected") {
        const refusal = findServiceOwnershipRefusal(result.reason);
        if (refusal) {
          throw refusal;
        }
      }
    }
    const value = <T>(result: PromiseSettledResult<T>): T => {
      if (result.status === "rejected") {
        throw result.reason;
      }
      return result.value;
    };
    return [value(results[0]), value(results[1]), value(results[2]), value(results[3])] as const;
  };
  // A delegated native child suspends the parent fence. Join each read before
  // another can use the parent's direct native peer; ordinary reads stay parallel.
  const [installed, loadState, runtime, definitionMutationCapability] =
    getGatewayServiceUpdateNativeCommand()
      ? ([
          await readDiagnostic(readInstalled, () => command !== null),
          await readDiagnostic(readLoadState, deadlineLoadState),
          await readDiagnostic(readRuntime, createServiceRuntimeInspectionFailure),
          await readDefinitionCapability(),
        ] as const)
      : await readParallel();
  systemdReadBinding?.verify();
  const state: GatewayServiceState = {
    inspectionReason:
      runtime?.inspectionReason ??
      (loadState.status === "unknown" ? loadState.inspectionReason : undefined),
    ...(args.systemdInstallation ? { systemdInstallation: args.systemdInstallation } : {}),
    installed,
    loadState,
    running: runtime?.status === "running",
    env,
    command,
    ...(definitionMutationCapability ? { definitionMutationCapability } : {}),
    runtime,
  };
  if (timeoutMs !== undefined && performance.now() >= deadline) {
    const error = new ServiceInspectionDeadlineError();
    if (args.requireEffective) {
      throw error;
    }
    return deadlineDiagnosticState(state, error);
  }
  return state;
}
