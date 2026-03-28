"""
SuperMemory — Unified persistent memory for OpenClaw Bot.

Combines:
- RAG Engine (ChromaDB) — document retrieval with cosine similarity
- Tiered Memory (hot/warm/cold) — conversation facts with importance scoring
- Episodic Memory — task trajectories for few-shot retrieval
- Cross-session persistence — SQLite-backed fact store

SuperMemory is the single entry point for all memory operations:
- store(key, content, importance) — add/update a memory item
- recall(query, top_k) — retrieve relevant memories (RAG + tiered + episodic)
- record_episode(task, steps, reward) — save a completed task trajectory
- gc() — garbage collect cold memories and compress warm ones
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import structlog

logger = structlog.get_logger("SuperMemory")


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class MemoryRecord:
    """A single memory record with tier, importance, and metadata."""
    key: str
    content: str
    tier: str = "hot"  # "hot" | "warm" | "cold"
    importance: float = 0.5
    source: str = "conversation"  # "conversation" | "tool" | "rag" | "episode"
    created_at: float = field(default_factory=time.time)
    last_access: float = field(default_factory=time.time)
    access_count: int = 0

    def touch(self) -> None:
        self.last_access = time.time()
        self.access_count += 1

    def token_estimate(self) -> int:
        return max(1, len(self.content) // 4)


@dataclass
class EpisodeRecord:
    """A completed task trajectory for few-shot retrieval."""
    episode_id: str
    task: str
    steps: List[Dict[str, str]]
    reward: float
    success: bool
    timestamp: float = field(default_factory=time.time)
    summary: str = ""


@dataclass
class StepExperience:
    """v14.1 SLEA-RL: A single step within an episode for fine-grained retrieval.

    arXiv:2603.18079 — Step-Level Experience Augmented RL
    Stores intermediate step data (role, action, observation, reward)
    to enable step-level few-shot retrieval instead of episode-level only.
    """
    step_id: str
    episode_id: str
    step_index: int
    role: str
    action: str  # what the agent did (prompt summary or tool call)
    observation: str  # result / response
    reward: float  # per-step quality score
    timestamp: float = field(default_factory=time.time)


@dataclass
class RecallResult:
    """A single result from recall()."""
    content: str
    source: str  # "rag", "hot", "warm", "cold", "episode"
    score: float
    key: str = ""


# ---------------------------------------------------------------------------
# Token budget
# ---------------------------------------------------------------------------
_MAX_HOT_TOKENS = 8000
_MAX_WARM_TOKENS = 16000
_COLD_ARCHIVE_AFTER_HOURS = 24
_WARM_DEMOTE_AFTER_HOURS = 4


class SuperMemory:
    """Unified memory system combining RAG, tiered memory, and episodic recall.

    Usage:
        mem = SuperMemory(persist_dir="data/supermemory")
        mem.initialize()
        mem.store("user_preference", "Prefers Python over JS", importance=0.8)
        results = mem.recall("What language does the user prefer?", top_k=5)
        mem.record_episode("fix_bug", [{"action": "read", "result": "found issue"}], reward=1.0)
    """

    def __init__(
        self,
        persist_dir: str = "data/supermemory",
        rag_collection: str = "openclaw_supermemory",
        index_dirs: Optional[List[str]] = None,
    ):
        self._persist_dir = persist_dir
        self._rag_collection = rag_collection
        self._index_dirs = index_dirs or []
        self._db_path = os.path.join(persist_dir, "supermemory.db")
        self._conn: Optional[sqlite3.Connection] = None
        self._rag = None  # ChromaDB collection
        self._rag_client = None
        self._initialized = False
        # In-memory tier caches (loaded from SQLite on init)
        self._hot: Dict[str, MemoryRecord] = {}
        self._warm: Dict[str, MemoryRecord] = {}
        self._cold: Dict[str, MemoryRecord] = {}
        self._episodes: List[EpisodeRecord] = []
        self._step_experiences: List[StepExperience] = []

    # ------------------------------------------------------------------
    # Initialization
    # ------------------------------------------------------------------

    def initialize(self) -> None:
        """Initialize SQLite + ChromaDB backends."""
        os.makedirs(self._persist_dir, exist_ok=True)

        # SQLite for tiered memory + episodes
        self._conn = sqlite3.connect(self._db_path)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._create_tables()
        self._load_tiers_from_db()

        # ChromaDB for RAG
        try:
            import chromadb
            from chromadb.config import Settings

            rag_dir = os.path.join(self._persist_dir, "rag")
            os.makedirs(rag_dir, exist_ok=True)
            self._rag_client = chromadb.PersistentClient(
                path=rag_dir,
                settings=Settings(anonymized_telemetry=False),
            )
            self._rag = self._rag_client.get_or_create_collection(
                name=self._rag_collection,
                metadata={"hnsw:space": "cosine"},
            )
            logger.info("SuperMemory RAG initialized", docs=self._rag.count())
        except ImportError:
            logger.warning("ChromaDB not installed — RAG disabled. pip install chromadb")
            self._rag = None

        self._initialized = True
        logger.info(
            "SuperMemory initialized",
            hot=len(self._hot), warm=len(self._warm),
            cold=len(self._cold), episodes=len(self._episodes),
        )

    def _create_tables(self) -> None:
        assert self._conn is not None
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS memories (
                key TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                tier TEXT NOT NULL DEFAULT 'hot',
                importance REAL DEFAULT 0.5,
                source TEXT DEFAULT 'conversation',
                created_at REAL,
                last_access REAL,
                access_count INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS episodes (
                episode_id TEXT PRIMARY KEY,
                task TEXT NOT NULL,
                steps TEXT NOT NULL,
                reward REAL DEFAULT 0.0,
                success INTEGER DEFAULT 0,
                timestamp REAL,
                summary TEXT DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
            CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
            CREATE INDEX IF NOT EXISTS idx_episodes_task ON episodes(task);

            -- v14.1 SLEA-RL: step-level experiences
            CREATE TABLE IF NOT EXISTS step_experiences (
                step_id TEXT PRIMARY KEY,
                episode_id TEXT NOT NULL,
                step_index INTEGER NOT NULL,
                role TEXT NOT NULL,
                action TEXT NOT NULL,
                observation TEXT NOT NULL DEFAULT '',
                reward REAL DEFAULT 0.0,
                timestamp REAL
            );
            CREATE INDEX IF NOT EXISTS idx_steps_episode ON step_experiences(episode_id);
            CREATE INDEX IF NOT EXISTS idx_steps_role ON step_experiences(role);
        """)
        self._conn.commit()

    def _load_tiers_from_db(self) -> None:
        assert self._conn is not None
        cursor = self._conn.execute("SELECT * FROM memories")
        for row in cursor.fetchall():
            rec = MemoryRecord(
                key=row[0], content=row[1], tier=row[2],
                importance=row[3], source=row[4],
                created_at=row[5], last_access=row[6], access_count=row[7],
            )
            target = {"hot": self._hot, "warm": self._warm, "cold": self._cold}.get(rec.tier, self._cold)
            target[rec.key] = rec

        # Load episodes
        cursor = self._conn.execute("SELECT * FROM episodes ORDER BY timestamp DESC LIMIT 100")
        for row in cursor.fetchall():
            self._episodes.append(EpisodeRecord(
                episode_id=row[0], task=row[1],
                steps=json.loads(row[2]) if row[2] else [],
                reward=row[3], success=bool(row[4]),
                timestamp=row[5], summary=row[6] or "",
            ))

        # v14.1 SLEA-RL: load recent step experiences
        try:
            cursor = self._conn.execute(
                "SELECT * FROM step_experiences ORDER BY timestamp DESC LIMIT 500"
            )
            for row in cursor.fetchall():
                self._step_experiences.append(StepExperience(
                    step_id=row[0], episode_id=row[1], step_index=row[2],
                    role=row[3], action=row[4], observation=row[5],
                    reward=row[6], timestamp=row[7] or time.time(),
                ))
        except sqlite3.OperationalError:
            # Table may not exist yet in older DBs — will be created on next init
            pass

    # ------------------------------------------------------------------
    # Store
    # ------------------------------------------------------------------

    def store(
        self,
        key: str,
        content: str,
        importance: float = 0.5,
        source: str = "conversation",
        tier: str = "hot",
    ) -> None:
        """Store or update a memory record."""
        if not self._initialized:
            return

        record = MemoryRecord(
            key=key, content=content, tier=tier,
            importance=min(1.0, max(0.0, importance)),
            source=source,
        )

        # Put in appropriate tier cache
        target = {"hot": self._hot, "warm": self._warm, "cold": self._cold}.get(tier, self._hot)
        target[key] = record

        # Persist to SQLite
        assert self._conn is not None
        self._conn.execute("""
            INSERT OR REPLACE INTO memories
            (key, content, tier, importance, source, created_at, last_access, access_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (key, content, tier, importance, source, record.created_at, record.last_access, 0))
        self._conn.commit()

        # Also index in RAG for semantic retrieval
        if self._rag is not None:
            self._rag.upsert(
                ids=[f"mem:{key}"],
                documents=[content],
                metadatas=[{"key": key, "tier": tier, "source": source, "importance": importance}],
            )

    # ------------------------------------------------------------------
    # Recall
    # ------------------------------------------------------------------

    def recall(self, query: str, top_k: int = 5) -> List[RecallResult]:
        """Recall relevant memories combining RAG + tiered lookup.

        Returns up to top_k results sorted by relevance score.
        """
        if not self._initialized:
            return []

        results: List[RecallResult] = []

        # 1. RAG semantic search
        if self._rag is not None:
            try:
                rag_results = self._rag.query(query_texts=[query], n_results=min(top_k, 20))
                if rag_results and rag_results["documents"]:
                    docs = rag_results["documents"][0]
                    metas = rag_results["metadatas"][0] if rag_results.get("metadatas") else [{}] * len(docs)
                    dists = rag_results["distances"][0] if rag_results.get("distances") else [1.0] * len(docs)
                    for doc, meta, dist in zip(docs, metas, dists):
                        score = max(0.0, 1.0 - dist)
                        if score >= 0.25:
                            results.append(RecallResult(
                                content=doc,
                                source=f"rag:{meta.get('source', 'unknown')}",
                                score=score,
                                key=meta.get("key", ""),
                            ))
            except Exception as e:
                logger.warning("RAG recall error", error=str(e))

        # 2. Keyword search in hot memory (highest priority)
        query_lower = query.lower()
        for rec in self._hot.values():
            if any(word in rec.content.lower() for word in query_lower.split() if len(word) > 3):
                rec.touch()
                results.append(RecallResult(
                    content=rec.content, source="hot", score=0.7 + rec.importance * 0.3, key=rec.key,
                ))

        # 3. Keyword search in warm memory
        for rec in self._warm.values():
            if any(word in rec.content.lower() for word in query_lower.split() if len(word) > 3):
                rec.touch()
                results.append(RecallResult(
                    content=rec.content, source="warm", score=0.4 + rec.importance * 0.3, key=rec.key,
                ))

        # 4. Episodic memory — match by task similarity
        for ep in self._episodes[:20]:  # only recent episodes
            if any(word in ep.task.lower() for word in query_lower.split() if len(word) > 3):
                results.append(RecallResult(
                    content=ep.summary or f"Task: {ep.task}, Reward: {ep.reward}",
                    source="episode",
                    score=0.5 + (ep.reward * 0.3 if ep.success else 0.0),
                    key=ep.episode_id,
                ))

        # Deduplicate by key, keep highest score
        seen: Dict[str, RecallResult] = {}
        for r in results:
            dedup_key = r.key or r.content[:100]
            if dedup_key not in seen or r.score > seen[dedup_key].score:
                seen[dedup_key] = r
        results = sorted(seen.values(), key=lambda r: -r.score)[:top_k]

        return results

    # ------------------------------------------------------------------
    # Episodes
    # ------------------------------------------------------------------

    def record_episode(
        self,
        task: str,
        steps: List[Dict[str, str]],
        reward: float = 0.0,
        success: bool = False,
        summary: str = "",
    ) -> str:
        """Record a completed task trajectory. Returns episode_id."""
        if not self._initialized:
            return ""

        episode_id = str(uuid.uuid4())[:8]
        ep = EpisodeRecord(
            episode_id=episode_id, task=task, steps=steps,
            reward=reward, success=success, summary=summary,
        )
        self._episodes.insert(0, ep)

        assert self._conn is not None
        self._conn.execute("""
            INSERT INTO episodes (episode_id, task, steps, reward, success, timestamp, summary)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (episode_id, task, json.dumps(steps), reward, int(success), ep.timestamp, summary))
        self._conn.commit()

        logger.info("Episode recorded", episode_id=episode_id, task=task[:60], success=success)
        return episode_id

    # ------------------------------------------------------------------
    # RAG indexing
    # ------------------------------------------------------------------

    def index_documents(self, dirs: Optional[List[str]] = None) -> Dict[str, int]:
        """Index .md files from directories into RAG."""
        if self._rag is None:
            return {"indexed": 0, "skipped": 0, "errors": 0}

        import hashlib
        import re

        target_dirs = dirs or self._index_dirs
        stats = {"indexed": 0, "skipped": 0, "errors": 0}

        for dir_path in target_dirs:
            dir_path = os.path.abspath(dir_path)
            if not os.path.isdir(dir_path):
                continue

            for root, _dirs, files in os.walk(dir_path):
                parts = Path(root).parts
                if any(p.startswith(".") or p in ("node_modules", "__pycache__") for p in parts):
                    continue

                for fname in files:
                    if not fname.endswith(".md"):
                        continue
                    fpath = os.path.join(root, fname)
                    try:
                        with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                            content = f.read()
                        if len(content.strip()) < 50:
                            stats["skipped"] += 1
                            continue

                        content_hash = hashlib.md5(content.encode()).hexdigest()[:8]
                        rel_path = os.path.relpath(fpath, dir_path)

                        # Chunk by headings
                        chunks = re.split(r"(?=^#{1,4}\s)", content, flags=re.MULTILINE)
                        chunks = [c.strip() for c in chunks if len(c.strip()) > 30]
                        if not chunks:
                            stats["skipped"] += 1
                            continue

                        ids = [f"doc:{rel_path}::{i}::{content_hash}" for i in range(len(chunks))]
                        metas = [{"source_file": rel_path, "chunk_index": i} for i in range(len(chunks))]

                        self._rag.upsert(ids=ids, documents=chunks, metadatas=metas)
                        stats["indexed"] += 1
                    except Exception as e:
                        logger.warning("Index error", file=fpath, error=str(e))
                        stats["errors"] += 1

        logger.info("SuperMemory RAG indexing complete", **stats)
        return stats

    # ------------------------------------------------------------------
    # Garbage collection
    # ------------------------------------------------------------------

    def gc(self) -> Dict[str, int]:
        """Garbage collect: demote and archive stale memories."""
        now = time.time()
        demoted = 0
        archived = 0

        # Demote hot → warm (not accessed in WARM_DEMOTE hours)
        for key in list(self._hot):
            rec = self._hot[key]
            hours_since_access = (now - rec.last_access) / 3600
            if hours_since_access > _WARM_DEMOTE_AFTER_HOURS and rec.importance < 0.8:
                rec.tier = "warm"
                self._warm[key] = rec
                del self._hot[key]
                demoted += 1

        # Archive warm → cold (not accessed in COLD_ARCHIVE hours)
        for key in list(self._warm):
            rec = self._warm[key]
            hours_since_access = (now - rec.last_access) / 3600
            if hours_since_access > _COLD_ARCHIVE_AFTER_HOURS and rec.importance < 0.6:
                rec.tier = "cold"
                self._cold[key] = rec
                del self._warm[key]
                archived += 1

        # Enforce hot token budget
        if self._total_tokens("hot") > _MAX_HOT_TOKENS:
            # Evict least important hot items
            sorted_hot = sorted(self._hot.values(), key=lambda r: r.importance)
            while self._total_tokens("hot") > _MAX_HOT_TOKENS and sorted_hot:
                evict = sorted_hot.pop(0)
                evict.tier = "warm"
                self._warm[evict.key] = evict
                del self._hot[evict.key]
                demoted += 1

        # Persist tier changes to SQLite
        if demoted + archived > 0 and self._conn:
            for rec in list(self._warm.values()) + list(self._cold.values()):
                self._conn.execute(
                    "UPDATE memories SET tier = ?, last_access = ? WHERE key = ?",
                    (rec.tier, rec.last_access, rec.key),
                )
            self._conn.commit()

        logger.info("SuperMemory GC", demoted=demoted, archived=archived)
        return {"demoted": demoted, "archived": archived}

    def _total_tokens(self, tier: str) -> int:
        store = {"hot": self._hot, "warm": self._warm, "cold": self._cold}.get(tier, {})
        return sum(r.token_estimate() for r in store.values())

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def get_stats(self) -> Dict[str, Any]:
        """Get memory statistics."""
        return {
            "hot_items": len(self._hot),
            "warm_items": len(self._warm),
            "cold_items": len(self._cold),
            "episodes": len(self._episodes),
            "step_experiences": len(self._step_experiences),
            "hot_tokens": self._total_tokens("hot"),
            "warm_tokens": self._total_tokens("warm"),
            "cold_tokens": self._total_tokens("cold"),
            "rag_docs": self._rag.count() if self._rag else 0,
            "initialized": self._initialized,
        }

    @property
    def is_ready(self) -> bool:
        return self._initialized

    # ------------------------------------------------------------------
    # v14.0: Complementary RL — Success Trajectory Library
    # arXiv:2603.17621 — Dilxat Muhtar et al.
    # ------------------------------------------------------------------

    def save_success_trajectory(
        self,
        task: str,
        chain: List[str],
        complexity: str,
        reward: float,
        response_preview: str = "",
        tools_used: Optional[List[str]] = None,
    ) -> str:
        """Сохраняет «граф решения» успешной сложной задачи в SuperMemory.

        Тегируется source="success_trajectory" для последующего few-shot поиска.
        Возвращает episode_id, или "" если SuperMemory не инициализирована.
        """
        if not self._initialized:
            return ""

        tools_used = tools_used or []
        # Записываем эпизод в episodes-таблицу
        steps = [
            {"action": role, "result": "success"} for role in chain
        ]
        summary = (
            f"[SUCCESS_TRAJECTORY] chain={' → '.join(chain)} | "
            f"complexity={complexity} | reward={reward:.2f} | "
            f"tools={','.join(tools_used) if tools_used else 'none'} | "
            f"preview={response_preview[:120]}"
        )
        episode_id = self.record_episode(
            task=task,
            steps=steps,
            reward=reward,
            success=True,
            summary=summary,
        )

        # Дополнительно кладём в hot-memory для быстрого семантического поиска
        mem_key = f"trajectory:{episode_id}"
        self.store(
            key=mem_key,
            content=summary,
            importance=min(1.0, 0.5 + reward * 0.4),
            source="success_trajectory",
            tier="warm",
        )
        logger.info(
            "Success trajectory saved",
            episode_id=episode_id,
            chain=chain,
            complexity=complexity,
            reward=round(reward, 2),
        )
        return episode_id

    def recall_similar_trajectories(
        self,
        query: str,
        top_k: int = 3,
    ) -> str:
        """Ищет похожие траектории успешных решений для few-shot инжекции в AFlow.

        Возвращает отформатированную строку few-shot-примеров
        (пустую строку если нет подходящих траекторий).
        """
        if not self._initialized:
            return ""

        # Ищем в episodes среди success_trajectory записей
        matches: List[tuple[float, EpisodeRecord]] = []
        query_words = set(w for w in query.lower().split() if len(w) > 3)
        for ep in self._episodes[:100]:
            if not ep.success:
                continue
            if "[SUCCESS_TRAJECTORY]" not in (ep.summary or ""):
                continue
            text_lower = (ep.task + " " + ep.summary).lower()
            overlap = sum(1 for w in query_words if w in text_lower)
            if overlap > 0:
                score = (ep.reward * 0.4) + (overlap / max(len(query_words), 1)) * 0.6
                matches.append((score, ep))

        # Семантический поиск через RAG — дополняем
        rag_results = [
            r for r in self.recall(query, top_k=top_k * 2)
            if r.source.startswith("rag") and "trajectory" in r.key
        ]
        for rag_r in rag_results:
            # Не дублируем
            if not any(ep.episode_id == rag_r.key.split(":")[-1] for _, ep in matches):
                # Создаём синтетический EpisodeRecord из RAG-результата
                matches.append((rag_r.score, EpisodeRecord(
                    episode_id=rag_r.key,
                    task=query[:60],
                    steps=[],
                    reward=rag_r.score,
                    success=True,
                    summary=rag_r.content,
                )))

        matches.sort(key=lambda x: -x[0])
        top_matches = matches[:top_k]

        if not top_matches:
            return ""

        lines = ["[FEW-SHOT TRAJECTORIES from past successes]"]
        for i, (score, ep) in enumerate(top_matches, 1):
            lines.append(f"Example {i} (relevance {score:.2f}):")
            lines.append(f"  Task: {ep.task[:100]}")
            lines.append(f"  {ep.summary or 'No summary'}")
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # v14.1: SLEA-RL — Step-Level Experience Augmented RL
    # arXiv:2603.18079 — Dilxat Muhtar et al.
    # ------------------------------------------------------------------

    def save_step_experience(
        self,
        episode_id: str,
        step_index: int,
        role: str,
        action: str,
        observation: str = "",
        reward: float = 0.0,
    ) -> str:
        """Сохраняет отдельный шаг выполнения пайплайна как step-level experience.

        Позволяет recall_step_experiences искать релевантные шаги по роли/ключевым словам
        для более точной few-shot инжекции на уровне отдельных шагов (а не целых эпизодов).

        Returns step_id, пустую строку если SuperMemory не инициализирована.
        """
        if not self._initialized:
            return ""

        step_id = f"{episode_id}:s{step_index}"
        step = StepExperience(
            step_id=step_id,
            episode_id=episode_id,
            step_index=step_index,
            role=role,
            action=action[:500],
            observation=observation[:500],
            reward=reward,
        )
        self._step_experiences.insert(0, step)

        # Persist to SQLite
        if self._conn:
            try:
                self._conn.execute("""
                    INSERT OR REPLACE INTO step_experiences
                    (step_id, episode_id, step_index, role, action, observation, reward, timestamp)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (step.step_id, step.episode_id, step.step_index,
                      step.role, step.action, step.observation,
                      step.reward, step.timestamp))
                self._conn.commit()
            except Exception as e:
                logger.warning("SLEA-RL: step save DB error", error=str(e))

        logger.debug(
            "SLEA-RL: step experience saved",
            step_id=step_id, role=role, reward=round(reward, 2),
        )
        return step_id

    def recall_step_experiences(
        self,
        query: str,
        role_filter: Optional[str] = None,
        top_k: int = 5,
    ) -> str:
        """Ищет похожие step-level experiences для few-shot инжекции.

        Фильтрует по role_filter (если задан) и ключевым словам из query.
        Возвращает отформатированный блок [STEP-LEVEL FEW-SHOT] или пустую строку.
        """
        if not self._initialized or not self._step_experiences:
            return ""

        query_words = set(w.lower() for w in query.split() if len(w) > 3)
        if not query_words:
            return ""

        scored: list[tuple[float, StepExperience]] = []
        for step in self._step_experiences[:200]:
            if role_filter and step.role != role_filter:
                continue
            text = (step.action + " " + step.observation).lower()
            overlap = sum(1 for w in query_words if w in text)
            if overlap > 0:
                score = (step.reward * 0.4) + (overlap / max(len(query_words), 1)) * 0.6
                scored.append((score, step))

        scored.sort(key=lambda x: -x[0])
        top = scored[:top_k]
        if not top:
            return ""

        lines = ["[STEP-LEVEL FEW-SHOT from past step experiences]"]
        for i, (score, s) in enumerate(top, 1):
            lines.append(f"Step {i} (role={s.role}, relevance={score:.2f}):")
            lines.append(f"  Action: {s.action[:200]}")
            if s.observation:
                lines.append(f"  Observation: {s.observation[:200]}")
        return "\n".join(lines)

    def decay(self, factor: float = 0.95) -> int:
        """Apply time-based importance decay to all tiers. Returns count of decayed items."""
        decayed = 0
        for store in (self._hot, self._warm, self._cold):
            for rec in store.values():
                old_imp = rec.importance
                rec.importance = max(0.01, rec.importance * factor)
                if rec.importance != old_imp:
                    decayed += 1
        # Persist to SQLite
        if decayed and self._conn:
            for store in (self._hot, self._warm, self._cold):
                for rec in store.values():
                    self._conn.execute(
                        "UPDATE memories SET importance = ? WHERE key = ?",
                        (rec.importance, rec.key),
                    )
            self._conn.commit()
        logger.info("SuperMemory decay applied", factor=factor, items_decayed=decayed)
        return decayed
