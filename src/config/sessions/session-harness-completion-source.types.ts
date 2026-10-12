import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { HarnessCompletionRecovery } from "./restart-recovery-types.js";
import type { SessionTranscriptContextVersion } from "./session-accessor.sqlite-contract.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionTranscriptWorkerReadError } from "./session-transcript-worker-error.types.js";
import type { SessionEntry } from "./types.js";

export type HarnessCompletionSourceSnapshot = {
  entry?: SessionEntry;
  validInput: boolean;
  readError?: SessionTranscriptWorkerReadError;
  version?: SessionTranscriptContextVersion;
};
export type Input = {
  kind: "session-harness-completion-source";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  claim: HarnessCompletionRecovery;
  source: CapturedSessionEntryReadSource;
  admission?: UserTurnTranscriptAdmissionReceipt;
};
export type Value = {
  kind: "session-harness-completion-source";
  snapshot: HarnessCompletionSourceSnapshot;
};
export type Reader = (
  input: Omit<Input, "kind" | "database">,
) => Promise<HarnessCompletionSourceSnapshot>;
