import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { SESSIONS_PATCH_MANY_MAX_TARGETS } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import { readSessionMethodAccess } from "../session-method-access.ts";
import { parseAgentSessionKey } from "./session-key.ts";
import { withSessionMutationOperations } from "./session-mutation-operations.ts";
import type { SessionMutationsHost } from "./session-mutations-host.ts";
import {
  createOptimisticRowField,
  resolvePendingConversation,
  resolvePendingRowTarget,
} from "./session-pending-rows.ts";

type HiddenRunReadRow = Pick<
  GatewaySessionRow,
  "key" | "agentId" | "sessionId" | "sharingRole" | "markedUnreadAt"
>;
export type HiddenRunReadOutcome = { key: string; ok: boolean; error?: unknown };

/** One transport owner for folded reads, including concurrent panes and organizer actions. */
export function createHiddenRunReads(
  host: SessionMutationsHost,
  unread: ReturnType<typeof createOptimisticRowField<"unread">>,
) {
  let pending: Promise<unknown> = Promise.resolve();
  return (
    rows: readonly HiddenRunReadRow[],
    options: { agentId?: string; publishErrors?: boolean } = {},
  ): Promise<HiddenRunReadOutcome[]> => {
    const scope = host.connection.capture();
    if (!scope) {
      return Promise.resolve(rows.map(({ key }) => ({ key, ok: false })));
    }
    const snapshot = host.snapshot();
    const entries = rows.map((row) => {
      const agentId = parseAgentSessionKey(row.key)?.agentId ?? row.agentId ?? options.agentId;
      const target = {
        key: row.key,
        ...(agentId ? { agentId } : {}),
        ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}),
        expectedMarkedUnreadAt: null,
      };
      const allowed = () =>
        row.markedUnreadAt == null &&
        row.sharingRole !== "viewer" &&
        readSessionMethodAccess(host.snapshot(), {
          method: "sessions.patchMany",
          params: { targets: [target], patch: { unread: false } },
          sessionScope: true,
          session: row,
        }).allowed;
      const conversation = resolvePendingConversation(snapshot, row.key, agentId);
      const optimisticTarget = resolvePendingRowTarget(host, snapshot, conversation, row.sessionId);
      const token =
        allowed() && optimisticTarget ? unread.prepare(() => false)(optimisticTarget) : null;
      return { row, target, optimisticTarget, token, allowed };
    });
    const run = async (): Promise<HiddenRunReadOutcome[]> => {
      const outcomes = new Map<string, HiddenRunReadOutcome>();
      const errors: string[] = [];
      try {
        for (let start = 0; start < entries.length; start += SESSIONS_PATCH_MANY_MAX_TARGETS) {
          if (!host.connection.isCurrent(scope)) {
            break;
          }
          const chunk = entries.slice(start, start + SESSIONS_PATCH_MANY_MAX_TARGETS);
          try {
            const result = await withSessionMutationOperations((runtime) => {
              // A cold import or an earlier chunk can outlive the original grant.
              const targets = chunk.filter((entry) => entry.allowed()).map((entry) => entry.target);
              return targets.length === 0
                ? null
                : runtime.patchSessionBatch(host, scope, snapshot, targets, { unread: false });
            });
            if (!host.connection.isCurrent(scope)) {
              break;
            }
            for (const outcome of result?.outcomes ?? []) {
              const error = outcome.ok ? undefined : new GatewayProtocolRequestError(outcome.error);
              outcomes.set(outcome.key, {
                key: outcome.key,
                ok: outcome.ok,
                ...(error ? { error } : {}),
              });
              if (error) {
                errors.push(`${outcome.key}: ${formatUiError(error)}`);
              }
            }
          } catch (error) {
            for (const { row } of chunk) {
              outcomes.set(row.key, { key: row.key, ok: false, error });
            }
            errors.push(formatUiError(error));
          }
        }
      } finally {
        // Admitted row events update the optimistic owner's canonical value,
        // including newer manual markers; read acknowledgements do not change membership.
        for (const { row, optimisticTarget, token } of entries) {
          if (optimisticTarget && token) {
            unread.settle(
              optimisticTarget,
              token,
              outcomes.get(row.key)?.ok === true,
              host.connection.isCurrent(scope),
            );
          }
        }
      }
      const results = entries.map(({ row }): HiddenRunReadOutcome =>
        host.connection.isCurrent(scope)
          ? (outcomes.get(row.key) ?? { key: row.key, ok: false })
          : { key: row.key, ok: false },
      );
      if (options.publishErrors && errors.length > 0 && host.connection.isCurrent(scope)) {
        host.publish({ ...host.readState(), error: errors.join("; ") }, "operation");
      }
      return results;
    };
    const execution = pending.then(run);
    pending = execution.catch(() => undefined);
    return execution;
  };
}
