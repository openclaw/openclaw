# PostgreSQL portability report

- Readiness tooling only: SQLite remains the runtime store and canonical .sql files remain authoritative. No data migration or runtime SQL/concurrency conformance is proved.
- Agent runtime DDL represents one admitted store UUID per owner-supplied namespace. Agent PostgreSQL enablement remains blocked on the pending search capability and runtime cutover.
- Text uses C collation. PostgreSQL text rejects NUL; SQLite length(text) stops at NUL. Data validation and numeric/JSON representation differences need a separate migration contract.
- STRICT and WITHOUT ROWID options are removed. Identity sequences do not reproduce SQLite rowid/AUTOINCREMENT/sqlite_sequence allocation or rollback semantics; each rowid alias adds a PostgreSQL PK index absent from SQLite's index_list.
- Not covered: runtime-created memory FTS5 in src/infra/database-engine/sqlite-search-schema.ts; vec0 in src/infra/database-engine/sqlite-vector.ts.
- Not covered: plugin-owned databases, including extensions/workboard/src/sqlite-store-schema.ts, extensions/logbook/src/store-schema.ts and extensions/team-reports/src/store-schema.ts.
- Not covered: additive/startup repair DDL in src/state/*-schema.ts and _migration_.ts, including openclaw-agent-transcript-fts-schema.ts, openclaw-agent-board-schema.ts and openclaw-agent-canonical-validation-migration.ts.
- Agent runtime update: the preceding agent search/cutover limitation is superseded. The generated PostgreSQL-only transcript projection and engine search admission enable agent transcript text search. PostgreSQL memory search still awaits its owner cutover.

## Counts

| Database | Object        | Total | Translated | Reported |
| -------- | ------------- | ----: | ---------: | -------: |
| state    | table         |   133 |        133 |        0 |
| state    | column        |  1402 |       1400 |        2 |
| state    | index         |   288 |        288 |        0 |
| state    | foreignKey    |    33 |         33 |        0 |
| state    | check         |   297 |        297 |        0 |
| state    | trigger       |     0 |          0 |        0 |
| state    | virtualTable  |     0 |          0 |        0 |
| state    | internalTable |     1 |          0 |        1 |
| agent    | table         |    45 |         45 |        0 |
| agent    | column        |   420 |        384 |       36 |
| agent    | index         |    98 |         94 |        4 |
| agent    | foreignKey    |    28 |         28 |        0 |
| agent    | check         |    66 |         66 |        0 |
| agent    | trigger       |     8 |          4 |        4 |
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
- internalTable `sqlite_sequence.sqlite_sequence`: SQLite-owned storage is not translated. Source: `CREATE TABLE sqlite_sequence(name,seq)`
- column `sqlite_sequence.name`: Parent table omitted. Source: ``
- column `sqlite_sequence.seq`: Parent table omitted. Source: ``

## agent: omissions and semantic notes

- context_engine_turn_outbox.enqueue_sequence: rowid alias becomes identity; rowid reuse semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.
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
- Voice indexes: the sole writer (src/talk/client-voice-session-store.ts) uses JSON.stringify; agentId/sessionKey are strings, origin is client/relay, status is open/closed. src/talk/client-voice-session-lookup.worker.ts compares strings only. Non-string members cannot match; no boolean/numeric coercion is needed. Duplicate-key JSON is unreachable from writers: SQLite resolves first-wins, PostgreSQL last-wins. P3-6 preflight must refuse duplicate-key voice rows before copying, with row evidence. Canonical JSON remains text.
- virtualTable `session_transcript_fts.session_transcript_fts`: FTS5 is not translated; pendingCapability: search; FTS sync; tsvector + GIN; preserve tokenizer/ranking semantics separately. Source: `CREATE VIRTUAL TABLE session_transcript_fts USING fts5(   text,   session_id UNINDEXED,   message_id UNINDEXED,   role UNINDEXED,   timestamp UNINDEXED,   tokenize = 'unicode61 remove_diacritics 2' )`
- column `session_transcript_fts.text`: Parent table omitted; pendingCapability: search. Source: ``
- column `session_transcript_fts.session_id`: Parent table omitted; pendingCapability: search. Source: ``
- column `session_transcript_fts.message_id`: Parent table omitted; pendingCapability: search. Source: ``
- column `session_transcript_fts.role`: Parent table omitted; pendingCapability: search. Source: ``
- column `session_transcript_fts.timestamp`: Parent table omitted; pendingCapability: search. Source: ``
- column `session_transcript_fts.session_transcript_fts`: Parent table omitted; pendingCapability: search. Source: ``
- column `session_transcript_fts.rank`: Parent table omitted; pendingCapability: search. Source: ``
- internalTable `session_transcript_fts_config.session_transcript_fts_config`: SQLite-owned storage is not translated; pendingCapability: search. Source: `CREATE TABLE 'session_transcript_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID`
- column `session_transcript_fts_config.k`: Parent table omitted; pendingCapability: search. Source: ``
- column `session_transcript_fts_config.v`: Parent table omitted; pendingCapability: search. Source: ``
- primaryKey `session_transcript_fts_config.pk`: Parent table omitted; pendingCapability: search. Source: `k`
- index `session_transcript_fts_config.sqlite_autoindex_session_transcript_fts_config_1`: Parent table omitted; pendingCapability: search. Source: `k`
- internalTable `session_transcript_fts_content.session_transcript_fts_content`: SQLite-owned storage is not translated; pendingCapability: search. Source: `CREATE TABLE 'session_transcript_fts_content'(id INTEGER PRIMARY KEY, c0, c1, c2, c3, c4)`
- column `session_transcript_fts_content.id`: Parent table omitted; pendingCapability: search. Source: `INTEGER`
- column `session_transcript_fts_content.c0`: Parent table omitted; pendingCapability: search. Source: ``
- column `session_transcript_fts_content.c1`: Parent table omitted; pendingCapability: search. Source: ``
- column `session_transcript_fts_content.c2`: Parent table omitted; pendingCapability: search. Source: ``
- column `session_transcript_fts_content.c3`: Parent table omitted; pendingCapability: search. Source: ``
- column `session_transcript_fts_content.c4`: Parent table omitted; pendingCapability: search. Source: ``
- primaryKey `session_transcript_fts_content.pk`: Parent table omitted; pendingCapability: search. Source: `id`
- internalTable `session_transcript_fts_data.session_transcript_fts_data`: SQLite-owned storage is not translated; pendingCapability: search. Source: `CREATE TABLE 'session_transcript_fts_data'(id INTEGER PRIMARY KEY, block BLOB)`
- column `session_transcript_fts_data.id`: Parent table omitted; pendingCapability: search. Source: `INTEGER`
- column `session_transcript_fts_data.block`: Parent table omitted; pendingCapability: search. Source: `BLOB`
- primaryKey `session_transcript_fts_data.pk`: Parent table omitted; pendingCapability: search. Source: `id`
- internalTable `session_transcript_fts_docsize.session_transcript_fts_docsize`: SQLite-owned storage is not translated; pendingCapability: search. Source: `CREATE TABLE 'session_transcript_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB)`
- column `session_transcript_fts_docsize.id`: Parent table omitted; pendingCapability: search. Source: `INTEGER`
- column `session_transcript_fts_docsize.sz`: Parent table omitted; pendingCapability: search. Source: `BLOB`
- primaryKey `session_transcript_fts_docsize.pk`: Parent table omitted; pendingCapability: search. Source: `id`
- internalTable `session_transcript_fts_idx.session_transcript_fts_idx`: SQLite-owned storage is not translated; pendingCapability: search. Source: `CREATE TABLE 'session_transcript_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID`
- column `session_transcript_fts_idx.segid`: Parent table omitted; pendingCapability: search. Source: ``
- column `session_transcript_fts_idx.term`: Parent table omitted; pendingCapability: search. Source: ``
- column `session_transcript_fts_idx.pgno`: Parent table omitted; pendingCapability: search. Source: ``
- primaryKey `session_transcript_fts_idx.pk`: Parent table omitted; pendingCapability: search. Source: `segid, term`
- index `session_transcript_fts_idx.sqlite_autoindex_session_transcript_fts_idx_1`: Parent table omitted; pendingCapability: search. Source: `segid, term`
- internalTable `sqlite_sequence.sqlite_sequence`: SQLite-owned storage is not translated. Source: `CREATE TABLE sqlite_sequence(name,seq)`
- column `sqlite_sequence.name`: Parent table omitted. Source: ``
- column `sqlite_sequence.seq`: Parent table omitted. Source: ``
- virtualTable `standing_intents_fts.standing_intents_fts`: FTS5 is not translated; pendingCapability: search; FTS sync; tsvector + GIN; preserve tokenizer/ranking semantics separately. Source: `CREATE VIRTUAL TABLE standing_intents_fts USING fts5(   trigger_keywords,   content = 'standing_intents',   content_rowid = 'intent_key',   tokenize = 'unicode61 remove_diacritics 2' )`
- column `standing_intents_fts.trigger_keywords`: Parent table omitted; pendingCapability: search. Source: ``
- column `standing_intents_fts.standing_intents_fts`: Parent table omitted; pendingCapability: search. Source: ``
- column `standing_intents_fts.rank`: Parent table omitted; pendingCapability: search. Source: ``
- internalTable `standing_intents_fts_config.standing_intents_fts_config`: SQLite-owned storage is not translated; pendingCapability: search. Source: `CREATE TABLE 'standing_intents_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID`
- column `standing_intents_fts_config.k`: Parent table omitted; pendingCapability: search. Source: ``
- column `standing_intents_fts_config.v`: Parent table omitted; pendingCapability: search. Source: ``
- primaryKey `standing_intents_fts_config.pk`: Parent table omitted; pendingCapability: search. Source: `k`
- index `standing_intents_fts_config.sqlite_autoindex_standing_intents_fts_config_1`: Parent table omitted; pendingCapability: search. Source: `k`
- internalTable `standing_intents_fts_data.standing_intents_fts_data`: SQLite-owned storage is not translated; pendingCapability: search. Source: `CREATE TABLE 'standing_intents_fts_data'(id INTEGER PRIMARY KEY, block BLOB)`
- column `standing_intents_fts_data.id`: Parent table omitted; pendingCapability: search. Source: `INTEGER`
- column `standing_intents_fts_data.block`: Parent table omitted; pendingCapability: search. Source: `BLOB`
- primaryKey `standing_intents_fts_data.pk`: Parent table omitted; pendingCapability: search. Source: `id`
- internalTable `standing_intents_fts_docsize.standing_intents_fts_docsize`: SQLite-owned storage is not translated; pendingCapability: search. Source: `CREATE TABLE 'standing_intents_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB)`
- column `standing_intents_fts_docsize.id`: Parent table omitted; pendingCapability: search. Source: `INTEGER`
- column `standing_intents_fts_docsize.sz`: Parent table omitted; pendingCapability: search. Source: `BLOB`
- primaryKey `standing_intents_fts_docsize.pk`: Parent table omitted; pendingCapability: search. Source: `id`
- internalTable `standing_intents_fts_idx.standing_intents_fts_idx`: SQLite-owned storage is not translated; pendingCapability: search. Source: `CREATE TABLE 'standing_intents_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID`
- column `standing_intents_fts_idx.segid`: Parent table omitted; pendingCapability: search. Source: ``
- column `standing_intents_fts_idx.term`: Parent table omitted; pendingCapability: search. Source: ``
- column `standing_intents_fts_idx.pgno`: Parent table omitted; pendingCapability: search. Source: ``
- primaryKey `standing_intents_fts_idx.pk`: Parent table omitted; pendingCapability: search. Source: `segid, term`
- index `standing_intents_fts_idx.sqlite_autoindex_standing_intents_fts_idx_1`: Parent table omitted; pendingCapability: search. Source: `segid, term`
- trigger `session_transcript_fts_rows.session_transcript_fts_rows_after_delete`: trigger is not translated; pendingCapability: search; FTS sync; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER session_transcript_fts_rows_after_delete AFTER DELETE ON session_transcript_fts_rows BEGIN   DELETE FROM session_transcript_fts WHERE rowid = OLD.id; END`
- trigger `standing_intents.standing_intents_fts_after_delete`: trigger is not translated; pendingCapability: search; FTS sync; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER standing_intents_fts_after_delete AFTER DELETE ON standing_intents BEGIN   INSERT INTO standing_intents_fts(standing_intents_fts, rowid, trigger_keywords)   VALUES ('delete', old.intent_key, old.trigger_keywords); END`
- trigger `standing_intents.standing_intents_fts_after_insert`: trigger is not translated; pendingCapability: search; FTS sync; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER standing_intents_fts_after_insert AFTER INSERT ON standing_intents BEGIN   INSERT INTO standing_intents_fts(rowid, trigger_keywords)   VALUES (new.intent_key, new.trigger_keywords); END`
- trigger `standing_intents.standing_intents_fts_after_update`: trigger is not translated; pendingCapability: search; FTS sync; plpgsql trigger; preserve atomicity and write authority. Source: `CREATE TRIGGER standing_intents_fts_after_update AFTER UPDATE OF trigger_keywords ON standing_intents BEGIN   INSERT INTO standing_intents_fts(standing_intents_fts, rowid, trigger_keywords)   VALUES ('delete', old.intent_key, old.trigger_keywords);   INSERT INTO standing_intents_fts(rowid, trigger_keywords)   VALUES (new.intent_key, new.trigger_keywords); END`
