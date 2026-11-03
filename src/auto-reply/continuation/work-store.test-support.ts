// Seed a queued continuation-work record straight into custody, bypassing the
// election's owner condition and cap, as a pre-existing record would be. Tests
// that exercise the election itself call `enqueuePendingWorkReplacing`. The
// seed is bound to the session's recipient authority, as every election is;
// `bind: false` writes the shape a build before the binding wrote (an incognito
// session, which has no durable authority, can only hold such a record).
import crypto from "node:crypto";
import { createContinuationRecord } from "./custody/custody-store.js";
import {
  encodeWorkState,
  workRecordDueAt,
  workToRuntime,
  type PendingContinuationWork,
} from "./work-flow-state.js";
import { captureContinuationWorkRecipientAuthority } from "./work-recipient-authority.js";

export async function enqueuePendingWork(
  work: PendingContinuationWork,
  options: { bind?: false } = {},
): Promise<PendingContinuationWork | null> {
  const state = encodeWorkState(
    options.bind === false || work.recipientAuthority
      ? work
      : {
          ...work,
          recipientAuthority: await captureContinuationWorkRecipientAuthority(work.sessionKey),
        },
  );
  const created = await createContinuationRecord({
    recordId: crypto.randomUUID(),
    kind: "work",
    ownerSessionKey: work.sessionKey,
    ...(work.chainId ? { chainId: work.chainId } : {}),
    status: "queued",
    phase: "Queued for same-session continuation wake",
    createdAt: work.electedAt,
    dueAt: workRecordDueAt(state),
    stateJson: JSON.stringify(state),
  });
  return created.outcome === "created" ? workToRuntime(created.record, state, "queued") : null;
}
