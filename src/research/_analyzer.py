"""Evidence analysis helpers for Deep Research Pipeline.

Extracted from deep_research.py — scoring, contradictions, confidence, verification.
"""

import json
import re
from typing import Any, Callable, Awaitable, Dict, List

import structlog

logger = structlog.get_logger("DeepResearch")

# Type alias for the LLM call function passed from the core class
LLMCallFn = Callable[..., Awaitable[str]]


async def score_evidence(
    llm_call: LLMCallFn,
    research_context: List[str],
    question: str,
    evidence: List[str],
) -> List[Dict[str, Any]]:
    """Score evidence pieces by relevance and reliability."""
    if not evidence:
        return []
    evidence_text = "\n---\n".join(e[:300] for e in evidence[:10])
    result = await llm_call(
        system=(
            "Оцени каждый блок доказательств по шкале 1-10 по релевантности к вопросу. "
            "Ответь в формате: по одной строке на блок: НОМЕР|ОЦЕНКА|ПРИЧИНА\n"
            "Например: 1|8|Прямо отвечает на вопрос"
        ),
        user=f"ВОПРОС: {question}\n\nДОКАЗАТЕЛЬСТВА:\n{evidence_text}",
        max_tokens=512,
    )
    scored = []
    for line in result.split("\n"):
        parts = line.strip().split("|")
        if len(parts) >= 2:
            try:
                idx = int(parts[0].strip()) - 1
                score_val = float(parts[1].strip())
                reason = parts[2].strip() if len(parts) > 2 else ""
                scored.append({"index": idx, "score": score_val, "reason": reason})
            except (ValueError, IndexError):
                continue
    research_context.append(
        f"Оценено {len(scored)} блоков доказательств по релевантности."
    )
    return scored


async def detect_contradictions(
    llm_call: LLMCallFn,
    research_context: List[str],
    question: str,
    evidence: List[str],
) -> List[str]:
    """Detect contradictions between evidence pieces."""
    if len(evidence) < 2:
        return []
    evidence_text = "\n---\n".join(e[:400] for e in evidence[:10])
    result = await llm_call(
        system=(
            "Ты — детектор противоречий. Проанализируй все доказательства и "
            "найди утверждения которые ПРОТИВОРЕЧАТ друг другу. "
            "Для каждого противоречия напиши:\n"
            "ПРОТИВОРЕЧИЕ: <источник A> утверждает X, а <источник B> утверждает Y\n"
            "Если противоречий нет — ответь 'none'."
        ),
        user=f"ВОПРОС: {question}\n\nДОКАЗАТЕЛЬСТВА:\n{evidence_text}",
        max_tokens=512,
    )
    if result.strip().lower() in ("none", "нет"):
        return []
    contradictions = [
        line.strip() for line in result.split("\n")
        if line.strip() and "ПРОТИВОРЕЧИЕ" in line.upper()
    ]
    if contradictions:
        research_context.append(
            f"Обнаружено {len(contradictions)} противоречий в доказательствах."
        )
    return contradictions


async def estimate_confidence(
    llm_call: LLMCallFn,
    question: str,
    report: str,
    evidence: List[str],
) -> float:
    """Estimate confidence in the current report (0.0-1.0)."""
    result = await llm_call(
        system=(
            "Оцени уверенность в корректности исследовательского отчёта "
            "по шкале от 0.0 до 1.0, где 1.0 = полностью подтверждён фактами, "
            "0.0 = не подтверждён. Учитывай: количество доказательств, "
            "наличие противоречий, полноту ответа на вопрос. "
            "Ответь ОДНИМ числом, например: 0.85"
        ),
        user=(
            f"ВОПРОС: {question}\n"
            f"ОТЧЁТ (первые 500 символов): {report[:500]}\n"
            f"ДОКАЗАТЕЛЬСТВ: {len(evidence)}"
        ),
        max_tokens=10,
        retries=1,
    )
    try:
        numbers = re.findall(r"0?\.\d+|1\.0|0\.0", result.strip())
        if numbers:
            return min(1.0, max(0.0, float(numbers[0])))
    except (ValueError, IndexError):
        pass
    return 0.5


async def verify_facts(
    llm_call: LLMCallFn,
    research_context: List[str],
    question: str,
    evidence: List[str],
) -> str:
    """Extract key claims from evidence and cross-verify them."""
    evidence_text = "\n---\n".join(evidence[:8])
    result = await llm_call(
        system=(
            "Ты — факт-чекер. Проанализируй собранные данные и выдели ключевые "
            "утверждения (максимум 5). Для каждого укажи:\n"
            "- ФАКТ: <утверждение>\n"
            "- СТАТУС: ПОДТВЕРЖДЁН / ПРОТИВОРЕЧИВ / НЕ ПРОВЕРЕН\n"
            "- ОБОСНОВАНИЕ: <почему так решил, какие источники согласуются/противоречат>\n"
            "Если источники противоречат друг другу — отметь это явно."
        ),
        user=f"ВОПРОС: {question}\n\nДАННЫЕ:\n{evidence_text}",
        max_tokens=1024,
    )
    research_context.append(f"Верификация: {result[:300]}")
    return result


async def final_fact_check(
    llm_call: LLMCallFn,
    question: str,
    report: str,
    all_evidence: List[str],
) -> Dict[str, Any]:
    """Final verification: cross-check report claims against all evidence."""
    evidence_summary = "\n---\n".join(e[:500] for e in all_evidence[:10])
    result = await llm_call(
        system=(
            "Ты — финальный верификатор. Сравни каждое утверждение из отчёта "
            "с собранными данными. Ответь в формате JSON:\n"
            '{"verified": ["факт 1", "факт 2"], '
            '"refuted": ["опровергнутый факт 1"], '
            '"corrections": "Исправленный текст отчёта или пустая строка если всё верно"}'
        ),
        user=(
            f"ВОПРОС: {question}\n\n"
            f"ОТЧЁТ:\n{report}\n\n"
            f"ВСЕ ДАННЫЕ:\n{evidence_summary}"
        ),
        max_tokens=3072,
    )

    try:
        start = result.find("{")
        end = result.rfind("}") + 1
        if start >= 0 and end > start:
            parsed = json.loads(result[start:end])
            corrected = parsed.get("corrections", "")
            return {
                "report": corrected if corrected and len(corrected) > 100 else report,
                "verified": parsed.get("verified", []),
                "refuted": parsed.get("refuted", []),
            }
    except (json.JSONDecodeError, ValueError):
        logger.warning("Final fact-check JSON parse failed, using original report")

    return {"report": report, "verified": [], "refuted": []}
