import { buildSpawnAuthorityReceipt } from "../../../config/sessions/session-entry-lineage.js";
import type { SessionEntry } from "../../../config/sessions/types.js";

type ParentIncarnation = Pick<SessionEntry, "sessionId" | "lifecycleRevision">;

const PARENT_CHANGED_ERROR = "Parent session changed before spawn; retry from the current turn.";

/**
 * A reset during child preparation may leave stale lineage. The memory owner
 * denies that receipt at access, so spawn need not re-read the parent before commit.
 */
export function captureSpawnParentLineage(params: {
  parentEntry: ParentIncarnation | undefined;
  expectedParentSessionId?: string;
  senderIsOwner?: boolean;
}): ReturnType<typeof buildSpawnAuthorityReceipt> {
  const { parentEntry } = params;
  if (
    parentEntry &&
    params.expectedParentSessionId !== undefined &&
    parentEntry.sessionId !== params.expectedParentSessionId
  ) {
    throw new Error(PARENT_CHANGED_ERROR);
  }
  return buildSpawnAuthorityReceipt(parentEntry, params.senderIsOwner);
}
