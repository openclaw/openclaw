import type {
  GroupKeyResolution,
  InternalSessionEntry,
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
  sessionEntry: InternalSessionEntry;
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

export type InitSessionLifecycleMutation = {
  kind: "lifecycle-mutation";
  cyberAccessProgram?: SessionEntry["cyberAccessProgram"];
  sessionId: string;
  sessionKey: string;
  lifecycleRevision?: string;
  resetTriggered: boolean;
};
export type InitSessionStateAttemptOutcome =
  | { kind: "complete"; result: SessionInitResult }
  | InitSessionLifecycleMutation;

export type ReplySessionPreprocessingState = {
  sessionEntry?: SessionEntry;
  sessionKey: string;
  storePath: string;
};
