import { sha256HexPrefixCore } from "@openclaw/normalization-core/node-crypto";
import pLimit from "p-limit";
import { resolveNestedAgentLaneForSession } from "../agents/lanes.js";
import { discoverRestartRecoveryStoreTargets } from "../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import { decodeRequesterOrigin } from "../agents/requester-origin.js";
import { SessionCommunicationDeniedError } from "../agents/tools/sessions-send-communication.js";
import { isMainRestartRecoveryCandidate } from "../config/sessions/restart-recovery-state.js";
import { appendSessionTranscriptReport } from "../config/sessions/session-accessor.js";
import { readPendingInputRecoveryEntriesInWorker } from "../config/sessions/session-entry-read-maintenance.js";
import { readSessionSendRecoveryPage } from "../config/sessions/session-pending-input-history.js";
import { readPendingInputSource } from "../config/sessions/session-pending-input-source.js";
import { discardSessionPendingInput } from "../config/sessions/session-pending-input-withdrawal.js";
import type { SessionPendingInput } from "../config/sessions/session-pending-input.types.js";
import { withSessionTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessageForDisplay } from "../infra/error-diagnostics.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import { isTransientRestartRecoveryError } from "../infra/restart-recovery-errors.js";
import { getRetryAttemptErrors } from "../infra/retry-attempt-errors.js";
import { retryAsync } from "../infra/retry.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { AgentDatabaseAdmissionError } from "../state/agent-database-admission.js";
import { recoverAfterAgentDatabasePreparation } from "../state/agent-database-preparation-recovery.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { CHAT_INPUT_RECOVERY_MAX_AGE_MS } from "./chat-input-recovery-source.js";
import type { RestoredGatewayOperatorAuthority } from "./operator-run-recovery.js";
import {
  createPendingInputRecoveryTrace,
  type PendingInputRecoveryTrace,
} from "./pending-input-recovery-trace.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";
import { readSessionSendDelivery, withSessionSendDelivery } from "./session-send-delivery.js";
import {
  prepareSessionSendRecoveryCommunication,
  SessionSendEndpointChangedError,
} from "./session-send-recovery-source.js";
import { SessionStoreUnavailableError } from "./session-utils-store-error.js";
class SessionSendRequesterUnavailableError extends Error {}

/** Discover saved inputs; existing turn owners retain execution and sender custody. */
export async function recoverSessionSendDeliveries(
  context: GatewayRequestContext,
  signal: AbortSignal,
  startupTrace?: GatewayStartupTrace,
): Promise<void> {
  if (!context.recoveryRuntime) {
    return;
  }
  const config = context.getRuntimeConfig();
  const replaySession = pLimit(4);
  await recoverAfterAgentDatabasePreparation(signal, (agentIds) =>
    recoverSessionSendDeliveriesForAgents(
      context,
      agentIds ? context.getRuntimeConfig() : config,
      signal,
      replaySession,
      startupTrace,
      agentIds,
    ),
  );
}

