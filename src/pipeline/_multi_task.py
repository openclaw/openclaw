"""Multi-task decomposer — splits numbered/semantic multi-part prompts.

Extracted from _core.py for modularity.
ReDoS-safe: all quantifiers are bounded (\\s{0,10} instead of \\s*).
"""

from __future__ import annotations

import asyncio
import re
from typing import Any, Dict, List, Optional, Tuple

import structlog

logger = structlog.get_logger(__name__)

# ---- regex patterns (ReDoS-safe: bounded quantifiers) ----

_NUMBERED_RE = re.compile(
    r"(?:^|\n)\s{0,10}(\d+)\.\s+(.+?)(?=\n\s{0,10}\d+\.\s|\Z)",
    re.DOTALL,
)

_ACTION_VERBS_RE = re.compile(
    r"^(?:Сделай|Проанализируй|Напиши|Найди|Создай|Проверь|Check|Create|Write|Find|Analyze|Build|Implement|Audit|Auditor:)",
    re.IGNORECASE,
)

_SEMANTIC_MIN_LEN = 300

# Keyword → brigade mapping
_BRIGADE_KEYWORDS: Dict[str, List[str]] = {
    "Dmarket-Dev": [
        "dmarket", "buy", "sell", "trade", "price", "skin", "inventory",
        "купить", "продать", "торговля", "скин", "инвентарь", "арбитраж",
        "pyo3", "подпис", "hft", "latency",
    ],
    "Research-Ops": [
        "research", "найди", "поищи", "youtube", "видео", "video",
        "url", "http", "ссылк", "статью", "интернет", "анализ",
        "vision", "проанализируй",
    ],
    "OpenClaw-Core": [
        "config", "pipeline", "model", "bot", "openclaw", "gateway",
        "конфиг", "бригад", "бот", "память", "memory", "mcp",
        "code", "python", "rust", "напиши", "функци",
    ],
}


def route_subtask(text: str) -> str:
    """Route a single sub-task to the most relevant brigade by keywords."""
    lower = text.lower()
    scores: Dict[str, int] = {}
    for brigade, keywords in _BRIGADE_KEYWORDS.items():
        scores[brigade] = sum(1 for kw in keywords if kw in lower)
    best = max(scores, key=scores.get)  # type: ignore[arg-type]
    return best if scores[best] > 0 else "OpenClaw-Core"


def decompose_multi_task(prompt: str) -> List[Tuple[str, str]]:
    """Split a prompt into ``(sub_task_text, brigade)`` pairs.

    Two-pass strategy:
    1. Try numbered-list regex (``1. ... 2. ...``).
    2. Fallback: semantic paragraph splitting.

    Returns an empty list if the prompt doesn't look like a multi-task.
    """
    # Pass 1: numbered-list regex
    matches = _NUMBERED_RE.findall(prompt)
    if len(matches) >= 2:
        sub_tasks: List[Tuple[str, str]] = []
        for _num, body in matches:
            body = body.strip()
            if body:
                brigade = route_subtask(body)
                sub_tasks.append((body, brigade))
        return sub_tasks

    # Pass 2: semantic paragraph splitting
    analysis_text = prompt
    if "[CURRENT TASK]:" in prompt:
        analysis_text = prompt.split("[CURRENT TASK]:", 1)[1].strip()

    if len(analysis_text) < _SEMANTIC_MIN_LEN:
        return []

    paragraphs = [p.strip() for p in re.split(r"\n\n+", analysis_text) if p.strip()]
    if len(paragraphs) < 2:
        paragraphs = [p.strip() for p in analysis_text.split("\n") if p.strip()]

    action_paragraphs: List[str] = []
    for para in paragraphs:
        if _ACTION_VERBS_RE.search(para):
            action_paragraphs.append(para)
        elif re.search(r"https?://", para) and len(para) > 40:
            action_paragraphs.append(para)

    if len(action_paragraphs) < 2:
        return []

    sub_tasks = []
    for para in action_paragraphs:
        brigade = route_subtask(para)
        sub_tasks.append((para, brigade))
    logger.info(
        "Semantic decomposer activated (v15.3)",
        n_paragraphs=len(paragraphs),
        n_tasks=len(sub_tasks),
    )
    return sub_tasks


async def execute_multi_task(
    sub_tasks: List[Tuple[str, str]],
    original_prompt: str,
    max_steps: int,
    execute_fn,
    status_callback: Any = None,
) -> Dict[str, Any]:
    """Run decomposed sub-tasks concurrently, each routed to its brigade."""
    _history_block = ""
    if "[CURRENT TASK]:" in original_prompt:
        _history_block = original_prompt.split("[CURRENT TASK]:")[0] + "[CURRENT TASK]:\n"

    shared_observations: Dict[str, str] = {}

    async def _run_one(idx: int, text: str, brigade: str) -> Dict[str, Any]:
        if status_callback:
            await status_callback(
                "Decomposer", "system",
                f"🔀 Подзадача {idx + 1}/{len(sub_tasks)} → {brigade}",
            )
        enriched_text = _history_block + text if _history_block else text
        return await execute_fn(
            prompt=enriched_text,
            brigade=brigade,
            max_steps=max_steps,
            status_callback=status_callback,
            shared_observations=shared_observations,
        )

    tasks = [
        _run_one(i, text, brigade)
        for i, (text, brigade) in enumerate(sub_tasks)
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    merged_parts: List[str] = []
    all_steps: List[Dict] = []
    all_chains: List[str] = []
    for i, (text, brigade) in enumerate(sub_tasks):
        res = results[i]
        if isinstance(res, Exception):
            merged_parts.append(f"**Задача {i + 1}** ({brigade}): ⚠️ Ошибка: {res}")
        else:
            resp = res.get("final_response", "")
            merged_parts.append(f"**Задача {i + 1}** ({brigade}):\n{resp}")
            all_steps.extend(res.get("steps", []))
            all_chains.extend(res.get("chain_executed", []))

    final = "\n\n---\n\n".join(merged_parts)
    logger.info("Multi-task decomposer complete", n_subtasks=len(sub_tasks), n_steps=len(all_steps))
    return {
        "final_response": final,
        "brigade": "Multi-Task",
        "chain_executed": all_chains,
        "steps": all_steps,
        "status": "completed",
        "meta": {"decomposed": True, "n_subtasks": len(sub_tasks)},
    }
