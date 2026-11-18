import { AsyncLocalStorage } from "node:async_hooks";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { createKeyedFifoLeaseRegistry } from "../../shared/keyed-fifo-lease.js";
import {
  createOpenClawStateLeaseAbortError,
  OpenClawStateLeaseError,
} from "../../state/openclaw-state-lease-error.js";
import { withOpenClawStateLeaseAsync } from "../../state/openclaw-state-lease.js";
import type { OpenClawStateAsyncLeaseContext } from "../../state/openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";

const waitMs = 60_000;
const queue = createKeyedFifoLeaseRegistry(Symbol.for("openclaw.localWorkspaceLeaseQueue"));
const current = new AsyncLocalStorage<readonly { key: string; active: boolean }[]>();

/** Local hand-off orders callers; the persisted lease still owns exclusion and expiry. */
export async function withLocalWorkspaceLease<T>(
  params: { worktreeId: string; signal?: AbortSignal },
  context: OpenClawStateWorkerContext,
  run: (lease: OpenClawStateAsyncLeaseContext) => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([context.admission.coordinationKey, params.worktreeId]);
  const parents = current.getStore() ?? [];
  if (parents.some((owner) => owner.active && owner.key === key)) {
    throw new OpenClawStateLeaseError(
      `Local sandbox operation already holds workspace.local-reconciliation/${params.worktreeId}; release execution custody before checkpointing this workspace`,
      { code: "OPENCLAW_STATE_LEASE_INVALID_INPUT" },
    );
  }
  const deadline = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, deadline.signal])
    : deadline.signal;
  const timeout = setTimeout(() => {
    deadline.abort(
      new OpenClawStateLeaseError(
        `Timed out after ${waitMs} ms waiting for local sandbox workspace workspace.local-reconciliation/${params.worktreeId}; retry the tool call after the current checkpoint or reconciliation finishes`,
        { code: "OPENCLAW_STATE_LEASE_HELD" },
      ),
    );
  }, waitMs);
  timeout.unref?.();
  const turn = queue.reserve([key])!;
  const owner = { key, active: true };
  try {
    await racePromiseWithAbortSignal(turn.wait(), signal, (aborted) =>
      createOpenClawStateLeaseAbortError(aborted, "acquisition", "local sandbox workspace"),
    );
    signal.throwIfAborted();
    return await withOpenClawStateLeaseAsync(
      {
        scope: "workspace.local-reconciliation",
        key: params.worktreeId,
        leaseMs: 60_000,
        waitMs,
        signal,
        leaseLabel: "local sandbox workspace",
        operationLabel: "workspace.local-reconciliation",
      },
      context,
      (lease) => {
        clearTimeout(timeout);
        return current.run([...parents, owner], () => run(lease));
      },
    );
  } catch (error) {
    if (deadline.signal.aborted && !hasSqliteWorkerOutcomeUnknown(error)) {
      throw deadline.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    owner.active = false;
    turn.release();
  }
}
