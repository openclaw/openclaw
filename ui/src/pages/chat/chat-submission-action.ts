import { generateUUID } from "../../lib/uuid.ts";

const submissionIdsByAction = new WeakMap<Event, string>();
const claimedSubmissionActions = new WeakSet<Event>();

export function claimChatSubmissionAction(action: Event): {
  submissionId: string;
  firstUse: boolean;
} {
  const existing = submissionIdsByAction.get(action);
  const submissionId = existing ?? generateUUID();
  if (!existing) {
    submissionIdsByAction.set(action, submissionId);
  }
  // One browser event is one logical action: handler re-entry keeps this ID
  // and skips duplicate UI mutations, while another activation gets a new ID.
  const firstUse = !claimedSubmissionActions.has(action);
  if (firstUse) {
    claimedSubmissionActions.add(action);
  }
  return { submissionId, firstUse };
}

export function runClaimedChatSubmissionAction(
  action: Event,
  run: (submissionId: string) => void,
): void {
  const claim = claimChatSubmissionAction(action);
  if (claim.firstUse) {
    run(claim.submissionId);
  }
}
