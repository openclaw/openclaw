import fs from "node:fs";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { hasErrnoCode } from "./errno.js";
import {
  classifyGatewayLockProcessNamespace,
  parseGatewayLockPayload,
} from "./gateway-lock-payload.js";
import { readGatewayOwnerLeaseAsync } from "./gateway-owner-lease.js";
import {
  resolveGatewayStateOwnerPath,
  tryAcquireGatewayStateOwner,
} from "./gateway-state-owner.js";
import { resolveSqliteInspectionSignal } from "./sqlite-readonly-worker.js";

// Worker renewal proves custody, not main-thread progress through startup.
const GATEWAY_STARTUP_BUDGET_MS = 5 * 60_000;

export async function captureStalledGatewayStartup(env: NodeJS.ProcessEnv = process.env) {
  const signal = resolveSqliteInspectionSignal(getAsyncWorkSignal());
  signal?.throwIfAborted();
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
    classifyGatewayLockProcessNamespace(holder, lockPath) !== "same"
  ) {
    return undefined;
  }
  const isListening = async () => {
    const lease = await readGatewayOwnerLeaseAsync({ env });
    return (
      lease &&
      lease.owner === holder.ownerId &&
      (lease.listeningAt !== undefined || holder.startupPhase === undefined)
    );
  };
  if (await isListening()) {
    return undefined;
  }
  const assertPhysicalCurrent = () => {
    signal?.throwIfAborted();
    if (
      fs.readFileSync(lockPath, "utf8") !== raw ||
      !isPidAlive(holder.pid) ||
      getFileLockProcessStartTime(holder.pid, env) !== holder.startTime
    ) {
      throw new Error(`Gateway startup owner pid ${holder.pid} changed; process preserved`);
    }
  };
  assertPhysicalCurrent();
  const assertCurrent = async () => {
    assertPhysicalCurrent();
    const listening = await isListening();
    assertPhysicalCurrent();
    if (listening) {
      throw new Error(`Gateway startup owner pid ${holder.pid} changed; process preserved`);
    }
  };
  return {
    pid: holder.pid,
    description: `Gateway pid ${holder.pid} has been stuck in startup for ${Math.floor(elapsedMs / 1000)} s without a listening readiness fact`,
    assertCurrent,
    assertPhysicalCurrent,
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
