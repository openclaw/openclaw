import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import type { SessionActorStorageBinding } from "./session-actor-storage-binding.js";

export type SessionCollaborationScope = SessionAccessScope & {
  sessionActor?: SessionActorStorageBinding;
};
