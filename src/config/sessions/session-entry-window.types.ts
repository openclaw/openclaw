import type { Selectable } from "kysely";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";

export const sessionEntryWindowColumns = [
  "session_id",
  "session_key",
  "reason",
  "created_at",
  "updated_at",
  "session_entry_provenance",
  "acp_owned",
  "plugin_owner_id",
  "hook_external_content_source",
  "previous_session_id",
  "session_scope",
  "started_at",
  "ended_at",
  "status",
  "chat_type",
  "channel",
  "account_id",
  "model_provider",
  "model",
  "agent_harness_id",
  "parent_session_key",
  "spawned_by",
  "display_name",
  "primary_conversation_id",
  "transcript_observed_at",
  "transcript_updated_at",
] as const;

export type SessionEntryWindowRow = Pick<
  Selectable<OpenClawAgentKyselyDatabase["session_windows"]>,
  (typeof sessionEntryWindowColumns)[number]
>;

export type SessionEntryWindowFacts = {
  sessionId: string;
  row: SessionEntryWindowRow | null;
};
