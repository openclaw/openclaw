import type { Server } from "node:net";
import { platform } from "node:os";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
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

/** Hold the real loopback listener as well as the cooperative port claim. */
export async function reserveTestPortListener<T extends Server>(params: {
  offsets: number[];
  port?: number;
  signal?: AbortSignal;
  createListener: () => T;
  verifyCleanup?: (cleanup: () => Promise<void>) => Promise<void>;
}) {
  const verifyCleanup = params.verifyCleanup ?? ((cleanup: () => Promise<void>) => cleanup());
  const seen = new Set<number>();
  while (true) {
    const claim = await acquireTestPortBlock(params);
    let reservation: { listener: T; releaseListener: () => Promise<void> } | undefined;
    let bindError: unknown;
    try {
      if (seen.has(claim.port)) {
        throw new Error("no unclaimed test Gateway port block available");
      }
      seen.add(claim.port);
      params.signal?.throwIfAborted();
      const listener = params.createListener();
      const releaseListener = () =>
        new Promise<void>((resolve, reject) => {
          listener.close((error) => (error ? reject(error) : resolve()));
        });
      reservation = { listener, releaseListener };
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => {
          bindError = error;
          reject(error);
        };
        listener.once("error", failed);
        listener.listen(claim.port, "127.0.0.1", () => {
          listener.off("error", failed);
          resolve();
        });
      });
      params.signal?.throwIfAborted();
      return { claim, ...reservation };
    } catch (error) {
      try {
        await runQaGatewayFixture(
          async (): Promise<never> => {
            throw error;
          },
          () =>
            reservation?.listener.listening
              ? verifyCleanup(reservation.releaseListener)
              : undefined,
          () => verifyCleanup(claim.release),
        );
      } catch (rollbackError) {
        // Windows can deny a candidate after its probe too. Only initial automatic
        // selection may move, after both provisional owners drain.
        if (
          rollbackError !== error ||
          params.port !== undefined ||
          error !== bindError ||
          !(
            hasErrnoCode(error, "EADDRINUSE") ||
            (platform() === "win32" && hasErrnoCode(error, "EACCES"))
          )
        ) {
          throw rollbackError;
        }
      }
    }
  }
}
