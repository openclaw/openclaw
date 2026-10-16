import fs from "node:fs";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { hasErrnoCode } from "./errno.js";
import {
  classifyGatewayLockProcessNamespace,
  parseGatewayLockPayload,
} from "./gateway-lock-payload.js";
import { readGatewayOwnerLease } from "./gateway-owner-lease.js";
import {
  resolveGatewayStateOwnerPath,
  tryAcquireGatewayStateOwner,
} from "./gateway-state-owner.js";

// Worker renewal proves custody, not main-thread progress through startup.
const GATEWAY_STARTUP_BUDGET_MS = 5 * 60_000;

export function captureStalledGatewayStartup(env: NodeJS.ProcessEnv = process.env) {
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const lockPath = resolveGatewayStateOwnerPath(databasePath);
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  const holder = parseGatewayLockPayload(raw);
  const elapsedMs = Date.now() - Date.parse(holder?.createdAt ?? "");
  if (
    !holder ||
    (holder.role ?? "gateway") !== "gateway" ||
    holder.pid === process.pid ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= GATEWAY_STARTUP_BUDGET_MS ||
    holder.startTime === undefined ||
    !isPidAlive(holder.pid) ||
    classifyGatewayLockProcessNamespace(holder.processNamespace, lockPath) !== "same"
  ) {
    return undefined;
  }
  const isListening = () => {
    const lease = readGatewayOwnerLease({ env, current: true });
    return (
      lease &&
      lease.owner === holder.ownerId &&
      (lease.listeningAt !== undefined || holder.startupPhase === undefined)
    );
  };
  if (isListening()) {
    return undefined;
  }
  const assertCurrent = () => {
    if (
      fs.readFileSync(lockPath, "utf8") !== raw ||
      !isPidAlive(holder.pid) ||
      getFileLockProcessStartTime(holder.pid, env) !== holder.startTime ||
      isListening()
    ) {
      throw new Error(`Gateway startup owner pid ${holder.pid} changed; process preserved`);
    }
  };
  return {
    pid: holder.pid,
    description: `Gateway pid ${holder.pid} has been stuck in startup for ${Math.floor(elapsedMs / 1000)} s without a listening readiness fact`,
    assertCurrent,
    confirmStopped() {
      if (isPidAlive(holder.pid)) {
        throw new Error(`Gateway startup pid ${holder.pid} exit could not be confirmed`);
      }
      const exclusion = tryAcquireGatewayStateOwner(databasePath);
      if (!exclusion) {
        throw new Error("Gateway state ownership is still held after startup stop");
      }
      exclusion.release();
    },
  };
}
