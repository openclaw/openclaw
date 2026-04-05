"""Prompt Evolution — genetic-style prompt optimization for API models.

Since OpenRouter models cannot be fine-tuned (no weight access), we optimize
the system prompts themselves. This module implements:

1. Prompt variant tracking with performance scores
2. Mutation operators (rephrase, extend, compress, merge)
3. A/B selection weighted by accumulated rewards
4. ELO-style rating for prompt variants
5. Persistence across sessions via SQLite

Conceptually this is an evolutionary strategy operating on prompt strings
instead of model parameters — the "training" for API-based inference.

References:
- EvoPrompt (Guo et al., 2024): evolutionary prompt optimization
- PromptBreeder (Fernando et al., 2024): self-referential prompt evolution
- APE (Zhou et al., 2023): automatic prompt engineering
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import random
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine, Dict, List, Optional, Tuple

import structlog

logger = structlog.get_logger("PromptEvolver")

_INITIAL_ELO = 1200.0
_ELO_K = 32.0  # K-factor for ELO updates


@dataclass
class PromptVariant:
    """A tracked system prompt variant."""
    variant_id: str
    role: str           # Planner, Executor, Auditor, etc.
    task_type: str      # code, research, conversation, etc.
    prompt_text: str
    parent_id: str = ""     # Which variant this was derived from
    mutation: str = "seed"  # seed, rephrase, extend, compress, merge, crossover
    elo_rating: float = _INITIAL_ELO
    times_used: int = 0
    total_reward: float = 0.0
    mean_reward: float = 0.0
    created_at: float = field(default_factory=time.time)

    @property
    def prompt_hash(self) -> str:
        return hashlib.sha256(self.prompt_text.encode()).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Mutation operators
# ---------------------------------------------------------------------------

# Instruction fragments that can be added/removed during mutation
_BOOSTER_FRAGMENTS = [
    "\nОтвечай КОНКРЕТНО и без воды.",
    "\nВключай примеры кода там, где уместно.",
    "\nДавай структурированный ответ с пунктами.",
    "\nЕсли задача требует анализа — начни с ключевого вывода.",
    "\nПри написании кода: docstring + type hints обязательны.",
    "\nИспользуй Markdown для форматирования.",
    "\nПростые вопросы — короткие ответы (2-3 предложения).",
    "\nСложные вопросы — разбивай на логические шаги.",
    "\nНЕ повторяй одну мысль разными словами.",
    "\nЕсли не знаешь — скажи прямо, не выдумывай.",
]

_COMPRESSION_TARGETS = [
    "Ты — универсальный ИИ-ассистент",
    "ПРАВИЛА:",
    "ЗАПРЕЩЁННЫЕ конструкции:",
    "Текущее дата и время:",
]


def _mutate_extend(prompt: str) -> str:
    """Add a random booster fragment."""
    fragment = random.choice(_BOOSTER_FRAGMENTS)
    if fragment.strip() not in prompt:
        return prompt.rstrip() + "\n" + fragment.strip()
    return prompt


def _mutate_compress(prompt: str) -> str:
    """Remove a random line from the prompt (keep core structure)."""
    lines = prompt.split("\n")
    if len(lines) <= 3:
        return prompt  # too short to compress
    # Never remove the first 2 lines (identity/role) or the last line
    removable = list(range(2, len(lines) - 1))
    if not removable:
        return prompt
    idx = random.choice(removable)
    lines.pop(idx)
    return "\n".join(lines)


def _mutate_swap_order(prompt: str) -> str:
    """Swap two random instruction lines."""
    lines = prompt.split("\n")
    # Find numbered instructions (e.g., "1. ...", "2. ...")
    numbered = [(i, l) for i, l in enumerate(lines) if l.strip()[:2] in
                [f"{n}." for n in range(1, 10)]]
    if len(numbered) < 2:
        return prompt
    a, b = random.sample(range(len(numbered)), 2)
    idx_a, idx_b = numbered[a][0], numbered[b][0]
    lines[idx_a], lines[idx_b] = lines[idx_b], lines[idx_a]
    # Renumber
    num = 1
    for i, line in enumerate(lines):
        if line.strip()[:2] in [f"{n}." for n in range(1, 10)]:
            lines[i] = f"{num}." + line.strip()[2:]
            num += 1
    return "\n".join(lines)


def _mutate_emphasis(prompt: str) -> str:
    """Add emphasis markers to a random instruction."""
    lines = prompt.split("\n")
    candidates = [i for i, l in enumerate(lines)
                  if l.strip() and not l.strip().startswith("**") and len(l.strip()) > 10]
    if not candidates:
        return prompt
    idx = random.choice(candidates)
    line = lines[idx].strip()
    if "КРИТИЧЕСКИ ВАЖНО" not in line and "ОБЯЗАТЕЛЬНО" not in line:
        lines[idx] = "**" + line + "**"
    return "\n".join(lines)


MUTATION_OPS = {
    "extend": _mutate_extend,
    "compress": _mutate_compress,
    "swap_order": _mutate_swap_order,
    "emphasis": _mutate_emphasis,
}


# ---------------------------------------------------------------------------
# Prompt Evolver
# ---------------------------------------------------------------------------

class PromptEvolver:
    """Manages prompt variants with evolutionary optimization.

    Usage:
        evolver = PromptEvolver("data/rl/prompt_evolution.db")
        evolver.initialize()

        # Register initial (seed) prompts
        evolver.register_seed("Planner", "code", "Ты — кодер ...")

        # Get best prompt for a role+task
        prompt = evolver.select("Planner", "code")

        # After use, record reward
        evolver.record_reward(variant_id, reward=0.85)

        # Evolve: create new variants from best performers
        new_variants = evolver.evolve("Planner", "code", n=3)
    """

    def __init__(self, db_path: str = "data/rl/prompt_evolution.db") -> None:
        self._db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None

    def initialize(self) -> None:
        os.makedirs(os.path.dirname(self._db_path), exist_ok=True)
        self._conn = sqlite3.connect(self._db_path)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS prompt_variants (
                variant_id TEXT PRIMARY KEY,
                role TEXT NOT NULL,
                task_type TEXT NOT NULL,
                prompt_text TEXT NOT NULL,
                prompt_hash TEXT NOT NULL,
                parent_id TEXT DEFAULT '',
                mutation TEXT DEFAULT 'seed',
                elo_rating REAL DEFAULT 1200.0,
                times_used INTEGER DEFAULT 0,
                total_reward REAL DEFAULT 0.0,
                mean_reward REAL DEFAULT 0.0,
                created_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_pv_role_task
                ON prompt_variants(role, task_type);
            CREATE INDEX IF NOT EXISTS idx_pv_elo
                ON prompt_variants(elo_rating DESC);
            CREATE INDEX IF NOT EXISTS idx_pv_hash
                ON prompt_variants(prompt_hash);
        """)
        self._conn.commit()
        logger.info("PromptEvolver initialized", db=self._db_path)

    def _ensure_init(self) -> None:
        if self._conn is None:
            self.initialize()

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------

    def register_seed(self, role: str, task_type: str, prompt_text: str) -> str:
        """Register an initial (seed) prompt variant. Returns variant_id."""
        self._ensure_init()
        assert self._conn is not None

        prompt_hash = hashlib.sha256(prompt_text.encode()).hexdigest()[:12]

        # Check for dedup
        existing = self._conn.execute(
            "SELECT variant_id FROM prompt_variants WHERE prompt_hash = ? AND role = ? AND task_type = ?",
            (prompt_hash, role, task_type),
        ).fetchone()
        if existing:
            return existing[0]

        variant_id = f"pv_{role}_{task_type}_{prompt_hash}"
        self._conn.execute("""
            INSERT INTO prompt_variants
            (variant_id, role, task_type, prompt_text, prompt_hash, parent_id,
             mutation, elo_rating, times_used, total_reward, mean_reward, created_at)
            VALUES (?, ?, ?, ?, ?, '', 'seed', 1200.0, 0, 0.0, 0.0, ?)
        """, (variant_id, role, task_type, prompt_text, prompt_hash, time.time()))
        self._conn.commit()

        logger.info("Seed prompt registered", variant_id=variant_id, role=role, task_type=task_type)
        return variant_id

    # ------------------------------------------------------------------
    # Selection
    # ------------------------------------------------------------------

    def select(self, role: str, task_type: str, explore_prob: float = 0.15) -> Tuple[str, str]:
        """Select best prompt variant for role+task. Returns (variant_id, prompt_text).

        Uses Thompson Sampling: with explore_prob, picks a random variant
        instead of the ELO-best to explore alternatives.
        """
        self._ensure_init()
        assert self._conn is not None

        variants = self._conn.execute(
            """SELECT variant_id, prompt_text, elo_rating, times_used
               FROM prompt_variants
               WHERE role = ? AND task_type = ?
               ORDER BY elo_rating DESC""",
            (role, task_type),
        ).fetchall()

        if not variants:
            # Fallback: try wildcard task_type
            variants = self._conn.execute(
                """SELECT variant_id, prompt_text, elo_rating, times_used
                   FROM prompt_variants
                   WHERE role = ? AND task_type = 'general'
                   ORDER BY elo_rating DESC""",
                (role,),
            ).fetchall()

        if not variants:
            return ("", "")

        # Thompson Sampling: explore with probability
        if random.random() < explore_prob and len(variants) > 1:
            chosen = random.choice(variants)
        else:
            chosen = variants[0]  # best ELO

        variant_id, prompt_text = chosen[0], chosen[1]

        # Increment usage count
        self._conn.execute(
            "UPDATE prompt_variants SET times_used = times_used + 1 WHERE variant_id = ?",
            (variant_id,),
        )
        self._conn.commit()

        return (variant_id, prompt_text)

    # ------------------------------------------------------------------
    # Reward recording & ELO update
    # ------------------------------------------------------------------

    def record_reward(self, variant_id: str, reward: float) -> None:
        """Record a reward for a prompt variant and update ELO."""
        self._ensure_init()
        assert self._conn is not None

        row = self._conn.execute(
            "SELECT total_reward, times_used, elo_rating, role, task_type FROM prompt_variants WHERE variant_id = ?",
            (variant_id,),
        ).fetchone()
        if not row:
            return

        total_reward = row[0] + reward
        times_used = max(row[1], 1)
        mean_reward = total_reward / times_used
        old_elo = row[2]
        role, task_type = row[3], row[4]

        # ELO update: compare against population mean
        pop_mean = self._get_population_mean_reward(role, task_type)
        expected = 1.0 / (1.0 + math.pow(10, (pop_mean - mean_reward) / 0.4))
        actual = 1.0 if reward > pop_mean else (0.5 if abs(reward - pop_mean) < 0.05 else 0.0)
        new_elo = old_elo + _ELO_K * (actual - expected)

        self._conn.execute(
            """UPDATE prompt_variants
               SET total_reward = ?, mean_reward = ?, elo_rating = ?
               WHERE variant_id = ?""",
            (total_reward, mean_reward, new_elo, variant_id),
        )
        self._conn.commit()

        logger.debug(
            "Prompt reward recorded",
            variant_id=variant_id,
            reward=reward,
            elo=f"{old_elo:.1f}→{new_elo:.1f}",
        )

    def _get_population_mean_reward(self, role: str, task_type: str) -> float:
        assert self._conn is not None
        row = self._conn.execute(
            "SELECT AVG(mean_reward) FROM prompt_variants WHERE role = ? AND task_type = ? AND times_used > 0",
            (role, task_type),
        ).fetchone()
        return row[0] if row and row[0] is not None else 0.0

    # ------------------------------------------------------------------
    # Evolution (mutation)
    # ------------------------------------------------------------------

    def evolve(self, role: str, task_type: str, n: int = 3) -> List[str]:
        """Create n new prompt variants by mutating top performers.

        Returns list of new variant_ids.
        """
        self._ensure_init()
        assert self._conn is not None

        # Get top variants (parents)
        parents = self._conn.execute(
            """SELECT variant_id, prompt_text, elo_rating
               FROM prompt_variants
               WHERE role = ? AND task_type = ? AND times_used > 0
               ORDER BY elo_rating DESC LIMIT 5""",
            (role, task_type),
        ).fetchall()

        if not parents:
            # If no used variants, use seeds
            parents = self._conn.execute(
                """SELECT variant_id, prompt_text, elo_rating
                   FROM prompt_variants
                   WHERE role = ? AND task_type = ?
                   ORDER BY created_at ASC LIMIT 3""",
                (role, task_type),
            ).fetchall()
        if not parents:
            return []

        new_ids: List[str] = []
        mutations_used = list(MUTATION_OPS.keys())

        for i in range(n):
            parent = random.choice(parents)
            parent_id, parent_text = parent[0], parent[1]

            # Pick a random mutation
            mutation_name = random.choice(mutations_used)
            mutation_fn = MUTATION_OPS[mutation_name]
            new_text = mutation_fn(parent_text)

            # Crossover: occasionally merge two parents
            if len(parents) >= 2 and random.random() < 0.2:
                other = random.choice([p for p in parents if p[0] != parent_id])
                new_text = self._crossover(new_text, other[1])
                mutation_name = "crossover"

            # Dedup check
            new_hash = hashlib.sha256(new_text.encode()).hexdigest()[:12]
            existing = self._conn.execute(
                "SELECT variant_id FROM prompt_variants WHERE prompt_hash = ? AND role = ? AND task_type = ?",
                (new_hash, role, task_type),
            ).fetchone()
            if existing:
                continue

            variant_id = f"pv_{role}_{task_type}_{new_hash}"
            self._conn.execute("""
                INSERT INTO prompt_variants
                (variant_id, role, task_type, prompt_text, prompt_hash, parent_id,
                 mutation, elo_rating, times_used, total_reward, mean_reward, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1200.0, 0, 0.0, 0.0, ?)
            """, (variant_id, role, task_type, new_text, new_hash,
                  parent_id, mutation_name, time.time()))
            self._conn.commit()
            new_ids.append(variant_id)

        logger.info(f"Evolved {len(new_ids)} new variants", role=role, task_type=task_type)
        return new_ids

    @staticmethod
    def _crossover(text_a: str, text_b: str) -> str:
        """Crossover: take first half of A, second half of B."""
        lines_a = text_a.split("\n")
        lines_b = text_b.split("\n")
        mid_a = len(lines_a) // 2
        mid_b = len(lines_b) // 2
        return "\n".join(lines_a[:mid_a] + lines_b[mid_b:])

    # ------------------------------------------------------------------
    # Stats & utilities
    # ------------------------------------------------------------------

    def get_best(self, role: str, task_type: str) -> Optional[PromptVariant]:
        """Get the best-performing variant for role+task."""
        self._ensure_init()
        assert self._conn is not None

        row = self._conn.execute(
            """SELECT variant_id, role, task_type, prompt_text, parent_id,
                      mutation, elo_rating, times_used, total_reward, mean_reward, created_at
               FROM prompt_variants
               WHERE role = ? AND task_type = ?
               ORDER BY elo_rating DESC LIMIT 1""",
            (role, task_type),
        ).fetchone()
        if not row:
            return None
        return PromptVariant(
            variant_id=row[0], role=row[1], task_type=row[2],
            prompt_text=row[3], parent_id=row[4], mutation=row[5],
            elo_rating=row[6], times_used=row[7], total_reward=row[8],
            mean_reward=row[9], created_at=row[10],
        )

    def stats(self) -> Dict[str, Any]:
        """Get evolution statistics."""
        self._ensure_init()
        assert self._conn is not None

        total = self._conn.execute("SELECT COUNT(*) FROM prompt_variants").fetchone()[0]
        used = self._conn.execute(
            "SELECT COUNT(*) FROM prompt_variants WHERE times_used > 0"
        ).fetchone()[0]
        best_elo = self._conn.execute(
            "SELECT MAX(elo_rating) FROM prompt_variants"
        ).fetchone()[0] or 0
        worst_elo = self._conn.execute(
            "SELECT MIN(elo_rating) FROM prompt_variants WHERE times_used > 0"
        ).fetchone()[0] or 0

        by_mutation = dict(self._conn.execute(
            "SELECT mutation, COUNT(*) FROM prompt_variants GROUP BY mutation"
        ).fetchall())

        return {
            "total_variants": total,
            "used_variants": used,
            "best_elo": round(best_elo, 1),
            "worst_elo": round(worst_elo, 1),
            "elo_spread": round(best_elo - worst_elo, 1),
            "by_mutation": by_mutation,
        }

    def prune(self, keep_top_n: int = 20, min_uses: int = 3) -> int:
        """Remove low-performing variants (keep top N per role+task)."""
        self._ensure_init()
        assert self._conn is not None

        # Get all role+task pairs
        pairs = self._conn.execute(
            "SELECT DISTINCT role, task_type FROM prompt_variants"
        ).fetchall()

        total_pruned = 0
        for role, task_type in pairs:
            # Get IDs of variants to keep
            keep_ids = [row[0] for row in self._conn.execute(
                """SELECT variant_id FROM prompt_variants
                   WHERE role = ? AND task_type = ?
                   ORDER BY elo_rating DESC LIMIT ?""",
                (role, task_type, keep_top_n),
            ).fetchall()]

            if not keep_ids:
                continue

            placeholders = ",".join("?" * len(keep_ids))
            result = self._conn.execute(
                f"""DELETE FROM prompt_variants
                    WHERE role = ? AND task_type = ?
                    AND variant_id NOT IN ({placeholders})
                    AND times_used >= ?""",
                (role, task_type, *keep_ids, min_uses),
            )
            total_pruned += result.rowcount

        self._conn.commit()
        if total_pruned > 0:
            logger.info(f"Pruned {total_pruned} low-performing variants")
        return total_pruned
