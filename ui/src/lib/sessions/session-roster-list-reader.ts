import type { SessionsListResult } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import type {
  SessionListOptions,
  SessionListScope,
  SessionRefreshOutcome,
  SessionState,
} from "./session-capability.ts";
import type { SessionListRefreshHost } from "./session-managed-list-refresh.ts";
import { requestSessionList } from "./session-requests.ts";
import type { createSessionRosterObservations } from "./session-roster-observations.ts";

/** Reads scoped roster facts without acquiring foreground query ownership. */
export function createSessionRosterListReader(
  host: SessionListRefreshHost & { publish: (state: SessionState) => void },
  nextRevision: () => number,
  observations: Pick<
    ReturnType<typeof createSessionRosterObservations>,
    "mergeRows" | "stageObservedRows"
  >,
  primaryList: () => { scope: SessionListScope },
) {
  const readList = async (options: SessionListOptions) => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    try {
      const issuedRevision = nextRevision();
      const response = await requestSessionList(scope.client, options);
      if (!host.connection.isCurrent(scope)) {
        return null;
      }
      const result = host.reconcileList(response ?? null, issuedRevision, options.agentId);
      return { result, scope, issuedRevision };
    } catch (error) {
      if (!host.connection.isCurrent(scope)) {
        return null;
      }
      throw error;
    }
  };

  const list = async (options: SessionListOptions = {}): Promise<SessionsListResult | null> => {
    const read = await readList(options);
    return read && host.connection.isCurrent(read.scope)
      ? host.decorate(read.result, { scope: options })
      : null;
  };

  const reconcile = async (
    options: SessionListOptions,
    isErrorCurrent?: () => boolean,
  ): Promise<SessionRefreshOutcome> => {
    const scope = host.connection.capture();
    if (!scope) {
      return { status: "stale" };
    }
    // A newer selection may have absorbed the foreground read. Reconcile the
    // mutation's rows without replacing that selection or publishing unrelated errors.
    try {
      const read = await readList(options);
      if (!read || !host.connection.isCurrent(scope)) {
        return { status: "stale" };
      }
      const rows = read.result?.sessions ?? [];
      const state = host.readState();
      const result = host.decorate(
        observations.mergeRows(state.result, rows, state.agentId, options.agentId),
        primaryList(),
      );
      const notify = observations.stageObservedRows(
        rows,
        read.scope,
        options.agentId,
        read.issuedRevision,
      );
      if (result !== state.result) {
        host.publish({ ...state, result });
      }
      notify();
      return { status: "refreshed" };
    } catch (error) {
      return host.connection.isCurrent(scope) && isErrorCurrent?.() !== false
        ? { status: "failed", error: formatUiError(error) }
        : { status: "stale" };
    }
  };
  return { list, reconcile };
}
