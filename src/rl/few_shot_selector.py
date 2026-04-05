"""Few-Shot Selector — dynamic example injection for in-context learning.

Selects the most relevant and high-quality examples from ExperienceBuffer
to inject into prompts. This is the API-model equivalent of fine-tuning:
instead of adjusting weights, we adjust the context window with carefully
chosen demonstrations.

Strategies:
- Task-type matching: examples from same task category
- Keyword similarity: TF-IDF-like matching against prompt
- Quality filtering: only inject high-reward examples
- MMR diversity: avoid redundant examples
- Token-budget aware: respects context window limits

References:
- KATE (Liu et al., 2022): kNN-augmented in-context examples
- Unified Demonstration Retriever (Li et al., 2023)
"""

from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

import structlog

from src.rl.experience_buffer import Experience, ExperienceReplayBuffer

logger = structlog.get_logger("FewShotSelector")


@dataclass
class FewShotExample:
    """A formatted example for in-context learning."""
    experience_id: str
    role: str
    task_type: str
    prompt: str        # cleaned input
    response: str      # cleaned output
    reward: float
    relevance_score: float = 0.0
    diversity_score: float = 0.0
    final_score: float = 0.0

    def format_for_injection(self, include_metadata: bool = False) -> str:
        """Format as a demonstration for system/user prompt injection."""
        parts = []
        if include_metadata:
            parts.append(f"[Пример | роль: {self.role} | тип: {self.task_type} | оценка: {self.reward:.2f}]")
        parts.append(f"Вопрос: {self.prompt}")
        parts.append(f"Ответ: {self.response}")
        return "\n".join(parts)


# ---------------------------------------------------------------------------
# Text similarity (lightweight, no external deps)
# ---------------------------------------------------------------------------

def _tokenize(text: str) -> List[str]:
    """Simple word tokenizer."""
    return re.findall(r'\b[а-яА-ЯёЁa-zA-Z_]\w{2,}\b', text.lower())


def _compute_tf(tokens: List[str]) -> Dict[str, float]:
    """Term frequency (normalized by document length)."""
    counts = Counter(tokens)
    total = len(tokens) or 1
    return {word: count / total for word, count in counts.items()}


def _cosine_similarity(tf_a: Dict[str, float], tf_b: Dict[str, float]) -> float:
    """Cosine similarity between two TF vectors."""
    vocab = set(tf_a.keys()) | set(tf_b.keys())
    if not vocab:
        return 0.0
    dot = sum(tf_a.get(w, 0) * tf_b.get(w, 0) for w in vocab)
    norm_a = math.sqrt(sum(v * v for v in tf_a.values())) or 1e-8
    norm_b = math.sqrt(sum(v * v for v in tf_b.values())) or 1e-8
    return dot / (norm_a * norm_b)


def _text_similarity(text_a: str, text_b: str) -> float:
    """Lightweight text similarity using TF cosine."""
    tf_a = _compute_tf(_tokenize(text_a))
    tf_b = _compute_tf(_tokenize(text_b))
    return _cosine_similarity(tf_a, tf_b)


# ---------------------------------------------------------------------------
# Few-Shot Selector
# ---------------------------------------------------------------------------

