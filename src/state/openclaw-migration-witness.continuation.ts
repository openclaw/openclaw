// Continuation's recipient authority in migration witnesses, split from
// openclaw-migration-witness.ts to keep that file under its line cap.
import { AGENT_ACTIVE_EVENT_FACTS_SCHEMA_VERSION } from "./openclaw-agent-active-event-facts-schema.js";
import {
  AGENT_RECIPIENT_AUTHORITY_SCHEMA_VERSION,
  RECIPIENT_AUTHORITY_TABLE,
} from "./openclaw-agent-recipient-authority-schema.js";

export { RECIPIENT_AUTHORITY_TABLE };

/** Agent schemas a witness admits: upstream's 24..41 and continuation's authority step. */
export const AGENT_WITNESS_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([
  24,
  25,
  26,
  27,
  28,
  29,
  30,
  31,
  32,
  33,
  34,
  35,
  36,
  37,
  38,
  39,
  40,
  AGENT_ACTIVE_EVENT_FACTS_SCHEMA_VERSION,
  AGENT_RECIPIENT_AUTHORITY_SCHEMA_VERSION,
]);

/** The authority step creates its table; a migration crossing it may leave the table empty. */
export function omitAddedRecipientAuthority(
  currentTables: Map<string, { rowCount: number }>,
  crossing: boolean,
): void {
  if (crossing && currentTables.get(RECIPIENT_AUTHORITY_TABLE)?.rowCount === 0) {
    currentTables.delete(RECIPIENT_AUTHORITY_TABLE);
  }
}
