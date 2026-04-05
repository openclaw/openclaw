"""Reflexion — self-reflecting agent with verbal reinforcement learning.

Reference: Shinn et al., "Reflexion: Language Agents with Verbal
Reinforcement Learning", arXiv:2303.11366.
"""

import time
from typing import List

from src.llm.gateway import route_llm

from src.ai.agents._shared import (
    EvaluationResult,
    ReflexionResult,
    logger,
)


class ReflexionAgent:
    """Self-reflecting agent that learns from verbal feedback."""

    _SUCCESS_THRESHOLD = 0.7

    def __init__(self, model: str = ""):
        self.model = model

    async def solve_with_reflection(
        self, task: str, max_attempts: int = 3
    ) -> ReflexionResult:
        reflections: List[str] = []
        evaluations: List[EvaluationResult] = []
        start = time.monotonic()
        last_response = ""

        for attempt in range(1, max_attempts + 1):
            gen_prompt = self._build_generation_prompt(task, reflections)
            last_response = await route_llm(
                "",
                messages=[
                    {"role": "system", "content": "You are a helpful assistant. Answer concisely and accurately."},
                    {"role": "user", "content": gen_prompt},
                ],
                model=self.model,
                temperature=0.3,
            )
            logger.info("reflexion_attempt", attempt=attempt, response_len=len(last_response))

            evaluation = await self._evaluate(task, last_response)
            evaluations.append(evaluation)

            if evaluation.success:
                return ReflexionResult(
                    final_response=last_response,
                    attempts=attempt,
                    reflections=reflections,
                    evaluations=evaluations,
                    success=True,
                    elapsed_sec=time.monotonic() - start,
                )

            if attempt < max_attempts:
                reflection = await self._reflect(task, last_response, evaluation)
                reflections.append(reflection)
                logger.info("reflexion_reflection", attempt=attempt, reflection=reflection[:200])

        return ReflexionResult(
            final_response=last_response,
            attempts=max_attempts,
            reflections=reflections,
            evaluations=evaluations,
            success=False,
            elapsed_sec=time.monotonic() - start,
        )

    async def _evaluate(self, task: str, response: str) -> EvaluationResult:
        eval_prompt = (
            "Evaluate the following response to a task.\n\n"
            f"Task: {task}\n\n"
            f"Response: {response}\n\n"
            "Rate the response quality from 0.0 (terrible) to 1.0 (perfect).\n"
            "List any issues found.\n"
            "Format your answer as:\n"
            "Score: <float>\n"
            "Issues: <comma-separated list or 'none'>\n"
            "Reasoning: <brief explanation>"
        )
        raw = await route_llm(
            "",
            messages=[
                {"role": "system", "content": "You are a strict evaluator. Be honest and concise."},
                {"role": "user", "content": eval_prompt},
            ],
            model=self.model,
            temperature=0.1,
            max_tokens=512,
        )
        score = self._parse_score(raw)
        issues = self._parse_issues(raw)
        return EvaluationResult(
            success=score >= self._SUCCESS_THRESHOLD,
            score=score,
            reasoning=raw.strip(),
            issues=issues,
        )

    async def _reflect(
        self, task: str, response: str, evaluation: EvaluationResult
    ) -> str:
        issues_str = "; ".join(evaluation.issues) if evaluation.issues else "unspecified"
        reflect_prompt = (
            "You attempted the following task and failed.\n\n"
            f"Task: {task}\n\n"
            f"Your response: {response}\n\n"
            f"Issues identified: {issues_str}\n"
            f"Score: {evaluation.score:.2f}\n\n"
            "Write a short reflection (2-3 sentences) on what went wrong "
            "and what you should do differently next time."
        )
        return await route_llm(
            "",
            messages=[
                {"role": "system", "content": "You are a self-reflective agent. Be specific and actionable."},
                {"role": "user", "content": reflect_prompt},
            ],
            model=self.model,
            temperature=0.3,
            max_tokens=256,
        )

    @staticmethod
    def _build_generation_prompt(task: str, reflections: List[str]) -> str:
        parts = [f"Task: {task}"]
        if reflections:
            parts.append("\n--- Previous reflections (learn from these) ---")
            for i, r in enumerate(reflections, 1):
                parts.append(f"Reflection {i}: {r}")
            parts.append("--- End reflections ---\n")
            parts.append("Using the reflections above, provide an improved answer.")
        return "\n".join(parts)

    @staticmethod
    def _parse_score(raw: str) -> float:
        for line in raw.splitlines():
            stripped = line.strip().lower()
            if stripped.startswith("score:"):
                try:
                    return max(0.0, min(1.0, float(stripped.split(":", 1)[1].strip())))
                except ValueError:
                    pass
        return 0.5

    @staticmethod
    def _parse_issues(raw: str) -> List[str]:
        for line in raw.splitlines():
            stripped = line.strip()
            if stripped.lower().startswith("issues:"):
                body = stripped.split(":", 1)[1].strip()
                if body.lower() == "none":
                    return []
                return [i.strip() for i in body.split(",") if i.strip()]
        return []
