import type {
  GroupKeyResolution,
  SessionEntry,
  SessionScope,
} from "../../config/sessions/types.js";
import type { SessionMemoryTranscript } from "../../hooks/bundled/session-memory/capture.js";
import type { FinalizedTemplateContext } from "../templating.js";
import type { ReplySessionEntryHandle } from "./session-entry-handle.js";

export type SessionInitResult = Required<
  Pick<SessionEntry, "sessionId" | "systemSent" | "abortedLastRun">
> & {
  sessionCtx: FinalizedTemplateContext;
  sessionEntry: SessionEntry;
  initialSessionEntry?: SessionEntry;
  previousSessionEntry?: SessionEntry;
  previousSessionMemory?: SessionMemoryTranscript;
  previousSessionResetMessages?: unknown[];
  sessionEntryHandle: ReplySessionEntryHandle;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  isNewSession: boolean;
  resetTriggered: boolean;
  storePath: string;
  sessionScope: SessionScope;
  groupResolution?: GroupKeyResolution;
  isGroup: boolean;
  bodyStripped?: string;
  triggerBodyNormalized: string;
};
