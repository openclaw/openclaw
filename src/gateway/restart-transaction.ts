import { randomUUID } from "node:crypto";
import { replyRunRegistry } from "../auto-reply/reply/reply-run-registry.js";
import { type RestartSentinelPayload, writeRestartSentinel } from "../infra/restart-sentinel.js";
import {
  type RestartTransaction,
  type RestartTransactionMode,
  type RestartTransactionRequester,
  updateRestartTransaction,
  writeRestartTransaction,
} from "../infra/restart-transaction.js";
import { scheduleGatewaySigusr1Restart, type ScheduledRestart } from "../infra/restart.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

function cloneTransaction(transaction: RestartTransaction): RestartTransaction {
  return JSON.parse(JSON.stringify(transaction)) as RestartTransaction;
}

async function writeSentinelForTransaction(
  payload: RestartSentinelPayload,
  transaction: RestartTransaction,
): Promise<string | null> {
  try {
    return await writeRestartSentinel({
      ...payload,
      transaction: cloneTransaction(transaction),
    });
  } catch {
    return null;
  }
}

async function advanceRestartTransaction(params: {
  transaction: RestartTransaction;
  state: RestartTransaction["state"];
  finalOutcome?: string | null;
}): Promise<RestartTransaction> {
  const next: RestartTransaction = {
    ...params.transaction,
    state: params.state,
    ...(params.finalOutcome !== undefined ? { finalOutcome: params.finalOutcome } : {}),
  };
  await writeRestartTransaction(next);
  return next;
}

export async function requestGatewayRestartTransaction(params: {
  payload: RestartSentinelPayload;
  requester?: RestartTransactionRequester | null;
  entryPoint: string;
  reason?: string | null;
  restartDelayMs?: number;
}): Promise<{
  restart: ScheduledRestart;
  sentinelPath: string | null;
  transaction: RestartTransaction;
  mode: RestartTransactionMode;
}> {
  const sessionKey = normalizeOptionalString(params.payload.sessionKey);
  const activeRun = sessionKey ? replyRunRegistry.get(sessionKey) : undefined;
  const mode: RestartTransactionMode = activeRun ? "terminal-handoff" : "drain-then-restart";
  const turnId = activeRun?.sessionId;
  const transactionBase: RestartTransaction = {
    restartId: randomUUID(),
    requestedAt: Date.now(),
    requester: params.requester ?? null,
    reason: params.reason ?? null,
    sessionKey: sessionKey ?? undefined,
    turnId,
    mode,
    state: "requested",
    note: params.payload.message ?? null,
    deliveryContext: params.payload.deliveryContext ?? null,
    threadId: params.payload.threadId,
    interruptedTurn: activeRun
      ? {
          sessionKey,
          turnId,
          phase: activeRun.phase,
          interruptionCause: "gateway_restart",
          pendingUserVisibleFollowupNote: params.payload.message ?? null,
          resumeEligible: false,
        }
      : null,
  };

  await writeRestartTransaction(transactionBase);
  let transaction = await advanceRestartTransaction({
    transaction: transactionBase,
    state: "acked",
  });
  let sentinelPath = await writeSentinelForTransaction(params.payload, transaction);

  try {
    transaction = await advanceRestartTransaction({
      transaction,
      state: mode === "terminal-handoff" ? "handoff_pending" : "draining",
    });
    sentinelPath = (await writeSentinelForTransaction(params.payload, transaction)) ?? sentinelPath;

    if (activeRun) {
      activeRun.abortForRestart();
    }

    const restart = scheduleGatewaySigusr1Restart({
      delayMs: params.restartDelayMs,
      reason: params.reason ?? params.entryPoint,
      audit:
        params.requester &&
        (params.requester.actor || params.requester.deviceId || params.requester.clientIp)
          ? {
              actor: params.requester.actor,
              deviceId: params.requester.deviceId,
              clientIp: params.requester.clientIp,
              changedPaths: [],
            }
          : undefined,
    });

    transaction = await advanceRestartTransaction({
      transaction,
      state: "restarting",
      finalOutcome: restart.coalesced ? "coalesced" : "scheduled",
    });
    sentinelPath = (await writeSentinelForTransaction(params.payload, transaction)) ?? sentinelPath;

    return {
      restart,
      sentinelPath,
      transaction,
      mode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateRestartTransaction((current) => {
      if (!current || current.restartId !== transaction.restartId) {
        return current;
      }
      return {
        ...current,
        state: "needs_attention",
        finalOutcome: message,
        finalizedAt: Date.now(),
      };
    });
    throw error;
  }
}
