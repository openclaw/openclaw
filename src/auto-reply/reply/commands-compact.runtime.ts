/** Runtime facade for compact command dependencies. */
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";

export function resolveCurrentSessionEntry(params: {
  agentId: string;
  sessionKey: string;
  storePath: string;
  expected: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
}) {
  const source = captureIncognitoSessionSource(params);
  source?.admissionSignal?.throwIfAborted();
  const current = source
    ? "kind" in source
      ? undefined
      : source.actor.sessions.readCapability(params.sessionKey)
    : loadSessionEntryReadOnly(params);
  return current?.sessionId === params.expected.sessionId &&
    current.lifecycleRevision === params.expected.lifecycleRevision
    ? current
    : undefined;
}

/** Full command data is prepared asynchronously; final predicates use the bounded live facts. */
export async function readCurrentSessionEntry(
  params: Parameters<typeof resolveCurrentSessionEntry>[0],
) {
  const current = await readSessionEntryReadOnlyInWorker(params);
  return current?.sessionId === params.expected.sessionId &&
    current.lifecycleRevision === params.expected.lifecycleRevision
    ? current
    : undefined;
}

export {
  abortEmbeddedAgentRun,
  compactEmbeddedAgentSession,
  isEmbeddedAgentRunAbortableForCompaction,
  waitForEmbeddedAgentRunEnd,
} from "../../agents/embedded-agent.js";
export { resolveFreshSessionTotalTokens } from "../../config/sessions.js";
export { enqueueSystemEvent } from "../../infra/system-events.js";
export { formatContextUsageShort, formatTokenCount } from "../status.js";
export { incrementCompactionCount } from "./session-updates.js";
