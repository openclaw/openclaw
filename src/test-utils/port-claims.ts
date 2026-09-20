import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { hasErrnoCode } from "../infra/errno.js";
import { createFileLockManager } from "../infra/file-lock-manager.js";
import { FILE_LOCK_TIMEOUT_ERROR_CODE } from "../infra/file-lock.js";
import { isLockOwnerDefinitelyStale } from "../infra/stale-lock-file.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { getDeterministicFreePortBlock } from "./ports.js";

const portClaims = createFileLockManager("openclaw.test-gateway-ports");
let portClaimOwnerStartTime: number | null | undefined;
const isDefinitelyStalePortClaim = ({ payload }: { payload: unknown }) =>
  isLockOwnerDefinitelyStale({ payload: isRecord(payload) ? payload : null });

export type TestPortClaim = { port: number; release: () => Promise<void> };

async function claimPortBlock(
  port: number,
  offsets: number[],
  signal?: AbortSignal,
): Promise<TestPortClaim> {
  signal?.throwIfAborted();
  const root = await fs.realpath(tmpdir());
  const claims: Awaited<ReturnType<typeof portClaims.acquire>>[] = [];
  const release = () =>
    runQaGatewayFixture(async () => {}, ...claims.map((claim) => () => claim.release()));
  try {
    for (const offset of offsets) {
      signal?.throwIfAborted();
      claims.push(
        await portClaims.acquire(path.join(root, `openclaw-test-port-${port + offset}`), {
          retry: { retries: 0 },
          staleMs: 30_000,
          staleRecovery: "remove-if-unchanged",
          shouldReclaim: isDefinitelyStalePortClaim,
          shouldRemoveStaleLock: isDefinitelyStalePortClaim,
          payload: () => {
            if (portClaimOwnerStartTime === undefined) {
              portClaimOwnerStartTime = getFileLockProcessStartTime(process.pid);
            }
            return {
              pid: process.pid,
              createdAt: new Date().toISOString(),
              ...(portClaimOwnerStartTime === null ? {} : { starttime: portClaimOwnerStartTime }),
            };
          },
        }),
      );
    }
    signal?.throwIfAborted();
    return { port, release };
  } catch (error) {
    return runQaGatewayFixture(async (): Promise<never> => {
      throw error;
    }, release);
  }
}

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
      return await claimPortBlock(requestedPort, offsets, signal);
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
      return await claimPortBlock(port, offsets, signal);
    } catch (error) {
      if (!hasErrnoCode(error, FILE_LOCK_TIMEOUT_ERROR_CODE)) {
        throw error;
      }
    }
  }
}
