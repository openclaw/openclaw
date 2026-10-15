import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { isPidAlive } from "../shared/pid-alive.js";
import {
  assertServiceInspectionFallbackAllowed,
  ServiceInspectionError,
  type ServiceInspectionReason,
  type SystemdServiceStartRefusal,
} from "./service-inspection-error.js";
export type SystemdUserTransport =
  | { kind: "session-bus" | "runtime-bus" | "private"; address: string; runtimeDir: string }
  | { kind: "machine"; user: string };

/** systemd supervision fields used to spot unhealthy or given-up gateway service state. */
type GatewayServiceSystemdRuntime = {
  scope?: "user" | "system";
  transport?: SystemdUserTransport;
  unit?: string;
  startRefusal?: SystemdServiceStartRefusal;
  /** Native D-Bus credential of the observed manager, not the service account or CLI UID. */
  managerUid?: number;
  controlGroup?: string;
  killMode?: string;
  tasksCurrent?: number;
  memoryCurrent?: number;
  // systemd `Result` (e.g. success, exit-code, start-limit-hit) plus the restart
  // counter and configured StartLimitBurst. Together they detect a crash-loop
  // give-up that the collapsed `status` string and `Result` alone cannot.
  result?: string;
  nRestarts?: number;
  startLimitBurst?: number;
};

export type GatewayServiceRuntime = {
  inspectionReason?: ServiceInspectionReason;
  status?: string;
  state?: string;
  subState?: string;
  pid?: number;
  lastExitStatus?: number;
  lastExitReason?: string;
  lastRunResult?: string;
  lastRunTime?: string;
  detail?: string;
  /** Bounded platform detail for classifiers/debug JSON; never render as the primary status. */
  inspectionFailure?: {
    code: "service-runtime-inspection-failed";
    detail: string;
    /** Present only when the native inspection timed out, with its enforced budget. */
    timeoutMs?: number;
  };
  cachedLabel?: boolean;
  missingUnit?: boolean;
  missingGuiSession?: boolean;
  /** Same-label system-domain owner or an ownership probe that failed closed. */
  systemLaunchDaemon?: {
    status: "loaded" | "installed" | "unverifiable";
    serviceTarget: string;
    plistPath?: string;
  };
  systemd?: GatewayServiceSystemdRuntime;
};

/** Native start policy is diagnostic; it never establishes process or definition ownership. */
export function resolveSystemdServiceStartRefusal(facts: {
  unit: string;
  scope?: "user" | "system";
  loadState?: string;
  unitFileState?: string;
  activeState?: string;
  refuseManualStart?: boolean;
  canStart?: boolean;
}): SystemdServiceStartRefusal | undefined {
  const command = facts.scope === "system" ? "sudo systemctl --system" : "systemctl --user";
  const unit = facts.unit;
  if (
    facts.loadState === "masked" ||
    ["masked", "masked-runtime"].includes(facts.unitFileState ?? "")
  ) {
    return {
      reason: "masked",
      message: `Service ${unit} is masked. Run \`${command} unmask ${unit}\`, then retry.`,
    };
  }
  if (facts.refuseManualStart === true) {
    return {
      reason: "refuse-manual-start",
      message: `Service ${unit} has RefuseManualStart=yes. Inspect \`${command} cat ${unit}\`, remove the maintenance restriction, run \`${command} daemon-reload\`, then retry.`,
    };
  }
  if (
    facts.unitFileState === "disabled" &&
    facts.activeState === "inactive" &&
    facts.canStart === false
  ) {
    return {
      reason: "disabled-no-start",
      message: `Service ${unit} is disabled and inactive with no start path (CanStart=no). Repair its definition using \`${command} cat ${unit}\`, run \`${command} daemon-reload\`, then retry.`,
    };
  }
  return undefined;
}

/** Positive process observations protect serving files, but grant no service-control authority. */
export function isGatewayServiceStateLive(state: {
  running: boolean;
  runtime?: GatewayServiceRuntime;
}): boolean {
  if (state.running || (state.runtime?.systemd?.tasksCurrent ?? 0) > 0) {
    return true;
  }
  const pid = state.runtime?.pid;
  if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 && isPidAlive(pid)) {
    return true;
  }
  const serviceState = state.runtime?.state?.toLowerCase() ?? "";
  const subState = state.runtime?.subState?.toLowerCase() ?? "";
  return (
    serviceState === "deactivating" ||
    subState === "stop-sigterm" ||
    subState === "stop-sigkill" ||
    subState === "final-sigterm"
  );
}

