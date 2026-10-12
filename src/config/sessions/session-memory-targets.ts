import { listSessionTranscriptArchivesReadOnly } from "./session-accessor.sqlite-history.js";
import { listSessionParticipantsReadOnly } from "./session-accessor.sqlite-participant-read.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { listSessionTranscriptInstances } from "./session-history.js";
import { selectMemorySessionTargets } from "./session-memory-targets-policy.js";
import type {
  MemorySessionSelectors,
  MemorySessionTarget,
} from "./session-memory-targets.types.js";

export {
  projectSessionMetadata,
  resolveMemorySessionSince,
  unresolvedMemorySessionTarget,
} from "./session-memory-targets-policy.js";

/** Resolve explicit memory-forget selectors against authoritative session owners. */
export function readMemorySessionTargets(
  params: MemorySessionSelectors & { env?: NodeJS.ProcessEnv },
  continuation?: CanonicalSessionReaderContinuation,
): MemorySessionTarget[] {
  if (!params.sessionIds?.length && !params.hookSources?.length && !params.participants?.length) {
    return [];
  }
  return selectMemorySessionTargets(params, {
    instances: listSessionTranscriptInstances(params, { includeAllWindows: true }, continuation),
    participants: new Map(
      [...listSessionParticipantsReadOnly(params)].map(([key, rows]) => [
        key,
        rows.map(({ identity }) => identity),
      ]),
    ),
    archives: listSessionTranscriptArchivesReadOnly({
      ...params,
      sessionIds: [...new Set(params.sessionIds ?? [])],
    }),
  });
}
