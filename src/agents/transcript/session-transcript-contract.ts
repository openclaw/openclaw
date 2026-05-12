import { SessionManagerValue } from "./session-manager.js";
import type { SessionManager as SessionManagerType } from "./session-transcript-types.js";
export { buildSessionContext, CURRENT_SESSION_VERSION } from "./session-transcript-format.js";
export type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
} from "../agent-extension-public-types.js";
export type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  CustomMessageEntry,
  LabelEntry,
  ModelChangeEntry,
  SessionContext,
  SessionEntry,
  SessionEntryBase,
  SessionHeader,
  SessionInfoEntry,
  SessionMessageEntry,
  SessionTranscriptScope,
  SessionTreeNode,
  ThinkingLevelChangeEntry,
  TranscriptEntry,
} from "./session-transcript-types.js";

export type SessionManager = SessionManagerType;

export const SessionManager = SessionManagerValue as {
  inMemory(cwd?: string): SessionManagerType;
};
