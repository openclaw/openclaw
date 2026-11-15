import type { OpenClawAgentDatabaseClaim } from "../../state/openclaw-agent-db-identity.js";
import type { SessionEntryTargetPatchScope } from "./session-accessor.types.js";
import type { SessionActor, SessionActorLifetime } from "./session-actor-contract.js";
import type { SessionAdmissionTransition } from "./session-admission-transition.types.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";

export type ActorSessionAdmissionClaim = {
  kind: "worker" | "memory";
  identity: string;
  incarnation: string;
  readonly target: SessionEntryTargetPatchScope;
  reader?: SessionEntryCohortReader;
  acquireSessionActor(lifetime: SessionActorLifetime): Promise<SessionActor>;
  afterTransition?(
    transition: SessionAdmissionTransition,
    assertOwnerCurrent: () => void,
  ): Promise<ActorSessionAdmissionClaim>;
  isCurrent(): boolean;
  assertCurrent(): void;
  release(): Promise<void>;
};

export type SessionAdmissionDatabaseClaim = OpenClawAgentDatabaseClaim | ActorSessionAdmissionClaim;
