import type { AgentMessage } from "../../agents/runtime/index.js";
import { readSessionTranscriptContextMessages } from "../../config/sessions/session-accessor.js";
import { readSessionMessagesAsync } from "../../gateway/session-transcript-readers.js";

type TranscriptScope = {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
};

export async function readPreflightTranscriptContextMessages(
  scope: TranscriptScope,
): Promise<AgentMessage[]> {
  const activeMessages = readSessionTranscriptContextMessages(scope, (messages, header) =>
    header === undefined ? undefined : Array.from(messages),
  );
  if (activeMessages) {
    return activeMessages;
  }
  // Headerless legacy projections have no canonical context snapshot.
  return (await readSessionMessagesAsync(scope, {
    mode: "full",
    reason: "preflight-compaction-estimate-legacy",
  })) as AgentMessage[]; // SAFETY: Gateway readers project stored rows as AgentMessage values.
}
