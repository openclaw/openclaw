// Continuation (karmaterminal/openclaw#1544): the sessions session-store maintenance keeps for live
// continuation custody. Entry-cap eviction, age pruning and disk-budget cleanup never select one:
// a deleted room loses the elections it owns ("source session owner is unavailable") and refuses
// the returns owed to it, because its recipient authority advanced.
//
// A session holds custody while it owns a live election (`hasLiveContinuationCustody`'s rule), while
// a pending continuation row is addressed to it, or while an admitted continuation child still owes
// it a return (the subagent registry's maintenance provider adds those from its own runs). Once the
// election, row or child settles (delivered, cancelled, refused, failed), the next pass may evict
// the session as before. The named limit: a store full of live custody stays above `maxEntries`
// until custody ends.
//
// Accepted edge: these are read once while a pass prepares. Custody that begins after that read,
// and whose session no other protection covers by the capture, is seen by the next pass.
import { listPendingContinuationSessionDeliveryKeys } from "../../infra/session-delivery-queue-storage.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { listLiveContinuationCustodyOwners } from "./work-store.js";

export async function listContinuationCustodyHolders(): Promise<string[]> {
  const [owners, recipients] = await Promise.all([
    listLiveContinuationCustodyOwners(),
    listPendingContinuationSessionDeliveryKeys(captureOpenClawStateWorkerContext()),
  ]);
  return [...owners, ...recipients];
}
