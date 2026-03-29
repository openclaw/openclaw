"""Adaptive token budget — per-request budget estimation.

Reference: Scaling Data-Constrained Language Models (arXiv:2305.16264).
"""

from typing import Dict

from src.ai.inference._shared import TokenBudget, logger

_TASK_BUDGET_DEFAULTS: Dict[str, int] = {
    "general": 1024,
    "chat": 512,
    "code": 2048,
    "math": 1536,
    "creative": 2048,
}


class AdaptiveTokenBudget:
    """Dynamically adjust token budgets per request."""

    def __init__(self, default_max_tokens: int = 2048, vram_gb: float = 16.0) -> None:
        self._default_max = default_max_tokens
        self._vram_gb = vram_gb

        logger.info(
            "AdaptiveTokenBudget initialised",
            default_max_tokens=default_max_tokens,
            vram_gb=vram_gb,
        )

    def estimate_budget(self, prompt: str, task_type: str = "general") -> TokenBudget:
        # B5-fix: автодетект task_type из промпта когда передан "general"
        if task_type == "general":
            task_type = self._infer_task_type(prompt)

        base = _TASK_BUDGET_DEFAULTS.get(task_type, self._default_max)

        prompt_tokens = self._rough_token_count(prompt)
        if prompt_tokens > 500:
            base = min(int(base * 1.3), self._default_max)

        if prompt_tokens < 30 and task_type in ("chat", "general"):
            base = min(base, 256)

        reason = f"task={task_type}, prompt_tokens≈{prompt_tokens}"
        budget = TokenBudget(
            max_tokens=base,
            estimated_output_tokens=int(base * 0.6),
            context_tokens=prompt_tokens,
            budget_reason=reason,
        )
        logger.debug("Token budget estimated", budget_reason=reason, max_tokens=base)
        return budget

    def adjust_for_vram(self, budget: TokenBudget, current_vram_usage: float) -> TokenBudget:
        headroom = self._vram_gb - current_vram_usage
        if headroom < 1.0:
            factor, suffix = 0.5, " [VRAM critical]"
        elif headroom < 2.0:
            factor, suffix = 0.75, " [VRAM constrained]"
        else:
            return budget

        adjusted = TokenBudget(
            max_tokens=max(64, int(budget.max_tokens * factor)),
            estimated_output_tokens=max(32, int(budget.estimated_output_tokens * factor)),
            context_tokens=budget.context_tokens,
            budget_reason=budget.budget_reason + suffix,
        )
        logger.info(
            "Token budget reduced for VRAM",
            original=budget.max_tokens,
            adjusted=adjusted.max_tokens,
            vram_headroom_gb=round(headroom, 2),
        )
        return adjusted

    @staticmethod
    def _rough_token_count(text: str) -> int:
        return max(1, len(text) // 4)

    @staticmethod
    def _infer_task_type(prompt: str) -> str:
        """B5-fix: вывод task_type из контента промпта."""
        lower = prompt[:500].lower()
        if any(kw in lower for kw in [
            "код", "code", "функци", "function", "class ", "def ", "import ",
            "напиши", "реализуй", "implement", "refactor", "рефактор",
            "python", "typescript", "javascript", "rust", "binary_search",
        ]):
            return "code"
        if any(kw in lower for kw in ["math", "матем", "вычисл", "формул", "уравнен"]):
            return "math"
        if any(kw in lower for kw in [
            "research", "исследу", "анализ", "найди", "youtube", "http",
        ]):
            return "general"  # research stays general (1024 base is OK)
        return "general"
