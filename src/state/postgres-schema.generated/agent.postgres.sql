-- Generated runtime DDL; the owner supplies search_path and the transaction.

CREATE FUNCTION "openclaw_transcript_navigation_check"(navigation_json text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $navigation$
WITH input AS (SELECT CASE WHEN navigation_json IS JSON THEN navigation_json::json END AS document),
members AS (SELECT (SELECT member.value FROM json_each(CASE WHEN json_typeof(document) = 'object' THEN document ELSE '{}'::json END) WITH ORDINALITY AS member(key, value, position) WHERE member.key = 'version' ORDER BY member.position LIMIT 1) AS "j_version",
(SELECT member.value FROM json_each(CASE WHEN json_typeof(document) = 'object' THEN document ELSE '{}'::json END) WITH ORDINALITY AS member(key, value, position) WHERE member.key = 'modelBytes' ORDER BY member.position LIMIT 1) AS "j_modelBytes",
(SELECT member.value FROM json_each(CASE WHEN json_typeof(document) = 'object' THEN document ELSE '{}'::json END) WITH ORDINALITY AS member(key, value, position) WHERE member.key = 'modelWithoutCheckpointBytes' ORDER BY member.position LIMIT 1) AS "j_modelWithoutCheckpointBytes",
(SELECT member.value FROM json_each(CASE WHEN json_typeof(document) = 'object' THEN document ELSE '{}'::json END) WITH ORDINALITY AS member(key, value, position) WHERE member.key = 'withoutCustomDataBytes' ORDER BY member.position LIMIT 1) AS "j_withoutCustomDataBytes",
(SELECT member.value FROM json_each(CASE WHEN json_typeof(document) = 'object' THEN document ELSE '{}'::json END) WITH ORDINALITY AS member(key, value, position) WHERE member.key = 'report' ORDER BY member.position LIMIT 1) AS "j_report",
(SELECT member.value FROM json_each(CASE WHEN json_typeof((SELECT member.value FROM json_each(CASE WHEN json_typeof(document) = 'object' THEN document ELSE '{}'::json END) WITH ORDINALITY AS member(key, value, position) WHERE member.key = 'report' ORDER BY member.position LIMIT 1)) = 'object' THEN (SELECT member.value FROM json_each(CASE WHEN json_typeof(document) = 'object' THEN document ELSE '{}'::json END) WITH ORDINALITY AS member(key, value, position) WHERE member.key = 'report' ORDER BY member.position LIMIT 1) ELSE '{}'::json END) WITH ORDINALITY AS member(key, value, position) WHERE member.key = 'kind' ORDER BY member.position LIMIT 1) AS "j_report.kind",
(SELECT member.value FROM json_each(CASE WHEN json_typeof(document) = 'object' THEN document ELSE '{}'::json END) WITH ORDINALITY AS member(key, value, position) WHERE member.key = 'navigation' ORDER BY member.position LIMIT 1) AS "j_navigation",
(SELECT member.value FROM json_each(CASE WHEN json_typeof(document) = 'object' THEN document ELSE '{}'::json END) WITH ORDINALITY AS member(key, value, position) WHERE member.key = 'reset' ORDER BY member.position LIMIT 1) AS "j_reset",
(SELECT member.value FROM json_each(CASE WHEN json_typeof(document) = 'object' THEN document ELSE '{}'::json END) WITH ORDINALITY AS member(key, value, position) WHERE member.key = 'model' ORDER BY member.position LIMIT 1) AS "j_model" FROM input)
SELECT "navigation_json" IS NULL OR CASE WHEN ("navigation_json" IS JSON) THEN coalesce((octet_length("navigation_json") <= 16384) AND (CASE WHEN json_typeof("j_version") = 'number' AND ("j_version" #>> '{}') ~ '^-?[0-9]+$' THEN 'integer' WHEN json_typeof("j_version") = 'number' THEN 'real' ELSE json_typeof("j_version") END = 'integer') AND (CASE WHEN json_typeof("j_version") = 'number' AND ("j_version" #>> '{}') ~ '^-?[0-9]+$' AND char_length(("j_version" #>> '{}')) <= 20 THEN ("j_version" #>> '{}')::numeric END = 1) AND (CASE WHEN json_typeof("j_report") = 'number' AND ("j_report" #>> '{}') ~ '^-?[0-9]+$' THEN 'integer' WHEN json_typeof("j_report") = 'number' THEN 'real' ELSE json_typeof("j_report") END = 'object') AND (CASE WHEN json_typeof("j_report.kind") = 'string' THEN ("j_report.kind" #>> '{}') END IN ('canonical', 'leaf', 'link', 'ignored')) AND (CASE WHEN json_typeof("j_navigation") = 'number' AND ("j_navigation" #>> '{}') ~ '^-?[0-9]+$' THEN 'integer' WHEN json_typeof("j_navigation") = 'number' THEN 'real' ELSE json_typeof("j_navigation") END = 'object') AND (CASE WHEN json_typeof("j_reset") = 'number' AND ("j_reset" #>> '{}') ~ '^-?[0-9]+$' THEN 'integer' WHEN json_typeof("j_reset") = 'number' THEN 'real' ELSE json_typeof("j_reset") END = 'object') AND (CASE WHEN json_typeof("j_model") = 'number' AND ("j_model" #>> '{}') ~ '^-?[0-9]+$' THEN 'integer' WHEN json_typeof("j_model") = 'number' THEN 'real' ELSE json_typeof("j_model") END = 'object') AND (CASE WHEN json_typeof("j_modelBytes") = 'number' AND ("j_modelBytes" #>> '{}') ~ '^-?[0-9]+$' THEN 'integer' WHEN json_typeof("j_modelBytes") = 'number' THEN 'real' ELSE json_typeof("j_modelBytes") END = 'integer') AND (CASE WHEN json_typeof("j_modelBytes") = 'number' AND ("j_modelBytes" #>> '{}') ~ '^-?[0-9]+$' AND char_length(("j_modelBytes" #>> '{}')) <= 20 THEN ("j_modelBytes" #>> '{}')::numeric END BETWEEN 0 AND 4194304) AND (CASE WHEN json_typeof("j_modelWithoutCheckpointBytes") = 'number' AND ("j_modelWithoutCheckpointBytes" #>> '{}') ~ '^-?[0-9]+$' THEN 'integer' WHEN json_typeof("j_modelWithoutCheckpointBytes") = 'number' THEN 'real' ELSE json_typeof("j_modelWithoutCheckpointBytes") END = 'integer') AND (CASE WHEN json_typeof("j_modelWithoutCheckpointBytes") = 'number' AND ("j_modelWithoutCheckpointBytes" #>> '{}') ~ '^-?[0-9]+$' AND char_length(("j_modelWithoutCheckpointBytes" #>> '{}')) <= 20 THEN ("j_modelWithoutCheckpointBytes" #>> '{}')::numeric END BETWEEN 0 AND 4194304) AND (CASE WHEN json_typeof("j_withoutCustomDataBytes") = 'number' AND ("j_withoutCustomDataBytes" #>> '{}') ~ '^-?[0-9]+$' THEN 'integer' WHEN json_typeof("j_withoutCustomDataBytes") = 'number' THEN 'real' ELSE json_typeof("j_withoutCustomDataBytes") END = 'integer') AND (CASE WHEN json_typeof("j_withoutCustomDataBytes") = 'number' AND ("j_withoutCustomDataBytes" #>> '{}') ~ '^-?[0-9]+$' AND char_length(("j_withoutCustomDataBytes" #>> '{}')) <= 20 THEN ("j_withoutCustomDataBytes" #>> '{}')::numeric END BETWEEN 0 AND 4194304), FALSE) ELSE FALSE END FROM members;
$navigation$;

CREATE TABLE "acp_parent_stream_events" (
  "session_id" text COLLATE "C" NOT NULL,
  "run_id" text COLLATE "C" NOT NULL,
  "seq" bigint NOT NULL,
  "event_json" text COLLATE "C" NOT NULL,
  "created_at" bigint NOT NULL,
  PRIMARY KEY ("session_id", "run_id", "seq")
);

CREATE TABLE "auth_profile_state" (
  "state_key" text COLLATE "C" NOT NULL,
  "state_json" text COLLATE "C" NOT NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("state_key")
);

CREATE TABLE "auth_profile_store" (
  "store_key" text COLLATE "C" NOT NULL,
  "store_json" text COLLATE "C" NOT NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("store_key")
);

CREATE TABLE "board_tabs" (
  "session_key" text COLLATE "C" NOT NULL,
  "tab_id" text COLLATE "C" NOT NULL,
  "title" text COLLATE "C" NOT NULL,
  "position" bigint NOT NULL,
  "chat_dock" text COLLATE "C" NOT NULL DEFAULT 'right',
  "created_by" text COLLATE "C" NOT NULL,
  "revision" bigint NOT NULL,
  PRIMARY KEY ("session_key", "tab_id"),
  CHECK (("position" >= 0)),
  CHECK (("chat_dock" IN ('left', 'right', 'bottom', 'hidden'))),
  CHECK (("created_by" IN ('user', 'agent'))),
  CHECK (("revision" >= 0))
);

CREATE TABLE "board_widgets" (
  "session_key" text COLLATE "C" NOT NULL,
  "name" text COLLATE "C" NOT NULL,
  "tab_id" text COLLATE "C" NOT NULL,
  "title" text COLLATE "C",
  "content_kind" text COLLATE "C" NOT NULL,
  "html" bytea,
  "descriptor_json" text COLLATE "C",
  "sha256" text COLLATE "C" NOT NULL,
  "view_generation" text COLLATE "C",
  "revision" bigint NOT NULL,
  "size_w" bigint NOT NULL,
  "size_h" bigint NOT NULL,
  "position" bigint NOT NULL,
  "manifest" text COLLATE "C" NOT NULL DEFAULT '{}',
  "grant_state" text COLLATE "C" NOT NULL DEFAULT 'none',
  "granted_sha" text COLLATE "C",
  "created_by" text COLLATE "C" NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("session_key", "name"),
  CHECK (("content_kind" IN ('html', 'mcp-app', 'plugin'))),
  CHECK (("revision" >= 1)),
  CHECK (("size_w" BETWEEN 1 AND 12)),
  CHECK (("size_h" BETWEEN 1 AND 20)),
  CHECK (("position" >= 0)),
  CHECK (("grant_state" IN ('none', 'pending', 'granted', 'rejected'))),
  CHECK (("created_by" IN ('user', 'agent'))),
  CHECK ((("content_kind" = 'html') AND "html" IS NOT NULL AND "descriptor_json" IS NULL AND "view_generation" IS NOT NULL) OR (("content_kind" = 'mcp-app') AND "html" IS NULL AND "descriptor_json" IS NOT NULL AND "view_generation" IS NULL) OR (("content_kind" = 'plugin') AND "html" IS NULL AND "descriptor_json" IS NOT NULL AND "view_generation" IS NULL))
);

CREATE TABLE "cache_entries" (
  "scope" text COLLATE "C" NOT NULL,
  "key" text COLLATE "C" NOT NULL,
  "value_json" text COLLATE "C",
  "blob" bytea,
  "expires_at" bigint,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("scope", "key")
);

CREATE TABLE "context_engine_turn_outbox" (
  "advancement_key" text COLLATE "C" NOT NULL,
  "engine_id" text COLLATE "C" NOT NULL,
  "owner_plugin_id" text COLLATE "C",
  "session_id" text COLLATE "C" NOT NULL,
  "payload_json" text COLLATE "C" NOT NULL,
  "payload_state" text COLLATE "C",
  "attempt_count" bigint NOT NULL DEFAULT 0,
  "last_attempt_at" bigint,
  "last_error" text COLLATE "C",
  "created_at" bigint NOT NULL,
  PRIMARY KEY ("advancement_key")
);

CREATE TABLE "conversation_deliveries" (
  "operation_id" text COLLATE "C" NOT NULL,
  "operation_kind" text COLLATE "C" NOT NULL,
  "conversation_id" text COLLATE "C" NOT NULL,
  "source_session_key" text COLLATE "C",
  "message_hash" text COLLATE "C" NOT NULL,
  "status" text COLLATE "C" NOT NULL,
  "prepared_message_id" text COLLATE "C",
  "platform_message_id" text COLLATE "C",
  "queue_id" text COLLATE "C",
  "rejection_error" text COLLATE "C",
  "reply_message_id" text COLLATE "C",
  "reply_to_id" text COLLATE "C",
  "reply_thread_id" text COLLATE "C",
  "reply_text" text COLLATE "C",
  "reply_timestamp" bigint,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("operation_id"),
  CHECK (("operation_kind" IN ('send', 'turn'))),
  CHECK (("status" IN ('created', 'queued', 'sent', 'suppressed', 'rejected', 'unknown', 'replied'))),
  CHECK ((("status" = 'rejected') AND "rejection_error" IS NOT NULL) OR (("status" != 'rejected') AND "rejection_error" IS NULL))
);

CREATE TABLE "conversations" (
  "conversation_id" text COLLATE "C" NOT NULL,
  "channel" text COLLATE "C" NOT NULL,
  "account_id" text COLLATE "C" NOT NULL,
  "kind" text COLLATE "C" NOT NULL,
  "peer_id" text COLLATE "C" NOT NULL,
  "delivery_target" text COLLATE "C" NOT NULL,
  "parent_conversation_id" text COLLATE "C",
  "thread_id" text COLLATE "C",
  "native_channel_id" text COLLATE "C",
  "native_direct_user_id" text COLLATE "C",
  "label" text COLLATE "C",
  "metadata_json" text COLLATE "C",
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("conversation_id"),
  CHECK (("kind" IN ('direct', 'group', 'channel')))
);

CREATE TABLE "heartbeat_outcomes" (
  "session_key" text COLLATE "C" NOT NULL,
  "run_session_key" text COLLATE "C" NOT NULL,
  "outcome" text COLLATE "C" NOT NULL,
  "summary" text COLLATE "C" NOT NULL,
  "response_reason" text COLLATE "C",
  "priority" text COLLATE "C",
  "next_check" text COLLATE "C",
  "task_names_json" text COLLATE "C",
  "wake_source" text COLLATE "C",
  "wake_reason" text COLLATE "C",
  "occurred_at" bigint NOT NULL,
  "context_run_id" text COLLATE "C",
  "context_claimed_at" bigint,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("session_key"),
  CHECK (("outcome" IN ('progress', 'done', 'blocked', 'needs_attention'))),
  CHECK ("priority" IS NULL OR ("priority" IN ('low', 'normal', 'high')))
);

CREATE TABLE "memory_embedding_cache" (
  "provider" text COLLATE "C" NOT NULL,
  "model" text COLLATE "C" NOT NULL,
  "provider_key" text COLLATE "C" NOT NULL,
  "hash" text COLLATE "C" NOT NULL,
  "embedding" bytea NOT NULL,
  "dims" bigint,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("provider", "model", "provider_key", "hash")
);

CREATE TABLE "memory_entry_origins" (
  "entry_key" text COLLATE "C" NOT NULL,
  "agent_id" text COLLATE "C" NOT NULL,
  "session_id" text COLLATE "C" NOT NULL,
  "session_key" text COLLATE "C",
  "origin_class" text COLLATE "C" NOT NULL,
  "observed_at" bigint NOT NULL,
  PRIMARY KEY ("entry_key", "agent_id", "session_id"),
  CHECK (("origin_class" IN ('owner', 'agent', 'untrusted', 'system')))
);

CREATE TABLE "memory_index_chunk_provenance" (
  "chunk_id" text COLLATE "C" NOT NULL,
  "origin_class" text COLLATE "C" NOT NULL,
  "session_kind" text COLLATE "C" NOT NULL,
  "observed_at" bigint NOT NULL,
  "supersedes_key" text COLLATE "C",
  PRIMARY KEY ("chunk_id"),
  CHECK (("origin_class" IN ('owner', 'agent', 'untrusted', 'system'))),
  CHECK (("session_kind" IN ('interactive', 'cron', 'heartbeat', 'subagent', 'unknown')))
);

CREATE TABLE "memory_index_chunk_recall_metadata" (
  "chunk_id" text COLLATE "C" NOT NULL,
  "importance" bigint,
  "triggers" text COLLATE "C",
  "project_key" text COLLATE "C",
  PRIMARY KEY ("chunk_id"),
  CHECK ("importance" IS NULL OR ("importance" BETWEEN 1 AND 10))
);

CREATE TABLE "memory_index_chunks" (
  "chunk_rowid" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "id" text COLLATE "C" NOT NULL,
  "path" text COLLATE "C" NOT NULL,
  "source" text COLLATE "C" NOT NULL DEFAULT 'memory',
  "start_line" bigint NOT NULL,
  "end_line" bigint NOT NULL,
  "hash" text COLLATE "C" NOT NULL,
  "model" text COLLATE "C" NOT NULL,
  "text" text COLLATE "C" NOT NULL,
  "embedding" bytea NOT NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("chunk_rowid"),
  UNIQUE ("id")
);

CREATE TABLE "memory_index_meta" (
  "key" text COLLATE "C" NOT NULL,
  "value" text COLLATE "C" NOT NULL,
  PRIMARY KEY ("key")
);

CREATE TABLE "memory_index_sources" (
  "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "path" text COLLATE "C" NOT NULL,
  "source" text COLLATE "C" NOT NULL DEFAULT 'memory',
  "hash" text COLLATE "C" NOT NULL,
  "mtime" double precision NOT NULL,
  "size" bigint NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("path", "source")
);

CREATE TABLE "memory_index_state" (
  "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "revision" bigint NOT NULL,
  PRIMARY KEY ("id"),
  CHECK (("id" = 1))
);

CREATE TABLE "memory_session_tombstones" (
  "session_id" text COLLATE "C" NOT NULL,
  "agent_id" text COLLATE "C" NOT NULL,
  "reason" text COLLATE "C" NOT NULL,
  "created_at" bigint NOT NULL,
  PRIMARY KEY ("session_id")
);

CREATE TABLE "message_tool_run_outcomes" (
  "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "run_id" text COLLATE "C" NOT NULL,
  "session_key" text COLLATE "C" NOT NULL,
  "agent_id" text COLLATE "C" NOT NULL,
  "provider" text COLLATE "C" NOT NULL,
  "model" text COLLATE "C" NOT NULL,
  "outcome" text COLLATE "C" NOT NULL,
  "run_status" text COLLATE "C" NOT NULL,
  "occurred_at" bigint NOT NULL,
  PRIMARY KEY ("id"),
  CHECK (("outcome" IN ('tool_delivered', 'mute'))),
  CHECK (("run_status" IN ('completed', 'errored', 'aborted')))
);

CREATE TABLE "schema_meta" (
  "meta_key" text COLLATE "C" NOT NULL,
  "role" text COLLATE "C" NOT NULL,
  "schema_version" bigint NOT NULL,
  "agent_id" text COLLATE "C",
  "app_version" text COLLATE "C",
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("meta_key")
);

CREATE TABLE "session_canonical_validation_pending" (
  "session_key" text COLLATE "C" NOT NULL,
  PRIMARY KEY ("session_key")
);

CREATE TABLE "session_conversations" (
  "session_id" text COLLATE "C" NOT NULL,
  "conversation_id" text COLLATE "C" NOT NULL,
  "role" text COLLATE "C" NOT NULL DEFAULT 'primary',
  "route_context_json" text COLLATE "C",
  "first_seen_at" bigint NOT NULL,
  "last_seen_at" bigint NOT NULL,
  PRIMARY KEY ("session_id", "conversation_id", "role"),
  CHECK (("role" IN ('primary', 'participant', 'related')))
);

CREATE TABLE "session_entry_snapshots" (
  "session_key" text COLLATE "C" NOT NULL,
  "field" text COLLATE "C" NOT NULL,
  "value_json" text COLLATE "C" NOT NULL,
  PRIMARY KEY ("session_key", "field"),
  CHECK (("field" IN ('sessionDiffBaseline', 'skillsSnapshot', 'systemPromptReport')))
);

CREATE TABLE "session_goal_operations" (
  "session_key" text COLLATE "C" NOT NULL,
  "operation_id" text COLLATE "C" NOT NULL,
  "session_id" text COLLATE "C" NOT NULL,
  "request_fingerprint" text COLLATE "C" NOT NULL,
  "result_json" text COLLATE "C" NOT NULL,
  "expires_at" bigint NOT NULL,
  PRIMARY KEY ("session_key", "operation_id")
);

CREATE TABLE "session_input_completions" (
  "session_key" text COLLATE "C" NOT NULL,
  "session_id" text COLLATE "C" NOT NULL,
  "idempotency_key" text COLLATE "C" NOT NULL,
  "run_id" text COLLATE "C" NOT NULL,
  "request_hash" text COLLATE "C" NOT NULL,
  "outcome_json" text COLLATE "C" NOT NULL,
  "succeeded" bigint NOT NULL,
  "completed_at" bigint NOT NULL,
  PRIMARY KEY ("session_id", "idempotency_key"),
  CHECK (("succeeded" IN (0, 1)))
);

CREATE TABLE "session_key_contract" (
  "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "main_key" text COLLATE "C" NOT NULL,
  "canonical_ready" text COLLATE "C",
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("id"),
  CHECK (("id" = 1))
);

CREATE TABLE "session_members" (
  "session_key" text COLLATE "C" NOT NULL,
  "identity_id" text COLLATE "C" NOT NULL,
  "added_by" text COLLATE "C" NOT NULL,
  "added_at" bigint NOT NULL,
  PRIMARY KEY ("session_key", "identity_id")
);

CREATE TABLE "session_nodes" (
  "session_key" text COLLATE "C" NOT NULL,
  "current_session_id" text COLLATE "C" NOT NULL,
  "entry_json" text COLLATE "C" NOT NULL,
  "session_started_at" bigint,
  "has_optional_references" bigint NOT NULL DEFAULT 0,
  "snapshot_revision" bigint NOT NULL DEFAULT 0,
  "legacy_acp_migration_json" text COLLATE "C",
  "entry_valid" bigint NOT NULL DEFAULT 0,
  "updated_at" bigint NOT NULL,
  "status" text COLLATE "C",
  "created_at" bigint,
  "created_via" text COLLATE "C",
  "created_actor_type" text COLLATE "C",
  "created_actor_id" text COLLATE "C",
  "owner_actor_type" text COLLATE "C",
  "owner_actor_id" text COLLATE "C",
  "owner_assigned_by_type" text COLLATE "C",
  "owner_assigned_by_id" text COLLATE "C",
  "owner_assigned_at" bigint,
  "project_id" text COLLATE "C",
  "parent_session_key" text COLLATE "C",
  "spawned_by" text COLLATE "C",
  "fork_source_session_key" text COLLATE "C",
  "fork_source_session_id" text COLLATE "C",
  "fork_source_entry_id" text COLLATE "C",
  "label" text COLLATE "C",
  "display_name" text COLLATE "C",
  "category" text COLLATE "C",
  "icon" text COLLATE "C",
  "pinned_at" bigint,
  "archived_at" bigint,
  "last_read_at" bigint,
  "last_interaction_at" bigint,
  "last_activity_at" bigint,
  PRIMARY KEY ("session_key"),
  CHECK (("entry_valid" IN (-1, 0, 1))),
  CHECK ("status" IS NULL OR ("status" IN ('running', 'done', 'failed', 'killed', 'timeout'))),
  CHECK ("created_via" IS NULL OR ("created_via" IN ('operator', 'spawn', 'channel', 'cron', 'talk', 'run', 'plugin', 'internal'))),
  CHECK ("created_actor_type" IS NULL OR ("created_actor_type" IN ('human', 'agent', 'system')))
);

CREATE TABLE "session_participants" (
  "session_key" text COLLATE "C" NOT NULL,
  "identity_namespace" text COLLATE "C" NOT NULL,
  "actor_id" text COLLATE "C" NOT NULL,
  "contribution_count" bigint NOT NULL,
  "first_prompted_at" bigint,
  "last_prompted_at" bigint,
  PRIMARY KEY ("session_key", "identity_namespace", "actor_id")
);

CREATE TABLE "session_pending_inputs" (
  "seq" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "input_id" text COLLATE "C" NOT NULL,
  "session_key" text COLLATE "C" NOT NULL,
  "session_id" text COLLATE "C" NOT NULL,
  "idempotency_key" text COLLATE "C" NOT NULL,
  "run_id" text COLLATE "C" NOT NULL,
  "request_hash" text COLLATE "C" NOT NULL,
  "message_json" text COLLATE "C" NOT NULL,
  "lifecycle_generation" text COLLATE "C" NOT NULL,
  "state" text COLLATE "C" NOT NULL,
  "accepted_at" bigint NOT NULL,
  "consumed_event_id" text COLLATE "C",
  PRIMARY KEY ("seq"),
  CHECK (("state" IN ('queued', 'interrupted', 'cancelled'))),
  UNIQUE ("input_id"),
  UNIQUE ("session_id", "idempotency_key")
);

CREATE TABLE "session_progress_cards" (
  "session_key" text COLLATE "C" NOT NULL,
  "markdown" text COLLATE "C",
  "steps_json" text COLLATE "C",
  "revision" bigint NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("session_key")
);

CREATE TABLE "session_reactions" (
  "session_key" text COLLATE "C" NOT NULL,
  "session_id" text COLLATE "C" NOT NULL,
  "message_id" text COLLATE "C" NOT NULL,
  "emoji" text COLLATE "C" NOT NULL,
  "identity_id" text COLLATE "C" NOT NULL,
  "identity_label" text COLLATE "C",
  "created_at" bigint NOT NULL,
  PRIMARY KEY ("session_key", "session_id", "message_id", "emoji", "identity_id")
);

CREATE TABLE "session_suggestions" (
  "id" text COLLATE "C" NOT NULL,
  "session_key" text COLLATE "C" NOT NULL,
  "author_id" text COLLATE "C" NOT NULL,
  "author_label" text COLLATE "C",
  "text" text COLLATE "C" NOT NULL,
  "created_at" bigint NOT NULL,
  "state" text COLLATE "C" NOT NULL,
  "dispatch_token" text COLLATE "C",
  "dispatch_started_at" bigint,
  "dispatch_resolution" text COLLATE "C",
  PRIMARY KEY ("id"),
  CHECK (("state" IN ('pending', 'accepted', 'dismissed'))),
  CHECK (("dispatch_resolution" IN ('send', 'queue', 'edit', 'dismiss'))),
  CHECK (("dispatch_token" IS NULL AND "dispatch_started_at" IS NULL AND "dispatch_resolution" IS NULL) OR ("dispatch_token" IS NOT NULL AND "dispatch_started_at" IS NOT NULL AND "dispatch_resolution" IS NOT NULL))
);

CREATE TABLE "session_transcript_active_events" (
  "session_id" text COLLATE "C" NOT NULL,
  "active_position" bigint NOT NULL,
  "event_seq" bigint NOT NULL,
  "message_position" bigint,
  "context_eligible" bigint,
  PRIMARY KEY ("session_id", "active_position"),
  CHECK (("active_position" >= 0)),
  CHECK ("message_position" IS NULL OR ("message_position" >= 0))
);

CREATE TABLE "session_transcript_archives" (
  "session_id" text COLLATE "C" NOT NULL,
  "generation" text COLLATE "C" NOT NULL,
  "session_key" text COLLATE "C" NOT NULL,
  "reason" text COLLATE "C" NOT NULL,
  "encoding" text COLLATE "C" NOT NULL,
  "archive_blob" bytea NOT NULL,
  "archive_sha256" text COLLATE "C" NOT NULL,
  "archive_name" text COLLATE "C" NOT NULL,
  "created_at" bigint NOT NULL,
  "published_at" bigint,
  "publish_attempts" bigint NOT NULL DEFAULT 0,
  "last_publish_attempt_at" bigint,
  "last_publish_error" text COLLATE "C",
  PRIMARY KEY ("session_id", "generation"),
  CHECK (("reason" IN ('deleted', 'reset'))),
  CHECK (("encoding" IN ('identity', 'zstd'))),
  CHECK ((char_length("archive_sha256") = 64)),
  CHECK (("publish_attempts" >= 0)),
  CHECK ((strpos("archive_name", '/') = 0) AND (strpos("archive_name", '\') = 0)),
  UNIQUE ("archive_name")
);

CREATE TABLE "session_transcript_cold_archives" (
  "session_id" text COLLATE "C" NOT NULL,
  "generation" text COLLATE "C" NOT NULL,
  "archive_name" text COLLATE "C" NOT NULL,
  "archive_sha256" text COLLATE "C" NOT NULL,
  "event_count" bigint NOT NULL,
  "raw_bytes" bigint NOT NULL,
  "archive_bytes" bigint NOT NULL,
  "last_seq" bigint NOT NULL,
  "archived_at" bigint NOT NULL,
  "storage" text COLLATE "C" NOT NULL,
  "archive_blob" bytea,
  PRIMARY KEY ("session_id"),
  CHECK ((char_length("archive_sha256") = 64)),
  CHECK (("event_count" >= 1)),
  CHECK (("raw_bytes" >= 0)),
  CHECK (("archive_bytes" >= 0)),
  CHECK (("storage" IN ('file', 'sqlite'))),
  CHECK ((char_length("archive_name") > 0) AND ("archive_name" NOT IN ('.', '..')) AND (strpos("archive_name", '/') = 0) AND (strpos("archive_name", '\') = 0)),
  CHECK ((("storage" = 'file') AND "archive_blob" IS NULL) OR (("storage" = 'sqlite') AND "archive_blob" IS NOT NULL)),
  UNIQUE ("archive_name")
);

CREATE TABLE "session_transcript_fts_rows" (
  "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "session_id" text COLLATE "C" NOT NULL,
  "message_id" text COLLATE "C",
  PRIMARY KEY ("id")
);

CREATE TABLE "session_transcript_index_state" (
  "session_id" text COLLATE "C" NOT NULL,
  "indexed_seq" bigint NOT NULL,
  "leaf_event_id" text COLLATE "C",
  "needs_rebuild" bigint NOT NULL DEFAULT 0,
  "active_event_count" bigint NOT NULL DEFAULT 0,
  "active_message_count" bigint NOT NULL DEFAULT 0,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("session_id")
);

CREATE TABLE "session_windows" (
  "session_id" text COLLATE "C" NOT NULL,
  "session_key" text COLLATE "C" NOT NULL,
  "previous_session_id" text COLLATE "C",
  "reason" text COLLATE "C",
  "session_scope" text COLLATE "C" NOT NULL DEFAULT 'conversation',
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "transcript_updated_at" bigint DEFAULT NULL,
  "transcript_observed_at" bigint DEFAULT NULL,
  "session_entry_provenance" bigint NOT NULL DEFAULT 0,
  "acp_owned" bigint NOT NULL DEFAULT 0,
  "plugin_owner_id" text COLLATE "C",
  "hook_external_content_source" text COLLATE "C",
  "started_at" bigint,
  "ended_at" bigint,
  "status" text COLLATE "C",
  "chat_type" text COLLATE "C",
  "channel" text COLLATE "C",
  "account_id" text COLLATE "C",
  "primary_conversation_id" text COLLATE "C",
  "model_provider" text COLLATE "C",
  "model" text COLLATE "C",
  "agent_harness_id" text COLLATE "C",
  "parent_session_key" text COLLATE "C",
  "spawned_by" text COLLATE "C",
  "display_name" text COLLATE "C",
  PRIMARY KEY ("session_id"),
  CHECK ("reason" IS NULL OR ("reason" IN ('initial', 'reset', 'rollover', 'fork', 'rewind', 'switch', 'recovery', 'compaction'))),
  CHECK (("session_scope" IN ('conversation', 'shared-main', 'group', 'channel'))),
  CHECK (("session_entry_provenance" IN (0, 1))),
  CHECK (("acp_owned" IN (0, 1))),
  CHECK ("hook_external_content_source" IS NULL OR ("hook_external_content_source" IN ('gmail', 'webhook'))),
  CHECK ("status" IS NULL OR ("status" IN ('running', 'done', 'failed', 'killed', 'timeout'))),
  CHECK ("chat_type" IS NULL OR ("chat_type" IN ('direct', 'group', 'channel')))
);

CREATE TABLE "standing_intents" (
  "intent_key" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "id" text COLLATE "C" NOT NULL,
  "description" text COLLATE "C" NOT NULL,
  "trigger_keywords" text COLLATE "C" NOT NULL,
  "trigger_embedding" text COLLATE "C",
  "channel_scope" text COLLATE "C",
  "sender_scope" text COLLATE "C",
  "creator_sender" text COLLATE "C",
  "status" text COLLATE "C" NOT NULL,
  "expires_at" bigint NOT NULL,
  "max_fires" bigint NOT NULL,
  "fire_count" bigint NOT NULL DEFAULT 0,
  "cooldown_seconds" bigint NOT NULL DEFAULT 86400,
  "last_fired_at" bigint,
  "created_at" bigint NOT NULL,
  "source_session_id" text COLLATE "C",
  PRIMARY KEY ("intent_key"),
  CHECK ("creator_sender" IS NULL OR (char_length(btrim("creator_sender")) > 0)),
  CHECK (("status" IN ('pending', 'armed', 'fired', 'done', 'cancelled', 'expired'))),
  CHECK (("max_fires" > 0)),
  CHECK (("fire_count" >= 0)),
  CHECK (("cooldown_seconds" >= 0)),
  UNIQUE ("id")
);

CREATE TABLE "trajectory_runtime_events" (
  "session_id" text COLLATE "C" NOT NULL,
  "seq" bigint NOT NULL,
  "run_id" text COLLATE "C",
  "event_json" text COLLATE "C" NOT NULL,
  "created_at" bigint NOT NULL,
  PRIMARY KEY ("session_id", "seq")
);

CREATE TABLE "transcript_event_identities" (
  "session_id" text COLLATE "C" NOT NULL,
  "event_id" text COLLATE "C" NOT NULL,
  "seq" bigint NOT NULL,
  "event_type" text COLLATE "C",
  "parent_id" text COLLATE "C",
  "message_idempotency_key" text COLLATE "C",
  "created_at" bigint NOT NULL,
  PRIMARY KEY ("session_id", "event_id")
);

CREATE TABLE "transcript_events" (
  "session_id" text COLLATE "C" NOT NULL,
  "seq" bigint NOT NULL,
  "event_json" text COLLATE "C",
  "created_at" bigint NOT NULL,
  "event_zstd" bytea,
  "event_utf8_bytes" bigint,
  "navigation_json" text COLLATE "C",
  "navigation_type" text COLLATE "C",
  "navigation_custom_type" text COLLATE "C",
  "navigation_display" bigint NOT NULL DEFAULT 0,
  "message_role" text COLLATE "C",
  "navigation_last_type" text COLLATE "C",
  "navigation_last_custom_type" text COLLATE "C",
  "navigation_valid" bigint NOT NULL DEFAULT 1,
  PRIMARY KEY ("session_id", "seq"),
  CHECK ("event_utf8_bytes" IS NULL OR ("event_utf8_bytes" >= 0)),
  CHECK (("event_json" IS NOT NULL AND "event_zstd" IS NULL) OR ("event_json" IS NULL AND "event_zstd" IS NOT NULL AND "event_utf8_bytes" IS NOT NULL AND ("event_utf8_bytes" BETWEEN 1 AND 4194304) AND (octet_length("event_zstd") BETWEEN 1 AND 4194304) AND "navigation_json" IS NOT NULL)),
  CHECK ("openclaw_transcript_navigation_check"("navigation_json"))
);

CREATE TABLE "transcript_rewrite_watermarks" (
  "session_id" text COLLATE "C" NOT NULL,
  "generation" text COLLATE "C" NOT NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("session_id")
);

CREATE INDEX "idx_agent_acp_parent_stream_run" ON "acp_parent_stream_events" (("run_id") ASC NULLS FIRST, ("seq") ASC NULLS FIRST);

CREATE INDEX "idx_agent_board_widgets_tab_position" ON "board_widgets" (("session_key") ASC NULLS FIRST, ("tab_id") ASC NULLS FIRST, ("position") ASC NULLS FIRST);

CREATE INDEX "idx_agent_cache_expiry" ON "cache_entries" (("scope") ASC NULLS FIRST, ("expires_at") ASC NULLS FIRST, ("key") ASC NULLS FIRST) WHERE "expires_at" IS NOT NULL;

CREATE INDEX "idx_agent_cache_updated" ON "cache_entries" (("scope") ASC NULLS FIRST, ("updated_at") DESC NULLS LAST, ("key") ASC NULLS FIRST);

CREATE INDEX "idx_agent_voice_session_open_scope" ON "cache_entries" ((CASE WHEN ("value_json" IS JSON) THEN CASE WHEN json_typeof(("value_json"::json -> 'agentId')) = 'string' THEN (("value_json"::json -> 'agentId') #>> '{}') END ELSE NULL END) ASC NULLS FIRST, (CASE WHEN ("value_json" IS JSON) THEN CASE WHEN json_typeof(("value_json"::json -> 'sessionKey')) = 'string' THEN (("value_json"::json -> 'sessionKey') #>> '{}') END ELSE NULL END) ASC NULLS FIRST, (CASE WHEN ("value_json" IS JSON) THEN CASE WHEN json_typeof(("value_json"::json -> 'origin')) = 'string' THEN (("value_json"::json -> 'origin') #>> '{}') END ELSE NULL END) ASC NULLS FIRST) WHERE ("scope" = 'talk-client-voice-sessions') AND (CASE WHEN ("value_json" IS JSON) THEN CASE WHEN json_typeof(("value_json"::json -> 'status')) = 'string' THEN (("value_json"::json -> 'status') #>> '{}') END ELSE NULL END = 'open');

CREATE INDEX "idx_agent_voice_session_open_updated" ON "cache_entries" (("scope") ASC NULLS FIRST, ("updated_at") ASC NULLS FIRST) WHERE ("scope" = 'talk-client-voice-sessions') AND (CASE WHEN ("value_json" IS JSON) THEN CASE WHEN json_typeof(("value_json"::json -> 'status')) = 'string' THEN (("value_json"::json -> 'status') #>> '{}') END ELSE NULL END = 'open');

CREATE INDEX "idx_agent_context_engine_turn_outbox_engine" ON "context_engine_turn_outbox" (("engine_id") ASC NULLS FIRST, ("created_at") ASC NULLS FIRST);

CREATE INDEX "idx_agent_conversation_deliveries_reply" ON "conversation_deliveries" (("conversation_id") ASC NULLS FIRST, ("platform_message_id") ASC NULLS FIRST, ("prepared_message_id") ASC NULLS FIRST) WHERE ("status" IN ('queued', 'sent', 'replied'));

CREATE INDEX "idx_agent_conversation_deliveries_updated" ON "conversation_deliveries" (("updated_at") DESC NULLS LAST, ("operation_id") ASC NULLS FIRST);

CREATE UNIQUE INDEX "idx_agent_conversations_identity" ON "conversations" (("channel") ASC NULLS FIRST, ("account_id") ASC NULLS FIRST, ("kind") ASC NULLS FIRST, ("peer_id") ASC NULLS FIRST, (coalesce("parent_conversation_id", '')) ASC NULLS FIRST, (coalesce("thread_id", '')) ASC NULLS FIRST);

CREATE INDEX "idx_agent_conversations_lookup" ON "conversations" (("channel") ASC NULLS FIRST, ("account_id") ASC NULLS FIRST, ("kind") ASC NULLS FIRST, ("peer_id") ASC NULLS FIRST, ("thread_id") ASC NULLS FIRST);

CREATE INDEX "idx_agent_conversations_updated" ON "conversations" (("updated_at") DESC NULLS LAST, ("conversation_id") ASC NULLS FIRST);

CREATE INDEX "idx_memory_embedding_cache_updated_at" ON "memory_embedding_cache" (("updated_at") ASC NULLS FIRST);

CREATE INDEX "idx_memory_index_chunks_path_source" ON "memory_index_chunks" (("path") ASC NULLS FIRST, ("source") ASC NULLS FIRST);

CREATE INDEX "idx_memory_index_chunks_source" ON "memory_index_chunks" (("source") ASC NULLS FIRST);

CREATE INDEX "idx_memory_index_sources_source" ON "memory_index_sources" (("source") ASC NULLS FIRST);

CREATE INDEX "idx_agent_message_tool_run_outcomes_occurred" ON "message_tool_run_outcomes" (("occurred_at") DESC NULLS LAST, ("id") DESC NULLS LAST);

CREATE INDEX "idx_agent_session_conversations_conversation" ON "session_conversations" (("conversation_id") ASC NULLS FIRST, ("last_seen_at") DESC NULLS LAST, ("session_id") ASC NULLS FIRST);

CREATE UNIQUE INDEX "idx_agent_session_conversations_primary" ON "session_conversations" (("session_id") ASC NULLS FIRST) WHERE ("role" = 'primary');

CREATE INDEX "idx_agent_session_goal_operations_expiry" ON "session_goal_operations" (("expires_at") ASC NULLS FIRST);

CREATE INDEX "idx_agent_session_members_identity" ON "session_members" (("identity_id") ASC NULLS FIRST, ("session_key") ASC NULLS FIRST);

CREATE INDEX "idx_agent_session_nodes_active" ON "session_nodes" (("session_key") ASC NULLS FIRST) WHERE "archived_at" IS NULL;

CREATE INDEX "idx_agent_session_nodes_archived_at" ON "session_nodes" (("archived_at") ASC NULLS FIRST, ("session_key") ASC NULLS FIRST) WHERE "archived_at" IS NOT NULL;

CREATE INDEX "idx_agent_session_nodes_current_session_id" ON "session_nodes" (("current_session_id") ASC NULLS FIRST);

CREATE INDEX "idx_agent_session_nodes_entry_not_valid" ON "session_nodes" (("session_key") ASC NULLS FIRST) WHERE ("entry_valid" != 1);

CREATE INDEX "idx_agent_session_nodes_entry_valid_pending" ON "session_nodes" (("session_key") ASC NULLS FIRST) WHERE ("entry_valid" = 0);

CREATE INDEX "idx_agent_session_nodes_label" ON "session_nodes" (("label") ASC NULLS FIRST, ("session_key") ASC NULLS FIRST) WHERE "label" IS NOT NULL;

CREATE INDEX "idx_agent_session_nodes_last_interaction_at" ON "session_nodes" (("last_interaction_at") DESC NULLS LAST, ("session_key") ASC NULLS FIRST);

CREATE INDEX "idx_agent_session_nodes_parent_session_key" ON "session_nodes" (("parent_session_key") ASC NULLS FIRST, ("session_key") ASC NULLS FIRST);

CREATE INDEX "idx_agent_session_nodes_spawned_by" ON "session_nodes" (("spawned_by") ASC NULLS FIRST, ("session_key") ASC NULLS FIRST);

CREATE INDEX "idx_agent_session_nodes_status" ON "session_nodes" (("status") ASC NULLS FIRST, ("session_key") ASC NULLS FIRST) WHERE "status" IS NOT NULL;

CREATE INDEX "idx_agent_session_nodes_updated_at" ON "session_nodes" (("updated_at") DESC NULLS LAST, ("session_key") ASC NULLS FIRST);

CREATE INDEX "idx_agent_session_pending_inputs_session" ON "session_pending_inputs" (("session_key") ASC NULLS FIRST, ("session_id") ASC NULLS FIRST, ("seq") DESC NULLS LAST);

CREATE INDEX "idx_agent_session_reactions_message" ON "session_reactions" (("session_key") ASC NULLS FIRST, ("session_id") ASC NULLS FIRST, ("message_id") ASC NULLS FIRST);

CREATE INDEX "idx_agent_session_suggestions_author_created" ON "session_suggestions" (("author_id") ASC NULLS FIRST, ("created_at") ASC NULLS FIRST, ("id") ASC NULLS FIRST);

CREATE INDEX "idx_agent_session_suggestions_session_state_created" ON "session_suggestions" (("session_key") ASC NULLS FIRST, ("state") ASC NULLS FIRST, ("created_at") ASC NULLS FIRST, ("id") ASC NULLS FIRST);

CREATE UNIQUE INDEX "idx_agent_transcript_active_event_seq" ON "session_transcript_active_events" (("session_id") ASC NULLS FIRST, ("event_seq") ASC NULLS FIRST);

CREATE UNIQUE INDEX "idx_agent_transcript_active_messages" ON "session_transcript_active_events" (("session_id") ASC NULLS FIRST, ("message_position") ASC NULLS FIRST) WHERE "message_position" IS NOT NULL;

CREATE INDEX "idx_agent_transcript_context_pending" ON "session_transcript_active_events" (("session_id") ASC NULLS FIRST) WHERE "context_eligible" IS NULL;

CREATE INDEX "idx_agent_session_transcript_archives_pending" ON "session_transcript_archives" (("created_at") ASC NULLS FIRST, ("session_id") ASC NULLS FIRST, ("generation") ASC NULLS FIRST) WHERE "published_at" IS NULL;

CREATE INDEX "idx_agent_session_transcript_archives_retention" ON "session_transcript_archives" (("created_at") ASC NULLS FIRST, ("session_id") ASC NULLS FIRST, ("generation") ASC NULLS FIRST);

CREATE INDEX "idx_session_transcript_fts_rows_session_message" ON "session_transcript_fts_rows" (("session_id") ASC NULLS FIRST, ("message_id") ASC NULLS FIRST);

CREATE INDEX "idx_agent_session_windows_conversation" ON "session_windows" (("primary_conversation_id") ASC NULLS FIRST, ("updated_at") DESC NULLS LAST, ("session_id") ASC NULLS FIRST) WHERE "primary_conversation_id" IS NOT NULL;

CREATE INDEX "idx_agent_session_windows_created_at" ON "session_windows" (("created_at") DESC NULLS LAST, ("session_id") ASC NULLS FIRST);

CREATE INDEX "idx_agent_session_windows_session_key" ON "session_windows" (("session_key") ASC NULLS FIRST, ("updated_at") DESC NULLS LAST, ("session_id") ASC NULLS FIRST);

CREATE INDEX "idx_agent_session_windows_updated_at" ON "session_windows" (("updated_at") DESC NULLS LAST, ("session_id") ASC NULLS FIRST);

CREATE INDEX "idx_standing_intents_lifecycle" ON "standing_intents" (("status") ASC NULLS FIRST, ("expires_at") ASC NULLS FIRST, ("last_fired_at") ASC NULLS FIRST);

CREATE INDEX "idx_standing_intents_scope" ON "standing_intents" (("status") ASC NULLS FIRST, ("channel_scope") ASC NULLS FIRST, ("sender_scope") ASC NULLS FIRST);

CREATE INDEX "idx_agent_trajectory_runtime_run" ON "trajectory_runtime_events" (("session_id") ASC NULLS FIRST, ("run_id") ASC NULLS FIRST, ("created_at") ASC NULLS FIRST, (octet_length("event_json")) ASC NULLS FIRST);

CREATE INDEX "idx_agent_transcript_event_identity_sequence" ON "transcript_event_identities" (("session_id") ASC NULLS FIRST, ("seq") ASC NULLS FIRST);

CREATE INDEX "idx_agent_transcript_event_parent" ON "transcript_event_identities" (("session_id") ASC NULLS FIRST, ("parent_id") ASC NULLS FIRST) WHERE "parent_id" IS NOT NULL;

CREATE INDEX "idx_agent_transcript_event_sequence" ON "transcript_event_identities" (("session_id") ASC NULLS FIRST, ("event_type") ASC NULLS FIRST, ("seq") DESC NULLS LAST);

CREATE UNIQUE INDEX "idx_agent_transcript_message_idempotency" ON "transcript_event_identities" (("session_id") ASC NULLS FIRST, ("message_idempotency_key") ASC NULLS FIRST) WHERE "message_idempotency_key" IS NOT NULL;

ALTER TABLE "acp_parent_stream_events" ADD FOREIGN KEY ("session_id") REFERENCES "session_windows" ("session_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "board_tabs" ADD FOREIGN KEY ("session_key") REFERENCES "session_nodes" ("session_key") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "board_widgets" ADD FOREIGN KEY ("session_key", "tab_id") REFERENCES "board_tabs" ("session_key", "tab_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "conversation_deliveries" ADD FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("conversation_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "heartbeat_outcomes" ADD FOREIGN KEY ("session_key") REFERENCES "session_nodes" ("session_key") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "memory_index_chunk_provenance" ADD FOREIGN KEY ("chunk_id") REFERENCES "memory_index_chunks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "memory_index_chunk_recall_metadata" ADD FOREIGN KEY ("chunk_id") REFERENCES "memory_index_chunks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "session_conversations" ADD FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("conversation_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "session_conversations" ADD FOREIGN KEY ("session_id") REFERENCES "session_windows" ("session_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "session_entry_snapshots" ADD FOREIGN KEY ("session_key") REFERENCES "session_nodes" ("session_key") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "session_input_completions" ADD FOREIGN KEY ("session_id") REFERENCES "session_windows" ("session_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "session_input_completions" ADD FOREIGN KEY ("session_key") REFERENCES "session_nodes" ("session_key") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "session_members" ADD FOREIGN KEY ("session_key") REFERENCES "session_nodes" ("session_key") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "session_participants" ADD FOREIGN KEY ("session_key") REFERENCES "session_nodes" ("session_key") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "session_pending_inputs" ADD FOREIGN KEY ("session_id") REFERENCES "session_windows" ("session_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "session_pending_inputs" ADD FOREIGN KEY ("session_key") REFERENCES "session_nodes" ("session_key") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "session_progress_cards" ADD FOREIGN KEY ("session_key") REFERENCES "session_nodes" ("session_key") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "session_reactions" ADD FOREIGN KEY ("session_key") REFERENCES "session_nodes" ("session_key") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "session_suggestions" ADD FOREIGN KEY ("session_key") REFERENCES "session_nodes" ("session_key") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "session_transcript_active_events" ADD FOREIGN KEY ("session_id", "event_seq") REFERENCES "transcript_events" ("session_id", "seq") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "session_transcript_cold_archives" ADD FOREIGN KEY ("session_id") REFERENCES "session_windows" ("session_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "session_transcript_index_state" ADD FOREIGN KEY ("session_id") REFERENCES "session_windows" ("session_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "session_windows" ADD FOREIGN KEY ("primary_conversation_id") REFERENCES "conversations" ("conversation_id") ON UPDATE NO ACTION ON DELETE SET NULL NOT DEFERRABLE;

ALTER TABLE "session_windows" ADD FOREIGN KEY ("session_key") REFERENCES "session_nodes" ("session_key") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "trajectory_runtime_events" ADD FOREIGN KEY ("session_id") REFERENCES "session_windows" ("session_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "transcript_event_identities" ADD FOREIGN KEY ("session_id", "seq") REFERENCES "transcript_events" ("session_id", "seq") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "transcript_events" ADD FOREIGN KEY ("session_id") REFERENCES "session_windows" ("session_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "transcript_rewrite_watermarks" ADD FOREIGN KEY ("session_id") REFERENCES "session_windows" ("session_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

CREATE FUNCTION "openclaw_memory_index_chunks_trigger"() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $trigger$
BEGIN
  UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
  RETURN NULL;
END;
$trigger$;

CREATE FUNCTION "openclaw_memory_index_sources_trigger"() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $trigger$
BEGIN
  UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
  RETURN NULL;
END;
$trigger$;

CREATE FUNCTION "openclaw_session_conversations_trigger"() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $trigger$
BEGIN
  UPDATE session_conversations SET route_context_json = NULL WHERE session_id = NEW.session_id AND conversation_id = NEW.conversation_id AND role = NEW.role;
  RETURN NULL;
END;
$trigger$;

CREATE FUNCTION "openclaw_session_entry_snapshots_trigger"() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $trigger$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE session_nodes SET snapshot_revision = snapshot_revision + 1 WHERE session_key = OLD.session_key;
  ELSIF TG_OP = 'INSERT' THEN
    UPDATE session_nodes SET snapshot_revision = snapshot_revision + 1 WHERE session_key = NEW.session_key;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE session_nodes SET snapshot_revision = snapshot_revision + 1 WHERE session_key IN (OLD.session_key, NEW.session_key);
  END IF;
  RETURN NULL;
END;
$trigger$;

CREATE TRIGGER "memory_index_chunks_revision_after_delete" AFTER DELETE ON "memory_index_chunks" FOR EACH ROW EXECUTE FUNCTION "openclaw_memory_index_chunks_trigger"();

CREATE TRIGGER "memory_index_chunks_revision_after_insert" AFTER INSERT ON "memory_index_chunks" FOR EACH ROW EXECUTE FUNCTION "openclaw_memory_index_chunks_trigger"();

CREATE TRIGGER "memory_index_chunks_revision_after_update" AFTER UPDATE ON "memory_index_chunks" FOR EACH ROW EXECUTE FUNCTION "openclaw_memory_index_chunks_trigger"();

CREATE TRIGGER "memory_index_sources_revision_after_delete" AFTER DELETE ON "memory_index_sources" FOR EACH ROW EXECUTE FUNCTION "openclaw_memory_index_sources_trigger"();

CREATE TRIGGER "memory_index_sources_revision_after_insert" AFTER INSERT ON "memory_index_sources" FOR EACH ROW EXECUTE FUNCTION "openclaw_memory_index_sources_trigger"();

CREATE TRIGGER "memory_index_sources_revision_after_update" AFTER UPDATE ON "memory_index_sources" FOR EACH ROW EXECUTE FUNCTION "openclaw_memory_index_sources_trigger"();

CREATE TRIGGER "session_conversations_route_context_invalidate_after_update" AFTER UPDATE OF "role", "last_seen_at" ON "session_conversations" FOR EACH ROW WHEN (NEW.route_context_json IS NOT DISTINCT FROM OLD.route_context_json) EXECUTE FUNCTION "openclaw_session_conversations_trigger"();

CREATE TRIGGER "session_entry_snapshots_after_delete" AFTER DELETE ON "session_entry_snapshots" FOR EACH ROW EXECUTE FUNCTION "openclaw_session_entry_snapshots_trigger"();

CREATE TRIGGER "session_entry_snapshots_after_insert" AFTER INSERT ON "session_entry_snapshots" FOR EACH ROW EXECUTE FUNCTION "openclaw_session_entry_snapshots_trigger"();

CREATE TRIGGER "session_entry_snapshots_after_update" AFTER UPDATE OF "session_key", "field", "value_json" ON "session_entry_snapshots" FOR EACH ROW WHEN (NEW.session_key IS DISTINCT FROM OLD.session_key OR NEW.field IS DISTINCT FROM OLD.field OR NEW.value_json IS DISTINCT FROM OLD.value_json) EXECUTE FUNCTION "openclaw_session_entry_snapshots_trigger"();