async function recoverSessionSendDeliveriesForAgents(
  context: GatewayRequestContext,
  config: OpenClawConfig,
  signal: AbortSignal,
  replaySession: ReturnType<typeof pLimit>,
  startupTrace?: GatewayStartupTrace,
  agentIds?: ReadonlySet<string>,
): Promise<void> {
  const runtime = context.recoveryRuntime;
  if (!runtime) {
    return;
  }
  const logSkippedInput = (
    input: SessionPendingInput,
    skipReason:
      | "predecessor-not-ready"
      | "state-not-interrupted"
      | "missing-recovery-metadata"
      | "expired",
  ) => {
    context.logGateway.debug(
      `Pending input replay: ${JSON.stringify({
        inputHash: sha256HexPrefixCore(input.id, 16),
        kind: readSessionSendDelivery(input.message) ? "peer" : "chat",
        outcome: "skipped",
        state: input.state,
        skipReason,
      })}`,
    );
  };
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
  const waitReason = (error: unknown) =>
    error instanceof SessionSendEndpointChangedError
      ? ("endpoint-replaced" as const)
      : error instanceof SessionSendRequesterUnavailableError
        ? ("requester-unavailable" as const)
        : error instanceof SessionCommunicationDeniedError
          ? ("permission-denied" as const)
          : isTransient(error)
            ? ("transient-admission" as const)
            : error instanceof SessionStoreUnavailableError ||
                error instanceof AgentDatabaseAdmissionError
              ? ("store-unavailable" as const)
              : ("unknown" as const);
  const retry = <T>(
    operation: () => Promise<T>,
    phase?: string,
    trace?: PendingInputRecoveryTrace,
  ) =>
    retryAsync(
      async () => {
        assertCurrent();
        return phase ? measureStartup(startupTrace, phase, operation) : operation();
      },
      {
        attempts: 3,
        minDelayMs: 5_000,
        maxDelayMs: 10_000,
        shouldRetry: (error) => !signal.aborted && isTransient(error),
        sleep: (ms) =>
          measureStartup(startupTrace, "sidecars.delivery-retry-wait", () =>
            trace
              ? trace.measure("retryWaitMs", () => sleepWithAbort(ms, signal, { ref: false }))
              : sleepWithAbort(ms, signal, { ref: false }),
          ),
        onRetry: ({ err, attempt, delayMs }) => {
          context.logGateway.warn(
            `Session delivery recovery retry after attempt ${attempt} in ${delayMs}ms: ${formatErrorMessageForDisplay(err, formatErrorMessageWithCode(err))}`,
          );
        },
      },
    );
  const targets = await retry(
    () =>
      discoverRestartRecoveryStoreTargets({
        cfg: config,
        agentIds,
        shouldContinue: () => !signal.aborted,
      }),
    "sidecars.delivery-discovery",
  );
  let blockedCount = 0;
  let cancelledCount = 0;
  const stores = await Promise.allSettled(
    targets.map(async (target) => {
      assertCurrent();
      const entries = await retry(
        () => readPendingInputRecoveryEntriesInWorker(target),
        "sidecars.delivery-entries",
      );
      // One task owns a session through retries; other sessions can make progress.
      const outcomes = await Promise.allSettled(
        entries.map(({ sessionKey, entry }) =>
          replaySession(async () => {
            const scope = {
              ...target,
              agentId: parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId,
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
              const page = await retry(
                () => readSessionSendRecoveryPage(scope, { before }),
                "sidecars.delivery-history",
              );
              pending.unshift(...page.items);
              before = page.nextBefore;
            } while (before !== undefined);
            // Peer replay enters agent admission directly, which would claim the
            // interrupted turn. Start that predecessor through its owner first.
            if (
              entry.abortedLastRun &&
              isMainRestartRecoveryCandidate(entry, sessionKey) &&
              pending.some(
                (input) => input.state === "interrupted" && readSessionSendDelivery(input.message),
              )
            ) {
              const { retryRestartAbortedMainSessionRecovery } =
                await import("../agents/main-session-recovery/main-session-restart-recovery.js");
              const recovery = await retryRestartAbortedMainSessionRecovery({
                ...scope,
                cfg: config,
                expectedSessionId: entry.sessionId,
                gatewayRuntime: runtime,
              });
              assertCurrent();
              if (recovery.started === 0 && recovery.settled === 0) {
                for (const input of pending) {
                  logSkippedInput(input, "predecessor-not-ready");
                }
                return;
              }
            }
            const undeliverableRunIds: string[] = [];
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
              if (input.state !== "interrupted") {
                logSkippedInput(input, "state-not-interrupted");
                continue;
              }
              if (!delivery && !input.message["__openclaw"]?.chatInputRecovery) {
                logSkippedInput(input, "missing-recovery-metadata");
                continue;
              }
              if (!delivery && Date.now() - input.acceptedAt > CHAT_INPUT_RECOVERY_MAX_AGE_MS) {
                logSkippedInput(input, "expired");
                continue;
              }
              let attempts = 0;
              const trace = createPendingInputRecoveryTrace();
              let outcome: "accepted" | "stale" | "cancelled" | "blocked" | "aborted" = "stale";
              let reason: ReturnType<typeof waitReason> | "none" = "none";
              let staleReason:
                | "session-changed"
                | "input-missing"
                | "input-changed"
                | "state-not-interrupted"
                | "consumed"
                | undefined;
              try {
                await retry(
                  async () => {
                    attempts++;
                    let communication:
                      | Awaited<ReturnType<typeof prepareSessionSendRecoveryCommunication>>
                      | undefined;
                    let operator:
                      | Pick<
                          RestoredGatewayOperatorAuthority,
                          "authority" | "controlUiAdmin" | "release"
                        >
                      | undefined;
                    try {
                      const retained = await trace.measure("sourceLoadMs", () =>
                        readPendingInputSource(scope, input.message.idempotencyKey!, true),
                      );
                      const row = retained?.snapshot.pending;
                      if (
                        !retained?.snapshot.current ||
                        !row ||
                        row.input_id !== input.id ||
                        row.run_id !== input.runId ||
                        row.state !== "interrupted" ||
                        row.consumed_event_id != null ||
                        row.message_json !== JSON.stringify(input.message)
                      ) {
                        staleReason = !retained?.snapshot.current
                          ? "session-changed"
                          : !row
                            ? "input-missing"
                            : row.state !== "interrupted"
                              ? "state-not-interrupted"
                              : row.consumed_event_id != null
                                ? "consumed"
                                : "input-changed";
                        return;
                      }
                      const assertInputCurrent = () => {
                        assertCurrent();
                        retained.assertCurrent();
                      };
                      if (!delivery) {
                        await runtime.resumeChatInput(
                          {
                            ...scope,
                            runId: input.runId,
                            message: input.message,
                            requestHash: row.request_hash,
                          },
                          { signal, assertCurrent: assertInputCurrent, trace },
                        );
                        outcome = "accepted";
                        return;
                      }
                      communication = await prepareSessionSendRecoveryCommunication({
                        config,
                        delivery,
                        inputProvenance: input.message.provenance,
                        target: scope,
                        assertCurrent: assertInputCurrent,
                        signal,
                        trace,
                      });
                      if (!communication) {
                        // Archive stops work without replacing the transcript. Retain the
                        // cancelled receipt, but do not create a misleading failure notice.
                        await discardSessionPendingInput(scope, input.runId, assertCurrent);
                        outcome = "cancelled";
                        return;
                      }
                      await trace.measure("communicationAdmissionMs", () =>
                        communication!.refresh(),
                      );
                      const guard = () => {
                        assertInputCurrent();
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
                          const source = delivery.operatorSource;
                          operator = await trace.measure("authorityRestoreMs", () =>
                            restoreGatewayQueuedOperatorRecovery({
                              source,
                              context,
                              assertCurrent: assertRequesterCurrent,
                            }),
                          );
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
                      await trace.measure("dispatchAckMs", () =>
                        withSessionSendDelivery({ delivery, acceptedMessage: input.message }, () =>
                          runtime.dispatchAgent(
                            {
                              agentId: delivery.target.agentId,
                              sessionKey: delivery.target.sessionKey,
                              expectedExistingSessionId: delivery.target.sessionId,
                              expectedExistingSessionLifecycleRevision:
                                delivery.target.lifecycleRevision ?? null,
                              idempotencyKey: delivery.runId,
                              message: delivery.message,
                              ...(delivery.returnedResult
                                ? { extraSystemPrompt: delivery.returnedResult.extraSystemPrompt }
                                : {}),
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
                              ...(delivery.returnedResult
                                ? { replyExpectation: "optional" as const }
                                : {}),
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
                        ),
                      );
                      accepted = true;
                      outcome = "accepted";
                    } finally {
                      operator?.release();
                      communication?.close();
                    }
                  },
                  "sidecars.delivery-replay",
                  trace,
                );
              } catch (error) {
                outcome = signal.aborted ? "aborted" : "blocked";
                reason = waitReason(error);
                if (signal.aborted) {
                  return;
                }
                if (!delivery) {
                  // Retain the existing interrupted notice when current policy blocks replay.
                  context.logGateway.warn(
                    `Chat input recovery blocked: ${formatErrorMessageForDisplay(error, formatErrorMessageWithCode(error))} ${JSON.stringify({ sessionKeyHash: sha256HexPrefixCore(sessionKey, 16), inputId: input.id, ageMs: Math.max(0, Date.now() - input.acceptedAt) })}`,
                  );
                  if (isTransient(error)) {
                    break;
                  }
                  continue;
                }
                blockedCount++;
                if (error instanceof SessionSendEndpointChangedError) {
                  undeliverableRunIds.push(input.runId);
                }
                blocked.push({
                  inputId: input.id,
                  sourceSessionKey: delivery.source.sessionKey,
                  reason,
                  attempts,
                });
                const causes = [
                  ...new Set(
                    (getRetryAttemptErrors(error) ?? [error]).map(formatErrorMessageWithCode),
                  ),
                ];
                context.logGateway.warn(
                  `Session delivery recovery blocked after ${attempts} attempts: ${formatErrorMessageForDisplay(error, causes.join("; "))} ${JSON.stringify({ sessionKeyHash: sha256HexPrefixCore(sessionKey, 16), inputId: input.id, ageMs: Math.max(0, Date.now() - input.acceptedAt) })}`,
                );
                if (isTransient(error)) {
                  break;
                }
              } finally {
                const timings = trace.finish();
                context.logGateway.info(
                  `Pending input replay: ${JSON.stringify({
                    inputHash: sha256HexPrefixCore(input.id, 16),
                    kind: delivery ? "peer" : "chat",
                    ...(staleReason ? { staleReason } : {}),
                    outcome,
                    waitReason:
                      reason === "none" && timings.retryWaitMs > 0 ? "transient-admission" : reason,
                    attempts,
                    ...timings,
                  })}`,
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
                        "the source or destination session was reset or replaced",
                      "requester-unavailable":
                        "original requester authority is unavailable; submit a new request",
                      "permission-denied":
                        "current session permissions do not allow automatic delivery",
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
                "\nThe updates remain saved; no sender task was rerun. Resend the update or ask the sender to retry." +
                (undeliverableRunIds.length > 0
                  ? " Updates with replaced endpoints will not be retried automatically."
                  : "");
              const result = await measureStartup(startupTrace, "sidecars.delivery-notices", () =>
                retry(() =>
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
                ),
              );
              if (!result.ok) {
                context.logGateway.warn(
                  "Could not record blocked agent-update delivery notice; inputs retained.",
                );
              } else {
                // Keep the notice durable before withdrawing replay. A crash between
                // these writes may retry cleanup, but cannot silently lose the update.
                for (const runId of undeliverableRunIds) {
                  if (await retry(() => discardSessionPendingInput(scope, runId, assertCurrent))) {
                    cancelledCount++;
                  }
                }
              }
            }
          }),
        ),
      );
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          throw outcome.reason;
        }
      }
    }),
  );
  for (const store of stores) {
    if (store.status === "rejected") {
      throw store.reason;
    }
  }
  if (blockedCount > 0) {
    context.logGateway.warn(
      `Session delivery recovery blocked for ${blockedCount} saved inputs; ${cancelledCount} cancelled as undeliverable, ${blockedCount - cancelledCount} retained for retry.`,
    );
  }
}
