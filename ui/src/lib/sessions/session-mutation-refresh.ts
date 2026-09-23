import { ErrorCodes, GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import type {
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionRefreshOutcome,
  SessionState,
} from "./session-capability.ts";
import { sessionListAgentMatcher } from "./session-list-query.ts";

type Host = {
  connection: SessionConnectionOwner;
  readState: () => SessionState;
  publish: (state: SessionState, errorSource?: "session-observer" | "operation") => void;
  reconcileMutation: (
    agentId?: string | null,
    isErrorCurrent?: () => boolean,
  ) => Promise<SessionRefreshOutcome>;
};

/** Reconcile committed mutations without confusing refresh failures with failed writes. */
export function createSessionMutationRefresh(host: Host) {
  const reconcileConfirmedPreviousConnection = async (
    scope: SessionConnectionScope,
    agentId?: string | null,
  ): Promise<boolean> => {
    const replacement = host.connection.capture();
    if (!replacement || replacement.client !== scope.client) {
      return false;
    }
    let refreshError: string | undefined;
    try {
      const outcome = await host.reconcileMutation(agentId);
      refreshError = outcome.status === "failed" ? outcome.error : undefined;
    } catch (error) {
      refreshError = formatUiError(error);
    }
    if (!host.connection.isCurrent(replacement)) {
      return false;
    }
    host.publish(
      {
        ...host.readState(),
        error: refreshError
          ? t("connection.sessionOperationCompletedPreviousConnectionWithRefreshError", {
              error: refreshError,
            })
          : t("connection.sessionOperationCompletedPreviousConnection"),
      },
      "operation",
    );
    return true;
  };

  // Placement receipts complete immediately; the roster owner reconciles asynchronously.
  const refreshCategory = (scope: SessionConnectionScope, agentId?: string | null): void => {
    // A scoped read cannot acquire error ownership by later selecting its agent.
    // A replacement foreground snapshot retires this warning, not row reconciliation.
    const foreground = host.readState();
    const ownsForeground = sessionListAgentMatcher(agentId)(foreground.agentId ?? undefined);
    const isErrorCurrent = () => {
      const current = host.readState();
      return (
        ownsForeground &&
        host.connection.isCurrent(scope) &&
        current.agentId === foreground.agentId &&
        current.result === foreground.result &&
        current.resultCached === foreground.resultCached
      );
    };
    const report = (error: string) => {
      if (isErrorCurrent()) {
        host.publish(
          { ...host.readState(), error: t("connection.sessionMoveRefreshFailed", { error }) },
          "operation",
        );
      }
    };
    void host
      .reconcileMutation(agentId, isErrorCurrent)
      .then((outcome) => {
        if (outcome.status === "failed") {
          report(outcome.error);
        }
      })
      .catch((error: unknown) => report(formatUiError(error)));
  };
  // Reconcile the original owner after transport loss without retrying its write.
  const reportUncertainCategory = (error: unknown, agentId?: string | null): Error => {
    void host.reconcileMutation(agentId).catch(() => undefined);
    const uncertainty = new Error(
      t("connection.sessionMoveUncertain", { error: formatUiError(error) }),
    );
    host.publish({ ...host.readState(), error: uncertainty.message }, "operation");
    return uncertainty;
  };
  return { reconcileConfirmedPreviousConnection, refreshCategory, reportUncertainCategory };
}

/** Only definitive protocol rejection proves that the requested mutation did not commit. */
export function isRejectedSessionMutation(error: unknown): boolean {
  return (
    error instanceof GatewayProtocolRequestError &&
    (error.gatewayCode === ErrorCodes.INVALID_REQUEST ||
      error.gatewayCode === ErrorCodes.FORBIDDEN ||
      error.gatewayCode === ErrorCodes.APPROVAL_NOT_FOUND)
  );
}
