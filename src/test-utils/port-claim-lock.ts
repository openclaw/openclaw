import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { findVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { createFileLockManager } from "../infra/file-lock-manager.js";
import { isLockOwnerDefinitelyStale } from "../infra/stale-lock-file.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";

const portClaims = createFileLockManager("openclaw.test-gateway-ports");
let portClaimOwnerStartTime: number | null | undefined;
const isDefinitelyStalePortClaim = ({ payload }: { payload: unknown }) =>
  isLockOwnerDefinitelyStale({ payload: isRecord(payload) ? payload : null });

export type TestPortClaim = { port: number; release: () => Promise<void> };

export async function claimTestPortBlock(
  port: number,
  offsets: number[],
  signal?: AbortSignal,
): Promise<TestPortClaim> {
  signal?.throwIfAborted();
  let root = await fs.realpath(tmpdir());
  // Vitest namespaces own disposable files, but sibling invocations share TCP
  // ports. Keep claims outside every enclosing invocation's cleanup boundary.
  for (let owner = findVitestResourceOwner(root); owner; owner = findVitestResourceOwner(root)) {
    root = path.dirname(owner.root);
  }
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
