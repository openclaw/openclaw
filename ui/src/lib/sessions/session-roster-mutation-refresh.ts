import type { SessionRefreshOptions, SessionRefreshOutcome } from "./session-capability.ts";
import {
  sessionListAgentMatcher,
  sessionMutationRefreshOutcome,
  type SessionRefreshAttempt,
} from "./session-list-query.ts";
import type { SessionListRefreshHost } from "./session-managed-list-refresh.ts";

type MutationRefreshOperations = {
  foreground: () => { agentId?: string; initial: boolean };
  replacementOptions: (agentId?: string | null) => SessionRefreshOptions;
  invalidate: (agentId?: string | null) => void;
  refresh: (
    options: SessionRefreshOptions,
    isErrorCurrent?: () => boolean,
  ) => Promise<SessionRefreshAttempt | null>;
  read: (
    options: SessionRefreshOptions,
    isErrorCurrent?: () => boolean,
  ) => Promise<SessionRefreshOutcome>;
};

/** Reconcile mutation facts without taking ownership of the foreground query. */
export function createSessionMutationRefresh(
  host: Pick<SessionListRefreshHost, "connection">,
  roster: MutationRefreshOperations,
) {
  return async (
    agentId?: string | null,
    isErrorCurrent?: () => boolean,
  ): Promise<SessionRefreshOutcome> => {
    const scope = host.connection.capture();
    if (!scope) {
      return { status: "stale" };
    }
    roster.invalidate(agentId);
    const foreground = roster.foreground();
    if (sessionListAgentMatcher(agentId)(foreground.agentId)) {
      const options = roster.replacementOptions(foreground.initial ? agentId : undefined);
      const attempt = await roster.refresh(options, isErrorCurrent);
      if (!host.connection.isCurrent(scope)) {
        return { status: "stale" };
      }
      const outcome = sessionMutationRefreshOutcome(attempt, agentId);
      if (outcome) {
        return outcome.status === "failed" && isErrorCurrent?.() === false
          ? { status: "stale" }
          : outcome;
      }
      if (!agentId?.trim() || isErrorCurrent?.() === false) {
        return { status: "stale" };
      }
    }
    return roster.read(roster.replacementOptions(agentId), isErrorCurrent);
  };
}
