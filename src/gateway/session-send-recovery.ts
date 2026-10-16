import { resolveNestedAgentLaneForSession } from "../agents/lanes.js";
import { discoverRestartRecoveryStoreTargets } from "../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import { decodeRequesterOrigin } from "../agents/requester-origin.js";
import type { AgentToolGatewayRequestCaller } from "../agents/tools/in-process-gateway.js";
import {
  prepareSessionsSendCommunication,
  SessionCommunicationDeniedError,
} from "../agents/tools/sessions-send-communication.js";
import { appendSessionTranscriptReport } from "../config/sessions/session-accessor.js";
import { readPendingInputRecoveryEntriesInWorker } from "../config/sessions/session-entry-read-maintenance.js";
import { listSessionPendingInputs } from "../config/sessions/session-pending-input-history.js";
import { readPendingInputSource } from "../config/sessions/session-pending-input-source.js";
import type { SessionPendingInput } from "../config/sessions/session-pending-input.types.js";
import { withSessionTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import { sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessageForDisplay } from "../infra/error-diagnostics.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import { isTransientRestartRecoveryError } from "../infra/restart-recovery-errors.js";
import { getRetryAttemptErrors } from "../infra/retry-attempt-errors.js";
import { retryAsync } from "../infra/retry.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import type { CommunicationEndpoint } from "../sessions/communication-admission.js";
import { AgentDatabaseAdmissionError } from "../state/agent-database-admission.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import type { RestoredGatewayOperatorAuthority } from "./operator-run-recovery.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  readSessionSendDelivery,
  withSessionSendDelivery,
  type SessionSendDeliveryEndpoint,
} from "./session-send-delivery.js";
import { SessionStoreUnavailableError } from "./session-utils-store-error.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";

class SessionSendEndpointChangedError extends Error {}
class SessionSendRequesterUnavailableError extends Error {}

function matches(endpoint: CommunicationEndpoint, expected: SessionSendDeliveryEndpoint): boolean {
  return (
    endpoint.agentId === expected.agentId &&
    endpoint.sessionKey === expected.sessionKey &&
    endpoint.entry?.sessionId === expected.sessionId &&
    endpoint.entry.lifecycleRevision === expected.lifecycleRevision
  );
}

