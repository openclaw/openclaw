import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import { readProcessServiceCgroup } from "../infra/proc-cgroup.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  resolveGatewaySystemdServiceName,
  resolveNodeSystemdServiceName,
} from "./constants.js";
import { execFileUtf8 } from "./exec-file.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { SystemdSystemUnitRuntime } from "./service-runtime.js";
import type { GatewayServiceEnv } from "./service-types.js";

export type SystemdSystemProbeOutcome = {
  /** Units observed by the system-bus probe (loaded or active). */
  units: SystemdSystemUnitRuntime[];
  /** Whether at least one system-bus probe call succeeded. */
  systemBusAvailable: boolean;
};

/**
 * Extra candidate system unit names that downstream packaging is known to
 * use on headless deployments in addition to the canonical
 * `openclaw-gateway` / `openclaw-node` names.
 */
const EXTRA_SYSTEM_UNIT_CANDIDATES = ["openclaw-host-gateway", "openclaw-node-host"] as const;

const MAIN_UNIT_CANDIDATE_TAG = Symbol("mainUnit");

function buildGatewayCandidates(env: GatewayServiceEnv): string[] {
  const names = new Set<string>();
  const configuredGateway = env.OPENCLAW_SYSTEMD_UNIT?.trim();
  if (configuredGateway) {
    names.add(configuredGateway);
  }
  names.add(resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE));
  for (const legacy of LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES) {
    names.add(legacy);
  }
  for (const extra of EXTRA_SYSTEM_UNIT_CANDIDATES) {
    names.add(extra);
  }
  names.add(resolveNodeSystemdServiceName());
  return Array.from(names, (name) => (name.endsWith(".service") ? name : `${name}.service`));
}

/**
 * Candidate units for the system-bus probe. Exported for tests.
 */
export function resolveCandidateSystemUnits(env: GatewayServiceEnv): string[] {
  return buildGatewayCandidates(env);
}

type ShowResult = {
  info: SystemdSystemUnitRuntime;
  code: number;
  detail: string;
};

function execSystemctlSystem(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return execFileUtf8("systemctl", args);
}

async function probeOneSystemUnit(unitName: string): Promise<ShowResult> {
  // `systemctl show` works against the system bus without sudo and does not
  // fail when the unit is missing (it prints defaults and returns 0). Use
  // `is-active` first to cheaply skip units that don't exist to keep output
  // noise-free, but don't rely on non-zero codes as hard errors because the
  // system bus itself may be missing in containers.
  const show = await execSystemctlSystem([
    "show",
    unitName,
    "--no-page",
    "--property",
    "ActiveState,SubState,MainPID,LoadState,ControlGroup",
  ]);
  const detail = `${show.stderr} ${show.stdout}`.trim();
  const entries = parseKeyValueOutput(show.stdout || "", "=");
  const activeState = entries.activestate || undefined;
  const subState = entries.substate || undefined;
  const mainPidRaw = entries.mainpid;
  const loadState = entries.loadstate || undefined;
  const controlGroup = entries.controlgroup || undefined;
  const mainPid = mainPidRaw ? parseStrictPositiveInteger(mainPidRaw) : undefined;
  const info: SystemdSystemUnitRuntime = {
    unitName,
    ...(activeState ? { activeState } : {}),
    ...(subState ? { subState } : {}),
    ...(mainPid ? { mainPid } : {}),
    loaded: loadState ? normalizeLowercaseStringOrEmpty(loadState) === "loaded" : undefined,
  };
  if (controlGroup && controlGroup.trim()) {
    info.cgroup = controlGroup.trim();
  } else if (mainPid) {
    const fromProc = readProcessServiceCgroup(mainPid);
    if (fromProc) {
      info.cgroup = fromProc;
    }
  }
  return { info, code: show.code, detail };
}

/**
 * Probe the system bus for known OpenClaw systemd units. This is a
 * no-sudo-required probe intended as a fallback when the user bus is
 * unavailable (headless hosts without a login session). It intentionally
 * returns a list of runtimes rather than a single one because OpenClaw can
 * be installed as multiple co-located system services (gateway + node host).
 */
export async function probeSystemdSystemServices(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
): Promise<SystemdSystemProbeOutcome> {
  const candidates = buildGatewayCandidates(env);
  const units: SystemdSystemUnitRuntime[] = [];
  let systemBusAvailable = false;
  for (const unitName of candidates) {
    try {
      const result = await probeOneSystemUnit(unitName);
      if (result.code === 0) {
        systemBusAvailable = true;
      }
      if (isUnitWorthReporting(result.info)) {
        units.push(result.info);
      }
    } catch {
      // best-effort; skip
    }
  }
  return { units, systemBusAvailable };
}

function isUnitWorthReporting(info: SystemdSystemUnitRuntime): boolean {
  if (info.loaded) {
    return true;
  }
  if (info.activeState && info.activeState !== "inactive") {
    return true;
  }
  if (info.mainPid && info.mainPid > 0) {
    return true;
  }
  return false;
}

/**
 * Given a set of system-bus probe results, pick the unit that should
 * represent the "gateway" service for status output (prefers the configured
 * unit, then the canonical gateway, then host-gateway variants, then the
 * first active unit).
 */
export function pickPrimaryGatewayUnit(
  env: GatewayServiceEnv,
  units: SystemdSystemUnitRuntime[],
): SystemdSystemUnitRuntime | null {
  if (units.length === 0) {
    return null;
  }
  const ordered = buildGatewayCandidates(env);
  for (const candidate of ordered) {
    const match = units.find((u) => u.unitName === candidate);
    if (match) {
      return match;
    }
  }
  return units.find((u) => u.activeState === "active") ?? units[0] ?? null;
}

// Silence unused symbol warnings when tree-shaken.
export const _MAIN_UNIT_CANDIDATE_TAG = MAIN_UNIT_CANDIDATE_TAG;
