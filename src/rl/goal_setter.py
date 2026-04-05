"""Goal Setter — autonomous sub-goal generation from knowledge gaps.

Analyzes the bot's current state (memory, experience, skill coverage)
and generates prioritized learning goals that can be queued for
autonomous execution.

Goal sources:
1. Knowledge gaps — concepts referenced but not in Knowledge vault
2. Skill gaps — tool types with low success rates
3. Model gaps — task types with poor performance
4. Memory gaps — frequently asked topics with low recall quality
5. Coverage gaps — code areas without tests or documentation

Goals are stored in SQLite with priority scores and status tracking.
A scheduler (not in this module) picks the highest-priority unfinished
goal and creates a pipeline task for it.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

import structlog

logger = structlog.get_logger("GoalSetter")


class GoalStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    DEFERRED = "deferred"


class GoalSource(str, Enum):
    KNOWLEDGE_GAP = "knowledge_gap"
    SKILL_GAP = "skill_gap"
    MODEL_PERFORMANCE = "model_performance"
    MEMORY_QUALITY = "memory_quality"
    COVERAGE_GAP = "coverage_gap"
    USER_IMPLICIT = "user_implicit"  # inferred from user patterns


@dataclass
class Goal:
    """An autonomous learning sub-goal."""
    goal_id: str = ""
    title: str = ""
    description: str = ""
    source: GoalSource = GoalSource.KNOWLEDGE_GAP
    priority: float = 0.5  # 0.0 (low) → 1.0 (critical)
    status: GoalStatus = GoalStatus.PENDING
    # What to do
    action_type: str = "research"  # "research", "practice", "document", "test", "optimize"
    action_params: Dict[str, Any] = field(default_factory=dict)
    # Tracking
    attempts: int = 0
    max_attempts: int = 3
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None
    result_summary: str = ""
    reward: Optional[float] = None


class GoalSetter:
    """Generates and manages autonomous learning goals.

    Usage:
        gs = GoalSetter("data/rl/goals.db")

        # Analyze gaps and generate goals
        new_goals = gs.analyze_knowledge_gaps(knowledge_vault_path="Knowledge/")
        new_goals += gs.analyze_skill_gaps(tool_stats={...})
        new_goals += gs.analyze_model_gaps(router_stats={...})

        # Get next goal to work on
        goal = gs.next_goal()

        # Mark completed
        gs.complete_goal(goal.goal_id, reward=0.8, summary="Learned X")
    """

    _PRIORITY_BOOST_REPEATED = 0.1  # boost if gap found again
    _MAX_PENDING_GOALS = 200

    def __init__(self, db_path: str = "data/rl/goals.db") -> None:
        self._db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None
        self._initialized = False

    def initialize(self) -> None:
        os.makedirs(os.path.dirname(self._db_path), exist_ok=True)
        self._conn = sqlite3.connect(self._db_path)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS goals (
                goal_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                source TEXT NOT NULL,
                priority REAL DEFAULT 0.5,
                status TEXT DEFAULT 'pending',
                action_type TEXT DEFAULT 'research',
                action_params TEXT DEFAULT '{}',
                attempts INTEGER DEFAULT 0,
                max_attempts INTEGER DEFAULT 3,
                created_at REAL,
                updated_at REAL,
                completed_at REAL,
                result_summary TEXT DEFAULT '',
                reward REAL
            );
            CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
            CREATE INDEX IF NOT EXISTS idx_goals_priority ON goals(priority DESC);
            CREATE INDEX IF NOT EXISTS idx_goals_source ON goals(source);
        """)
        self._conn.commit()
        self._initialized = True
        logger.info("GoalSetter initialized", db=self._db_path)

    # ------------------------------------------------------------------
    # Gap analysis → goal generation
    # ------------------------------------------------------------------

    def analyze_knowledge_gaps(
        self,
        knowledge_vault_path: str = "Knowledge/",
        referenced_concepts: Optional[List[str]] = None,
    ) -> List[Goal]:
        """Scan Knowledge vault for missing concepts.

        Compares `referenced_concepts` (from recent prompts/code) against
        existing .md files in the vault. Creates goals for missing ones.
        """
        self._ensure_init()

        existing_concepts: set[str] = set()
        if os.path.isdir(knowledge_vault_path):
            for root, _, files in os.walk(knowledge_vault_path):
                for f in files:
                    if f.endswith(".md"):
                        existing_concepts.add(f.replace(".md", "").lower())

        if not referenced_concepts:
            return []

        new_goals = []
        for concept in referenced_concepts:
            normalized = concept.lower().strip()
            if normalized in existing_concepts:
                continue
            if self._goal_exists(normalized, GoalSource.KNOWLEDGE_GAP):
                # Boost priority of existing gap
                self._boost_priority(normalized, GoalSource.KNOWLEDGE_GAP)
                continue

            goal = Goal(
                goal_id=f"kg_{int(time.time())}_{normalized[:20]}",
                title=f"Research: {concept}",
                description=f"Knowledge vault missing concept: '{concept}'. "
                            f"Research and create Knowledge/{concept}.md",
                source=GoalSource.KNOWLEDGE_GAP,
                priority=0.4,
                action_type="research",
                action_params={"concept": concept, "output_path": f"Knowledge/Concepts/{concept}.md"},
            )
            self._save_goal(goal)
            new_goals.append(goal)

        logger.info("knowledge_gaps_analyzed",
                     existing=len(existing_concepts),
                     referenced=len(referenced_concepts),
                     new_goals=len(new_goals))
        return new_goals

    def analyze_skill_gaps(self, tool_stats: Dict[str, Dict[str, Any]]) -> List[Goal]:
        """Find tools with low success rates and create practice goals.

        Args:
            tool_stats: from ToolLearningTracker.get_stats() —
                        {tool_name: {"total_calls": N, "success_rate": 0.x, ...}}
        """
        self._ensure_init()
        new_goals = []

        for tool_name, stats in tool_stats.items():
            total = stats.get("total_calls", 0)
            sr = stats.get("success_rate", 1.0)
            if total < 5:
                continue  # not enough data
            if sr >= 0.8:
                continue  # good enough

            goal_key = f"skill_{tool_name}"
            if self._goal_exists(goal_key, GoalSource.SKILL_GAP):
                self._boost_priority(goal_key, GoalSource.SKILL_GAP)
                continue

            priority = min(1.0, (1.0 - sr) * total / 50)  # worse + more used = higher priority
            goal = Goal(
                goal_id=f"sg_{int(time.time())}_{tool_name[:20]}",
                title=f"Improve tool: {tool_name}",
                description=f"Tool '{tool_name}' has {sr:.0%} success rate over {total} calls. "
                            f"Practice and improve usage patterns.",
                source=GoalSource.SKILL_GAP,
                priority=round(priority, 3),
                action_type="practice",
                action_params={"tool_name": tool_name, "current_success_rate": sr},
            )
            self._save_goal(goal)
            new_goals.append(goal)

        logger.info("skill_gaps_analyzed", tools=len(tool_stats), new_goals=len(new_goals))
        return new_goals

    def analyze_model_gaps(self, router_stats: Dict[str, Any]) -> List[Goal]:
        """Find model-task combinations with poor performance.

        Args:
            router_stats: from SmartModelRouter.get_routing_stats()
        """
        self._ensure_init()
        new_goals = []

        model_outcomes = router_stats.get("model_outcomes", {})
        for model, tasks in model_outcomes.items():
            for task_type, vals in tasks.items():
                total = vals.get("total", 0)
                avg_q = vals.get("avg_quality", 0.5)
                if total < 10:
                    continue
                if avg_q >= 0.7:
                    continue

                goal_key = f"model_{model}_{task_type}"
                if self._goal_exists(goal_key, GoalSource.MODEL_PERFORMANCE):
                    continue

                goal = Goal(
                    goal_id=f"mg_{int(time.time())}_{task_type[:10]}",
                    title=f"Optimize {task_type} on {model[:20]}",
                    description=f"Model '{model}' scores avg {avg_q:.2f} on '{task_type}' "
                                f"tasks ({total} samples). Optimize prompts or routing.",
                    source=GoalSource.MODEL_PERFORMANCE,
                    priority=round(min(1.0, (0.7 - avg_q) * 3), 3),
                    action_type="optimize",
                    action_params={"model": model, "task_type": task_type, "avg_quality": avg_q},
                )
                self._save_goal(goal)
                new_goals.append(goal)

        logger.info("model_gaps_analyzed", new_goals=len(new_goals))
        return new_goals

    # ------------------------------------------------------------------
    # Goal lifecycle
    # ------------------------------------------------------------------

    def next_goal(self) -> Optional[Goal]:
        """Get the highest-priority pending goal."""
        self._ensure_init()
        assert self._conn is not None

        row = self._conn.execute(
            "SELECT * FROM goals WHERE status = ? ORDER BY priority DESC LIMIT 1",
            (GoalStatus.PENDING.value,),
        ).fetchone()

        if not row:
            return None

        goal = self._row_to_goal(row)
        # Mark as in-progress
        self._conn.execute(
            "UPDATE goals SET status = ?, updated_at = ?, attempts = attempts + 1 WHERE goal_id = ?",
            (GoalStatus.IN_PROGRESS.value, time.time(), goal.goal_id),
        )
        self._conn.commit()
        goal.status = GoalStatus.IN_PROGRESS
        goal.attempts += 1
        return goal

    def complete_goal(self, goal_id: str, reward: float = 0.0, summary: str = "") -> None:
        """Mark a goal as completed."""
        self._ensure_init()
        assert self._conn is not None
        now = time.time()
        self._conn.execute(
            "UPDATE goals SET status = ?, completed_at = ?, updated_at = ?, "
            "reward = ?, result_summary = ? WHERE goal_id = ?",
            (GoalStatus.COMPLETED.value, now, now, reward, summary[:2000], goal_id),
        )
        self._conn.commit()
        logger.info("goal_completed", goal_id=goal_id, reward=reward)

    def fail_goal(self, goal_id: str, reason: str = "") -> None:
        """Mark a goal as failed. May be retried if attempts < max_attempts."""
        self._ensure_init()
        assert self._conn is not None

        row = self._conn.execute(
            "SELECT attempts, max_attempts FROM goals WHERE goal_id = ?", (goal_id,)
        ).fetchone()

        if row and row[0] < row[1]:
            # Reset to pending for retry
            self._conn.execute(
                "UPDATE goals SET status = ?, updated_at = ?, result_summary = ? WHERE goal_id = ?",
                (GoalStatus.PENDING.value, time.time(), reason[:2000], goal_id),
            )
        else:
            self._conn.execute(
                "UPDATE goals SET status = ?, updated_at = ?, result_summary = ? WHERE goal_id = ?",
                (GoalStatus.FAILED.value, time.time(), reason[:2000], goal_id),
            )
        self._conn.commit()

    def get_stats(self) -> Dict[str, Any]:
        """Return goal statistics."""
        self._ensure_init()
        assert self._conn is not None

        by_status = {}
        for row in self._conn.execute(
            "SELECT status, COUNT(*) FROM goals GROUP BY status"
        ).fetchall():
            by_status[row[0]] = row[1]

        by_source = {}
        for row in self._conn.execute(
            "SELECT source, COUNT(*) FROM goals GROUP BY source"
        ).fetchall():
            by_source[row[0]] = row[1]

        avg_reward = self._conn.execute(
            "SELECT AVG(reward) FROM goals WHERE status = ? AND reward IS NOT NULL",
            (GoalStatus.COMPLETED.value,),
        ).fetchone()[0]

        return {
            "total": sum(by_status.values()),
            "by_status": by_status,
            "by_source": by_source,
            "avg_completed_reward": round(avg_reward or 0.0, 4),
        }

    def list_goals(
        self,
        status: Optional[GoalStatus] = None,
        source: Optional[GoalSource] = None,
        limit: int = 50,
    ) -> List[Goal]:
        """List goals with optional filtering."""
        self._ensure_init()
        assert self._conn is not None

        conditions = []
        params: list = []
        if status:
            conditions.append("status = ?")
            params.append(status.value)
        if source:
            conditions.append("source = ?")
            params.append(source.value)

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        params.append(limit)

        rows = self._conn.execute(
            f"SELECT * FROM goals {where} ORDER BY priority DESC LIMIT ?",
            params,
        ).fetchall()
        return [self._row_to_goal(r) for r in rows]

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _ensure_init(self) -> None:
        if not self._initialized:
            self.initialize()

    def _save_goal(self, goal: Goal) -> None:
        assert self._conn is not None
        self._conn.execute("""
            INSERT OR REPLACE INTO goals
            (goal_id, title, description, source, priority, status,
             action_type, action_params, attempts, max_attempts,
             created_at, updated_at, completed_at, result_summary, reward)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            goal.goal_id, goal.title, goal.description,
            goal.source.value, goal.priority, goal.status.value,
            goal.action_type, json.dumps(goal.action_params),
            goal.attempts, goal.max_attempts,
            goal.created_at, goal.updated_at, goal.completed_at,
            goal.result_summary, goal.reward,
        ))
        self._conn.commit()

    def _goal_exists(self, key: str, source: GoalSource) -> bool:
        assert self._conn is not None
        # Use exact word boundary: search for the key preceded by ': ' (title format)
        pattern = f"%: {key[:30]}%"
        row = self._conn.execute(
            "SELECT 1 FROM goals WHERE title LIKE ? AND source = ? AND status IN (?, ?)",
            (pattern, source.value, GoalStatus.PENDING.value, GoalStatus.IN_PROGRESS.value),
        ).fetchone()
        return row is not None

    def _boost_priority(self, key: str, source: GoalSource) -> None:
        assert self._conn is not None
        pattern = f"%: {key[:30]}%"
        self._conn.execute(
            "UPDATE goals SET priority = MIN(1.0, priority + ?), updated_at = ? "
            "WHERE title LIKE ? AND source = ? AND status = ?",
            (self._PRIORITY_BOOST_REPEATED, time.time(),
             pattern, source.value, GoalStatus.PENDING.value),
        )
        self._conn.commit()

    @staticmethod
    def _row_to_goal(row: tuple) -> Goal:
        return Goal(
            goal_id=row[0],
            title=row[1],
            description=row[2],
            source=GoalSource(row[3]),
            priority=row[4],
            status=GoalStatus(row[5]),
            action_type=row[6],
            action_params=json.loads(row[7]) if row[7] else {},
            attempts=row[8],
            max_attempts=row[9],
            created_at=row[10],
            updated_at=row[11],
            completed_at=row[12],
            result_summary=row[13] or "",
            reward=row[14],
        )
