"""Knowledge Consolidator — cross-session memory merging & deduplication.

Runs as a periodic background task to:
1. Merge episodic memories from SuperMemory into long-term facts
2. Deduplicate similar memories using embedding similarity
3. Promote frequently accessed warm memories to hot tier
4. Archive stale hot memories to cold tier
5. Generate summary facts from clusters of related episodes

This is the "sleep learning" mechanism — consolidation happens during
idle periods, not during active inference.

References:
- Memory consolidation in humans: hippocampal replay during sleep
- SLEA-RL step-level experience (arXiv:2603.18079)
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import structlog

logger = structlog.get_logger("KnowledgeConsolidator")


@dataclass
class ConsolidationResult:
    """Report from a consolidation run."""
    episodes_processed: int = 0
    facts_extracted: int = 0
    duplicates_merged: int = 0
    memories_promoted: int = 0
    memories_demoted: int = 0
    memories_archived: int = 0
    elapsed_sec: float = 0.0
    timestamp: float = field(default_factory=time.time)


class KnowledgeConsolidator:
    """Cross-session memory consolidation engine.

    Usage:
        kc = KnowledgeConsolidator(supermemory_db="data/supermemory/supermemory.db")
        result = kc.run_consolidation()
        # result.facts_extracted, result.duplicates_merged, ...
    """

    # Thresholds
    _SIMILARITY_THRESHOLD = 0.85  # above this = duplicate
    _PROMOTION_ACCESS_COUNT = 5   # accesses before warm → hot
    _DEMOTION_STALE_HOURS = 48    # hours before hot → warm
    _ARCHIVE_STALE_HOURS = 168    # hours before warm → cold (1 week)
    _MIN_EPISODE_REWARD = 0.3     # only consolidate episodes with reward above this
    _MAX_FACTS_PER_RUN = 50       # limit fact extraction per run

    def __init__(
        self,
        supermemory_db: str = "data/supermemory/supermemory.db",
        consolidation_db: str = "data/rl/consolidation.db",
    ) -> None:
        self._supermemory_db = supermemory_db
        self._consolidation_db = consolidation_db
        self._sm_conn: Optional[sqlite3.Connection] = None
        self._rl_conn: Optional[sqlite3.Connection] = None
        self._initialized = False

    def initialize(self) -> None:
        os.makedirs(os.path.dirname(self._consolidation_db), exist_ok=True)

        # Connect to SuperMemory DB (read-write)
        if os.path.exists(self._supermemory_db):
            self._sm_conn = sqlite3.connect(self._supermemory_db)
        else:
            logger.warning("SuperMemory DB not found — creating empty", path=self._supermemory_db)
            os.makedirs(os.path.dirname(self._supermemory_db), exist_ok=True)
            self._sm_conn = sqlite3.connect(self._supermemory_db)

        # Consolidation tracking DB
        self._rl_conn = sqlite3.connect(self._consolidation_db)
        self._rl_conn.execute("PRAGMA journal_mode=WAL")
        self._rl_conn.executescript("""
            CREATE TABLE IF NOT EXISTS consolidation_log (
                run_id TEXT PRIMARY KEY,
                episodes_processed INTEGER,
                facts_extracted INTEGER,
                duplicates_merged INTEGER,
                promoted INTEGER,
                demoted INTEGER,
                archived INTEGER,
                elapsed_sec REAL,
                timestamp REAL
            );
            CREATE TABLE IF NOT EXISTS extracted_facts (
                fact_id TEXT PRIMARY KEY,
                source_episode_ids TEXT NOT NULL,
                fact_text TEXT NOT NULL,
                fact_hash TEXT NOT NULL,
                importance REAL DEFAULT 0.5,
                created_at REAL
            );
            CREATE TABLE IF NOT EXISTS processed_episodes (
                episode_id TEXT PRIMARY KEY,
                processed_at REAL
            );
            CREATE INDEX IF NOT EXISTS idx_facts_hash ON extracted_facts(fact_hash);
            CREATE INDEX IF NOT EXISTS idx_facts_importance ON extracted_facts(importance DESC);
        """)
        self._rl_conn.commit()
        self._initialized = True
        logger.info("KnowledgeConsolidator initialized")

    # ------------------------------------------------------------------
    # Main consolidation pipeline
    # ------------------------------------------------------------------

    def run_consolidation(self) -> ConsolidationResult:
        """Execute one consolidation cycle. Safe to call repeatedly."""
        self._ensure_init()
        start = time.time()
        result = ConsolidationResult()

        # Step 1: Extract facts from new episodes
        result.episodes_processed, result.facts_extracted = self._extract_facts_from_episodes()

        # Step 2: Deduplicate memories
        result.duplicates_merged = self._deduplicate_memories()

        # Step 3: Promote/demote memories based on access patterns
        result.memories_promoted = self._promote_warm_to_hot()
        result.memories_demoted = self._demote_stale_hot()
        result.memories_archived = self._archive_stale_warm()

        result.elapsed_sec = round(time.time() - start, 3)
        result.timestamp = time.time()

        # Log the run
        self._log_run(result)

        logger.info(
            "consolidation_complete",
            episodes=result.episodes_processed,
            facts=result.facts_extracted,
            dupes_merged=result.duplicates_merged,
            promoted=result.memories_promoted,
            demoted=result.memories_demoted,
            archived=result.memories_archived,
            elapsed=f"{result.elapsed_sec:.2f}s",
        )
        return result

    # ------------------------------------------------------------------
    # Step 1: Fact extraction from episodes
    # ------------------------------------------------------------------

    def _extract_facts_from_episodes(self) -> Tuple[int, int]:
        """Process unprocessed episodes and extract key facts."""
        assert self._sm_conn is not None and self._rl_conn is not None

        # Find episodes not yet processed
        processed_ids = set()
        for row in self._rl_conn.execute("SELECT episode_id FROM processed_episodes").fetchall():
            processed_ids.add(row[0])

        episodes = self._sm_conn.execute(
            "SELECT episode_id, task, steps, reward, success, summary FROM episodes "
            "WHERE reward >= ? ORDER BY reward DESC",
            (self._MIN_EPISODE_REWARD,),
        ).fetchall()

        episodes_processed = 0
        facts_extracted = 0

        for ep_id, task, steps_json, reward, success, summary in episodes:
            if ep_id in processed_ids:
                continue
            if facts_extracted >= self._MAX_FACTS_PER_RUN:
                break

            steps = json.loads(steps_json) if steps_json else []

            # Extract fact from the episode
            fact_text = self._summarize_episode_to_fact(task, steps, summary, reward)
            if fact_text:
                fact_hash = hashlib.md5(fact_text.encode()).hexdigest()[:12]

                # Check for duplicate fact
                existing = self._rl_conn.execute(
                    "SELECT 1 FROM extracted_facts WHERE fact_hash = ?", (fact_hash,)
                ).fetchone()

                if not existing:
                    self._rl_conn.execute(
                        "INSERT INTO extracted_facts (fact_id, source_episode_ids, fact_text, "
                        "fact_hash, importance, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (f"fact_{fact_hash}", ep_id, fact_text, fact_hash,
                         min(1.0, reward * 0.8 + 0.2), time.time()),
                    )

                    # Also store in SuperMemory as a warm memory
                    self._store_fact_in_supermemory(fact_hash, fact_text, reward)
                    facts_extracted += 1

            # Mark episode as processed
            self._rl_conn.execute(
                "INSERT OR REPLACE INTO processed_episodes (episode_id, processed_at) VALUES (?, ?)",
                (ep_id, time.time()),
            )
            episodes_processed += 1

        self._rl_conn.commit()
        return episodes_processed, facts_extracted

    def _summarize_episode_to_fact(
        self, task: str, steps: List[Dict], summary: str, reward: float
    ) -> str:
        """Convert an episode into a concise fact statement.

        This is a heuristic extraction — future versions will use LLM summarization.
        """
        if summary:
            return f"[reward={reward:.2f}] {task}: {summary}"

        # Build from steps
        key_actions = []
        for step in steps[:5]:  # limit to 5 steps
            action = step.get("action", step.get("role", ""))
            result = step.get("result", step.get("observation", ""))
            if action and result:
                key_actions.append(f"{action}: {result[:100]}")

        if not key_actions:
            return ""

        fact = f"[reward={reward:.2f}] Task: {task[:100]}. Steps: {'; '.join(key_actions[:3])}"
        return fact[:500]

    def _store_fact_in_supermemory(self, fact_hash: str, fact_text: str, reward: float) -> None:
        """Store extracted fact as a warm memory in SuperMemory."""
        assert self._sm_conn is not None
        now = time.time()
        try:
            self._sm_conn.execute(
                "INSERT OR REPLACE INTO memories "
                "(key, content, tier, importance, source, created_at, last_access, access_count) "
                "VALUES (?, ?, 'warm', ?, 'consolidation', ?, ?, 0)",
                (f"consolidated_{fact_hash}", fact_text, min(1.0, reward), now, now),
            )
            self._sm_conn.commit()
        except sqlite3.OperationalError:
            # SuperMemory table may not exist yet — skip gracefully
            logger.debug("supermemory_table_missing — skipping fact storage")

    # ------------------------------------------------------------------
    # Step 2: Deduplication
    # ------------------------------------------------------------------

    def _deduplicate_memories(self) -> int:
        """Merge memories with near-identical content.

        Uses content hashing for exact dedup. Embedding-based similarity
        dedup will be added when ChromaDB integration is complete.
        """
        assert self._sm_conn is not None
        merged = 0

        try:
            rows = self._sm_conn.execute(
                "SELECT key, content, importance, access_count FROM memories ORDER BY importance DESC"
            ).fetchall()
        except sqlite3.OperationalError:
            return 0

        seen_hashes: Dict[str, Tuple[str, float]] = {}  # hash → (key, importance)
        to_delete: List[str] = []

        for key, content, importance, access_count in rows:
            content_hash = hashlib.md5(content.strip().lower().encode()).hexdigest()[:16]
            if content_hash in seen_hashes:
                existing_key, existing_imp = seen_hashes[content_hash]
                if importance <= existing_imp:
                    to_delete.append(key)
                else:
                    to_delete.append(existing_key)
                    seen_hashes[content_hash] = (key, importance)
                merged += 1
            else:
                seen_hashes[content_hash] = (key, importance)

        if to_delete:
            placeholders = ",".join("?" for _ in to_delete)
            self._sm_conn.execute(
                f"DELETE FROM memories WHERE key IN ({placeholders})", to_delete
            )
            self._sm_conn.commit()

        return merged

    # ------------------------------------------------------------------
    # Step 3: Tier management
    # ------------------------------------------------------------------

    def _promote_warm_to_hot(self) -> int:
        """Promote frequently accessed warm memories to hot."""
        assert self._sm_conn is not None
        try:
            result = self._sm_conn.execute(
                "UPDATE memories SET tier = 'hot', last_access = ? "
                "WHERE tier = 'warm' AND access_count >= ?",
                (time.time(), self._PROMOTION_ACCESS_COUNT),
            )
            self._sm_conn.commit()
            return result.rowcount
        except sqlite3.OperationalError:
            return 0

    def _demote_stale_hot(self) -> int:
        """Demote stale hot memories to warm."""
        assert self._sm_conn is not None
        cutoff = time.time() - (self._DEMOTION_STALE_HOURS * 3600)
        try:
            result = self._sm_conn.execute(
                "UPDATE memories SET tier = 'warm' "
                "WHERE tier = 'hot' AND last_access < ? AND importance < 0.8",
                (cutoff,),
            )
            self._sm_conn.commit()
            return result.rowcount
        except sqlite3.OperationalError:
            return 0

    def _archive_stale_warm(self) -> int:
        """Archive very stale warm memories to cold."""
        assert self._sm_conn is not None
        cutoff = time.time() - (self._ARCHIVE_STALE_HOURS * 3600)
        try:
            result = self._sm_conn.execute(
                "UPDATE memories SET tier = 'cold' "
                "WHERE tier = 'warm' AND last_access < ? AND importance < 0.5",
                (cutoff,),
            )
            self._sm_conn.commit()
            return result.rowcount
        except sqlite3.OperationalError:
            return 0

    # ------------------------------------------------------------------
    # Logging
    # ------------------------------------------------------------------

    def _log_run(self, result: ConsolidationResult) -> None:
        assert self._rl_conn is not None
        # Use high-precision timestamp to avoid collisions on rapid runs
        run_id = f"run_{result.timestamp:.6f}".replace(".", "_")
        self._rl_conn.execute(
            "INSERT OR REPLACE INTO consolidation_log VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (run_id, result.episodes_processed, result.facts_extracted,
             result.duplicates_merged, result.memories_promoted,
             result.memories_demoted, result.memories_archived,
             result.elapsed_sec, result.timestamp),
        )
        self._rl_conn.commit()

    def get_history(self, limit: int = 20) -> List[Dict[str, Any]]:
        """Get recent consolidation run history."""
        self._ensure_init()
        assert self._rl_conn is not None
        rows = self._rl_conn.execute(
            "SELECT * FROM consolidation_log ORDER BY timestamp DESC LIMIT ?", (limit,)
        ).fetchall()
        return [
            {
                "run_id": r[0], "episodes": r[1], "facts": r[2],
                "dupes_merged": r[3], "promoted": r[4], "demoted": r[5],
                "archived": r[6], "elapsed_sec": r[7], "timestamp": r[8],
            }
            for r in rows
        ]

    def _ensure_init(self) -> None:
        if not self._initialized:
            self.initialize()
