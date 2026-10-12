/**
 * Process-liveness identity for durable channel-ingress claims.
 *
 * ownerId = pid:startToken:uuid. Starttime binds the PID to one process instance so
 * Linux TIDs and recycled PIDs cannot impersonate a dead claim owner.
 */
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { getProcessStartTime } from "../../shared/pid-alive.ts";
import type {
  ChannelIngressQueueClaim,
  ChannelIngressQueueCorruptClaim,
} from "./ingress-queue.types.js";

// Liveness default: a claim older than its lease is never live-owner protected,
// so recovery can reclaim it even when the owner process still exists.
export const INGRESS_CLAIM_LEASE_MS = 30 * 60 * 1000;

type IngressClaimLivenessOptions = {
  maxAgeMs?: number;
  now?: number;
  /** Test seam for PID existence (including Linux TID impersonation). */
  processExists?: (pid: number) => boolean;
  /** Test seam for process start-time identity. */
  readProcessStartTime?: (pid: number) => number | null;
};

function readProcessStartTime(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  if (process.platform === "darwin") {
    try {
      // Bounded: this runs on shared channel/SDK init paths, so a hung /bin/ps must
      // not block startup. Timeout -> null -> "unknown liveness" (callers hold claims).
      const startedAt = childProcess
        .execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2000,
          killSignal: "SIGKILL",
        })
        .trim();
      const startedAtMs = Date.parse(`${startedAt} UTC`);
      return Number.isFinite(startedAtMs) ? Math.floor(startedAtMs / 1000) : null;
    } catch {
      return null;
    }
  }
  return getProcessStartTime(pid);
}

const INGRESS_CLAIM_PROCESS_START_TIME = readProcessStartTime(process.pid);

export const INGRESS_CLAIM_PROCESS_ID = createIngressDrainOwnerId();

/** Process-local live drain instance UUIDs (ownerId third field). */
const liveIngressDrainInstanceIds = new Set<string>();

export function processPidFromOwnerId(ownerId: string): number {
  const pid = Number.parseInt(ownerId.split(":", 1)[0] ?? "", 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : -1;
}

/** Instance UUID from ownerId `pid:startToken:uuid`. */
function processInstanceIdFromOwnerId(ownerId: string): string | null {
  return ownerId.split(":")[2] || null;
}

/** Mint a unique per-drain ownerId (`pid:startToken:uuid`). Caller registers via drain. */
export function createIngressDrainOwnerId(): string {
  return [process.pid, INGRESS_CLAIM_PROCESS_START_TIME ?? "x", randomUUID()].join(":");
}

export function registerLiveIngressDrainInstance(ownerId: string): void {
  const instanceId = processInstanceIdFromOwnerId(ownerId);
  if (instanceId) {
    liveIngressDrainInstanceIds.add(instanceId);
  }
}

export function deregisterLiveIngressDrainInstance(ownerId: string): void {
  const instanceId = processInstanceIdFromOwnerId(ownerId);
  if (instanceId) {
    liveIngressDrainInstanceIds.delete(instanceId);
  }
}

/**
 * True when a same-process drain instance still holds this ownerId.
 * Recovery must not steal claims from a live peer drain on the same queue.
 */
export function isLiveLocalIngressDrainOwner(ownerId: string): boolean {
  const instanceId = processInstanceIdFromOwnerId(ownerId);
  return instanceId != null && liveIngressDrainInstanceIds.has(instanceId);
}

// Canonical ownerId: pid:startToken:uuid. startToken is a numeric starttime, or
// the explicit "x" sentinel when the writer cannot supply one (win32).
function parseOwnerStartToken(ownerId: string): number | "existence-only" | undefined {
  const parts = ownerId.split(":");
  // Legacy pid:uuid owners (pre start-token releases) carry no instance binding.
  // Keep existence-based liveness for them: reclaiming a fresh claim from a live
  // old-version worker during a rolling upgrade would double-dispatch its update.
  if (parts.length === 2) {
    return "existence-only";
  }
  if (parts.length < 2) {
    return undefined;
  }
  const startField = parts[1] ?? "";
  // Explicit "x": writer ran on a platform with no readable starttime (win32).
  if (startField === "x") {
    return "existence-only";
  }
  const starttime = Number(startField);
  return Number.isSafeInteger(starttime) && starttime >= 0 ? starttime : undefined;
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    return code !== "ESRCH" && code !== "EINVAL";
  }
}

function isFreshClaimOwner(
  claimedAt: number,
  options?: { maxAgeMs?: number; now?: number },
): boolean {
  const now = options?.now ?? Date.now();
  const maxAgeMs = options?.maxAgeMs ?? INGRESS_CLAIM_LEASE_MS;
  return now - claimedAt < maxAgeMs;
}

function isClaimOwnerProcessInstanceLive(
  ownerId: string,
  pid: number,
  options?: IngressClaimLivenessOptions,
): boolean {
  const exists = options?.processExists ?? processExists;
  const readStart = options?.readProcessStartTime ?? readProcessStartTime;
  if (!exists(pid)) {
    return false;
  }
  const startToken = parseOwnerStartToken(ownerId);
  if (startToken === undefined) {
    // Legacy/malformed owner ids have no process-instance binding; reclaim.
    return false;
  }
  if (startToken === "existence-only") {
    // Legacy or `x` owners cannot prove instance identity. Fall back to
    // processExists-only liveness — the pre-starttime lease contract — instead
    // of stealing a fresh claim from a possibly live worker.
    return true;
  }
  const actualStart = readStart(pid);
  // Unreadable starttime retains existence-based protection for a possibly live peer.
  return actualStart === null || actualStart === startToken;
}

/** True when another live process still holds a fresh claim on this event. */
export function isIngressClaimOwnedByOtherLiveProcess(
  { claim }: Pick<ChannelIngressQueueClaim<unknown>, "claim">,
  options?: IngressClaimLivenessOptions,
): boolean {
  const pid = processPidFromOwnerId(claim.ownerId);
  return (
    claim.ownerId !== INGRESS_CLAIM_PROCESS_ID &&
    pid !== process.pid &&
    isFreshClaimOwner(claim.claimedAt, options) &&
    isClaimOwnerProcessInstanceLive(claim.ownerId, pid, options)
  );
}

/** True when a corrupt claimed row is still live-owned by this or another process. */
export function isIngressCorruptClaimOwnedByOtherLiveProcess(
  { claim }: ChannelIngressQueueCorruptClaim,
  options?: IngressClaimLivenessOptions,
): boolean {
  if (claim.ownerId === INGRESS_CLAIM_PROCESS_ID) {
    return isFreshClaimOwner(claim.claimedAt, options);
  }
  const pid = processPidFromOwnerId(claim.ownerId);
  return (
    pid !== process.pid &&
    isFreshClaimOwner(claim.claimedAt, options) &&
    isClaimOwnerProcessInstanceLive(claim.ownerId, pid, options)
  );
}
