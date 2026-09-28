import {
  parseStrictInteger,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "@openclaw/normalization-core/number-coercion";
/** systemd service enabled-state and runtime inspection. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import {
  sanitizeServiceInspectionError,
  ServiceInspectionError,
} from "./service-inspection-error.js";
import {
  createServiceRuntimeInspectionFailure,
  type GatewayServiceRuntime,
} from "./service-runtime.js";
import type {
  GatewayServiceEnv,
  GatewayServiceCommandInspection,
  GatewayServiceEnvArgs,
  GatewayServiceReadOptions,
} from "./service-types.js";
import {
  assertSystemdAvailable,
  execSystemctl,
  execSystemctlUser,
  isSystemctlMissing,
  isSystemdUnitNotEnabled,
  readSystemctlDetail,
  systemdInspectionError,
} from "./systemd-exec.js";
import { readLoadedSystemdServiceRuntime } from "./systemd-loaded-runtime.js";
import { findInstalledSystemdGatewayScope } from "./systemd-scope.js";
import { readSystemdServiceExecStart, resolveSystemdServiceName } from "./systemd-service-files.js";
import { readSystemdUserTransport } from "./systemd-user-transport.js";

function parseSystemdShow(output: string) {
  const entries = parseKeyValueOutput(output, "=");
  return {
    loadState: entries.loadstate || undefined,
    activeState: entries.activestate || undefined,
    subState: entries.substate || undefined,
    mainPid: parseStrictPositiveInteger(entries.mainpid),
    execMainStatus: parseStrictInteger(entries.execmainstatus),
    execMainCode: entries.execmaincode || undefined,
    result: entries.result || undefined,
    nRestarts: parseStrictInteger(entries.nrestarts),
    startLimitBurst: parseStrictInteger(entries.startlimitburst),
    unit: entries.id || undefined,
    killMode: entries.killmode || undefined,
    tasksCurrent: parseStrictNonNegativeInteger(entries.taskscurrent),
    memoryCurrent: parseStrictNonNegativeInteger(entries.memorycurrent),
  };
}

export async function isSystemdServiceEnabled(args: GatewayServiceEnvArgs): Promise<boolean> {
  const env = args.env ?? process.env;
  const installed = await findInstalledSystemdGatewayScope(env, { timeoutMs: args.timeoutMs });
  if (!installed) {
    return false;
  }
  const res =
    installed.scope === "system"
      ? await execSystemctl(["is-enabled", installed.unitName], env, args.timeoutMs)
      : await execSystemctlUser(env, ["is-enabled", installed.unitName], args.timeoutMs);
  if (res.code === 0) {
    return true;
  }
  const detail = readSystemctlDetail(res);
  if (res.termination === "exit" && !isSystemctlMissing(res) && isSystemdUnitNotEnabled(detail)) {
    return false;
  }
  throw systemdInspectionError(
    res,
    `systemctl is-enabled unavailable: ${detail || "unknown error"}`.trim(),
    installed.scope,
  );
}

export async function readSystemdServiceRuntime(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
  opts?: GatewayServiceReadOptions,
): Promise<GatewayServiceRuntime> {
  const installed = opts?.systemdReadTarget ?? (await findInstalledSystemdGatewayScope(env, opts));
  if (opts?.requireLoaded) {
    return await readLoadedSystemdServiceRuntime(
      env,
      opts.timeoutMs,
      opts.loadForInspection,
      opts.systemdReadBinding,
      installed ?? undefined,
    );
  }
  const timeoutMs = opts?.timeoutMs;
  let commandInspectionFailure =
    opts?.commandInspection?.kind === "unavailable"
      ? createServiceRuntimeInspectionFailure(
          sanitizeServiceInspectionError(opts.commandInspection.error),
        )
      : undefined;
  if (installed?.scope !== "system") {
    try {
      await assertSystemdAvailable(env, timeoutMs);
    } catch (err) {
      return {
        ...commandInspectionFailure,
        status: "unknown",
        detail: formatErrorMessage(err),
        ...(err instanceof ServiceInspectionError ? { inspectionReason: err.reason } : {}),
      };
    }
    const inspection: GatewayServiceCommandInspection =
      opts?.commandInspection ??
      (installed
        ? { kind: "present" }
        : await readSystemdServiceExecStart(env, { ...opts, requireEffective: true }).then(
            (command) => ({ kind: command ? "present" : "absent" }) as const,
            (error: unknown) => ({ kind: "unavailable", error }) as const,
          ));
    if (inspection.kind === "unavailable") {
      commandInspectionFailure = createServiceRuntimeInspectionFailure(
        sanitizeServiceInspectionError(inspection.error),
      );
      if (!installed) {
        return commandInspectionFailure;
      }
    }
    if (!installed && inspection.kind === "absent") {
      const transport = await readSystemdUserTransport(env);
      return {
        status: "stopped",
        missingUnit: true,
        ...(transport ? { systemd: { transport } } : {}),
      };
    }
  }
  const unitName = installed?.unitName ?? `${resolveSystemdServiceName(env)}.service`;
  const showArgs = [
    "show",
    unitName,
    "--no-page",
    "--property",
    "Id,LoadState,ActiveState,SubState,Result,NRestarts,StartLimitBurst,MainPID,ExecMainStatus,ExecMainCode,KillMode,TasksCurrent,MemoryCurrent",
  ];
  const res =
    installed?.scope === "system"
      ? await execSystemctl(showArgs, env, timeoutMs)
      : await execSystemctlUser(env, showArgs, timeoutMs);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    const error = systemdInspectionError(res, detail, installed?.scope);
    return {
      ...commandInspectionFailure,
      status: "unknown",
      ...(detail ? { detail } : {}),
      missingUnit: false,
      ...(error instanceof ServiceInspectionError ? { inspectionReason: error.reason } : {}),
    };
  }
  const parsed = parseSystemdShow(res.stdout || "");
  const loadState = normalizeLowercaseStringOrEmpty(parsed.loadState);
  const activeState = normalizeLowercaseStringOrEmpty(parsed.activeState);
  if (loadState !== "loaded") {
    return {
      status: "unknown",
      missingUnit: false,
      detail:
        loadState === "not-found"
          ? `Unit ${unitName} is not visible in the ${installed?.scope ?? "user"} systemd manager.`
          : `Unit ${unitName} has an unverified systemd load state.`,
    };
  }
  // Restart and shutdown transitions can still own or respawn the process.
  // Only terminal native states establish that offline maintenance is safe.
  const status =
    activeState === "active"
      ? "running"
      : activeState === "inactive" || activeState === "failed"
        ? "stopped"
        : "unknown";
  return {
    ...commandInspectionFailure,
    status,
    state: parsed.activeState,
    subState: parsed.subState,
    pid: parsed.mainPid,
    lastExitStatus: parsed.execMainStatus,
    lastExitReason: parsed.execMainCode,
    systemd: {
      scope: installed?.scope ?? "user",
      transport: installed?.scope === "system" ? undefined : await readSystemdUserTransport(env),
      unit: parsed.unit ?? unitName,
      killMode: parsed.killMode,
      tasksCurrent: parsed.tasksCurrent,
      memoryCurrent: parsed.memoryCurrent,
      result: parsed.result,
      nRestarts: parsed.nRestarts,
      startLimitBurst: parsed.startLimitBurst,
    },
  };
}
