"""Adaptive Context Builder — learns optimal context assembly for prompts.

For API-model inference, the quality of the response depends heavily on
what context we include in the prompt. This module learns which context
elements (memory, examples, instructions, project context) improve
response quality and adjusts context composition accordingly.

Key mechanisms:
1. Context element weighting — scores each context section by its
   contribution to reward deltas
2. Attention-like gating — includes/excludes context sections based
   on learned importance per task type
3. Token budget optimization — distributes token budget across context
   sections proportionally to learned weights
4. Adaptive compression — more compression for low-value context

References:
- Lost in the Middle (Liu et al., 2023): position effects in long context
- Self-RAG (Asai et al., 2024): when to retrieve vs generate
"""

from __future__ import annotations

import json
import math
import os
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import structlog

logger = structlog.get_logger("AdaptiveContext")


@dataclass
class ContextSection:
    """A section of context to potentially include in a prompt."""
    name: str           # e.g., "memory", "few_shot", "brain_md", "project_context", "identity"
    content: str
    token_estimate: int = 0
    # Learned attributes
    weight: float = 1.0     # importance weight (learned)
    include: bool = True    # whether to include in final prompt

    def estimate_tokens(self, chars_per_token: float = 4.0) -> int:
        self.token_estimate = int(len(self.content) / chars_per_token)
        return self.token_estimate


@dataclass
class ContextConfig:
    """Configuration for context assembly."""
    max_total_tokens: int = 6000    # max tokens for all context
    min_section_tokens: int = 50     # don't include sections shorter than this
    # Section token budgets (fraction of max_total_tokens)
    section_budgets: Dict[str, float] = field(default_factory=lambda: {
        "system_prompt": 0.25,
        "few_shot": 0.20,
        "memory": 0.20,
        "brain_md": 0.15,
        "project_context": 0.10,
        "identity": 0.10,
    })