class FewShotSelector:
    """Selects best few-shot examples from experience buffer.

    Usage:
        selector = FewShotSelector(experience_buffer)

        examples = selector.select(
            query="Напиши async функцию...",
            task_type="code",
            role="Executor",
            max_examples=3,
            max_tokens=2000,
        )

        # Inject into prompt
        prompt = selector.format_examples(examples) + "\n\n" + user_query
    """

    # Weights for final scoring
    _W_RELEVANCE = 0.4    # How relevant is the example to current query
    _W_QUALITY = 0.35     # How high was the reward
    _W_DIVERSITY = 0.15   # How different is it from already-selected examples
    _W_RECENCY = 0.1      # How recent (prefer fresh examples)

    def __init__(
        self,
        experience_buffer: ExperienceReplayBuffer,
        min_reward: float = 0.3,
        chars_per_token: float = 4.0,
    ) -> None:
        self._buffer = experience_buffer
        self._min_reward = min_reward
        self._chars_per_token = chars_per_token

    def select(
        self,
        query: str,
        task_type: str = "general",
        role: str = "",
        max_examples: int = 3,
        max_tokens: int = 2000,
    ) -> List[FewShotExample]:
        """Select best few-shot examples for the given query.

        Uses a 4-step pipeline:
        1. Candidate filtering (task_type, min_reward)
        2. Relevance scoring (TF cosine similarity)
        3. MMR diversity re-ranking
        4. Token budget enforcement
        """
        # Step 1: Get candidates from buffer
        candidates = self._get_candidates(task_type, role, limit=100)
        if not candidates:
            return []

        # Step 2: Score relevance
        query_tf = _compute_tf(_tokenize(query))
        for ex in candidates:
            ex_tf = _compute_tf(_tokenize(ex.prompt + " " + ex.response[:200]))
            ex.relevance_score = _cosine_similarity(query_tf, ex_tf)

        # Step 3: MMR selection (greedy)
        selected = self._mmr_select(candidates, max_examples, query_tf)

        # Step 4: Token budget enforcement
        selected = self._enforce_token_budget(selected, max_tokens)

        return selected

    def _get_candidates(
        self, task_type: str, role: str, limit: int = 100,
    ) -> List[FewShotExample]:
        """Fetch high-quality experiences as candidates."""
        if not self._buffer._conn:
            return []

        query = """
            SELECT experience_id, role, task_type, state_prompt, action_response,
                   reward, timestamp
            FROM experiences
            WHERE reward >= ?
        """
        params: list = [self._min_reward]

        if task_type and task_type != "general":
            query += " AND task_type = ?"
            params.append(task_type)
        if role:
            query += " AND role = ?"
            params.append(role)

        query += " ORDER BY reward DESC LIMIT ?"
        params.append(limit)

        rows = self._buffer._conn.execute(query, params).fetchall()

        candidates = []
        for row in rows:
            candidates.append(FewShotExample(
                experience_id=row[0],
                role=row[1],
                task_type=row[2],
                prompt=row[3][:500],  # truncate for efficiency
                response=row[4][:1000],
                reward=row[5],
            ))
        return candidates

    def _mmr_select(
        self,
        candidates: List[FewShotExample],
        max_k: int,
        query_tf: Dict[str, float],
    ) -> List[FewShotExample]:
        """Maximal Marginal Relevance selection for diversity.

        Iteratively selects the candidate that maximizes:
          λ * relevance - (1-λ) * max_similarity_to_selected
        """
        if not candidates:
            return []

        lambda_param = 0.7  # balance relevance vs diversity
        selected: List[FewShotExample] = []
        remaining = list(candidates)

        # Normalize rewards to [0, 1] for quality scoring
        max_reward = max(c.reward for c in candidates) or 1.0

        for _ in range(min(max_k, len(remaining))):
            best_score = -float("inf")
            best_idx = 0

            for i, candidate in enumerate(remaining):
                # Relevance (combined with quality)
                quality = candidate.reward / max_reward
                relevance = (
                    self._W_RELEVANCE * candidate.relevance_score
                    + self._W_QUALITY * quality
                )

                # Diversity penalty (similarity to already selected)
                max_sim = 0.0
                if selected:
                    cand_tf = _compute_tf(_tokenize(candidate.response[:200]))
                    for sel in selected:
                        sel_tf = _compute_tf(_tokenize(sel.response[:200]))
                        sim = _cosine_similarity(cand_tf, sel_tf)
                        max_sim = max(max_sim, sim)

                mmr_score = lambda_param * relevance - (1 - lambda_param) * max_sim

                if mmr_score > best_score:
                    best_score = mmr_score
                    best_idx = i

            chosen = remaining.pop(best_idx)
            chosen.final_score = best_score
            selected.append(chosen)

        return selected

    def _enforce_token_budget(
        self, examples: List[FewShotExample], max_tokens: int,
    ) -> List[FewShotExample]:
        """Remove examples that exceed token budget."""
        result: List[FewShotExample] = []
        tokens_used = 0

        for ex in examples:
            formatted = ex.format_for_injection()
            est_tokens = int(len(formatted) / self._chars_per_token)
            if tokens_used + est_tokens > max_tokens:
                break
            tokens_used += est_tokens
            result.append(ex)

        return result

    @staticmethod
    def format_examples(
        examples: List[FewShotExample],
        header: str = "Примеры успешных ответов для контекста:",
    ) -> str:
        """Format selected examples as a prompt block."""
        if not examples:
            return ""

        parts = [header, ""]
        for i, ex in enumerate(examples, 1):
            parts.append(f"--- Пример {i} ---")
            parts.append(ex.format_for_injection(include_metadata=False))
            parts.append("")

        parts.append("--- Конец примеров ---\n")
        return "\n".join(parts)

    def stats(self) -> Dict[str, Any]:
        """Stats about available examples in the buffer."""
        if not self._buffer._conn:
            return {"available": 0}

        total = self._buffer._conn.execute(
            "SELECT COUNT(*) FROM experiences WHERE reward >= ?",
            (self._min_reward,),
        ).fetchone()[0]

        by_type = dict(self._buffer._conn.execute(
            """SELECT task_type, COUNT(*) FROM experiences
               WHERE reward >= ? GROUP BY task_type""",
            (self._min_reward,),
        ).fetchall())

        return {
            "available_examples": total,
            "min_reward_threshold": self._min_reward,
            "by_task_type": by_type,
        }
