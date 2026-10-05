import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  PendingInputRecoveryIntent,
  TurnRecoveryIntent,
} from "./main-session-recovery.types.js";
import type { SessionPendingInputRow } from "./session-accessor.sqlite-pending-inputs.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import type { InternalSessionEntry } from "./types.js";

/** Decode private acceptance metadata, never infer an issuer from the message or row labels. */
export function readPendingInputRecoveryIntent(
  row: SessionPendingInputRow,
): PendingInputRecoveryIntent | undefined {
  if (!row.recovery_intent_json) {
    return undefined;
  }
  try {
    const value = asOptionalRecord(JSON.parse(row.recovery_intent_json));
    const intent = asOptionalRecord(value?.intent);
    const issuer = asOptionalRecord(intent?.issuer);
    const actor = asOptionalRecord(issuer?.factoryActor);
    if (
      value?.version !== 1 ||
      typeof value?.queued !== "boolean" ||
      !intent ||
      value.requestHash !== row.request_hash ||
      value.messageHash !== createHash("sha256").update(row.message_json).digest("hex") ||
      intent.inputId !== row.input_id ||
      intent.runId !== row.run_id ||
      intent.idempotencyKey !== row.idempotency_key ||
      intent.sessionId !== row.session_id ||
      intent.sessionKey !== row.session_key ||
      typeof intent.lifecycleGeneration !== "string" ||
      !issuer ||
      issuer.version !== 1 ||
      typeof issuer.profileId !== "string" ||
      !actor ||
      actor.host !== "microsoft.ghe.com" ||
      typeof actor.accountId !== "number" ||
      !Number.isSafeInteger(actor.accountId) ||
      actor.accountId <= 0 ||
      !asOptionalRecord(issuer.authPrincipal) ||
      !(issuer.rolePolicyGeneration === null || typeof issuer.rolePolicyGeneration === "string")
    ) {
      return undefined;
    }
    // SAFETY: the acceptance worker is the only producer; the restore owner still verifies every issuer fact.
    return value as PendingInputRecoveryIntent;
  } catch {
    return undefined;
  }
}
/** A legacy current turn may supply its own exact input reference, never another row's issuer. */
export function readOriginalPendingInputIntent(
  row: SessionPendingInputRow,
  entry: Pick<InternalSessionEntry, "mainRestartRecovery">,
  admitted?: TurnRecoveryIntent,
): TurnRecoveryIntent | undefined {
  const legacy = entry.mainRestartRecovery?.turnIntent;
  const original =
    row.recovery_intent_json != null
      ? readPendingInputRecoveryIntent(row)?.intent
      : legacy?.inputId === row.input_id &&
          legacy.runId === row.run_id &&
          legacy.idempotencyKey === row.idempotency_key &&
          legacy.sessionId === row.session_id &&
          legacy.sessionKey === row.session_key
        ? legacy
        : undefined;
  if (row.recovery_intent_json != null && !original) {
    throw new SessionPendingInputCustodyError(
      "Pending input original custody is invalid; cannot readmit accepted work",
    );
  }
  if (
    original &&
    admitted &&
    (!isDeepStrictEqual(original.issuer, admitted.issuer) ||
      original.repositoryWorkspaceId !== admitted.repositoryWorkspaceId ||
      original.lifecycleRevision !== admitted.lifecycleRevision)
  ) {
    throw new Error("Pending input cannot transfer its original issuer");
  }
  return original;
}