class AdaptiveContextBuilder:
    """Builds optimized context for prompts based on learned weights.

    Usage:
        builder = AdaptiveContextBuilder("data/rl/context_weights.db")
        builder.initialize()

        # Add context sections
        sections = [
            ContextSection("memory", "User prefers Python 3.12..."),
            ContextSection("few_shot", "<examples>...", ),
            ContextSection("brain_md", "Current sprint: ..."),
        ]

        # Build optimized prompt
        prompt = builder.build(
            sections=sections,
            task_type="code",
            max_tokens=4000,
        )

        # After execution, record which context helped
        builder.record_reward("code", section_names=["memory", "few_shot"], reward=0.9)
    """

    def __init__(self, db_path: str = "data/rl/context_weights.db") -> None:
        self._db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None

    def initialize(self) -> None:
        os.makedirs(os.path.dirname(self._db_path), exist_ok=True)
        self._conn = sqlite3.connect(self._db_path)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS context_weights (
                section_name TEXT NOT NULL,
                task_type TEXT NOT NULL,
                weight REAL DEFAULT 1.0,
                times_included INTEGER DEFAULT 0,
                times_excluded INTEGER DEFAULT 0,
                reward_when_included REAL DEFAULT 0.0,
                reward_when_excluded REAL DEFAULT 0.0,
                last_updated REAL DEFAULT 0.0,
                PRIMARY KEY (section_name, task_type)
            );
            CREATE TABLE IF NOT EXISTS context_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_type TEXT NOT NULL,
                sections_included TEXT NOT NULL,
                reward REAL NOT NULL,
                total_tokens INTEGER DEFAULT 0,
                timestamp REAL NOT NULL
            );
        """)
        self._conn.commit()
        logger.info("AdaptiveContextBuilder initialized", db=self._db_path)

    def _ensure_init(self) -> None:
        if self._conn is None:
            self.initialize()

    # ------------------------------------------------------------------
    # Context building
    # ------------------------------------------------------------------

    def build(
        self,
        sections: List[ContextSection],
        task_type: str = "general",
        max_tokens: int = 6000,
    ) -> str:
        """Build an optimized context string from sections.

        1. Score each section by learned weight for this task_type
        2. Sort by weight (descending)
        3. Include sections until token budget is exhausted
        4. More important sections get more tokens
        """
        if not sections:
            return ""

        # Load learned weights
        weights = self._get_weights(task_type)

        # Apply weights and estimate tokens
        for section in sections:
            section.estimate_tokens()
            section.weight = weights.get(section.name, 1.0)

        # Sort by weight (highest first)
        sections.sort(key=lambda s: s.weight, reverse=True)

        # Allocate tokens proportionally to weights
        total_weight = sum(s.weight for s in sections if s.weight > 0)
        if total_weight == 0:
            total_weight = len(sections)

        # Build context, respecting token budget
        included: List[ContextSection] = []
        tokens_used = 0

        for section in sections:
            if not section.content.strip():
                section.include = False
                continue

            # Allocated budget for this section
            budget = int(max_tokens * (section.weight / total_weight))
            budget = max(budget, 100)  # minimum budget per section

            remaining = max_tokens - tokens_used
            if remaining < 100:
                section.include = False
                continue

            actual_budget = min(budget, remaining, section.token_estimate + 50)

            # Truncate if needed (keep proportional to weight)
            if section.token_estimate > actual_budget:
                char_limit = int(actual_budget * 4)  # ~4 chars per token
                section.content = section.content[:char_limit] + "\n[...сокращено...]"
                section.token_estimate = actual_budget

            section.include = True
            included.append(section)
            tokens_used += section.token_estimate

        # Assemble final context
        parts = []
        for section in included:
            parts.append(section.content)

        return "\n\n".join(parts)

    def _get_weights(self, task_type: str) -> Dict[str, float]:
        """Get learned weights for a task type."""
        self._ensure_init()
        assert self._conn is not None

        rows = self._conn.execute(
            "SELECT section_name, weight FROM context_weights WHERE task_type = ?",
            (task_type,),
        ).fetchall()

        if not rows:
            # Fallback to general
            rows = self._conn.execute(
                "SELECT section_name, weight FROM context_weights WHERE task_type = 'general'",
            ).fetchall()

        return {name: weight for name, weight in rows} if rows else {}

    # ------------------------------------------------------------------
    # Reward recording & weight updates
    # ------------------------------------------------------------------

    def record_reward(
        self,
        task_type: str,
        section_names: List[str],
        reward: float,
        total_tokens: int = 0,
    ) -> None:
        """Record reward and update section weights based on inclusion."""
        self._ensure_init()
        assert self._conn is not None

        # Update stats for included sections
        for name in section_names:
            self._conn.execute("""
                INSERT INTO context_weights (section_name, task_type, weight,
                    times_included, reward_when_included, last_updated)
                VALUES (?, ?, 1.0, 1, ?, ?)
                ON CONFLICT(section_name, task_type) DO UPDATE SET
                    times_included = times_included + 1,
                    reward_when_included = (reward_when_included * times_included + ?) / (times_included + 1),
                    last_updated = ?
            """, (name, task_type, reward, time.time(), reward, time.time()))

        # Update stats for excluded sections (all known sections not in section_names)
        all_sections = self._conn.execute(
            "SELECT DISTINCT section_name FROM context_weights WHERE task_type = ?",
            (task_type,),
        ).fetchall()
        for (name,) in all_sections:
            if name not in section_names:
                self._conn.execute("""
                    UPDATE context_weights
                    SET times_excluded = times_excluded + 1,
                        reward_when_excluded = (reward_when_excluded * times_excluded + ?) / (times_excluded + 1),
                        last_updated = ?
                    WHERE section_name = ? AND task_type = ?
                """, (reward, time.time(), name, task_type))

        # Record history
        self._conn.execute("""
            INSERT INTO context_history (task_type, sections_included, reward, total_tokens, timestamp)
            VALUES (?, ?, ?, ?, ?)
        """, (task_type, json.dumps(section_names), reward, total_tokens, time.time()))

        self._conn.commit()

        # Recompute weights
        self._recompute_weights(task_type)

    def _recompute_weights(self, task_type: str) -> None:
        """Recompute section weights based on reward deltas.

        Weight = sigmoid(reward_when_included - reward_when_excluded)
        Higher weight → section consistently helps when included.
        """
        assert self._conn is not None

        rows = self._conn.execute(
            """SELECT section_name, reward_when_included, reward_when_excluded,
                      times_included, times_excluded
               FROM context_weights WHERE task_type = ?""",
            (task_type,),
        ).fetchall()

        for name, r_incl, r_excl, n_incl, n_excl in rows:
            if n_incl < 2 and n_excl < 2:
                continue  # not enough data

            # Compute delta: positive means including helps
            delta = r_incl - r_excl

            # Sigmoid mapping with sensitivity scaling
            weight = 1.0 / (1.0 + math.exp(-5.0 * delta))
            # Scale to [0.1, 2.0] range
            weight = 0.1 + 1.9 * weight

            self._conn.execute(
                "UPDATE context_weights SET weight = ? WHERE section_name = ? AND task_type = ?",
                (weight, name, task_type),
            )

        self._conn.commit()

    # ------------------------------------------------------------------
    # Analysis
    # ------------------------------------------------------------------

    def get_weight_report(self) -> Dict[str, Any]:
        """Get a report on learned context weights."""
        self._ensure_init()
        assert self._conn is not None

        rows = self._conn.execute(
            """SELECT section_name, task_type, weight, times_included,
                      times_excluded, reward_when_included, reward_when_excluded
               FROM context_weights
               ORDER BY task_type, weight DESC"""
        ).fetchall()

        report: Dict[str, Any] = {}
        for name, tt, weight, n_incl, n_excl, r_incl, r_excl in rows:
            report.setdefault(tt, []).append({
                "section": name,
                "weight": round(weight, 3),
                "times_included": n_incl,
                "reward_delta": round(r_incl - r_excl, 4),
            })

        return report

    def stats(self) -> Dict[str, Any]:
        """Summary statistics."""
        self._ensure_init()
        assert self._conn is not None

        sections = self._conn.execute(
            "SELECT COUNT(DISTINCT section_name) FROM context_weights"
        ).fetchone()[0]
        task_types = self._conn.execute(
            "SELECT COUNT(DISTINCT task_type) FROM context_weights"
        ).fetchone()[0]
        history = self._conn.execute(
            "SELECT COUNT(*) FROM context_history"
        ).fetchone()[0]

        return {
            "tracked_sections": sections,
            "task_types": task_types,
            "history_records": history,
        }
