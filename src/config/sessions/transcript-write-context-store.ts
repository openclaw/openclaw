import type {
  ModelChangeEntry,
  ThinkingLevelChangeEntry,
} from "../../agents/sessions/session-manager-types.js";
import { AsyncContext } from "../../shared/async-context.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { runWithCliHistoryWriter } from "./cli-history-boundary.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptWriteScope,
} from "./session-accessor.sqlite-contract.js";
import type { SessionActor } from "./session-actor-contract.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionSourceAssertion } from "./session-source-authority.js";
import type { InitialSessionTranscriptWriter } from "./session-transcript-writer.types.js";
import type { SessionTranscriptTargetBinding } from "./transcript-target-binding.js";
import type { SessionEntry } from "./types.js";

export type SessionMetadataChange =
  | Pick<ModelChangeEntry, "type" | "provider" | "modelId">
  | Pick<ThinkingLevelChangeEntry, "type" | "thinkingLevel">;

export type MetadataTarget = SessionTranscriptTargetBinding;
export type MetadataPublicationOwner = {
  getSessionId(): string;
  getSessionTarget(): MetadataTarget | undefined;
};
export type SessionMetadataCommit = {
  entry: ModelChangeEntry | ThinkingLevelChangeEntry;
  version: SessionTranscriptContextVersion | undefined;
  target: MetadataTarget | undefined;
};
export type MetadataPublication = {
  owner: MetadataPublicationOwner;
  sessionId: string;
  target: MetadataTarget | undefined;
  change: SessionMetadataChange;
  publish: (commit: SessionMetadataCommit) => undefined;
};

export type SessionTranscriptWriteTarget = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  expectedLifecycleRevision?: string;
  expectedWriterRunId?: string;
  expectedOwner?: SessionTranscriptWriteScope["expectedOwner"];
};

export type OwnedSessionTranscriptWriteContext = {
  sessionFile?: string;
  sessionKey?: string;
  sessionTarget?: SessionTranscriptWriteTarget;
  initialWriter?: InitialSessionTranscriptWriter;
  /** A committed first writer retained only while its terminal outcome is appended. */
  settledInitialWriter?: InitialSessionTranscriptWriter;
  sessionReader?: SessionEntryCohortReader;
  sessionActor?: {
    actor: SessionActor;
    /** Retain the physical database owner, independently of the logical session agent. */
    database: Readonly<OpenClawAgentDatabaseOptions & { agentId: string; path: string }>;
  };
  /** Revalidate the captured owner, including an absent writer, inside each commit. */
  assertCommitAllowed?: SessionSourceAssertion;
  withTranscriptWrite: <T>(run: () => Promise<T> | T) => Promise<T>;
  /** Terminal bookkeeping through the retained writer after restart cancels execution. */
  withRestartAbortWrite?: <T>(write: () => Promise<T>) => Promise<T>;
  metadataPublication?: { current?: MetadataPublication };
};

export type TranscriptSourcePublication = {
  target: SessionTranscriptWriteTarget;
  claimed: boolean;
  publish?: (source: CapturedSessionEntryReadSource, entry: SessionEntry) => void;
};

export const ownedTranscriptWriteContext = new AsyncContext<
  OwnedSessionTranscriptWriteContext & { sourcePublication?: TranscriptSourcePublication }
>(Symbol("ownedTranscriptWriteContext"));

/** Runs detached work without retaining an attempt-owned transcript context. */
export function runWithoutOwnedSessionTranscriptWrites<T>(run: () => T): T {
  return ownedTranscriptWriteContext.exit(() => runWithCliHistoryWriter(undefined, run));
}
