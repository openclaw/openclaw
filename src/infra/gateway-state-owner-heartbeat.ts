import fs from "node:fs";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  GATEWAY_OWNER_HEARTBEAT_MS,
  GATEWAY_OWNER_HEARTBEAT_STALE_MS,
} from "./gateway-lock-payload.js";

const log = createSubsystemLogger("gateway/state");

/** Renew physical custody without replacing the immutable lock payload or inode. */
export function startGatewayStateOwnerHeartbeat(
  locks: () => Iterable<{ lockPath: string; verifyStillHeld(): boolean }>,
): { isCurrent(): boolean; stop(): void } {
  let lastRenewedAt = Date.now();
  let active = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    active = false;
    clearInterval(timer);
    timer = undefined;
  };
  const lose = (reason: string) => {
    if (!active) {
      return;
    }
    stop();
    log.warn(
      `Gateway state ownership heartbeat ${reason}; restart the Gateway to reacquire state ownership.`,
    );
  };
  const isCurrent = () => {
    if (active && Date.now() - lastRenewedAt > GATEWAY_OWNER_HEARTBEAT_STALE_MS) {
      lose("expired");
    }
    return active;
  };
  const renew = () => {
    if (!isCurrent()) {
      return;
    }
    try {
      const held = [...locks()];
      if (held.length === 0 || held.some((lock) => !lock.verifyStillHeld())) {
        throw new Error("physical ownership is no longer current");
      }
      const renewedAt = Date.now();
      const timestamp = new Date(renewedAt);
      const paths = new Set(held.map((lock) => lock.lockPath));
      for (const lockPath of paths) {
        // Windows timestamp updates require write-attribute access on the handle.
        const fd = fs.openSync(
          lockPath,
          fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
        );
        try {
          const opened = fs.fstatSync(fd, { bigint: true });
          const current = fs.lstatSync(lockPath, { bigint: true });
          if (
            !opened.isFile() ||
            !current.isFile() ||
            opened.dev !== current.dev ||
            opened.ino !== current.ino ||
            held.some((lock) => !lock.verifyStillHeld()) ||
            !isCurrent()
          ) {
            throw new Error("physical ownership changed before renewal");
          }
          // A pathname replacement after verification cannot redirect this touch to its successor.
          fs.futimesSync(fd, timestamp, timestamp);
        } finally {
          fs.closeSync(fd);
        }
      }
      if (held.some((lock) => !lock.verifyStillHeld())) {
        throw new Error("physical ownership changed during renewal");
      }
      // A paused callback must not revive custody after the previous renewal deadline.
      if (isCurrent()) {
        lastRenewedAt = renewedAt;
      }
    } catch (error) {
      lose(`failed (${error instanceof Error ? error.message : String(error)})`);
    }
  };
  try {
    const held = [...locks()];
    if (held.length === 0 || held.some((lock) => !lock.verifyStillHeld())) {
      throw new Error("physical ownership is no longer current");
    }
    // Publication precedes fsync completion; admission cannot restart its expiry clock.
    lastRenewedAt = Math.min(Date.now(), ...held.map((lock) => fs.statSync(lock.lockPath).mtimeMs));
    renew();
  } catch (error) {
    lose(`failed (${error instanceof Error ? error.message : String(error)})`);
  }
  if (active) {
    timer = setInterval(renew, GATEWAY_OWNER_HEARTBEAT_MS);
    timer.unref();
  }
  return { isCurrent, stop };
}