const SERVICE_RUNTIME_INSPECTION_FAILED_DETAIL = "service runtime inspection failed";

export function formatServiceInspectionDetail(error: unknown): string {
  const rawDetail = error instanceof Error ? error.message : String(error);
  return truncateUtf16Safe(sanitizeForLog(rawDetail), 500);
}

/** Keeps native probe failures bounded and diagnostic-only for status presentation owners. */
export function createServiceRuntimeInspectionFailure(
  error: unknown,
  timeoutMs?: number,
): GatewayServiceRuntime & {
  inspectionFailure: NonNullable<GatewayServiceRuntime["inspectionFailure"]>;
} {
  assertServiceInspectionFallbackAllowed(error);
  return {
    status: "unknown",
    ...(error instanceof ServiceInspectionError ? { inspectionReason: error.reason } : {}),
    detail: SERVICE_RUNTIME_INSPECTION_FAILED_DETAIL,
    inspectionFailure: {
      code: "service-runtime-inspection-failed",
      detail: formatServiceInspectionDetail(error) || "unknown error",
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
  };
}

const SYSTEMD_TASKS_CURRENT_WARNING_THRESHOLD = 200;
const SYSTEMD_MEMORY_CURRENT_WARNING_BYTES = 2 * 1024 * 1024 * 1024;

// EX_CONFIG deliberately stops through systemd's RestartPreventExitStatus=78;
// accumulated NRestarts from earlier crashes must not imply start-limit exhaustion.
const SYSTEMD_NO_RESTART_EXIT_STATUS = 78;

export function getSystemdCgroupHygieneSummary(
  runtime?: GatewayServiceSystemdRuntime,
): string | null {
  const killMode = normalizeLowercaseStringOrEmpty(runtime?.killMode);
  if (!runtime || (killMode !== "process" && killMode !== "none")) {
    return null;
  }
  // KillMode=process/none only becomes noisy when the cgroup is visibly large.
  const details: string[] = [];
  if (
    runtime.tasksCurrent !== undefined &&
    Number.isSafeInteger(runtime.tasksCurrent) &&
    runtime.tasksCurrent >= SYSTEMD_TASKS_CURRENT_WARNING_THRESHOLD
  ) {
    details.push(`tasks=${runtime.tasksCurrent}`);
  }
  if (
    runtime.memoryCurrent !== undefined &&
    Number.isSafeInteger(runtime.memoryCurrent) &&
    runtime.memoryCurrent >= SYSTEMD_MEMORY_CURRENT_WARNING_BYTES
  ) {
    const gib = (runtime.memoryCurrent / 1024 ** 3).toFixed(1).replace(/\.0$/, "");
    details.push(`memory=${gib}GiB`);
  }
  if (details.length === 0) {
    return null;
  }
  return `cgroup hygiene: KillMode=${runtime.killMode}, ${details.join(", ")}`;
}

export function isSystemdCgroupHygieneRisk(runtime?: GatewayServiceSystemdRuntime): boolean {
  return getSystemdCgroupHygieneSummary(runtime) !== null;
}

/** Start-limit latches need reset-failed + restart. systemd 249 retains Result=exit-code
 * after real crashes, so detection also needs the restart counter; an explicit
 * Result=start-limit-hit remains authoritative even after EX_CONFIG. */
export function isSystemdStartLimitHit(runtime?: GatewayServiceRuntime): boolean {
  if (!runtime || normalizeLowercaseStringOrEmpty(runtime.state) !== "failed") {
    return false;
  }
  const systemd = runtime.systemd;
  if (!systemd) {
    return false;
  }
  if (normalizeLowercaseStringOrEmpty(systemd.result) === "start-limit-hit") {
    return true;
  }
  if (runtime.lastExitStatus === SYSTEMD_NO_RESTART_EXIT_STATUS) {
    return false;
  }
  return (
    typeof systemd.startLimitBurst === "number" &&
    systemd.startLimitBurst > 0 &&
    typeof systemd.nRestarts === "number" &&
    systemd.nRestarts >= systemd.startLimitBurst
  );
}
