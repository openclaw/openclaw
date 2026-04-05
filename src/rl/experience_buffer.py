"""Experience Replay Buffer — persistent storage for RL training data.

Stores (state, action, reward, next_state) tuples from pipeline executions
in SQLite. Provides sampling strategies for future SFT / PPO training:
- Uniform random sampling
- Prioritized sampling (higher reward → higher probability)
- Per-role sampling (e.g. only Planner steps)
- Temporal sampling (recent experiences weighted higher)

Integrates with SuperMemory's EpisodeRecord and StepExperience data types.

References:
- Prioritized Experience Replay (Schaul et al., 2016)
- SLEA-RL step-level experience (arXiv:2603.18079)
"""

from __future__ import annotations

import json
import math
import os
import random
import sqlite3
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import structlog

logger = structlog.get_logger("ExperienceBuffer")


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class Experience:
    """A single (state, action, reward) tuple from a pipeline step."""
    experience_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    episode_id: str = ""
    step_index: int = 0
    role: str = ""           # Planner, Foreman, Executor, Auditor, Archivist
    task_type: str = "general"
    # State: what the agent saw
    state_prompt: str = ""   # input prompt / context for this step
    state_memory: str = ""   # relevant memory context recalled
    # Action: what the agent produced
    action_response: str = ""
    action_model: str = ""   # which model was used
    action_tokens: int = 0
    action_latency_ms: float = 0.0
    # Reward: how good it was
    reward: float = 0.0
    reward_components: Dict[str, float] = field(default_factory=dict)
    # Metadata
    success: bool = False
    timestamp: float = field(default_factory=time.time)
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def priority(self) -> float:
        """Priority for sampling — higher abs(reward) = more informative."""
        return abs(self.reward) + 0.01  # small epsilon to avoid zero priority


# ---------------------------------------------------------------------------
# Buffer
# ---------------------------------------------------------------------------

