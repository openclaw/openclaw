import os from "node:os";
import path from "node:path";
import {
  GatewayLockError,
  readLockPayload,
  resolveGatewayLockPaths,
  resolveGatewayOwnerStatus,
} from "./gateway-lock.js";

/** Published 2026.6.33 Gateways predate state-local locks and SQLite coordinators. */
export async function readLegacyGatewayLockIdentity(env: NodeJS.ProcessEnv) {
  const uid = process.getuid?.();
  const lockDir = path.join(os.tmpdir(), uid === undefined ? "openclaw" : `openclaw-${uid}`);
  const { configLockPath } = resolveGatewayLockPaths(env, lockDir);
  const payload = await readLockPayload(configLockPath, true).catch((cause: unknown) => {
    throw new GatewayLockError(
      `Legacy Gateway lock could not be read at ${configLockPath}; inspect that file as the Gateway service account before retrying maintenance.`,
      cause,
    );
  });
  if (!payload) {
    return undefined;
  }
  const state = await resolveGatewayOwnerStatus(payload.pid, payload, process.platform, {
    lockPath: configLockPath,
  });
  return state === "dead" ? undefined : { pid: payload.pid, state, path: configLockPath };
}

export async function assertLegacyGatewayStoppedForMaintenance(
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const owner = await readLegacyGatewayLockIdentity(env);
  if (owner) {
    const next =
      owner.path === resolveGatewayLockPaths(env).configLockPath
        ? "Stop that process before retrying."
        : "If that process has stopped on this host and in every container sharing this directory, remove that file as the Gateway service account.";
    throw new GatewayLockError(
      `Legacy Gateway lock ${owner.path} still has a live or unverified owner (PID ${owner.pid}). ${next}`,
    );
  }
}