/** Re-admit accepted peer inputs, not predecessor executions or sender tool calls. */
export async function recoverSessionSendDeliveries(
  context: GatewayRequestContext,
  signal: AbortSignal,
): Promise<void> {
  const runtime = context.recoveryRuntime;
  if (!runtime) {
    return;
  }
  const config = context.getRuntimeConfig();
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (context.getRuntimeConfig() !== config) {
      throw new Error("Session delivery recovery configuration changed");
    }
  };
  const isTransient = (error: unknown) =>
    isTransientRestartRecoveryError(error) ||
    (error instanceof SessionStoreUnavailableError &&
      (error.reason === "schema-missing" || isSqliteLockError(error.readError)));
  const retry = <T>(operation: () => Promise<T>) =>
    retryAsync(
      async () => {
        assertCurrent();
        return operation();
      },
      {
        attempts: 3,
        minDelayMs: 5_000,
        maxDelayMs: 10_000,
        shouldRetry: (error) => !signal.aborted && isTransient(error),
        sleep: (ms) => sleepWithAbort(ms, signal, { ref: false }),
        onRetry: ({ err, attempt, delayMs }) => {
          context.logGateway.warn(
            `Session delivery recovery retry after attempt ${attempt} in ${delayMs}ms: ${formatErrorMessageForDisplay(err, formatErrorMessageWithCode(err))}`,
          );
        },
      },
    );
  const targets = await retry(() =>
    discoverRestartRecoveryStoreTargets({
      cfg: config,
      shouldContinue: () => !signal.aborted,
    }),
  );
  let blockedCount = 0;
  for (const target of targets) {
    assertCurrent();
    const entries = await retry(() => readPendingInputRecoveryEntriesInWorker(target));
    for (const { sessionKey, entry } of entries) {
      const scope = {
        ...target,
        sessionKey,
        sessionId: entry.sessionId,
        expectedLifecycleRevision: entry.lifecycleRevision,
      };
      // History visits newest pages first, with each page already chronological.
      // Prepend older pages so the target receives accepted messages in order.
      const pending: SessionPendingInput[] = [];
      let before: number | undefined;
      do {
        assertCurrent();
        const page = await retry(() => listSessionPendingInputs(scope, { limit: 20, before }));
        pending.unshift(...page.items);
        before = page.nextBefore;
      } while (before !== undefined);
      const blocked: {
        inputId: string;
        sourceSessionKey: string;
        reason:
          | "endpoint-replaced"
          | "requester-unavailable"
          | "permission-denied"
          | "transient-admission"
          | "store-unavailable"
          | "unknown";
        attempts: number;
      }[] = [];
      for (const input of pending) {
        assertCurrent();
        const delivery = readSessionSendDelivery(input.message);
        if (!delivery || input.state !== "interrupted") {
          continue;
        }
        let attempts = 0;
        try {
          await retry(async () => {
            attempts++;
            let communication:
              | Awaited<ReturnType<typeof prepareSessionsSendCommunication>>
              | undefined;
            let operator: RestoredGatewayOperatorAuthority | undefined;
            try {
              const load = async (
                endpoint: SessionSendDeliveryEndpoint,
              ): Promise<CommunicationEndpoint> => {
                const loaded = await resolveGatewaySessionStoreTargetInWorker({
                  cfg: config,
                  key: endpoint.sessionKey,
                  agentId: endpoint.agentId,
                  assertActive: assertCurrent,
                  projection: "full",
                });
                const result = {
                  agentId: loaded.agentId,
                  sessionKey: loaded.canonicalKey,
                  storePath: loaded.readSource?.path ?? loaded.storePath,
                  entry: loaded.store[loaded.canonicalKey],
                };
                if (!matches(result, endpoint) || result.entry?.archivedAt) {
                  throw new SessionSendEndpointChangedError(
                    "Session delivery endpoint was replaced",
                  );
                }
                return result;
              };
              const [source, destination] = await Promise.all([
                load(delivery.source),
                load(delivery.target),
              ]);
              if (
                destination.sessionKey !== sessionKey ||
                destination.entry?.sessionId !== entry.sessionId ||
                destination.agentId !== target.agentId
              ) {
                throw new SessionSendEndpointChangedError(
                  "Session delivery target does not own this input",
                );
              }
              const callGateway: AgentToolGatewayRequestCaller = async () => {
                // Exact endpoint lineage is already loaded above. Recovery cannot
                // widen access through a fresh lookup or prompt for old consent.
                throw new Error("Session delivery recovery requires current direct access");
              };
              communication = await prepareSessionsSendCommunication({
                config,
                source,
                target: destination,
                message: delivery.message,
                dispatchMessage: delivery.message,
                inputProvenance: input.message.provenance,
                access: { sandboxed: delivery.sandboxed },
                allowApproval: false,
                assertSourceCurrent: assertCurrent,
                callGateway,
                signal,
              });
              const retained = await readPendingInputSource(
                scope,
                input.message.idempotencyKey!,
                true,
              );
              const row = retained?.snapshot.pending;
              if (
                !retained?.snapshot.current ||
                !row ||
                row.input_id !== input.id ||
                row.state !== "interrupted" ||
                row.consumed_event_id != null ||
                row.message_json !== JSON.stringify(input.message)
              ) {
                return;
              }
              await communication.refresh();
              const guard = () => {
                assertCurrent();
                retained.assertCurrent();
                communication!.assertCurrent();
              };
              guard();
              const savedOrigin = input.message["__openclaw"]?.requesterOrigin;
              const requesterOrigin = decodeRequesterOrigin(savedOrigin);
              if (
                (savedOrigin !== undefined && !requesterOrigin) ||
                delivery.operatorSource === undefined
              ) {
                throw new SessionSendRequesterUnavailableError();
              }
              let accepted = false;
              const assertRequesterCurrent = () => {
                signal.throwIfAborted();
                // Admission transfers custody to the turn. Pending consumption and
                // closing this communication lease must not revoke accepted work.
                if (!accepted) {
                  guard();
                }
              };
              try {
                if (delivery.operatorSource !== null) {
                  const { restoreGatewayQueuedOperatorRecovery } =
                    await import("./operator-run-recovery.js");
                  operator = await restoreGatewayQueuedOperatorRecovery({
                    source: delivery.operatorSource,
                    context,
                    assertCurrent: assertRequesterCurrent,
                  });
                }
                if (
                  requesterOrigin?.operatorProfileId &&
                  requesterOrigin.operatorProfileId !== operator?.authority.profileId
                ) {
                  throw new SessionSendRequesterUnavailableError();
                }
              } catch (error) {
                if (isTransient(error)) {
                  throw error;
                }
                throw new SessionSendRequesterUnavailableError(undefined, { cause: error });
              }
              guard();
              await withSessionSendDelivery({ delivery, acceptedMessage: input.message }, () =>
                runtime.dispatchAgent(
                  {
                    agentId: delivery.target.agentId,
                    sessionKey: delivery.target.sessionKey,
                    expectedExistingSessionId: delivery.target.sessionId,
                    expectedExistingSessionLifecycleRevision:
                      delivery.target.lifecycleRevision ?? null,
                    idempotencyKey: delivery.runId,
                    message: delivery.message,
                    inputProvenance: input.message.provenance,
                    deliver: false,
                    sourceReplyDeliveryMode: "message_tool_only",
                    channel: INTERNAL_MESSAGE_CHANNEL,
                    lane: resolveNestedAgentLaneForSession(delivery.target.sessionKey),
                  },
                  undefined,
                  {
                    signal,
                    assertAdmissionCurrent: assertRequesterCurrent,
                    operatorRunAuthority: operator?.authority,
                    agentToolCaller: requesterOrigin
                      ? {
                          agentId: delivery.source.agentId,
                          sessionKey: delivery.source.sessionKey,
                          requesterOrigin,
                        }
                      : undefined,
                  },
                ),
              );
              accepted = true;
            } finally {
              operator?.release();
              communication?.close();
            }
          });
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          blockedCount++;
          blocked.push({
            inputId: input.id,
            sourceSessionKey: delivery.source.sessionKey,
            reason:
              error instanceof SessionSendEndpointChangedError
                ? "endpoint-replaced"
                : error instanceof SessionSendRequesterUnavailableError
                  ? "requester-unavailable"
                  : error instanceof SessionCommunicationDeniedError
                    ? "permission-denied"
                    : isTransient(error)
                      ? "transient-admission"
                      : error instanceof SessionStoreUnavailableError ||
                          error instanceof AgentDatabaseAdmissionError
                        ? "store-unavailable"
                        : "unknown",
            attempts,
          });
          const causes = [
            ...new Set((getRetryAttemptErrors(error) ?? [error]).map(formatErrorMessageWithCode)),
          ];
          context.logGateway.warn(
            `Session delivery recovery blocked after ${attempts} attempts: ${formatErrorMessageForDisplay(error, causes.join("; "))}`,
          );
        }
      }
      if (blocked.length > 0) {
        const customType = "session-send-recovery-blocked";
        const displayed = blocked.slice(0, 20);
        const details = { inputs: displayed, total: blocked.length };
        const content =
          "Agent updates not delivered after restart:\n" +
          displayed
            .map(({ sourceSessionKey, reason, attempts }) => {
              const description = {
                "endpoint-replaced":
                  "the source or destination session was reset, archived, or replaced",
                "requester-unavailable":
                  "original requester authority is unavailable; submit a new request",
                "permission-denied": "current session permissions do not allow automatic delivery",
                "transient-admission": `the Gateway was still unavailable after ${attempts} automatic attempts`,
                "store-unavailable": "session storage was unavailable",
                unknown: "delivery failed",
              }[reason];
              return `- From ${sourceSessionKey}: ${description}.`;
            })
            .join("\n") +
          (blocked.length > displayed.length
            ? `\n${blocked.length - displayed.length} more updates were not delivered.`
            : "") +
          "\nThe updates remain saved; no sender task was rerun. Resend the update or ask the sender to retry.";
        const result = await retry(() =>
          withSessionTranscriptWriteAssertion(scope, assertCurrent, () =>
            appendSessionTranscriptReport(scope, {
              kind: "custom",
              customTypes: [customType],
              selectReport: (latest) =>
                latest?.content === content &&
                JSON.stringify(latest.details) === JSON.stringify(details)
                  ? undefined
                  : {
                      customType,
                      content,
                      details,
                      display: true,
                      excludeFromContext: true,
                    },
            }),
          ),
        );
        if (!result.ok) {
          context.logGateway.warn(
            "Could not record blocked agent-update delivery notice; inputs retained.",
          );
        }
      }
    }
  }
  if (blockedCount > 0) {
    context.logGateway.warn(
      `Session delivery recovery blocked for ${blockedCount} saved inputs; inputs retained.`,
    );
  }
}
