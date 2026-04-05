"""Router Optimizer — Bayesian model selection tuning from rewards.

Learns which OpenRouter model performs best for each task type
by accumulating reward statistics and using Thompson Sampling
with Beta priors for exploration/exploitation.

This replaces the static model_router config with learned preferences
that adapt over time based on actual performance data.

Persists learned weights in SQLite for cross-session learning.

References:
- Thompson Sampling (Thompson, 1933; Chapelle & Li, 2011)
- Contextual Bandits for LLM routing
"""

from __future__ import annotations

import json
import math
import os
import random
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import structlog

logger = structlog.get_logger("RouterOptimizer")


@dataclass
class ModelStats:
    """Accumulated statistics for a model×task_type pair."""
    model: str
    task_type: str
    # Beta distribution parameters (Thompson Sampling)
    alpha: float = 1.0     # successes + 1 (prior)
    beta_param: float = 1.0  # failures + 1 (prior)
    # Running statistics
    total_uses: int = 0
    total_reward: float = 0.0
    mean_reward: float = 0.0
    mean_latency_ms: float = 0.0
    last_used: float = 0.0

    @property
    def success_rate(self) -> float:
        total = self.alpha + self.beta_param - 2  # subtract priors
        return (self.alpha - 1) / total if total > 0 else 0.5

    def sample_thompson(self) -> float:
        """Draw from Beta(alpha, beta) for Thompson Sampling."""
        return random.betavariate(max(self.alpha, 0.01), max(self.beta_param, 0.01))


