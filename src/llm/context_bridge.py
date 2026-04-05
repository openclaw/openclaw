"""
Context Bridge — 3-layer persistent context transfer for cross-model swaps.

Solves the KV cache destruction problem when switching between
Qwen2.5-Coder-14B-AWQ ↔ DeepSeek-R1-distill-Qwen-14B-AWQ.

Architecture:
  Layer 1 — Summary Layer: structured JSON summaries generated before model unload
  Layer 2 — Fact Store: SQLite-backed persistent pipeline state
  Layer 3 — Embedding DB: ChromaDB semantic memory for long-term retrieval

Both models share the Qwen2 tokenizer, so text-level transfer is efficient.
"""

import json
import sqlite3
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import structlog

logger = structlog.get_logger("ContextBridge")

# Default paths
_DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "context_bridge.db"
_DEFAULT_CHROMA_DIR = Path(__file__).resolve().parent.parent / "data" / "context_embeddings"


# ---------------------------------------------------------------------------
# Layer 3 — Embedding Store (ChromaDB semantic memory)
# ---------------------------------------------------------------------------

class EmbeddingStore:
    """ChromaDB-backed semantic memory for long-term context retrieval.

    Provides `where` filter support for efficient pruning without
    loading all items into memory.
    """

    def __init__(self, persist_dir: Optional[str] = None, collection_name: str = "context_bridge"):
        self._persist_dir = str(persist_dir or _DEFAULT_CHROMA_DIR)
        self._collection_name = collection_name
        self._collection = None
        self._client = None

    def _ensure_collection(self):
        """Lazy-init ChromaDB (optional dependency)."""
        if self._collection is not None:
            return
        try:
            import chromadb
            self._client = chromadb.PersistentClient(path=self._persist_dir)
            self._collection = self._client.get_or_create_collection(
                name=self._collection_name,
                metadata={"hnsw:space": "cosine"},
            )
            logger.info("EmbeddingStore initialized", persist_dir=self._persist_dir)
        except ImportError:
            logger.warning("chromadb not installed — EmbeddingStore disabled")
        except Exception as e:
            logger.error("EmbeddingStore init failed", error=str(e))

    def add(self, doc_id: str, text: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        """Add or update a document in the embedding store."""
        self._ensure_collection()
        if self._collection is None:
            return
        meta = metadata or {}
        meta.setdefault("timestamp", time.time())
        self._collection.upsert(ids=[doc_id], documents=[text], metadatas=[meta])

    def query(self, text: str, n_results: int = 5, where: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """Semantic search with optional metadata `where` filter."""
        self._ensure_collection()
        if self._collection is None:
            return []
        kwargs: Dict[str, Any] = {"query_texts": [text], "n_results": n_results}
        if where:
            kwargs["where"] = where
        try:
            results = self._collection.query(**kwargs)
            docs = results.get("documents", [[]])[0]
            metas = results.get("metadatas", [[]])[0]
            dists = results.get("distances", [[]])[0]
            return [
                {"document": d, "metadata": m, "distance": dist}
                for d, m, dist in zip(docs, metas, dists)
            ]
        except Exception as e:
            logger.warning("EmbeddingStore query failed", error=str(e))
            return []

    def prune_old(self, max_age_seconds: float = 86400.0) -> int:
        """Delete entries older than max_age_seconds using `where` filter."""
        self._ensure_collection()
        if self._collection is None:
            return 0
        cutoff = time.time() - max_age_seconds
        try:
            self._collection.delete(where={"timestamp": {"$lt": cutoff}})
            return 1  # ChromaDB doesn't return count
        except Exception as e:
            logger.warning("EmbeddingStore prune failed", error=str(e))
            return 0

    def count(self) -> int:
        self._ensure_collection()
        if self._collection is None:
            return 0
        return self._collection.count()


@dataclass
class PipelineSnapshot:
    """Serializable snapshot of pipeline state at swap point."""

    pipeline_id: str
    timestamp: float = field(default_factory=time.time)
    brigade: str = ""
    chain_position: int = 0
    source_model: str = ""
    target_model: str = ""
    accumulated_context: str = ""
    step_summaries: List[Dict[str, str]] = field(default_factory=list)
    pending_actions: List[str] = field(default_factory=list)
    key_facts: List[str] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    @classmethod
    def from_json(cls, raw: str) -> "PipelineSnapshot":
        return cls(**json.loads(raw))


# ---------------------------------------------------------------------------
# Layer 2 — Fact Store (SQLite)
# ---------------------------------------------------------------------------

class FactStore:
    """SQLite-backed persistent store for pipeline snapshots."""

    def __init__(self, db_path: Optional[str] = None):
        self._db_path = str(db_path or _DEFAULT_DB_PATH)
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path)
        self._init_schema()

    def _init_schema(self) -> None:
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS pipeline_snapshots (
                pipeline_id TEXT PRIMARY KEY,
                timestamp REAL NOT NULL,
                brigade TEXT NOT NULL,
                chain_position INTEGER NOT NULL,
                source_model TEXT NOT NULL,
                target_model TEXT NOT NULL,
                snapshot_json TEXT NOT NULL
            )
        """)
        # Keep max 50 snapshots (auto-cleanup old)
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS context_facts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pipeline_id TEXT NOT NULL,
                role TEXT NOT NULL,
                fact_type TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp REAL NOT NULL,
                FOREIGN KEY (pipeline_id) REFERENCES pipeline_snapshots(pipeline_id)
            )
        """)
        self._conn.commit()

    def save_snapshot(self, snapshot: PipelineSnapshot) -> None:
        self._conn.execute(
            """INSERT OR REPLACE INTO pipeline_snapshots
               (pipeline_id, timestamp, brigade, chain_position, source_model, target_model, snapshot_json)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                snapshot.pipeline_id,
                snapshot.timestamp,
                snapshot.brigade,
                snapshot.chain_position,
                snapshot.source_model,
                snapshot.target_model,
                snapshot.to_json(),
            ),
        )
        self._conn.commit()
        self._cleanup_old()
        logger.info("Snapshot saved", pipeline_id=snapshot.pipeline_id)

    def load_snapshot(self, pipeline_id: str) -> Optional[PipelineSnapshot]:
        row = self._conn.execute(
            "SELECT snapshot_json FROM pipeline_snapshots WHERE pipeline_id = ?",
            (pipeline_id,),
        ).fetchone()
        if row:
            return PipelineSnapshot.from_json(row[0])
        return None

    def save_fact(self, pipeline_id: str, role: str, fact_type: str, content: str) -> None:
        self._conn.execute(
            """INSERT INTO context_facts (pipeline_id, role, fact_type, content, timestamp)
               VALUES (?, ?, ?, ?, ?)""",
            (pipeline_id, role, fact_type, content, time.time()),
        )
        self._conn.commit()

    def get_facts(self, pipeline_id: str, limit: int = 20) -> List[Dict[str, str]]:
        rows = self._conn.execute(
            """SELECT role, fact_type, content FROM context_facts
               WHERE pipeline_id = ? ORDER BY timestamp DESC LIMIT ?""",
            (pipeline_id, limit),
        ).fetchall()
        return [{"role": r[0], "type": r[1], "content": r[2]} for r in rows]

    def _cleanup_old(self, keep: int = 50) -> None:
        count = self._conn.execute("SELECT COUNT(*) FROM pipeline_snapshots").fetchone()[0]
        if count > keep:
            excess = count - keep
            self._conn.execute(
                """DELETE FROM pipeline_snapshots WHERE pipeline_id IN
                    (SELECT pipeline_id FROM pipeline_snapshots
                     ORDER BY timestamp ASC LIMIT ?)""",
                (excess,),
            )
            self._conn.commit()

    def close(self) -> None:
        self._conn.close()


# ---------------------------------------------------------------------------
# Main Context Bridge
# ---------------------------------------------------------------------------

class ContextBridge:
    """Orchestrates 3-layer context transfer between model swaps."""

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        bridge_cfg = (config or {}).get("context_bridge", {})
        db_path = bridge_cfg.get("fact_store_path", str(_DEFAULT_DB_PATH))
        chroma_dir = bridge_cfg.get("embedding_store_path", str(_DEFAULT_CHROMA_DIR))
        self._enabled = bridge_cfg.get("enabled", True)
        self._summary_max_tokens = bridge_cfg.get("summary_max_tokens", 500)
        self._fact_store = FactStore(db_path)
        self._embedding_store = EmbeddingStore(chroma_dir)
        logger.info(
            "ContextBridge initialized",
            enabled=self._enabled,
            db=db_path,
            embeddings=chroma_dir,
        )

    @property
    def enabled(self) -> bool:
        return self._enabled

    # -- Layer 1: Summary generation --

    def build_handoff_summary(
        self,
        pipeline_id: str,
        brigade: str,
        chain_position: int,
        source_model: str,
        target_model: str,
        steps_results: List[Dict[str, str]],
        accumulated_context: str,
    ) -> PipelineSnapshot:
        """Build a structured snapshot before model swap."""
        step_summaries = []
        for step in steps_results:
            role = step.get("role", "unknown")
            resp = step.get("response", "")
            # Compress each step to key output (max 200 chars)
            summary = resp[:200].strip()
            if len(resp) > 200:
                boundary = max(summary.rfind(". "), summary.rfind("\n"))
                if boundary > 100:
                    summary = summary[:boundary + 1]
                summary += "..."
            step_summaries.append({"role": role, "summary": summary})

        snapshot = PipelineSnapshot(
            pipeline_id=pipeline_id,
            brigade=brigade,
            chain_position=chain_position,
            source_model=source_model,
            target_model=target_model,
            accumulated_context=accumulated_context[:self._summary_max_tokens * 4],
            step_summaries=step_summaries,
        )
        return snapshot

    # -- Layer 2: Persist --

    def save_before_swap(self, snapshot: PipelineSnapshot) -> None:
        """Persist snapshot to SQLite + ChromaDB before model unload."""
        self._fact_store.save_snapshot(snapshot)
        # Also save individual step facts
        for step in snapshot.step_summaries:
            self._fact_store.save_fact(
                snapshot.pipeline_id,
                step["role"],
                "step_output",
                step["summary"],
            )
        # Layer 3: embed accumulated context for semantic retrieval
        if snapshot.accumulated_context:
            self._embedding_store.add(
                doc_id=f"snap:{snapshot.pipeline_id}",
                text=snapshot.accumulated_context[:2000],
                metadata={
                    "pipeline_id": snapshot.pipeline_id,
                    "brigade": snapshot.brigade,
                    "timestamp": snapshot.timestamp,
                },
            )

    def restore_after_swap(self, pipeline_id: str) -> Optional[str]:
        """Restore context as a formatted string after new model loads."""
        snapshot = self._fact_store.load_snapshot(pipeline_id)
        if not snapshot:
            logger.warning("No snapshot found for restore", pipeline_id=pipeline_id)
            return None

        facts = self._fact_store.get_facts(pipeline_id)

        # Layer 3: semantic retrieval of related context
        semantic_hits = self._embedding_store.query(
            snapshot.accumulated_context[:500] if snapshot.accumulated_context else snapshot.brigade,
            n_results=3,
            where={"brigade": snapshot.brigade},
        )

        # Build context briefing for the new model
        lines = [
            f"[CONTEXT BRIDGE — transferred from {snapshot.source_model}]",
            f"Brigade: {snapshot.brigade}, Chain position: {snapshot.chain_position}",
            "",
            "Previous steps:",
        ]
        for step in snapshot.step_summaries:
            lines.append(f"  - {step['role']}: {step['summary']}")

        if snapshot.accumulated_context:
            lines.append("")
            lines.append("Accumulated context:")
            lines.append(snapshot.accumulated_context[:1000])

        if facts:
            lines.append("")
            lines.append("Key facts:")
            for f in facts[:10]:
                lines.append(f"  - [{f['role']}] {f['content'][:150]}")

        if semantic_hits:
            lines.append("")
            lines.append("Semantic context (related):")
            for hit in semantic_hits:
                lines.append(f"  - {hit['document'][:150]}")

        return "\n".join(lines)

    def prune_embeddings(self, max_age_seconds: float = 86400.0) -> int:
        """Delete old embedding entries."""
        return self._embedding_store.prune_old(max_age_seconds)

    def close(self) -> None:
        self._fact_store.close()
