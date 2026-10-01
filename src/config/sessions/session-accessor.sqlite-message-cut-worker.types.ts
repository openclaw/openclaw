import type { SessionMessageCutMutationParams } from "./session-accessor.types.js";
import type { InternalSessionEntry } from "./types.js";

/** Serializable request; authority remains with the parent of the canonical writer. */
export type SessionForkAtMessageWorkerInput = {
  canonicalSourceKey: string;
  sourceKey: string;
  targetKey: string;
  entryId: string;
  expectedState: Pick<InternalSessionEntry, "lifecycleRevision" | "sessionId">;
  creation?: SessionMessageCutMutationParams["creation"];
};
