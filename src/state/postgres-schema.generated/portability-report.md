# PostgreSQL portability report

- Readiness tooling only: SQLite remains the runtime store and canonical .sql files remain authoritative. No data migration or runtime SQL/concurrency conformance is proved.
- Agent topology remains undecided: schema per agent versus shared tables. The agent output represents one canonical database only.
- Text uses C collation. PostgreSQL text rejects NUL; SQLite length(text) stops at NUL. Data validation and numeric/JSON representation differences need a separate migration contract.
- STRICT and WITHOUT ROWID options are removed. Identity sequences do not reproduce SQLite rowid/AUTOINCREMENT/sqlite_sequence allocation or rollback semantics; each rowid alias adds a PostgreSQL PK index absent from SQLite's index_list.
- Not covered: runtime-created memory FTS5 in packages/memory-host-sdk/src/host/memory-schema-fts.ts; vec0 in extensions/memory-core/src/memory/manager-sync-base.ts and src/migration/doctor-memory-sidecar-import.ts.
- Not covered: plugin-owned databases, including extensions/workboard/src/sqlite-store-schema.ts, extensions/logbook/src/store-schema.ts and extensions/team-reports/src/store-schema.ts.
- Not covered: additive/startup repair DDL in src/state/*-schema.ts and _migration_.ts, including openclaw-agent-transcript-fts-schema.ts, openclaw-agent-board-schema.ts and openclaw-agent-canonical-validation-migration.ts.

## Counts

| Database | Object        | Total | Translated | Reported |
| -------- | ------------- | ----: | ---------: | -------: |
| state    | table         |   134 |        134 |        0 |
| state    | column        |  1388 |       1386 |        2 |
| state    | index         |   292 |        290 |        2 |
| state    | foreignKey    |    32 |         32 |        0 |
| state    | check         |   293 |        293 |        0 |
| state    | trigger       |     0 |          0 |        0 |
| state    | virtualTable  |     0 |          0 |        0 |
| state    | internalTable |     1 |          0 |        1 |
| agent    | table         |    45 |         45 |        0 |
| agent    | column        |   414 |        378 |       36 |
| agent    | index         |   101 |         93 |        8 |
| agent    | foreignKey    |    28 |         28 |        0 |
| agent    | check         |    66 |         63 |        3 |
| agent    | trigger       |    14 |          0 |       14 |
| agent    | virtualTable  |     2 |          0 |        2 |
| agent    | internalTable |    10 |          0 |       10 |

## state: omissions and semantic notes

- audit_events.sequence: rowid alias becomes identity; AUTOINCREMENT/sqlite_sequence never-reuse semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.
- audit_identity_keys.id: rowid alias becomes identity; rowid reuse semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.
- capture_events.id: rowid alias becomes identity; rowid reuse semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.
- claw_mcp_server_refs.independent_owner: 0/1 boolean candidate retained as bigint.
- claw_package_refs.independent_owner: 0/1 boolean candidate retained as bigint.
- config_revision_keys.id: rowid alias becomes identity; rowid reuse semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.
- cron_job_runtime_authorities.recovery_required: 0/1 boolean candidate retained as bigint.
- macos_port_guardian_records.pid: rowid alias becomes identity; rowid reuse semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.
- managed_outgoing_image_records.cleanup_pending: 0/1 boolean candidate retained as bigint.
- meeting_transcript_utterances.final: 0/1 boolean candidate retained as bigint.
- operator_approvals.requested_by_device_token_auth: 0/1 boolean candidate retained as bigint.
- outbound_message_progress.sequence: rowid alias becomes identity; AUTOINCREMENT/sqlite_sequence never-reuse semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.
- session_repository_workspaces.run_setup_script: 0/1 boolean candidate retained as bigint.
- session_state_events.sequence: rowid alias becomes identity; AUTOINCREMENT/sqlite_sequence never-reuse semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.
- index `acp_sessions.idx_acp_sessions_resume_acpx`: v22 promotion follow-up PR4b (#169254): derive the ACP resume value once and index its promoted column; pendingPromotion. Source: `CREATE INDEX idx_acp_sessions_resume_acpx   ON acp_sessions(trim(json_extract(CASE WHEN json_valid(identity_json) THEN identity_json END, '$.acpxSessionId'),     char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))`
- index `acp_sessions.idx_acp_sessions_resume_agent`: v22 promotion follow-up PR4b (#169254): derive the ACP resume value once and index its promoted column; pendingPromotion. Source: `CREATE INDEX idx_acp_sessions_resume_agent   ON acp_sessions(trim(json_extract(CASE WHEN json_valid(identity_json) THEN identity_json END, '$.agentSessionId'),     char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))`
- internalTable `sqlite_sequence.sqlite_sequence`: SQLite-owned storage is not translated. Source: `CREATE TABLE sqlite_sequence(name,seq)`
- column `sqlite_sequence.name`: Parent table omitted. Source: ``
- column `sqlite_sequence.seq`: Parent table omitted. Source: ``

## agent: omissions and semantic notes

- memory_index_chunks.chunk_rowid: rowid alias becomes identity; rowid reuse semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.
- memory_index_sources.id: rowid alias becomes identity; rowid reuse semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.
- memory_index_state.id: rowid alias becomes identity; rowid reuse semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.
- message_tool_run_outcomes.id: rowid alias becomes identity; rowid reuse semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.
- session_input_completions.succeeded: 0/1 boolean candidate retained as bigint.
- session_key_contract.id: rowid alias becomes identity; rowid reuse semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.
- session_pending_inputs.seq: rowid alias becomes identity; AUTOINCREMENT/sqlite_sequence never-reuse semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.
- session_transcript_fts_rows.id: rowid alias becomes identity; rowid reuse semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.
- session_windows.session_entry_provenance: 0/1 boolean candidate retained as bigint.
- session_windows.acp_owned: 0/1 boolean candidate retained as bigint.
- standing_intents.intent_key: rowid alias becomes identity; rowid reuse semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.
- index `cache_entries.idx_agent_voice_session_open_scope`: Index omitted: Unsupported token CASE. Source: `CREATE INDEX idx_agent_voice_session_open_scope   ON cache_entries(CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.agentId') END,     CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.sessionKey') END, CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.origin') END)   WHERE scope = 'talk-client-voice-sessions'     AND CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.status') END = 'open'`
- index `cache_entries.idx_agent_voice_session_open_updated`: Index omitted: Unsupported token CASE. Source: `CREATE INDEX idx_agent_voice_session_open_updated   ON cache_entries(scope, updated_at)   WHERE scope = 'talk-client-voice-sessions'     AND CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.status') END = 'open'`
- index `conversations.idx_agent_conversations_identity`: Index omitted: Unsupported function IFNULL. Source: `CREATE UNIQUE INDEX idx_agent_conversations_identity   ON conversations(     channel,     account_id,     kind,     peer_id,     IFNULL(parent_conversation_id, ''),     IFNULL(thread_id, '')   )`
- check `session_transcript_archives.4`: Dropped check: Unsupported NOT predicate. Source: `archive_name NOT LIKE '%/%' AND archive_name NOT LIKE '%\%'`
- check `session_transcript_cold_archives.5`: Dropped check: Unsupported NOT predicate. Source: `length ( archive_name ) > 0 AND archive_name NOT IN ( '.' , '..' ) AND archive_name NOT LIKE '%/%' AND archive_name NOT LIKE '%\%'`
- virtualTable `session_transcript_fts.session_transcript_fts`: FTS5 is not translated; FTS sync; tsvector + GIN; preserve tokenizer/ranking semantics separately. Source: `CREATE VIRTUAL TABLE session_transcript_fts USING fts5(   text,   session_id UNINDEXED,   message_id UNINDEXED,   role UNINDEXED,   timestamp UNINDEXED,   tokenize = 'unicode61 remove_diacritics 2' )`
- column `session_transcript_fts.text`: Parent table omitted. Source: ``
- column `session_transcript_fts.session_id`: Parent table omitted. Source: ``
- column `session_transcript_fts.message_id`: Parent table omitted. Source: ``
- column `session_transcript_fts.role`: Parent table omitted. Source: ``
- column `session_transcript_fts.timestamp`: Parent table omitted. Source: ``
- column `session_transcript_fts.session_transcript_fts`: Parent table omitted. Source: ``
- column `session_transcript_fts.rank`: Parent table omitted. Source: ``
- internalTable `session_transcript_fts_config.session_transcript_fts_config`: SQLite-owned storage is not translated. Source: `CREATE TABLE 'session_transcript_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID`
- column `session_transcript_fts_config.k`: Parent table omitted. Source: ``
- column `session_transcript_fts_config.v`: Parent table omitted. Source: ``
- primaryKey `session_transcript_fts_config.pk`: Parent table omitted. Source: `k`
- index `session_transcript_fts_config.sqlite_autoindex_session_transcript_fts_config_1`: Parent table omitted. Source: `k`
- internalTable `session_transcript_fts_content.session_transcript_fts_content`: SQLite-owned storage is not translated. Source: `CREATE TABLE 'session_transcript_fts_content'(id INTEGER PRIMARY KEY, c0, c1, c2, c3, c4)`
- column `session_transcript_fts_content.id`: Parent table omitted. Source: `INTEGER`
- column `session_transcript_fts_content.c0`: Parent table omitted. Source: ``
- column `session_transcript_fts_content.c1`: Parent table omitted. Source: ``
- column `session_transcript_fts_content.c2`: Parent table omitted. Source: ``
- column `session_transcript_fts_content.c3`: Parent table omitted. Source: ``
- column `session_transcript_fts_content.c4`: Parent table omitted. Source: ``
- primaryKey `session_transcript_fts_content.pk`: Parent table omitted. Source: `id`
- internalTable `session_transcript_fts_data.session_transcript_fts_data`: SQLite-owned storage is not translated. Source: `CREATE TABLE 'session_transcript_fts_data'(id INTEGER PRIMARY KEY, block BLOB)`
- column `session_transcript_fts_data.id`: Parent table omitted. Source: `INTEGER`
- column `session_transcript_fts_data.block`: Parent table omitted. Source: `BLOB`
- primaryKey `session_transcript_fts_data.pk`: Parent table omitted. Source: `id`
- internalTable `session_transcript_fts_docsize.session_transcript_fts_docsize`: SQLite-owned storage is not translated. Source: `CREATE TABLE 'session_transcript_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB)`
- column `session_transcript_fts_docsize.id`: Parent table omitted. Source: `INTEGER`
- column `session_transcript_fts_docsize.sz`: Parent table omitted. Source: `BLOB`
- primaryKey `session_transcript_fts_docsize.pk`: Parent table omitted. Source: `id`
- internalTable `session_transcript_fts_idx.session_transcript_fts_idx`: SQLite-owned storage is not translated. Source: `CREATE TABLE 'session_transcript_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID`
- column `session_transcript_fts_idx.segid`: Parent table omitted. Source: ``
- column `session_transcript_fts_idx.term`: Parent table omitted. Source: ``
- column `session_transcript_fts_idx.pgno`: Parent table omitted. Source: ``
- primaryKey `session_transcript_fts_idx.pk`: Parent table omitted. Source: `segid, term`
- index `session_transcript_fts_idx.sqlite_autoindex_session_transcript_fts_idx_1`: Parent table omitted. Source: `segid, term`
- internalTable `sqlite_sequence.sqlite_sequence`: SQLite-owned storage is not translated. Source: `CREATE TABLE sqlite_sequence(name,seq)`
- column `sqlite_sequence.name`: Parent table omitted. Source: ``
- column `sqlite_sequence.seq`: Parent table omitted. Source: ``
- virtualTable `standing_intents_fts.standing_intents_fts`: FTS5 is not translated; FTS sync; tsvector + GIN; preserve tokenizer/ranking semantics separately. Source: `CREATE VIRTUAL TABLE standing_intents_fts USING fts5(   trigger_keywords,   content = 'standing_intents',   content_rowid = 'intent_key',   tokenize = 'unicode61 remove_diacritics 2' )`
- column `standing_intents_fts.trigger_keywords`: Parent table omitted. Source: ``
- column `standing_intents_fts.standing_intents_fts`: Parent table omitted. Source: ``
- column `standing_intents_fts.rank`: Parent table omitted. Source: ``
- internalTable `standing_intents_fts_config.standing_intents_fts_config`: SQLite-owned storage is not translated. Source: `CREATE TABLE 'standing_intents_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID`
- column `standing_intents_fts_config.k`: Parent table omitted. Source: ``
- column `standing_intents_fts_config.v`: Parent table omitted. Source: ``
- primaryKey `standing_intents_fts_config.pk`: Parent table omitted. Source: `k`
- index `standing_intents_fts_config.sqlite_autoindex_standing_intents_fts_config_1`: Parent table omitted. Source: `k`
- internalTable `standing_intents_fts_data.standing_intents_fts_data`: SQLite-owned storage is not translated. Source: `CREATE TABLE 'standing_intents_fts_data'(id INTEGER PRIMARY KEY, block BLOB)`
- column `standing_intents_fts_data.id`: Parent table omitted. Source: `INTEGER`
- column `standing_intents_fts_data.block`: Parent table omitted. Source: `BLOB`
- primaryKey `standing_intents_fts_data.pk`: Parent table omitted. Source: `id`
- internalTable `standing_intents_fts_docsize.standing_intents_fts_docsize`: SQLite-owned storage is not translated. Source: `CREATE TABLE 'standing_intents_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB)`
- column `standing_intents_fts_docsize.id`: Parent table omitted. Source: `INTEGER`
- column `standing_intents_fts_docsize.sz`: Parent table omitted. Source: `BLOB`
- primaryKey `standing_intents_fts_docsize.pk`: Parent table omitted. Source: `id`
- internalTable `standing_intents_fts_idx.standing_intents_fts_idx`: SQLite-owned storage is not translated. Source: `CREATE TABLE 'standing_intents_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID`
- column `standing_intents_fts_idx.segid`: Parent table omitted. Source: ``
- column `standing_intents_fts_idx.term`: Parent table omitted. Source: ``
- column `standing_intents_fts_idx.pgno`: Parent table omitted. Source: ``
- primaryKey `standing_intents_fts_idx.pk`: Parent table omitted. Source: `segid, term`
- index `standing_intents_fts_idx.sqlite_autoindex_standing_intents_fts_idx_1`: Parent table omitted. Source: `segid, term`
- index `trajectory_runtime_events.idx_agent_trajectory_runtime_run`: Index omitted: Unsupported function octet_length. Source: `CREATE INDEX idx_agent_trajectory_runtime_run   ON trajectory_runtime_events(session_id, run_id, created_at, octet_length(event_json))`
- check `transcript_events.2`: Dropped check: Unsupported token CASE. Source: `navigation_json IS NULL OR CASE WHEN json_valid ( navigation_json ) THEN coalesce ( octet_length ( navigation_json ) <= 16384 AND json_type ( navigation_json , '$.version' ) = 'integer' AND json_extract ( navigation_json , '$.version' ) = 1 AND json_type ( navigation_json , '$.report' ) = 'object' AND json_extract ( navigation_json , '$.report.kind' ) IN ( 'canonical' , 'leaf' , 'link' , 'ignored' ) AND json_type ( navigation_json , '$.navigation' ) = 'object' AND json_type ( navigation_json , '$.reset' ) = 'object' AND json_type ( navigation_json , '$.model' ) = 'object' AND json_type ( navigation_json , '$.modelBytes' ) = 'integer' AND json_extract ( navigation_json , '$.modelBytes' ) BETWEEN 0 AND 4194304 AND json_type ( navigation_json , '$.modelWithoutCheckpointBytes' ) = 'integer' AND json_extract ( navigation_json , '$.modelWithoutCheckpointBytes' ) BETWEEN 0 AND 4194304 AND json_type ( navigation_json , '$.withoutCustomDataBytes' ) = 'integer' AND json_extract ( navigation_json , '$.withoutCustomDataBytes' ) BETWEEN 0 AND 4194304 , 0 ) ELSE 0 END`
- trigger `memory_index_chunks.memory_index_chunks_revision_after_delete`: trigger is not translated; revision counter; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER memory_index_chunks_revision_after_delete AFTER DELETE ON memory_index_chunks BEGIN   UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END`
- trigger `memory_index_chunks.memory_index_chunks_revision_after_insert`: trigger is not translated; revision counter; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER memory_index_chunks_revision_after_insert AFTER INSERT ON memory_index_chunks BEGIN   UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END`
- trigger `memory_index_chunks.memory_index_chunks_revision_after_update`: trigger is not translated; revision counter; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER memory_index_chunks_revision_after_update AFTER UPDATE ON memory_index_chunks BEGIN   UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END`
- trigger `memory_index_sources.memory_index_sources_revision_after_delete`: trigger is not translated; revision counter; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER memory_index_sources_revision_after_delete AFTER DELETE ON memory_index_sources BEGIN   UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END`
- trigger `memory_index_sources.memory_index_sources_revision_after_insert`: trigger is not translated; revision counter; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER memory_index_sources_revision_after_insert AFTER INSERT ON memory_index_sources BEGIN   UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END`
- trigger `memory_index_sources.memory_index_sources_revision_after_update`: trigger is not translated; revision counter; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER memory_index_sources_revision_after_update AFTER UPDATE ON memory_index_sources BEGIN   UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END`
- trigger `session_conversations.session_conversations_route_context_invalidate_after_update`: trigger is not translated; other; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER session_conversations_route_context_invalidate_after_update AFTER UPDATE OF role, last_seen_at ON session_conversations WHEN NEW.route_context_json IS OLD.route_context_json BEGIN   UPDATE session_conversations   SET route_context_json = NULL   WHERE session_id = NEW.session_id     AND conversation_id = NEW.conversation_id     AND role = NEW.role; END`
- trigger `session_entry_snapshots.session_entry_snapshots_after_delete`: trigger is not translated; revision counter; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER session_entry_snapshots_after_delete AFTER DELETE ON session_entry_snapshots BEGIN   UPDATE session_nodes SET snapshot_revision = snapshot_revision + 1   WHERE session_key = OLD.session_key; END`
- trigger `session_entry_snapshots.session_entry_snapshots_after_insert`: trigger is not translated; revision counter; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER session_entry_snapshots_after_insert AFTER INSERT ON session_entry_snapshots BEGIN   UPDATE session_nodes SET snapshot_revision = snapshot_revision + 1   WHERE session_key = NEW.session_key; END`
- trigger `session_entry_snapshots.session_entry_snapshots_after_update`: trigger is not translated; revision counter; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER session_entry_snapshots_after_update AFTER UPDATE OF session_key, field, value_json ON session_entry_snapshots WHEN NEW.session_key IS NOT OLD.session_key   OR NEW.field IS NOT OLD.field OR NEW.value_json IS NOT OLD.value_json BEGIN   UPDATE session_nodes SET snapshot_revision = snapshot_revision + 1   WHERE session_key IN (OLD.session_key, NEW.session_key); END`
- trigger `session_transcript_fts_rows.session_transcript_fts_rows_after_delete`: trigger is not translated; FTS sync; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER session_transcript_fts_rows_after_delete AFTER DELETE ON session_transcript_fts_rows BEGIN   DELETE FROM session_transcript_fts WHERE rowid = OLD.id; END`
- trigger `standing_intents.standing_intents_fts_after_delete`: trigger is not translated; FTS sync; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER standing_intents_fts_after_delete AFTER DELETE ON standing_intents BEGIN   INSERT INTO standing_intents_fts(standing_intents_fts, rowid, trigger_keywords)   VALUES ('delete', old.intent_key, old.trigger_keywords); END`
- trigger `standing_intents.standing_intents_fts_after_insert`: trigger is not translated; FTS sync; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER standing_intents_fts_after_insert AFTER INSERT ON standing_intents BEGIN   INSERT INTO standing_intents_fts(rowid, trigger_keywords)   VALUES (new.intent_key, new.trigger_keywords); END`
- trigger `standing_intents.standing_intents_fts_after_update`: trigger is not translated; FTS sync; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER standing_intents_fts_after_update AFTER UPDATE OF trigger_keywords ON standing_intents BEGIN   INSERT INTO standing_intents_fts(standing_intents_fts, rowid, trigger_keywords)   VALUES ('delete', old.intent_key, old.trigger_keywords);   INSERT INTO standing_intents_fts(rowid, trigger_keywords)   VALUES (new.intent_key, new.trigger_keywords); END`
