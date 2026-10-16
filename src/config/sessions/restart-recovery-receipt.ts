import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { resolveRestartRecoveryTerminalDeliveryDisposition } from "./restart-recovery-receipt-state.js";
import { normalizeRestartRecoveryTerminalRunIds } from "./restart-recovery-state.js";
import type { SessionActorAuthority, SessionActorOutcome } from "./session-actor-contract.js";
import { runSessionActorCommand, withSessionActor } from "./session-actor-scope.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import type { SessionEntry } from "./types.js";

export type RestartRecoveryTerminalDeliveryScope = {
  sessionId: string;
  sessionKey: string;
  sourceTurnId: string;
  storePath: string;
  toolCallId: string;
};

/** Keep steering eligibility aligned with terminal-send ownership, using the exact active source. */
export function resolveRestartRecoverySteeringBlockReason(
  entry: SessionEntry | null | undefined,
  sessionId: string,
  sourceTurnId: string,
):
  | "terminal-pending"
  | "delivered-terminal"
  | "unresolved-terminal-tool"
  | "unknown-source-with-terminal-history"
  | "already-delivered"
  | "delivery-ambiguous"
  | "stale-claim"
  | undefined {
  if (!entry) {
    return undefined;
  }
  if (entry.restartRecoveryDeliveryReceiptState) {
    return entry.restartRecoveryDeliveryReceiptState;
  }
  if (entry.restartRecoveryDeliveryToolCallId) {
    return "unresolved-terminal-tool";
  }
  const normalizedSourceTurnId = normalizeOptionalString(sourceTurnId) ?? "";
  const disposition = resolveRestartRecoveryTerminalDeliveryDisposition(entry, {
    sessionId,
    sourceTurnId: normalizedSourceTurnId,
  });
  if (disposition === "not-applicable") {
    // Without a known active source, any retained tombstone could belong to it.
    if (
      normalizedSourceTurnId === "" &&
      (normalizeRestartRecoveryTerminalRunIds(entry.restartRecoveryTerminalRunIds)?.length ?? 0) > 0
    ) {
      return "unknown-source-with-terminal-history";
    }
    return undefined;
  }
  return disposition === "already-delivered" || disposition === "delivery-ambiguous"
    ? disposition
    : disposition === "stale"
      ? "stale-claim"
      : undefined;
}

function captureCurrent(input: RestartRecoveryTerminalDeliveryScope) {
  const memory = captureSessionActorStorageOwner(input, receiptAuthority);
  return {
    scope: {
      ...input,
      storePath: memory?.path ?? path.resolve(input.storePath),
      env: captureSessionTranscriptStorageEnvironment(
        memory ? { OPENCLAW_STATE_DIR: path.resolve(memory.path, "../../../..") } : process.env,
      ),
    },
    absent: memory !== undefined && !memory.owner && !memory.binding,
  };
}

/** Persists ambiguity before a terminal external send is allowed to start. */
export async function beginRestartRecoveryTerminalDelivery(
  input: RestartRecoveryTerminalDeliveryScope,
): Promise<"started" | "already-delivered" | "delivery-ambiguous" | "stale" | "not-applicable"> {
  const current = captureCurrent(input);
  const scope = current.scope;
  const { sessionId, sourceTurnId, toolCallId } = scope;
  if (current.absent) {
    return "stale";
  }
  const result = await withSessionActor(scope, receiptLifetime, async (actor) => {
    const outcome = await runSessionActorCommand(actor, receiptAuthority, (snapshot) =>
      actor.deliveryPending(
        {
          commandId: randomUUID(),
          phaseId: randomUUID(),
          expected: snapshot?.version,
          claim: { sessionId, sourceTurnId, toolCallId },
          updatedAt: Date.now(),
        },
        receiptAuthority,
      ),
    );
    const value = terminalValue(outcome);
    if (!value) {
      return "stale";
    }
    return value.disposition;
  });
  if (result !== undefined) {
    return result;
  }
  return "stale";
}

const receiptLifetime = { assertCurrent() {}, assertReadable() {} };
const receiptAuthority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };

function terminalValue<Value>(outcome: SessionActorOutcome<Value>): Value | undefined {
  if (outcome.kind === "committed") {
    if (outcome.failure) {
      throw new Error(outcome.failure.message);
    }
    return outcome.value;
  }
  if (outcome.kind === "rolled-back" && outcome.reason === "stale-state") {
    return undefined;
  }
  throw new SqliteWorkerError(
    outcome.error.message,
    outcome.kind === "unknown" ? "outcome-unknown" : "unavailable",
  );
}

async function updatePendingTerminalDelivery(
  scope: RestartRecoveryTerminalDeliveryScope & { env?: NodeJS.ProcessEnv },
  outcome: "confirmed" | "not-sent",
) {
  const { sessionId, sourceTurnId, toolCallId } = scope;
  const result = await withSessionActor(scope, receiptLifetime, async (actor) => {
    const settled = await runSessionActorCommand(actor, receiptAuthority, (snapshot) =>
      actor.deliverySettled(
        {
          commandId: randomUUID(),
          phaseId: randomUUID(),
          expected: snapshot?.version,
          restart: {
            claim: { sessionId, sourceTurnId, toolCallId },
            outcome,
            updatedAt: Date.now(),
          },
        },
        receiptAuthority,
      ),
    );
    const value = terminalValue(settled);
    if (!value) {
      return "stale";
    }
    if (!("disposition" in value)) {
      throw new Error("Restart delivery returned another settlement");
    }
    return value.disposition;
  });
  if (result !== undefined) {
    return result;
  }
  return "stale";
}

/** Resolves a pre-send ambiguity only after the provider confirms delivery. */
export async function completeRestartRecoveryTerminalDelivery(
  input: RestartRecoveryTerminalDeliveryScope,
): Promise<"recorded" | "stale"> {
  const source = captureCurrent(input);
  if (source.absent) {
    return "stale";
  }
  const disposition = await updatePendingTerminalDelivery(source.scope, "confirmed");
  return disposition === "recorded" ? disposition : "stale";
}

/** Clears the pre-send intent only when the provider proves no delivery occurred. */
export async function cancelRestartRecoveryTerminalDelivery(
  input: RestartRecoveryTerminalDeliveryScope,
): Promise<"cleared" | "stale"> {
  const source = captureCurrent(input);
  if (source.absent) {
    return "stale";
  }
  const disposition = await updatePendingTerminalDelivery(source.scope, "not-sent");
  return disposition === "cleared" ? disposition : "stale";
}
