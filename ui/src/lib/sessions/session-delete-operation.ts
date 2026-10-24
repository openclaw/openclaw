import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionsDeleteResult } from "../../../../packages/gateway-protocol/src/index.js";
import { SESSION_ARCHIVE_REQUEST_OPTIONS } from "../../../../src/shared/session-archive-timeout.ts";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerSessionOrganizationEnglish } from "../../i18n/locales/en-session-organization.ts";
import { formatUiError } from "../format-error.ts";
import { showToast } from "../toast.ts";
import type { Deletion, SessionDeletionOperationsHost } from "./session-deletions.ts";
import { buildSessionRequestParams } from "./session-requests.ts";
import type {
  SessionConnectionScope,
  SessionDeleteOutcome,
  SessionDeleteBatchResult,
  SessionDeleteTarget,
} from "./session-types.ts";

registerSessionOrganizationEnglish();

function performSessionDelete(
  deletion: Deletion,
  scope: SessionConnectionScope,
  allowAbsent: boolean,
  host: SessionDeletionOperationsHost,
): Promise<SessionDeleteOutcome> {
  if (deletion.operation) {
    return deletion.operation;
  }
  deletion.operation = (async () => {
    const { target } = deletion;
    if (!host.owns(deletion)) {
      return { deleted: false };
    }
    if (!host.connection.isCurrent(scope)) {
      host.rollback(deletion);
      const error = new Error(t("sessionsView.deleteSessionStale", { session: target.key }));
      host.reportError(error.message);
      throw error;
    }
    const confirmAbsent = async () => {
      if (!allowAbsent || !host.connection.isCurrent(scope)) {
        return false;
      }
      try {
        const result = await scope.client.request<{ session: GatewaySessionRow | null }>(
          "sessions.describe",
          { key: target.key, agentId: target.agentId },
        );
        if (result.session !== null || !host.connection.isCurrent(scope) || !host.owns(deletion)) {
          return false;
        }
        host.confirm(deletion, target.key);
        return true;
      } catch {
        // A failed read is not proof that the target is gone.
        return false;
      }
    };
    try {
      if (deletion.archiveBeforeDelete) {
        const archived = await host.patchNow(target.key, { archived: true }, target);
        if (!host.owns(deletion)) {
          return { deleted: false };
        }
        if (!host.connection.isCurrent(scope)) {
          host.rollback(deletion);
          return { deleted: false };
        }
        if (!archived) {
          throw new Error(t("sessionsView.deleteSessionStale", { session: target.key }));
        }
        deletion.archiveBeforeDelete = false;
      }
      const response = await scope.client.request<SessionsDeleteResult>(
        "sessions.delete",
        {
          ...buildSessionRequestParams(target.key, target.agentId),
          deleteTranscript: target.deleteTranscript ?? true,
          ...(target.expectedSessionId ? { expectedSessionId: target.expectedSessionId } : {}),
          ...(target.archivedOnly === true ? { archivedOnly: true } : {}),
        },
        SESSION_ARCHIVE_REQUEST_OPTIONS,
      );
      if (!host.owns(deletion)) {
        return { deleted: false };
      }
      if (!response.deleted && deletion.phase !== "confirmed") {
        if (await confirmAbsent()) {
          return { deleted: true };
        }
        if (!host.owns(deletion)) {
          return { deleted: false };
        }
        host.rollback(deletion);
        if (allowAbsent) {
          host.reportError(t("sessionsView.deleteSessionStale", { session: target.key }));
        }
        return { deleted: false };
      }
      host.confirm(deletion, target.key);
      return {
        deleted: true,
        ...(response.worktreePreserved ? { worktreePreserved: response.worktreePreserved } : {}),
      };
    } catch (error) {
      if (!host.owns(deletion)) {
        return { deleted: false };
      }
      // A missing expected incarnation (or missing archived row) can reject
      // before deletion. Permission and other failures must still roll back.
      if (
        error instanceof GatewayRequestError &&
        error.gatewayCode === "INVALID_REQUEST" &&
        ((isRecord(error.details) && error.details.reason === "session-changed") ||
          error.message ===
            `Session ${target.key} is not archived. Archive it first, then delete it.`) &&
        (await confirmAbsent())
      ) {
        return { deleted: true };
      }
      if (!host.owns(deletion)) {
        return { deleted: false };
      }
      host.rollback(deletion);
      host.reportError(formatUiError(error));
      throw error;
    }
  })();
  return deletion.operation;
}

export async function runDeferredSessionDelete(
  deletion: Deletion,
  scope: SessionConnectionScope,
  host: SessionDeletionOperationsHost,
): Promise<void> {
  if (!host.owns(deletion)) {
    return;
  }
  if (!host.connection.isCurrent(scope)) {
    host.rollback(deletion);
    host.reportError(t("sessionsView.deleteSessionStale", { session: deletion.target.key }));
    return;
  }
  try {
    const outcome = await performSessionDelete(deletion, scope, true, host);
    if (outcome.worktreePreserved) {
      const { formatPreservedWorktreesNotice } = await import("./worktree-preservation.ts");
      if (host.connection.isCurrent(scope)) {
        showToast({ message: formatPreservedWorktreesNotice([outcome.worktreePreserved]) });
      }
    }
    if (outcome.deleted && host.connection.isCurrent(scope)) {
      await host.reconcileMutation(deletion.target.agentId);
    }
  } catch (error) {
    if (host.owns(deletion)) {
      host.rollback(deletion);
      host.reportError(formatUiError(error));
    }
  }
}

export async function settleSessionDeleteBatch(
  records: Map<Deletion, Map<string, SessionDeleteTarget>>,
  targets: readonly SessionDeleteTarget[],
  scope: SessionConnectionScope,
  host: SessionDeletionOperationsHost,
): Promise<SessionDeleteBatchResult> {
  const result: SessionDeleteBatchResult = { deleted: [], errors: [], preservedWorktrees: [] };
  for (const [record, callerTargets] of records) {
    if (!host.connection.isCurrent(scope) && !record.operation) {
      const unstarted = [...records.keys()].filter(
        (candidate) => !candidate.operation && host.owns(candidate),
      );
      if (unstarted.length > 0) {
        const error = new Error(
          t("sessionsView.deleteSessionsStale", { count: String(targets.length) }),
        );
        for (const candidate of unstarted) {
          host.rollback(candidate);
          for (const target of records.get(candidate)!.values()) {
            result.errors.push({ target, error });
          }
        }
        host.reportError(error.message);
      }
      break;
    }
    try {
      const outcome = await performSessionDelete(record, scope, false, host);
      if (outcome.deleted) {
        result.deleted.push(...callerTargets.keys());
        if (outcome.worktreePreserved) {
          result.preservedWorktrees.push(outcome.worktreePreserved);
        }
      }
    } catch (error) {
      for (const target of callerTargets.values()) {
        result.errors.push({ target, error });
      }
    }
  }
  if (result.deleted.length > 0) {
    if (host.connection.isCurrent(scope)) {
      await host.reconcileMutation(targets.length === 1 ? targets[0]?.agentId : undefined);
    }
    if (!host.connection.isCurrent(scope) && !(await host.reconcilePreviousConnection(scope))) {
      return { deleted: [], errors: [], preservedWorktrees: [] };
    }
  }
  return result;
}
