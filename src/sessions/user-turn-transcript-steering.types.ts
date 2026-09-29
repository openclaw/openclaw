import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.types.js";
import type { SessionTranscriptWriterFence } from "../config/sessions/transcript-write-context.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptAdmissionReceipt,
} from "./user-turn-transcript.types.js";

export type SteeredUserTurnTranscriptSnapshot = {
  admission: UserTurnTranscriptAdmissionReceipt;
  message: PersistedUserTurnMessage;
};

export type SteeredUserTurnTranscriptCommit = {
  generation: string;
  message: PersistedUserTurnMessage;
  changed: boolean;
};

export type SteeredUserTurnTranscriptInput = {
  source: SteeredUserTurnTranscriptSnapshot;
  continuation?: SteeredUserTurnTranscriptSnapshot;
  targetRunId: string;
  target?: SessionTranscriptRuntimeTarget & SessionTranscriptWriterFence;
};

export type SteeredUserTurnTranscriptOperations = {
  confirm: { input: SteeredUserTurnTranscriptInput; output: SteeredUserTurnTranscriptCommit };
};
