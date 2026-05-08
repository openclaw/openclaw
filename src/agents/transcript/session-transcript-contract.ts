import { SessionManagerValue } from "./session-manager.js";
import type {
  SessionInfo,
  SessionListProgress,
  SessionManager as SessionManagerType,
} from "./session-transcript-types.js";
export {
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  parseSessionEntries,
} from "./session-transcript-format.js";
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
  FileEntry,
  LabelEntry,
  ModelChangeEntry,
  SessionContext,
  SessionEntry,
  SessionEntryBase,
  SessionHeader,
  SessionInfo,
  SessionInfoEntry,
  SessionListProgress,
  SessionMessageEntry,
  SessionTreeNode,
  ThinkingLevelChangeEntry,
} from "./session-transcript-types.js";

export type SessionManager = SessionManagerType;

export const SessionManager = SessionManagerValue as {
  create(cwd: string): SessionManagerType;
  open(path: string, cwdOverride?: string): SessionManagerType;
  continueRecent(cwd: string): SessionManagerType;
  inMemory(cwd?: string): SessionManagerType;
  forkFrom(sourcePath: string, targetCwd: string): SessionManagerType;
  list(cwd: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
  listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]>;
};