class ExperienceReplayBuffer:
    """SQLite-backed experience replay buffer with prioritized sampling.

    Usage:
        buf = ExperienceReplayBuffer("data/rl/experiences.db")
        buf.add(Experience(episode_id="ep1", role="Planner", reward=0.8, ...))
        batch = buf.sample(n=32, strategy="prioritized")
        # batch = list of Experience tuples for training
    """

    _DEFAULT_MAX_SIZE = 50_000  # Max experiences before FIFO eviction
    _SUPPORTED_STRATEGIES = ("uniform", "prioritized", "recent", "per_role")

    def __init__(
        self,
        db_path: str = "data/rl/experiences.db",
        max_size: int = _DEFAULT_MAX_SIZE,
    ) -> None:
        self._db_path = db_path
        self._max_size = max_size
        self._conn: Optional[sqlite3.Connection] = None
        self._initialized = False

    def initialize(self) -> None:
        """Create DB and tables."""
        os.makedirs(os.path.dirname(self._db_path), exist_ok=True)
        self._conn = sqlite3.connect(self._db_path)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS experiences (
                experience_id TEXT PRIMARY KEY,
                episode_id TEXT NOT NULL,
                step_index INTEGER NOT NULL DEFAULT 0,
                role TEXT NOT NULL DEFAULT '',
                task_type TEXT NOT NULL DEFAULT 'general',
                state_prompt TEXT NOT NULL DEFAULT '',
                state_memory TEXT NOT NULL DEFAULT '',
                action_response TEXT NOT NULL DEFAULT '',
                action_model TEXT NOT NULL DEFAULT '',
                action_tokens INTEGER DEFAULT 0,
                action_latency_ms REAL DEFAULT 0.0,
                reward REAL NOT NULL DEFAULT 0.0,
                reward_components TEXT DEFAULT '{}',
                success INTEGER DEFAULT 0,
                timestamp REAL NOT NULL,
                metadata TEXT DEFAULT '{}'
            );
            CREATE INDEX IF NOT EXISTS idx_exp_episode ON experiences(episode_id);
            CREATE INDEX IF NOT EXISTS idx_exp_role ON experiences(role);
            CREATE INDEX IF NOT EXISTS idx_exp_reward ON experiences(reward DESC);
            CREATE INDEX IF NOT EXISTS idx_exp_timestamp ON experiences(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_exp_task_type ON experiences(task_type);
        """)
        self._conn.commit()
        self._initialized = True

        count = self._count()
        logger.info("ExperienceReplayBuffer initialized", db=self._db_path, size=count)

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    def add(self, exp: Experience) -> None:
        """Add an experience. Evicts oldest if buffer is full."""
        self._ensure_init()
        assert self._conn is not None

        self._conn.execute("""
            INSERT OR REPLACE INTO experiences
            (experience_id, episode_id, step_index, role, task_type,
             state_prompt, state_memory, action_response, action_model,
             action_tokens, action_latency_ms, reward, reward_components,
             success, timestamp, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            exp.experience_id, exp.episode_id, exp.step_index,
            exp.role, exp.task_type,
            exp.state_prompt[:10_000],  # truncate huge prompts
            exp.state_memory[:5_000],
            exp.action_response[:10_000],
            exp.action_model, exp.action_tokens, exp.action_latency_ms,
            exp.reward, json.dumps(exp.reward_components),
            int(exp.success), exp.timestamp,
            json.dumps(exp.metadata),
        ))
        self._conn.commit()

        # Evict oldest if over max
        count = self._count()
        if count > self._max_size:
            excess = count - self._max_size
            self._conn.execute("""
                DELETE FROM experiences WHERE experience_id IN (
                    SELECT experience_id FROM experiences
                    ORDER BY timestamp ASC LIMIT ?
                )
            """, (excess,))
            self._conn.commit()
            logger.debug("experience_evicted", evicted=excess)

    def add_batch(self, experiences: List[Experience]) -> int:
        """Add multiple experiences in a single transaction."""
        self._ensure_init()
        assert self._conn is not None

        added = 0
        with self._conn:  # transaction
            for exp in experiences:
                self._conn.execute("""
                    INSERT OR REPLACE INTO experiences
                    (experience_id, episode_id, step_index, role, task_type,
                     state_prompt, state_memory, action_response, action_model,
                     action_tokens, action_latency_ms, reward, reward_components,
                     success, timestamp, metadata)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    exp.experience_id, exp.episode_id, exp.step_index,
                    exp.role, exp.task_type,
                    exp.state_prompt[:10_000],
                    exp.state_memory[:5_000],
                    exp.action_response[:10_000],
                    exp.action_model, exp.action_tokens, exp.action_latency_ms,
                    exp.reward, json.dumps(exp.reward_components),
                    int(exp.success), exp.timestamp,
                    json.dumps(exp.metadata),
                ))
                added += 1

        logger.info("experience_batch_added", count=added)
        return added

    # ------------------------------------------------------------------
    # Sampling strategies
    # ------------------------------------------------------------------

    def sample(
        self,
        n: int = 32,
        strategy: str = "prioritized",
        role: Optional[str] = None,
        min_reward: Optional[float] = None,
        task_type: Optional[str] = None,
    ) -> List[Experience]:
        """Sample a batch of experiences for training.

        Strategies:
        - "uniform": random uniform sampling
        - "prioritized": higher abs(reward) → higher probability
        - "recent": most recent experiences first
        - "per_role": only experiences from a specific role
        """
        self._ensure_init()
        assert self._conn is not None

        if strategy not in self._SUPPORTED_STRATEGIES:
            raise ValueError(f"Unknown strategy: {strategy}. Use one of {self._SUPPORTED_STRATEGIES}")

        # Build WHERE clause
        conditions = []
        params: list = []

        if role:
            conditions.append("role = ?")
            params.append(role)
        if min_reward is not None:
            conditions.append("reward >= ?")
            params.append(min_reward)
        if task_type:
            conditions.append("task_type = ?")
            params.append(task_type)

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        if strategy == "recent":
            query = f"SELECT * FROM experiences {where} ORDER BY timestamp DESC LIMIT ?"
            params.append(n)
            rows = self._conn.execute(query, params).fetchall()

        elif strategy == "prioritized":
            # Fetch candidate pool (3x sample size), then prioritized sample in Python
            pool_size = min(n * 3, self._count())
            query = f"SELECT * FROM experiences {where} ORDER BY ABS(reward) DESC LIMIT ?"
            params.append(pool_size)
            rows = self._conn.execute(query, params).fetchall()
            if len(rows) > n:
                # Weighted sampling by priority
                priorities = [abs(self._row_reward(r)) + 0.01 for r in rows]
                total_p = sum(priorities)
                probs = [p / total_p for p in priorities]
                indices = []
                for _ in range(n):
                    idx = self._weighted_choice(probs)
                    indices.append(idx)
                    # Reduce probability of re-selection (without replacement approx)
                    probs[idx] *= 0.1
                    total_p_new = sum(probs)
                    probs = [p / total_p_new for p in probs]
                rows = [rows[i] for i in indices]

        else:  # "uniform" or "per_role"
            query = f"SELECT * FROM experiences {where} ORDER BY RANDOM() LIMIT ?"
            params.append(n)
            rows = self._conn.execute(query, params).fetchall()

        return [self._row_to_experience(r) for r in rows]

    def sample_successful(self, n: int = 32, min_reward: float = 0.5) -> List[Experience]:
        """Shortcut: sample only successful experiences for SFT."""
        return self.sample(n=n, strategy="prioritized", min_reward=min_reward)

    def sample_failures(self, n: int = 16) -> List[Experience]:
        """Sample failed experiences for negative example training."""
        self._ensure_init()
        assert self._conn is not None
        rows = self._conn.execute(
            "SELECT * FROM experiences WHERE success = 0 ORDER BY RANDOM() LIMIT ?",
            (n,),
        ).fetchall()
        return [self._row_to_experience(r) for r in rows]

    # ------------------------------------------------------------------
    # Stats & queries
    # ------------------------------------------------------------------

    def get_stats(self) -> Dict[str, Any]:
        """Return buffer statistics."""
        self._ensure_init()
        assert self._conn is not None

        total = self._count()
        if total == 0:
            return {
                "total": 0, "successful": 0, "failed": 0,
                "mean_reward": 0.0, "by_role": {}, "by_task_type": {},
            }

        success_count = self._conn.execute(
            "SELECT COUNT(*) FROM experiences WHERE success = 1"
        ).fetchone()[0]

        mean_reward = self._conn.execute(
            "SELECT AVG(reward) FROM experiences"
        ).fetchone()[0] or 0.0

        by_role = {}
        for row in self._conn.execute(
            "SELECT role, COUNT(*), AVG(reward) FROM experiences GROUP BY role"
        ).fetchall():
            by_role[row[0]] = {"count": row[1], "avg_reward": round(row[2] or 0.0, 4)}

        by_task = {}
        for row in self._conn.execute(
            "SELECT task_type, COUNT(*), AVG(reward) FROM experiences GROUP BY task_type"
        ).fetchall():
            by_task[row[0]] = {"count": row[1], "avg_reward": round(row[2] or 0.0, 4)}

        return {
            "total": total,
            "successful": success_count,
            "failed": total - success_count,
            "mean_reward": round(mean_reward, 4),
            "by_role": by_role,
            "by_task_type": by_task,
        }

    def get_episode_trajectory(self, episode_id: str) -> List[Experience]:
        """Retrieve all steps of a specific episode, ordered by step index."""
        self._ensure_init()
        assert self._conn is not None
        rows = self._conn.execute(
            "SELECT * FROM experiences WHERE episode_id = ? ORDER BY step_index",
            (episode_id,),
        ).fetchall()
        return [self._row_to_experience(r) for r in rows]

    # ------------------------------------------------------------------
    # Export for training
    # ------------------------------------------------------------------

    def export_sft_jsonl(self, path: str, min_reward: float = 0.5, limit: int = 10_000) -> int:
        """Export successful experiences as SFT training JSONL.

        Format per line: {"prompt": "...", "completion": "...", "reward": 0.8}
        """
        self._ensure_init()
        assert self._conn is not None

        rows = self._conn.execute(
            "SELECT state_prompt, action_response, reward FROM experiences "
            "WHERE reward >= ? AND success = 1 ORDER BY reward DESC LIMIT ?",
            (min_reward, limit),
        ).fetchall()

        os.makedirs(os.path.dirname(path) if os.path.dirname(path) else ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            for prompt, response, reward in rows:
                line = json.dumps(
                    {"prompt": prompt, "completion": response, "reward": reward},
                    ensure_ascii=False,
                )
                f.write(line + "\n")

        logger.info("sft_exported", path=path, count=len(rows), min_reward=min_reward)
        return len(rows)

    def export_dpo_pairs(
        self,
        path: str,
        min_gap: float = 0.3,
        limit: int = 5_000,
    ) -> int:
        """Export DPO preference pairs (chosen vs rejected).

        For each prompt, pairs a high-reward response (chosen) with a
        low-reward response (rejected) from the same task_type.

        Format: {"prompt": "...", "chosen": "...", "rejected": "...", "reward_gap": 0.5}
        """
        self._ensure_init()
        assert self._conn is not None

        # Get successful and failed experiences grouped by task_type
        good_rows = self._conn.execute(
            "SELECT state_prompt, action_response, reward, task_type FROM experiences "
            "WHERE reward >= 0.5 ORDER BY reward DESC LIMIT ?",
            (limit,),
        ).fetchall()
        bad_rows = self._conn.execute(
            "SELECT state_prompt, action_response, reward, task_type FROM experiences "
            "WHERE reward < 0.0 ORDER BY reward ASC LIMIT ?",
            (limit,),
        ).fetchall()

        # Index bad rows by task_type
        bad_by_type: Dict[str, List[Tuple]] = {}
        for row in bad_rows:
            bad_by_type.setdefault(row[3], []).append(row)

        os.makedirs(os.path.dirname(path) if os.path.dirname(path) else ".", exist_ok=True)
        count = 0
        with open(path, "w", encoding="utf-8") as f:
            for g_prompt, g_response, g_reward, g_type in good_rows:
                candidates = bad_by_type.get(g_type, [])
                if not candidates:
                    continue
                # Pick a random bad example
                b_prompt, b_response, b_reward, _ = random.choice(candidates)
                gap = g_reward - b_reward
                if gap < min_gap:
                    continue
                line = json.dumps({
                    "prompt": g_prompt,
                    "chosen": g_response,
                    "rejected": b_response,
                    "reward_gap": round(gap, 4),
                }, ensure_ascii=False)
                f.write(line + "\n")
                count += 1

        logger.info("dpo_pairs_exported", path=path, count=count)
        return count

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ensure_init(self) -> None:
        if not self._initialized:
            self.initialize()

    def _count(self) -> int:
        assert self._conn is not None
        return self._conn.execute("SELECT COUNT(*) FROM experiences").fetchone()[0]

    @staticmethod
    def _row_reward(row: tuple) -> float:
        return row[11]  # reward column index

    @staticmethod
    def _row_to_experience(row: tuple) -> Experience:
        return Experience(
            experience_id=row[0],
            episode_id=row[1],
            step_index=row[2],
            role=row[3],
            task_type=row[4],
            state_prompt=row[5],
            state_memory=row[6],
            action_response=row[7],
            action_model=row[8],
            action_tokens=row[9],
            action_latency_ms=row[10],
            reward=row[11],
            reward_components=json.loads(row[12]) if row[12] else {},
            success=bool(row[13]),
            timestamp=row[14],
            metadata=json.loads(row[15]) if row[15] else {},
        )

    @staticmethod
    def _weighted_choice(probs: List[float]) -> int:
        r = random.random()
        cumulative = 0.0
        for i, p in enumerate(probs):
            cumulative += p
            if r <= cumulative:
                return i
        return len(probs) - 1
