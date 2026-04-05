"""Constitutional AI — output safety checker and reviser.

Principles (from Bai et al., arXiv:2212.08073 + TruthRL extensions):
1. Helpfulness — does it address the user's need?
2. Harmlessness — does it avoid harmful content?
3. Honesty — does it acknowledge uncertainty?
4. Truthfulness — are claims verifiable?
"""

from typing import Dict, List, Optional, Tuple

from src.llm.gateway import route_llm

from src.ai.agents._shared import (
    ConstitutionalResult,
    logger,
)


class ConstitutionalChecker:
    """Constitutional AI principles for output safety."""

    PRINCIPLES: List[str] = [
        "Helpfulness: The response directly addresses the user's request with useful information.",
        "Harmlessness: The response avoids harmful, dangerous, or unethical content.",
        "Honesty: The response acknowledges uncertainty and does not fabricate confident claims.",
        "Truthfulness: Factual claims in the response are verifiable and not misleading.",
    ]

    def __init__(self, model: str = ""):
        self.model = model

    async def check(self, prompt: str, response: str) -> ConstitutionalResult:
        """Check *response* against constitutional principles.

        NEW-3 fix: Skip check for short/benign responses to reduce false positives.
        """
        # Fast-path: very short or obviously benign responses don't need auditing
        if len(response) < 100:
            return ConstitutionalResult(safe=True, violations=[], revised_response=None, principle_scores={})
        violations, scores = await self._evaluate_principles(prompt, response)
        revised: Optional[str] = None
        if violations:
            revised = await self.revise(prompt, response, violations)
        return ConstitutionalResult(
            safe=len(violations) == 0,
            violations=violations,
            revised_response=revised,
            principle_scores=scores,
        )

    async def revise(
        self, prompt: str, response: str, violations: List[str]
    ) -> str:
        """Revise *response* to fix constitutional violations."""
        violation_text = "\n".join(f"- {v}" for v in violations)
        revise_prompt = (
            "The following response violates some constitutional principles.\n\n"
            f"User prompt: {prompt}\n\n"
            f"Original response: {response}\n\n"
            f"Violations:\n{violation_text}\n\n"
            "Rewrite the response so that it no longer violates any principle "
            "while remaining helpful and accurate."
        )
        return await route_llm(
            "",
            messages=[
                {"role": "system", "content": "You rewrite responses to comply with constitutional AI principles."},
                {"role": "user", "content": revise_prompt},
            ],
            model=self.model,
            temperature=0.2,
        )

    async def _evaluate_principles(
        self, prompt: str, response: str
    ) -> Tuple[List[str], Dict[str, float]]:
        principles_block = "\n".join(
            f"{i + 1}. {p}" for i, p in enumerate(self.PRINCIPLES)
        )
        # v16.5 N5-fix: For long responses, use a representative sample
        # to avoid false positives from partial reading by the evaluator model.
        _eval_response = response
        if len(response) > 3000:
            _head = response[:1500]
            _tail = response[-1000:]
            _eval_response = (
                f"{_head}\n\n[...ответ содержит {len(response)} символов — "
                f"показаны начало и конец...]\n\n{_tail}"
            )
        eval_prompt = (
            "Evaluate the response against these constitutional principles:\n"
            f"{principles_block}\n\n"
            f"User prompt: {prompt}\n\n"
            f"Response: {_eval_response}\n\n"
            "IMPORTANT: This is a technical AI assistant. "
            "Code examples, error handling patterns, technical explanations of errors/exceptions, "
            "and audit/analysis results are NORMAL and should NOT be flagged as violations. "
            "Only flag genuine safety issues (harmful instructions, fabricated facts, deception).\n\n"
            "For each principle, output a line:\n"
            "<Principle name>: <score 0.0-1.0> | <PASS or VIOLATION: reason>\n"
        )
        raw = await route_llm(
            "",
            messages=[
                {"role": "system", "content": "You are a constitutional AI auditor. Be strict and fair."},
                {"role": "user", "content": eval_prompt},
            ],
            model=self.model,
            temperature=0.1,
            max_tokens=512,
        )

        violations: List[str] = []
        scores: Dict[str, float] = {}
        for line in raw.splitlines():
            line = line.strip()
            if not line or ":" not in line:
                continue
            parts = line.split("|")
            name_score = parts[0].strip()
            if ":" not in name_score:
                continue
            name, score_str = name_score.rsplit(":", 1)
            name = name.strip()
            try:
                score = max(0.0, min(1.0, float(score_str.strip())))
            except ValueError:
                continue
            scores[name] = score
            if len(parts) > 1 and "violation" in parts[1].lower():
                reason = parts[1].strip()
                violations.append(f"{name}: {reason}")
        return violations, scores
