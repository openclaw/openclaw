import {
  admitUpdateInitialStores,
  type UpdateInitialStoreSelection,
} from "./update-initial-store-admission.js";
import type { ManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-database.js";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-lease.js";

/** Correlation only. The native lease and the state publication owner retain authority. */
export type UpdateInitialStoreTransport = Readonly<{
  protocol: "initial-pair-v1";
  selection: UpdateInitialStoreSelection;
}>;

export function admitUpdateInitialStoreTransport(
  input: UpdateInitialStoreTransport,
  selectors: { installationRoot: string; handoffPath: string; statePath: string },
) {
  if (!input || input.protocol !== "initial-pair-v1" || !input.selection) {
    throw new Error("Update initial store transport is missing or unsupported.");
  }
  const admission = admitUpdateInitialStores(input.selection);
  admission.assertCurrent(selectors);
  return admission;
}

/** Snapshot selected facts; this never captures/restats a successor generation. */
export function snapshotUpdateInitialStoreTransport(input: UpdateInitialStoreTransport) {
  const selection = input?.selection;
  const admission = admitUpdateInitialStoreTransport(input, {
    installationRoot: selection?.installation.path,
    handoffPath: selection?.handoff.databasePath,
    statePath: selection?.state.databasePath,
  });
  const transport: UpdateInitialStoreTransport = Object.freeze({
    protocol: "initial-pair-v1",
    selection: admission.selection,
  });
  admission.close();
  return transport;
}

/** Trusted control port, not a serialized grant. Its implementation must authenticate
 * the real IPC parent/child and exact native pair before admitting any transition. */
export type UpdateManagedGenerationIssuer = (
  input: Readonly<{
    runId: string;
    lease: ManagedHandoffLease;
    /** Actual target/service-plan selection; null explicitly means no distinct root.
     * Helper must select/acquire/bind it natively before issuer resolves. */
    retainedRoot: string | null;
    database: ManagedUpdateLeaseDatabaseIdentity;
    initialStores: UpdateInitialStoreTransport;
  }>,
) => Promise<UpdateManagedGenerationRoute>;

type UpdateManagedGenerationRoute = {
  /** Refuse disconnected/cancelled control locally, including while stores are retired. */
  assertCurrent: () => void;
  /** ACK only after all helper readers, Workers and handles have closed and joined. */
  retire: (transition: string, current: UpdateInitialStoreTransport) => Promise<void>;
  /** Accept only these verified provider facts for the same retired transition. */
  select: (transition: string, successor: UpdateInitialStoreTransport) => Promise<void>;
  /** Exact live child, after local operation/descendant joins; unchanged/no-op is valid. */
  terminal: (current: UpdateInitialStoreTransport) => Promise<void>;
  /** ACK means native revoke committed, NOT final settlement or release. The helper
   * joins this child's close and its own control/descendants before final release. */
  revoke: (cause: Error) => Promise<void>;
};
