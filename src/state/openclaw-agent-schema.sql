CREATE TABLE IF NOT EXISTS schema_meta (
  meta_key TEXT NOT NULL PRIMARY KEY,
  role TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  agent_id TEXT,
  app_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_entries (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT,
  blob BLOB,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_agent_cache_expiry
  ON cache_entries(scope, expires_at, key)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_cache_updated
  ON cache_entries(scope, updated_at DESC, key);

CREATE TABLE IF NOT EXISTS auth_profile_store (
  store_key TEXT NOT NULL PRIMARY KEY,
  store_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_profile_state (
  state_key TEXT NOT NULL PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_index_sources (
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (path, source)
);

CREATE TABLE IF NOT EXISTS memory_index_chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_embedding_cache (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  hash TEXT NOT NULL,
  embedding TEXT NOT NULL,
  dims INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model, provider_key, hash)
);

CREATE TABLE IF NOT EXISTS memory_index_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL
);

INSERT OR IGNORE INTO memory_index_state (id, revision) VALUES (1, 0);

CREATE TRIGGER IF NOT EXISTS memory_index_sources_revision_after_insert
AFTER INSERT ON memory_index_sources
BEGIN
  UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS memory_index_sources_revision_after_update
AFTER UPDATE ON memory_index_sources
BEGIN
  UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS memory_index_sources_revision_after_delete
AFTER DELETE ON memory_index_sources
BEGIN
  UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS memory_index_chunks_revision_after_insert
AFTER INSERT ON memory_index_chunks
BEGIN
  UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS memory_index_chunks_revision_after_update
AFTER UPDATE ON memory_index_chunks
BEGIN
  UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS memory_index_chunks_revision_after_delete
AFTER DELETE ON memory_index_chunks
BEGIN
  UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
END;

CREATE INDEX IF NOT EXISTS idx_memory_embedding_cache_updated_at
  ON memory_embedding_cache(updated_at);

CREATE INDEX IF NOT EXISTS idx_memory_index_sources_source
  ON memory_index_sources(source);

CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_path_source
  ON memory_index_chunks(path, source);

CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_path
  ON memory_index_chunks(path);

CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_source
  ON memory_index_chunks(source);

-- Conversational-memory durable store (Phase 2). Immutable append-only turns
-- plus thin span/box metadata. The accordion flips boxes.state only; turns is
-- never mutated. seq is assigned monotonically per session_key at append time.
CREATE TABLE IF NOT EXISTS turns (
  session_key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  run_id TEXT,
  channel TEXT,
  ts INTEGER NOT NULL,
  noise_class TEXT,
  PRIMARY KEY (session_key, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_idempotency
  ON turns(idempotency_key);

-- Contiguous range of turns sharing a topic; belongs to at most one box.
CREATE TABLE IF NOT EXISTS spans (
  span_id TEXT NOT NULL PRIMARY KEY,
  session_key TEXT NOT NULL,
  start_seq INTEGER NOT NULL,
  end_seq INTEGER NOT NULL,
  topic TEXT,
  box_id TEXT,
  noise_class TEXT
);

CREATE INDEX IF NOT EXISTS idx_spans_session_start
  ON spans(session_key, start_seq);

CREATE INDEX IF NOT EXISTS idx_spans_box
  ON spans(box_id)
  WHERE box_id IS NOT NULL;

-- A topic that owns one or more (possibly non-contiguous) spans. Collapse/expand
-- flips state; summary/importance/suppression_rollup are dreaming-maintained (Phase 3).
CREATE TABLE IF NOT EXISTS boxes (
  box_id TEXT NOT NULL PRIMARY KEY,
  session_key TEXT NOT NULL,
  label TEXT,
  state TEXT NOT NULL DEFAULT 'live',
  summary TEXT,
  summary_embedding_ref TEXT,
  importance REAL,
  suppression_rollup TEXT,
  last_active_seq INTEGER
);

CREATE INDEX IF NOT EXISTS idx_boxes_session
  ON boxes(session_key);

-- Phase 3 associative layer foundation. These tables keep local tag/entity
-- vocabulary and lightweight associations to durable turns, spans, and boxes.
CREATE TABLE IF NOT EXISTS memory_tags (
  tag_id TEXT NOT NULL PRIMARY KEY,
  label TEXT NOT NULL,
  normalized_label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_tags_normalized_label
  ON memory_tags(normalized_label);

-- Multi-parent tag DAG edge. Cycle prevention lives in the store API.
CREATE TABLE IF NOT EXISTS memory_tag_edges (
  child_tag_id TEXT NOT NULL,
  parent_tag_id TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'is_a',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (child_tag_id, parent_tag_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_tag_edges_parent
  ON memory_tag_edges(parent_tag_id);

CREATE TABLE IF NOT EXISTS memory_entities (
  entity_id TEXT NOT NULL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  label TEXT NOT NULL,
  normalized_label TEXT NOT NULL,
  local_only INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entities_type_label
  ON memory_entities(entity_type, normalized_label);

CREATE TABLE IF NOT EXISTS memory_associations (
  association_id TEXT NOT NULL PRIMARY KEY,
  session_key TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  tag_id TEXT,
  entity_id TEXT,
  salience REAL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_associations_unique_tag
  ON memory_associations(session_key, target_type, target_id, tag_id)
  WHERE tag_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_associations_unique_entity
  ON memory_associations(session_key, target_type, target_id, entity_id)
  WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_associations_target
  ON memory_associations(session_key, target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_memory_associations_tag
  ON memory_associations(tag_id)
  WHERE tag_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_associations_entity
  ON memory_associations(entity_id)
  WHERE entity_id IS NOT NULL;
