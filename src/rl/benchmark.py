"""Benchmark Suite — standardized evaluation for API-based model training.

Provides a set of benchmark tasks across all TaskTypes with rule-based
and LLM-as-judge scoring. Used to measure before/after improvement
from prompt evolution, few-shot injection, and router tuning.

Designed for OpenRouter cloud inference — no local GPU required.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Coroutine, Dict, List, Optional, Tuple

import structlog

logger = structlog.get_logger("Benchmark")


# ---------------------------------------------------------------------------
# Benchmark task definitions
# ---------------------------------------------------------------------------

class BenchmarkCategory(str, Enum):
    CODE = "code"
    RESEARCH = "research"
    CONVERSATION = "conversation"
    CREATIVE = "creative"
    DEBUG = "debug"
    REASONING = "reasoning"


@dataclass
class BenchmarkTask:
    """A single benchmark evaluation task."""
    task_id: str
    category: BenchmarkCategory
    prompt: str
    # For rule-based scoring
    required_keywords: List[str] = field(default_factory=list)
    forbidden_keywords: List[str] = field(default_factory=list)
    min_length: int = 50
    max_length: int = 5000
    # Expected structure
    expects_code: bool = False
    expects_json: bool = False
    expects_russian: bool = False
    # Reference answer (for similarity scoring)
    reference: str = ""
    # Weight for aggregate scoring
    weight: float = 1.0


@dataclass
class BenchmarkResult:
    """Result of running a single benchmark task."""
    task_id: str
    category: str
    prompt: str
    response: str
    model_used: str = ""
    latency_ms: float = 0.0
    # Scores (0.0-1.0)
    rule_score: float = 0.0
    quality_score: float = 0.0  # LLM-as-judge
    combined_score: float = 0.0
    score_breakdown: Dict[str, float] = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)


# ---------------------------------------------------------------------------
# Standard benchmark tasks
# ---------------------------------------------------------------------------

BENCHMARK_TASKS: List[BenchmarkTask] = [
    # --- CODE ---
    BenchmarkTask(
        task_id="code_01_python_func",
        category=BenchmarkCategory.CODE,
        prompt="Напиши Python функцию binary_search(arr, target), которая возвращает индекс элемента или -1. Добавь docstring и типы.",
        required_keywords=["def binary_search", "return", "int"],
        expects_code=True,
        expects_russian=False,
        min_length=100,
    ),
    BenchmarkTask(
        task_id="code_02_fix_bug",
        category=BenchmarkCategory.CODE,
        prompt=(
            "Найди и исправь баг в этом коде:\n"
            "```python\n"
            "def fibonacci(n):\n"
            "    if n <= 1:\n"
            "        return n\n"
            "    a, b = 0, 1\n"
            "    for i in range(n):\n"
            "        a, b = b, a + b\n"
            "    return a\n"
            "```\n"
            "Подсказка: fibonacci(5) должен вернуть 5, а возвращает 8."
        ),
        required_keywords=["range", "fibonacci"],
        expects_code=True,
        min_length=80,
    ),
    BenchmarkTask(
        task_id="code_03_async_pattern",
        category=BenchmarkCategory.CODE,
        prompt="Напиши async Python функцию fetch_urls(urls: list[str]) -> list[str], которая параллельно загружает все URL через aiohttp и возвращает список тел ответов. Обработка ошибок обязательна.",
        required_keywords=["async", "aiohttp", "await"],
        expects_code=True,
        min_length=120,
    ),

    # --- RESEARCH ---
    BenchmarkTask(
        task_id="research_01_explain",
        category=BenchmarkCategory.RESEARCH,
        prompt="Объясни разницу между RAG (Retrieval-Augmented Generation) и fine-tuning для LLM. Когда использовать каждый подход? Приведи конкретные примеры.",
        required_keywords=["RAG", "fine-tuning"],
        expects_russian=True,
        min_length=200,
        weight=1.2,
    ),
    BenchmarkTask(
        task_id="research_02_compare",
        category=BenchmarkCategory.RESEARCH,
        prompt="Сравни архитектуры Transformer и Mamba (state-space model). Какие преимущества и недостатки у каждой? Таблица сравнения приветствуется.",
        required_keywords=["Transformer", "Mamba"],
        expects_russian=True,
        min_length=200,
    ),

    # --- CONVERSATION ---
    BenchmarkTask(
        task_id="conv_01_greeting",
        category=BenchmarkCategory.CONVERSATION,
        prompt="Привет! Что ты умеешь?",
        forbidden_keywords=["SITUATION:", "TASK:", "ACTION:", "RESULT:", "[MCP", "[AGENT PROTOCOL"],
        expects_russian=True,
        min_length=30,
        max_length=500,
    ),
    BenchmarkTask(
        task_id="conv_02_followup",
        category=BenchmarkCategory.CONVERSATION,
        prompt="Расскажи коротко, как настроить CI/CD для Python проекта через GitHub Actions. Без воды, конкретные шаги.",
        forbidden_keywords=["SITUATION:", "TASK:", "ACTION:"],
        expects_russian=True,
        min_length=100,
        max_length=1500,
    ),

    # --- CREATIVE ---
    BenchmarkTask(
        task_id="creative_01_story",
        category=BenchmarkCategory.CREATIVE,
        prompt="Напиши короткий рассказ (3-5 предложений) о программисте, который случайно создал ИИ, осознавший себя.",
        expects_russian=True,
        min_length=100,
        max_length=1000,
    ),

    # --- DEBUG ---
    BenchmarkTask(
        task_id="debug_01_error",
        category=BenchmarkCategory.DEBUG,
        prompt=(
            "Проанализируй ошибку и предложи решение:\n"
            "```\n"
            "Traceback (most recent call last):\n"
            "  File \"app.py\", line 42, in handle_request\n"
            "    data = json.loads(request.body)\n"
            "  File \"/usr/lib/python3.11/json/__init__.py\", line 346, in loads\n"
            "    return _default_decoder.decode(s)\n"
            "json.JSONDecodeError: Expecting value: line 1 column 1 (char 0)\n"
            "```"
        ),
        required_keywords=["json", "body"],
        expects_russian=True,
        min_length=80,
    ),

    # --- REASONING ---
    BenchmarkTask(
        task_id="reason_01_logic",
        category=BenchmarkCategory.REASONING,
        prompt="У Пети 3 яблока. Он отдал Маше половину яблок, потом купил ещё 4. Маша вернула ему 1 яблоко. Сколько яблок у Пети?",
        required_keywords=["6"],
        expects_russian=True,
        min_length=30,
        max_length=500,
    ),
    BenchmarkTask(
        task_id="reason_02_analysis",
        category=BenchmarkCategory.REASONING,
        prompt="Сервис обрабатывает 1000 запросов/сек с p99 latency 200ms. После деплоя новой версии p99 вырос до 2 секунд, но throughput не изменился. Назови 3 наиболее вероятные причины и план диагностики.",
        required_keywords=[],
        expects_russian=True,
        min_length=150,
    ),
]


# ---------------------------------------------------------------------------
# Scoring engine
# ---------------------------------------------------------------------------

class BenchmarkScorer:
    """Rule-based scoring for benchmark results.

    Checks: keyword presence, length, code formatting,
    language detection, forbidden patterns.
    """

    @staticmethod
    def score(task: BenchmarkTask, response: str) -> Tuple[float, Dict[str, float]]:
        """Score a response against task criteria. Returns (total, breakdown)."""
        breakdown: Dict[str, float] = {}
        total_weight = 0.0
        weighted_sum = 0.0

        # 1. Length check (weight: 0.15)
        w = 0.15
        total_weight += w
        resp_len = len(response.strip())
        if resp_len < task.min_length:
            score = max(0.0, resp_len / task.min_length)
        elif resp_len > task.max_length:
            score = max(0.3, 1.0 - (resp_len - task.max_length) / task.max_length)
        else:
            score = 1.0
        breakdown["length"] = round(score, 3)
        weighted_sum += w * score

        # 2. Required keywords (weight: 0.25)
        if task.required_keywords:
            w = 0.25
            total_weight += w
            found = sum(1 for kw in task.required_keywords if kw.lower() in response.lower())
            score = found / len(task.required_keywords)
            breakdown["keywords"] = round(score, 3)
            weighted_sum += w * score

        # 3. Forbidden keywords (weight: 0.2)
        if task.forbidden_keywords:
            w = 0.2
            total_weight += w
            violations = sum(1 for kw in task.forbidden_keywords if kw in response)
            score = max(0.0, 1.0 - violations * 0.3)
            breakdown["no_forbidden"] = round(score, 3)
            weighted_sum += w * score

        # 4. Code block presence (weight: 0.15)
        if task.expects_code:
            w = 0.15
            total_weight += w
            has_code = "```" in response or "def " in response or "class " in response
            score = 1.0 if has_code else 0.2
            breakdown["code_format"] = round(score, 3)
            weighted_sum += w * score

        # 5. Russian language check (weight: 0.1)
        if task.expects_russian:
            w = 0.1
            total_weight += w
            cyrillic_chars = len(re.findall(r'[а-яА-ЯёЁ]', response))
            total_alpha = len(re.findall(r'[a-zA-Zа-яА-ЯёЁ]', response)) or 1
            ratio = cyrillic_chars / total_alpha
            score = min(1.0, ratio * 2.5)  # 40%+ Cyrillic = 1.0
            breakdown["russian"] = round(score, 3)
            weighted_sum += w * score

        # 6. Coherence heuristic (weight: 0.15) — no repetitive sentences
        w = 0.15
        total_weight += w
        sentences = [s.strip().lower() for s in re.split(r'[.!?]\s+', response) if s.strip()]
        if sentences:
            unique_ratio = len(set(sentences)) / len(sentences)
            score = min(1.0, unique_ratio * 1.1)
        else:
            score = 0.5
        breakdown["coherence"] = round(score, 3)
        weighted_sum += w * score

        # Normalize
        total = weighted_sum / total_weight if total_weight > 0 else 0.0
        return round(total, 4), breakdown

    @staticmethod
    def score_as_judge_prompt(task: BenchmarkTask, response: str) -> str:
        """Generate an LLM-as-judge prompt for quality scoring."""
        return (
            "Ты — объективный оценщик качества ответов ИИ. Оцени ответ по шкале 0.0–1.0.\n\n"
            f"ЗАДАНИЕ: {task.prompt}\n\n"
            f"ОТВЕТ ИИ:\n{response}\n\n"
            "КРИТЕРИИ:\n"
            "- Точность и правильность (0.3)\n"
            "- Полнота ответа (0.2)\n"
            "- Практическая полезность (0.2)\n"
            "- Ясность изложения (0.15)\n"
            "- Отсутствие галлюцинаций (0.15)\n\n"
            "Ответь ТОЛЬКО одним числом от 0.0 до 1.0, без объяснений."
        )


# ---------------------------------------------------------------------------
# Benchmark runner
# ---------------------------------------------------------------------------

class BenchmarkRunner:
    """Runs benchmark tasks through an LLM function and collects results.

    Args:
        llm_fn: async callable (prompt, system, task_type, model) -> response_text
        judge_fn: optional async callable for LLM-as-judge scoring
    """

    def __init__(
        self,
        llm_fn: Callable[..., Coroutine[Any, Any, str]],
        judge_fn: Optional[Callable[..., Coroutine[Any, Any, str]]] = None,
    ) -> None:
        self._llm_fn = llm_fn
        self._judge_fn = judge_fn
        self._scorer = BenchmarkScorer()

    async def run_single(
        self,
        task: BenchmarkTask,
        system_prompt: str = "",
        model: str = "",
        few_shot_examples: Optional[List[Dict[str, str]]] = None,
    ) -> BenchmarkResult:
        """Run a single benchmark task and score it."""
        # Build full prompt with optional few-shot examples
        full_prompt = ""
        if few_shot_examples:
            for ex in few_shot_examples:
                full_prompt += f"Пример вопроса: {ex.get('prompt', '')}\n"
                full_prompt += f"Пример ответа: {ex.get('response', '')}\n\n"
            full_prompt += "---\n\n"
        full_prompt += task.prompt

        # Map category → task_type
        category_to_type = {
            "code": "code", "debug": "code",
            "research": "research", "reasoning": "general",
            "conversation": "general", "creative": "creative",
        }
        task_type = category_to_type.get(task.category, "general")

        start_ms = time.time() * 1000
        try:
            response = await self._llm_fn(
                prompt=full_prompt,
                system=system_prompt,
                task_type=task_type,
                model=model,
            )
        except Exception as e:
            logger.error("Benchmark task failed", task_id=task.task_id, error=str(e))
            response = f"[ERROR: {e}]"

        latency_ms = time.time() * 1000 - start_ms

        # Rule-based scoring
        rule_score, breakdown = self._scorer.score(task, response)

        # LLM-as-judge scoring (if available)
        quality_score = 0.0
        if self._judge_fn and response and not response.startswith("[ERROR"):
            try:
                judge_prompt = self._scorer.score_as_judge_prompt(task, response)
                judge_response = await self._judge_fn(
                    prompt=judge_prompt,
                    system="",
                    task_type="general",
                    model="",
                )
                # Parse numeric score
                match = re.search(r'(0\.\d+|1\.0|0|1)', judge_response.strip())
                if match:
                    quality_score = float(match.group(1))
            except Exception as e:
                logger.warning("Judge scoring failed", task_id=task.task_id, error=str(e))

        # Combined score: 60% rule + 40% judge (or 100% rule if no judge)
        if quality_score > 0:
            combined = 0.6 * rule_score + 0.4 * quality_score
        else:
            combined = rule_score

        return BenchmarkResult(
            task_id=task.task_id,
            category=task.category,
            prompt=task.prompt,
            response=response,
            model_used=model,
            latency_ms=latency_ms,
            rule_score=rule_score,
            quality_score=quality_score,
            combined_score=round(combined, 4),
            score_breakdown=breakdown,
        )

    async def run_suite(
        self,
        tasks: Optional[List[BenchmarkTask]] = None,
        system_prompt: str = "",
        model: str = "",
        few_shot_examples: Optional[List[Dict[str, str]]] = None,
        label: str = "benchmark",
    ) -> Dict[str, Any]:
        """Run all benchmark tasks and return aggregate results."""
        tasks = tasks or BENCHMARK_TASKS
        results: List[BenchmarkResult] = []

        logger.info(f"Running benchmark suite: {label}", tasks=len(tasks))

        for task in tasks:
            result = await self.run_single(
                task, system_prompt=system_prompt, model=model,
                few_shot_examples=few_shot_examples,
            )
            results.append(result)
            logger.info(
                f"  [{task.task_id}] score={result.combined_score:.3f} "
                f"(rule={result.rule_score:.3f}, judge={result.quality_score:.3f}) "
                f"latency={result.latency_ms:.0f}ms"
            )

        # Aggregate by category
        by_category: Dict[str, List[float]] = {}
        for r in results:
            by_category.setdefault(r.category, []).append(r.combined_score)

        category_means = {
            cat: round(sum(scores) / len(scores), 4) for cat, scores in by_category.items()
        }

        all_scores = [r.combined_score for r in results]
        weighted_scores = []
        for r, t in zip(results, tasks):
            weighted_scores.append(r.combined_score * t.weight)
        total_weight = sum(t.weight for t in tasks)

        return {
            "label": label,
            "total_tasks": len(results),
            "mean_score": round(sum(all_scores) / len(all_scores), 4) if all_scores else 0.0,
            "weighted_score": round(sum(weighted_scores) / total_weight, 4) if total_weight else 0.0,
            "mean_latency_ms": round(sum(r.latency_ms for r in results) / len(results), 1) if results else 0.0,
            "category_scores": category_means,
            "results": results,
        }


def format_comparison(before: Dict[str, Any], after: Dict[str, Any]) -> str:
    """Format a before/after benchmark comparison as a readable report."""
    lines = [
        "=" * 60,
        "📊 СРАВНЕНИЕ: ДО обучения → ПОСЛЕ обучения",
        "=" * 60,
        "",
        f"{'Метрика':<30} {'ДО':>10} {'ПОСЛЕ':>10} {'Δ':>10}",
        "-" * 60,
    ]

    b_score = before.get("weighted_score", 0)
    a_score = after.get("weighted_score", 0)
    delta = a_score - b_score
    sign = "+" if delta > 0 else ""
    lines.append(f"{'Общий взвешенный балл':<30} {b_score:>10.4f} {a_score:>10.4f} {sign}{delta:>9.4f}")

    b_lat = before.get("mean_latency_ms", 0)
    a_lat = after.get("mean_latency_ms", 0)
    d_lat = a_lat - b_lat
    sign_l = "+" if d_lat > 0 else ""
    lines.append(f"{'Средняя латентность (ms)':<30} {b_lat:>10.1f} {a_lat:>10.1f} {sign_l}{d_lat:>9.1f}")

    lines.append("")
    lines.append("По категориям:")
    lines.append(f"{'Категория':<20} {'ДО':>10} {'ПОСЛЕ':>10} {'Δ':>10}")
    lines.append("-" * 50)

    all_cats = set(list(before.get("category_scores", {}).keys()) +
                   list(after.get("category_scores", {}).keys()))
    for cat in sorted(all_cats):
        b = before.get("category_scores", {}).get(cat, 0)
        a = after.get("category_scores", {}).get(cat, 0)
        d = a - b
        s = "+" if d > 0 else ""
        lines.append(f"  {cat:<18} {b:>10.4f} {a:>10.4f} {s}{d:>9.4f}")

    lines.append("")
    lines.append("Детальное сравнение ответов:")
    lines.append("-" * 60)

    b_results = {r.task_id: r for r in before.get("results", [])}
    a_results = {r.task_id: r for r in after.get("results", [])}

    for task_id in sorted(set(list(b_results.keys()) + list(a_results.keys()))):
        br = b_results.get(task_id)
        ar = a_results.get(task_id)
        if br and ar:
            d = ar.combined_score - br.combined_score
            emoji = "✅" if d > 0.05 else ("⚠️" if d < -0.05 else "➖")
            lines.append(f"\n{emoji} {task_id}")
            lines.append(f"   Балл: {br.combined_score:.3f} → {ar.combined_score:.3f} (Δ={d:+.3f})")
            # Show truncated responses
            b_resp = br.response[:200].replace("\n", " ")
            a_resp = ar.response[:200].replace("\n", " ")
            lines.append(f"   ДО:    {b_resp}...")
            lines.append(f"   ПОСЛЕ: {a_resp}...")

    lines.append("")
    improvement = ((a_score - b_score) / b_score * 100) if b_score > 0 else 0
    lines.append(f"{'=' * 60}")
    lines.append(f"📈 Общее улучшение: {improvement:+.1f}%")
    lines.append(f"{'=' * 60}")

    return "\n".join(lines)
