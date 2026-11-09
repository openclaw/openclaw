import { statSync } from "node:fs";
import path from "node:path";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveGatewayLockPaths } from "../../infra/gateway-lock.js";
import { captureGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { withChannelReadAuthority } from "../../shared/channel-read-authority.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Optional for old clients; new local callers must bind to the physically held owner. */
export function captureLocalStateMutationGuard(
  expectedOwnerId: string,
  options: GatewayRequestHandlerOptions,
  target?: { path: string; identity: string },
): () => void {
  const { stateDir } = resolveGatewayLockPaths(process.env);
  const owner = captureGatewayStateOwner(path.join(stateDir, "state", "openclaw.sqlite"));
  const cfg = options.context.getRuntimeConfig();
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    options.sessionMutationCommitGuard?.();
    if (
      !owner ||
      owner.role !== "gateway" ||
      owner.ownerId !== expectedOwnerId ||
      options.hasCurrentClientAuthority?.() === false ||
      options.context.getRuntimeConfig() !== cfg
    ) {
      throw new Error("Gateway state owner or requester changed; rerun against the current owner.");
    }
    owner.assertCurrent();
    if (target) {
      const current = statSync(target.path, { bigint: true });
      if (`${current.dev}:${current.ino}` !== target.identity) {
        throw new Error("Source repository changed; rerun worktrees create.");
      }
    }
  };
  assertCurrent();
  return assertCurrent;
}

export function localStateOwnerChangedError(error: unknown) {
  return errorShape(ErrorCodes.UNAVAILABLE, String(error), {
    details: { reason: "STATE_OWNER_CHANGED", mutationAccepted: false },
    retryable: false,
  });
}

/** Preserve the selected owner through plugin transport effects and response disclosure. */
export function runWithLocalStateMutationOwner<T>(
  expectedOwnerId: string,
  options: GatewayRequestHandlerOptions,
  run: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  const assertCurrent = captureLocalStateMutationGuard(expectedOwnerId, options);
  return withChannelReadAuthority(assertCurrent, () => run(assertCurrent), options.signal);
}
