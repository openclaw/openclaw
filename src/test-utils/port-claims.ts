import { hasErrnoCode } from "../infra/errno.js";
import { FILE_LOCK_TIMEOUT_ERROR_CODE } from "../infra/file-lock.js";
import { claimTestPortBlock, type TestPortClaim } from "./port-claim-lock.js";
import { getDeterministicFreePortBlock } from "./ports.js";

export type { TestPortClaim } from "./port-claim-lock.js";

/** Retain exclusive test ownership while a socket is handed to its eventual listener. */
export async function acquireTestPortBlock(params: {
  offsets: number[];
  port?: number;
  signal?: AbortSignal;
}): Promise<TestPortClaim> {
  const requestedPort = params.port;
  const signal = params.signal;
  signal?.throwIfAborted();
  const offsets = [...new Set(params.offsets)].toSorted((left, right) => left - right);
  if (
    offsets.length === 0 ||
    offsets.some((offset) => !Number.isInteger(offset) || offset < 0 || offset > 65534) ||
    (requestedPort !== undefined &&
      (!Number.isInteger(requestedPort) ||
        requestedPort <= 0 ||
        offsets.some((offset) => requestedPort + offset > 65535)))
  ) {
    throw new Error("Test port claims require a valid port and nonnegative TCP offsets");
  }
  if (requestedPort !== undefined) {
    try {
      return await claimTestPortBlock(requestedPort, offsets, signal);
    } catch (error) {
      if (!hasErrnoCode(error, FILE_LOCK_TIMEOUT_ERROR_CODE)) {
        throw error;
      }
      throw Object.assign(
        new Error(`Test port block at ${requestedPort} is already claimed`, { cause: error }),
        { code: "EADDRINUSE" },
      );
    }
  }
  const seen = new Set<number>();
  while (true) {
    signal?.throwIfAborted();
    const port = await getDeterministicFreePortBlock({ offsets });
    signal?.throwIfAborted();
    if (seen.has(port)) {
      throw new Error("no unclaimed test Gateway port block available");
    }
    seen.add(port);
    try {
      return await claimTestPortBlock(port, offsets, signal);
    } catch (error) {
      if (!hasErrnoCode(error, FILE_LOCK_TIMEOUT_ERROR_CODE)) {
        throw error;
      }
    }
  }
}
