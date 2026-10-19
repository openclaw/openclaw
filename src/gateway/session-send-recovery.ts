import { sha256HexPrefixCore } from "@openclaw/normalization-core/node-crypto";
import { resolveNestedAgentLaneForSession } from "../agents/lanes.js";
import { discoverRestartRecoveryStoreTargets } from "../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import { decodeRequesterOrigin } from "../agents/requester-origin.js";
import { SessionCommunicationDeniedError } from "../agents/tools/sessions-send-communication.js";
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
import {
  AgentDatabaseAdmissionError,
  listAgentDatabaseAdmissionRefusals,
  readAgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";
import { waitForAgentDatabasePreparation } from "../state/agent-database-preparation-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import type { RestoredGatewayOperatorAuthority } from "./operator-run-recovery.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";
import { readSessionSendDelivery, withSessionSendDelivery } from "./session-send-delivery.js";
import {
  prepareSessionSendRecoveryCommunication,
  SessionSendEndpointChangedError,
} from "./session-send-recovery-source.js";
import { SessionStoreUnavailableError } from "./session-utils-store-error.js";
class SessionSendRequesterUnavailableError extends Error {}

/** Re-admit accepted peer inputs, not predecessor executions or sender tool calls. */
export async function recoverSessionSendDeliveries(
  context: GatewayRequestContext,
  signal: AbortSignal,
  startupTrace?: GatewayStartupTrace,
): Promise<void> {
  if (!context.recoveryRuntime) {
    return;
  }
  const config = context.getRuntimeConfig();
  const pendingAgents = listAgentDatabaseAdmissionRefusals()
    .filter((refusal) => refusal.code === "agent-database-inspection-pending")
    .map((refusal) => refusal.agentId);
  await recoverSessionSendDeliveriesForAgents(context, config, signal, startupTrace);
  // Discovery skips pending stores. Join their existing admission owner before rescanning.
  const rescans = await Promise.allSettled(
    pendingAgents.map(async (agentId) => {
      await waitForAgentDatabasePreparation(agentId, { signal });
      signal.throwIfAborted();
      if (!readAgentDatabaseAdmissionRefusal(agentId)) {
        await recoverSessionSendDeliveriesForAgents(
          context,
          context.getRuntimeConfig(),
          signal,
          startupTrace,
          new Set([agentId]),
        );
      }
    }),
  );
  for (const result of rescans) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
}

async function recoverSessionSendDeliveriesForAgents(
  context: GatewayRequestContext,
  config: OpenClawConfig,
  signal: AbortSignal,
  startupTrace?: GatewayStartupTrace,
  agentIds?: ReadonlySet<string>,
): Promise<void> {
  const runtime = context.recoveryRuntime;
  if (!runtime) {
    return;
  }
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
  const retry = <T>(operation: () => Promise<T>, phase?: string) =>
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
            sleepWithAbort(ms, signal, { ref: false }),
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
  for (const target of targets) {
    assertCurrent();
    const entries = await retry(
      () => readPendingInputRecoveryEntriesInWorker(target),
      "sidecars.delivery-entries",
    );
    for (const { sessionKey, entry } of entries) {
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
        if (!delivery || input.state !== "interrupted") {
          continue;
        }
        let attempts = 0;
        try {
          await retry(async () => {
            attempts++;
            let communication:
              | Awaited<ReturnType<typeof prepareSessionSendRecoveryCommunication>>
              | undefined;
            let operator:
              | Pick<RestoredGatewayOperatorAuthority, "authority" | "controlUiAdmin" | "release">
              | undefined;
            try {
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
              communication = await prepareSessionSendRecoveryCommunication({
                config,
                delivery,
                inputProvenance: input.message.provenance,
                target: scope,
                assertCurrent: () => {
                  assertCurrent();
                  retained.assertCurrent();
                },
                signal,
              });
              if (!communication) {
                // Archive stops work without replacing the transcript. Retain the
                // cancelled receipt, but do not create a misleading failure notice.
                await discardSessionPendingInput(scope, input.runId, assertCurrent);
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
                    ...(delivery.returnedResult ? { replyExpectation: "optional" as const } : {}),
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
          }, "sidecars.delivery-replay");
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          blockedCount++;
          if (error instanceof SessionSendEndpointChangedError) {
            undeliverableRunIds.push(input.runId);
          }
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
            `Session delivery recovery blocked after ${attempts} attempts: ${formatErrorMessageForDisplay(error, causes.join("; "))} ${JSON.stringify({ sessionKeyHash: sha256HexPrefixCore(sessionKey, 16), inputId: input.id, ageMs: Math.max(0, Date.now() - input.acceptedAt) })}`,
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
                "endpoint-replaced": "the source or destination session was reset or replaced",
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
    }
  }
  if (blockedCount > 0) {
    context.logGateway.warn(
      `Session delivery recovery blocked for ${blockedCount} saved inputs; ${cancelledCount} cancelled as undeliverable, ${blockedCount - cancelledCount} retained for retry.`,
    );
  }
}