class RouterOptimizer:
    """Learns optimal model routing from reward signals.

    Usage:
        optimizer = RouterOptimizer("data/rl/router_weights.db")
        optimizer.initialize()

        # Register available models
        optimizer.register_model("nvidia/nemotron-3-super-120b-a12b:free",
                                 ["general", "code", "research"])

        # Select best model for a task
        model = optimizer.select_model("code")

        # After execution, record outcome
        optimizer.record_outcome("nvidia/nemotron-...", "code",
                                 reward=0.85, latency_ms=3200)

        # Get learned routing table
        table = optimizer.get_routing_table()
    """

    def __init__(self, db_path: str = "data/rl/router_weights.db") -> None:
        self._db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None
        # Cache: model → list of task_types
        self._model_capabilities: Dict[str, List[str]] = {}

    def initialize(self) -> None:
        os.makedirs(os.path.dirname(self._db_path), exist_ok=True)
        self._conn = sqlite3.connect(self._db_path)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS model_stats (
                model TEXT NOT NULL,
                task_type TEXT NOT NULL,
                alpha REAL DEFAULT 1.0,
                beta_param REAL DEFAULT 1.0,
                total_uses INTEGER DEFAULT 0,
                total_reward REAL DEFAULT 0.0,
                mean_reward REAL DEFAULT 0.0,
                mean_latency_ms REAL DEFAULT 0.0,
                last_used REAL DEFAULT 0.0,
                PRIMARY KEY (model, task_type)
            );
            CREATE TABLE IF NOT EXISTS routing_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                model TEXT NOT NULL,
                task_type TEXT NOT NULL,
                reward REAL NOT NULL,
                latency_ms REAL DEFAULT 0.0,
                timestamp REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_rh_model_task
                ON routing_history(model, task_type);
            CREATE INDEX IF NOT EXISTS idx_rh_timestamp
                ON routing_history(timestamp DESC);
        """)
        self._conn.commit()
        self._load_capabilities()
        logger.info("RouterOptimizer initialized", db=self._db_path)

    def _ensure_init(self) -> None:
        if self._conn is None:
            self.initialize()

    def _load_capabilities(self) -> None:
        """Load model→task mappings from DB."""
        assert self._conn is not None
        rows = self._conn.execute(
            "SELECT DISTINCT model, task_type FROM model_stats"
        ).fetchall()
        self._model_capabilities.clear()
        for model, task_type in rows:
            self._model_capabilities.setdefault(model, []).append(task_type)

    # ------------------------------------------------------------------
    # Model registration
    # ------------------------------------------------------------------

    def register_model(self, model: str, task_types: List[str]) -> None:
        """Register a model with its supported task types."""
        self._ensure_init()
        assert self._conn is not None

        for tt in task_types:
            self._conn.execute("""
                INSERT OR IGNORE INTO model_stats (model, task_type)
                VALUES (?, ?)
            """, (model, tt))
            self._model_capabilities.setdefault(model, [])
            if tt not in self._model_capabilities[model]:
                self._model_capabilities[model].append(tt)

        self._conn.commit()

    def register_models_from_config(self, model_router_config: Dict[str, str]) -> None:
        """Register all models from openclaw_config.json model_router section."""
        model_tasks: Dict[str, List[str]] = {}
        for task_type, model in model_router_config.items():
            if task_type == "notes":
                continue
            model_tasks.setdefault(model, []).append(task_type)

        for model, tasks in model_tasks.items():
            # Also register for 'general' if not explicitly listed
            if "general" not in tasks:
                tasks.append("general")
            self.register_model(model, tasks)

    # ------------------------------------------------------------------
    # Selection (Thompson Sampling)
    # ------------------------------------------------------------------

    def select_model(self, task_type: str, explore: bool = True) -> str:
        """Select the best model for a task type using Thompson Sampling.

        If explore=True, uses Thompson Sampling (stochastic).
        If explore=False, uses greedy (best mean reward).
        """
        self._ensure_init()
        assert self._conn is not None

        # Get all models that support this task_type (or general)
        rows = self._conn.execute(
            """SELECT model, alpha, beta_param, mean_reward, total_uses
               FROM model_stats
               WHERE task_type = ? OR task_type = 'general'
               ORDER BY mean_reward DESC""",
            (task_type,),
        ).fetchall()

        if not rows:
            return ""

        if explore:
            # Thompson Sampling: draw from Beta distribution
            scored: List[Tuple[float, str]] = []
            for model, alpha, beta_p, mean_r, uses in rows:
                thompson_score = random.betavariate(
                    max(alpha, 0.01), max(beta_p, 0.01)
                )
                # Bonus for under-explored models
                exploration_bonus = 0.1 / math.sqrt(max(uses, 1))
                scored.append((thompson_score + exploration_bonus, model))

            scored.sort(reverse=True)
            return scored[0][1]
        else:
            # Greedy: best mean reward
            return rows[0][0]

    # ------------------------------------------------------------------
    # Outcome recording
    # ------------------------------------------------------------------

    def record_outcome(
        self,
        model: str,
        task_type: str,
        reward: float,
        latency_ms: float = 0.0,
    ) -> None:
        """Record the outcome of a model execution and update Beta priors."""
        self._ensure_init()
        assert self._conn is not None

        # Ensure model+task exists
        self._conn.execute("""
            INSERT OR IGNORE INTO model_stats (model, task_type)
            VALUES (?, ?)
        """, (model, task_type))

        # Get current stats
        row = self._conn.execute(
            "SELECT alpha, beta_param, total_uses, total_reward, mean_latency_ms FROM model_stats WHERE model = ? AND task_type = ?",
            (model, task_type),
        ).fetchone()

        alpha, beta_p, total_uses, total_reward, mean_lat = row

        # Update Beta distribution
        # Reward > 0.5 → success; reward <= 0.5 → failure
        # Use soft update: add proportional to reward magnitude
        if reward > 0.0:
            alpha += min(reward, 1.0)  # cap at 1.0 per observation
        else:
            beta_p += min(abs(reward), 1.0)

        total_uses += 1
        total_reward += reward
        mean_reward = total_reward / total_uses

        # Exponential moving average for latency
        if mean_lat == 0:
            mean_lat = latency_ms
        else:
            mean_lat = 0.9 * mean_lat + 0.1 * latency_ms

        self._conn.execute("""
            UPDATE model_stats
            SET alpha = ?, beta_param = ?, total_uses = ?,
                total_reward = ?, mean_reward = ?, mean_latency_ms = ?,
                last_used = ?
            WHERE model = ? AND task_type = ?
        """, (alpha, beta_p, total_uses, total_reward, mean_reward,
              mean_lat, time.time(), model, task_type))

        # Record history
        self._conn.execute("""
            INSERT INTO routing_history (model, task_type, reward, latency_ms, timestamp)
            VALUES (?, ?, ?, ?, ?)
        """, (model, task_type, reward, latency_ms, time.time()))

        self._conn.commit()

    # ------------------------------------------------------------------
    # Routing table & analysis
    # ------------------------------------------------------------------

    def get_routing_table(self) -> Dict[str, str]:
        """Get the learned optimal model for each task type.

        Returns a dict compatible with openclaw_config model_router format.
        """
        self._ensure_init()
        assert self._conn is not None

        task_types = [row[0] for row in self._conn.execute(
            "SELECT DISTINCT task_type FROM model_stats"
        ).fetchall()]

        table: Dict[str, str] = {}
        for tt in task_types:
            best = self._conn.execute(
                """SELECT model FROM model_stats
                   WHERE task_type = ? AND total_uses > 0
                   ORDER BY mean_reward DESC LIMIT 1""",
                (tt,),
            ).fetchone()
            if best:
                table[tt] = best[0]

        return table

    def get_improvement_report(self) -> Dict[str, Any]:
        """Compare learned routing vs initial uniform performance."""
        self._ensure_init()
        assert self._conn is not None

        report: Dict[str, Any] = {"task_types": {}}

        task_types = [row[0] for row in self._conn.execute(
            "SELECT DISTINCT task_type FROM model_stats WHERE total_uses > 0"
        ).fetchall()]

        for tt in task_types:
            models = self._conn.execute(
                """SELECT model, mean_reward, total_uses, alpha, beta_param, mean_latency_ms
                   FROM model_stats
                   WHERE task_type = ? AND total_uses > 0
                   ORDER BY mean_reward DESC""",
                (tt,),
            ).fetchall()

            if not models:
                continue

            best = models[0]
            worst = models[-1] if len(models) > 1 else best

            report["task_types"][tt] = {
                "best_model": best[0],
                "best_reward": round(best[1], 4),
                "best_uses": best[2],
                "best_latency_ms": round(best[5], 1),
                "worst_model": worst[0],
                "worst_reward": round(worst[1], 4),
                "model_count": len(models),
                "reward_spread": round(best[1] - worst[1], 4),
            }

        # Overall metrics
        overall = self._conn.execute(
            "SELECT AVG(mean_reward), COUNT(*), SUM(total_uses) FROM model_stats WHERE total_uses > 0"
        ).fetchone()
        report["overall"] = {
            "avg_reward": round(overall[0] or 0, 4),
            "active_pairs": overall[1] or 0,
            "total_observations": overall[2] or 0,
        }

        return report

    def decay_old_data(self, decay_factor: float = 0.95, min_uses: int = 5) -> None:
        """Apply time-based decay to prevent stale preferences.

        Multiplies alpha and beta by decay_factor for entries with
        enough observations, keeping the ratio but reducing confidence.
        """
        self._ensure_init()
        assert self._conn is not None

        self._conn.execute("""
            UPDATE model_stats
            SET alpha = MAX(1.0, alpha * ?),
                beta_param = MAX(1.0, beta_param * ?)
            WHERE total_uses >= ?
        """, (decay_factor, decay_factor, min_uses))
        self._conn.commit()
        logger.info("Applied decay to router weights", factor=decay_factor)

    def stats(self) -> Dict[str, Any]:
        """Summary statistics."""
        self._ensure_init()
        assert self._conn is not None

        total_models = self._conn.execute(
            "SELECT COUNT(DISTINCT model) FROM model_stats"
        ).fetchone()[0]
        total_tasks = self._conn.execute(
            "SELECT COUNT(DISTINCT task_type) FROM model_stats"
        ).fetchone()[0]
        total_obs = self._conn.execute(
            "SELECT SUM(total_uses) FROM model_stats"
        ).fetchone()[0] or 0
        history_count = self._conn.execute(
            "SELECT COUNT(*) FROM routing_history"
        ).fetchone()[0]

        return {
            "registered_models": total_models,
            "task_types": total_tasks,
            "total_observations": total_obs,
            "history_records": history_count,
        }
