import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";

/** Assigns one legacy owner to job records that have no explicit or session-scoped owner. */
export function materializeLegacyDefaultCronJobOwnersInRecords(
  jobs: Array<Record<string, unknown>>,
  legacyDefaultAgentId: string,
): number {
  const agentId = normalizeAgentId(legacyDefaultAgentId);
  let rewritten = 0;
  for (const job of jobs) {
    const sessionKey = normalizeOptionalString(job.sessionKey);
    const scopedAgentId = parseAgentSessionKey(sessionKey)?.agentId;
    if (Object.hasOwn(job, "agentId") || scopedAgentId) {
      continue;
    }
    job.agentId = agentId;
    rewritten += 1;
  }
  return rewritten;
}
