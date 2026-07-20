import type { HookExternalContentSource } from "../../security/external-content.js";
import type { SessionEntry } from "./types.js";

/** Kept aligned with SessionStateActorType (src/sessions/session-state-event-kinds.ts); not imported to avoid layering config/sessions onto src/sessions. */
export type SessionCreatedActorType = "human" | "agent" | "system";
export type SessionCreatedActor = { type: SessionCreatedActorType; id?: string };
export type SessionCreatedVia =
  | "operator" // gateway sessions.create (Control UI / operator clients)
  | "spawn" // sessions_spawn native or ACP subagent spawn
  | "channel" // inbound channel conversation materialization
  | "cron"
  | "talk"
  | "run" // create-on-run materialization (agent-session-persist)
  | "plugin" // trusted plugin runtime creation
  | "internal"; // internal/hidden sessions (internal-session-effects, voice bare rows)

export function buildSessionCreationStamp(params: {
  via: SessionCreatedVia;
  actor?: SessionCreatedActor;
  now?: number;
}): Pick<SessionEntry, "createdVia" | "createdActor" | "createdAt"> {
  return {
    createdVia: params.via,
    ...(params.actor ? { createdActor: params.actor } : {}),
    createdAt: params.now ?? Date.now(),
  };
}

export type SessionEntryProvenance = {
  /** Plugin id that owns this session through a trusted runtime creation seam. */
  pluginOwnerId?: string;
  /** External hook source that has contributed content to this transcript. */
  hookExternalContentSource?: HookExternalContentSource;
};
