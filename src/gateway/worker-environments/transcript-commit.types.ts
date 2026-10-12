import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type {
  SessionTranscriptRuntimeTarget,
  SessionTranscriptWriteScope,
} from "../../config/sessions/session-accessor.types.js";

export type CommittedAgentMessage = Extract<
  AgentMessage,
  { role: "assistant" | "toolResult" | "user" | "custom" }
> & { idempotencyKey: string };

export type AppliedTranscriptMessage = {
  appended: boolean;
  message: AgentMessage;
  messageId: string;
  messageSeq?: number;
};

export type ApplyTranscriptCommitResult =
  | { ok: true; messages: AppliedTranscriptMessage[]; lifecycleRevision: string | undefined }
  | { ok: false; reason: "invalid-batch" | "session-not-attached" | "stale-base-leaf" };

export type TranscriptCommitInput = {
  scope: Omit<SessionTranscriptWriteScope, "env"> & SessionTranscriptRuntimeTarget;
  lifecycleRevision: string | undefined;
  requestedBaseLeafId: string | null;
  recoverPersistedBatch: boolean;
  messages: readonly CommittedAgentMessage[];
  cwd: string;
};
