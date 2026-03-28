"""
Deep Research Pipeline — core orchestration module.

Contains DeepResearchPipeline class, data classes, and constants.
Helper functions live in sibling modules (_searcher, _analyzer, _scraper).
"""

import asyncio
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import structlog

from src.llm_gateway import route_llm
from src.research._searcher import (
    search_sub_query,
    multi_source_search,
)
from src.research._analyzer import (
    score_evidence,
    detect_contradictions,
    estimate_confidence,
    verify_facts,
    final_fact_check,
)
from src.research._scraper import (
    enrich_with_full_content,
    apply_token_budget,
)
from src.utils.async_utils import taskgroup_gather

logger = structlog.get_logger("DeepResearch")

# ---------------------------------------------------------------------------
# Evidence tracking
# ---------------------------------------------------------------------------

@dataclass
class EvidencePiece:
    """A single piece of evidence with provenance and confidence."""
    query: str
    source_type: str  # "web", "memory", "academic"
    content: str
    confidence: float = 0.5
    perspective: str = "default"

    def summary(self, max_len: int = 500) -> str:
        return self.content[:max_len]


@dataclass
class ResearchState:
    """Tracks the full state of a research session."""
    question: str
    complexity: str = "medium"
    evidence: List[EvidencePiece] = field(default_factory=list)
    contradictions: List[str] = field(default_factory=list)
    verified_facts: List[str] = field(default_factory=list)
    refuted_facts: List[str] = field(default_factory=list)
    confidence_score: float = 0.0
    iterations: int = 0
    sources: List[str] = field(default_factory=list)

    @property
    def evidence_count(self) -> int:
        return len(self.evidence)

    @property
    def source_diversity(self) -> int:
        """Number of distinct source types used."""
        return len({e.source_type for e in self.evidence})

    def add_evidence(self, piece: EvidencePiece):
        self.evidence.append(piece)
        if piece.source_type == "web" and piece.content and piece.content != "No results found.":
            if piece.query not in self.sources:
                self.sources.append(piece.query)


# Depth profiles keyed by complexity level
_DEPTH_PROFILES = {
    "simple": {"max_iterations": 2, "max_sub_queries": 3, "max_gap_queries": 1},
    "medium": {"max_iterations": 4, "max_sub_queries": 5, "max_gap_queries": 2},
    "complex": {"max_iterations": 5, "max_sub_queries": 6, "max_gap_queries": 3},
}

_CONFIDENCE_THRESHOLD = 0.75


class DeepResearchPipeline:
    """Iterative research pipeline with parallel search, fact verification and self-critique.

    V2: Multi-perspective reformulation, evidence scoring, contradiction detection,
        academic paper search, adaptive stopping, structured evidence chain.
    V3: OpenRouter primary, multi-source parsers, page enrichment, token budgeting.
    """

    def __init__(
        self,
        vllm_url: str,
        model: str,
        mcp_client,
        openrouter_config: Optional[Dict[str, Any]] = None,
        openrouter_model: str = "",
    ):
        self.vllm_url = vllm_url.rstrip("/")
        self.model = model
        self.mcp_client = mcp_client
        self._research_context: List[str] = []
        self._academic_search_enabled = True
        self._firecrawl_api_key: Optional[str] = os.environ.get("FIRECRAWL_API_KEY")
        self._openrouter_config = openrouter_config or {}
        self._openrouter_model = (
            openrouter_model
            or os.environ.get("OPENROUTER_RESEARCH_MODEL", "")
        )
        self._parsers_enabled = True

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------
    async def research(
        self, question: str, status_callback=None
    ) -> Dict[str, Any]:
        """
        Returns {report, sources, iterations, verified_facts, refuted_facts,
                 confidence_score, evidence_count, source_diversity, contradictions}.
        """
        self._research_context = []
        state = ResearchState(question=question)

        # Step 0: Adaptive depth
        if status_callback:
            await status_callback("DeepResearch", self.model, "🔍 Оценка сложности...")
        complexity = await self._estimate_complexity(question)
        state.complexity = complexity
        profile = _DEPTH_PROFILES.get(complexity, _DEPTH_PROFILES["medium"])
        max_iterations = profile["max_iterations"]
        max_sub_queries = profile["max_sub_queries"]
        max_gap_queries = profile["max_gap_queries"]
        logger.info("Research depth", complexity=complexity, profile=profile)

        # Step 1: Decompose into sub-queries
        if status_callback:
            await status_callback("DeepResearch", self.model, "🔍 Декомпозиция вопроса...")
        sub_queries = await self._decompose(question)
        sub_queries = sub_queries[:max_sub_queries]
        logger.info("Research decomposed", sub_queries=sub_queries)

        # Step 1a: Multi-perspective reformulation
        if status_callback:
            await status_callback("DeepResearch", self.model, "🔄 Мульти-перспективная переформулировка...")
        reformulated = await self._reformulate_queries(question, sub_queries)
        all_queries = list(dict.fromkeys(sub_queries + reformulated))
        all_queries = all_queries[:max_sub_queries + 3]
        logger.info("Queries after reformulation", total=len(all_queries), added=len(reformulated))

        # Step 2: Parallel search for all sub-queries
        if status_callback:
            await status_callback(
                "DeepResearch", self.model,
                f"🔎 Параллельный поиск по {len(all_queries)} запросам..."
            )
        search_results = await taskgroup_gather(
            *[
                search_sub_query(
                    self.mcp_client, sq,
                    academic_enabled=self._academic_search_enabled,
                    parsers_enabled=self._parsers_enabled,
                )
                for sq in all_queries
            ]
        )

        all_evidence: List[str] = []
        sources: List[str] = []
        for res in search_results:
            evidence = (
                f"[Sub-query: {res['query']}]\n"
                f"Web: {res['web']}\n"
                f"Memory: {res['memory']}"
            )
            all_evidence.append(evidence)
            state.add_evidence(EvidencePiece(
                query=res["query"], source_type="web", content=res["web"],
                perspective=res.get("perspective", "default"),
            ))
            state.add_evidence(EvidencePiece(
                query=res["query"], source_type="memory", content=res["memory"],
                perspective=res.get("perspective", "default"),
            ))
            if res["web"] and res["web"] != "No results found.":
                sources.append(res["query"])
            if res.get("academic"):
                all_evidence.append(f"[Academic: {res['query']}]\n{res['academic']}")
                state.add_evidence(EvidencePiece(
                    query=res["query"], source_type="academic",
                    content=res["academic"], confidence=0.8,
                ))
            if res.get("multi_source"):
                all_evidence.append(f"[Multi-source: {res['query']}]\n{res['multi_source']}")
                state.add_evidence(EvidencePiece(
                    query=res["query"], source_type="multi_source",
                    content=res["multi_source"], confidence=0.6,
                ))

        self._research_context.append(
            f"Собраны данные по {len(all_queries)} подзапросам, "
            f"найдено {len(sources)} результатов с веб-источниками, "
            f"всего {state.evidence_count} блоков доказательств."
        )

        # Step 2a: Page enrichment (v3)
        if status_callback:
            await status_callback("DeepResearch", self.model, "📄 Загрузка полного содержимого страниц...")
        all_evidence = await enrich_with_full_content(
            self.mcp_client, all_evidence, state,
            self._research_context, self._firecrawl_api_key,
        )

        # Step 2b: Evidence scoring
        if status_callback:
            await status_callback("DeepResearch", self.model, "⚖️ Оценка релевантности доказательств...")
        await score_evidence(self._llm_call, self._research_context, question, all_evidence)

        # Step 2c: Contradiction detection
        if status_callback:
            await status_callback("DeepResearch", self.model, "⚡ Обнаружение противоречий...")
        contradictions = await detect_contradictions(
            self._llm_call, self._research_context, question, all_evidence,
        )
        state.contradictions = contradictions

        # Step 3: Verify key facts
        if status_callback:
            await status_callback("DeepResearch", self.model, "✅ Верификация фактов...")
        verification = await verify_facts(
            self._llm_call, self._research_context, question, all_evidence,
        )

        # Step 4: Synthesize report with citations
        if status_callback:
            await status_callback("DeepResearch", self.model, "📝 Синтез отчёта...")
        report = await self._synthesize(question, all_evidence, verification)

        # Step 5: Self-critique → revise
        if status_callback:
            await status_callback("DeepResearch", self.model, "🔍 Самокритика отчёта...")
        critique = await self._self_critique(question, report)
        if critique and critique.strip().lower() not in ("none", "нет", "no issues"):
            report = await self._revise_report(report, critique)

        # Step 6: Iterative gap-filling with adaptive stopping
        iteration = 0
        for iteration in range(max_iterations - 1):
            confidence = await estimate_confidence(
                self._llm_call, question, report, all_evidence,
            )
            state.confidence_score = confidence
            if confidence >= _CONFIDENCE_THRESHOLD:
                logger.info("Adaptive stop: confidence threshold met", confidence=confidence)
                self._research_context.append(
                    f"Адаптивная остановка: уверенность {confidence:.0%} ≥ порога {_CONFIDENCE_THRESHOLD:.0%}."
                )
                break

            if status_callback:
                await status_callback(
                    "DeepResearch", self.model,
                    f"🔄 Проверка #{iteration + 1}: ищу пробелы (уверенность {confidence:.0%})..."
                )

            gaps = await self._find_gaps(question, report)
            if not gaps or gaps.strip().lower() in ("none", "нет", "no gaps"):
                break

            gap_queries = [g.strip() for g in gaps.split("\n") if g.strip()][:max_gap_queries]
            gap_results = await taskgroup_gather(
                *[
                    search_sub_query(
                        self.mcp_client, gq,
                        academic_enabled=self._academic_search_enabled,
                        parsers_enabled=self._parsers_enabled,
                    )
                    for gq in gap_queries
                ]
            )
            gap_evidence = [
                f"[Gap query: {r['query']}]\nWeb: {r['web']}" for r in gap_results
            ]
            all_evidence.extend(gap_evidence)
            for r in gap_results:
                if r["web"] and r["web"] != "No results found.":
                    sources.append(r["query"])
                state.add_evidence(EvidencePiece(
                    query=r["query"], source_type="web", content=r["web"],
                ))

            report = await self._refine(question, report, gap_evidence)

        # Step 7: Final confidence calibration
        state.confidence_score = await estimate_confidence(
            self._llm_call, question, report, all_evidence,
        )

        # Step 8: Final fact-check pass
        if status_callback:
            await status_callback("DeepResearch", self.model, "🔒 Финальная проверка фактов...")
        final_check = await final_fact_check(
            self._llm_call, question, report, all_evidence,
        )

        total_iterations = iteration + 1 if sub_queries else 0
        state.iterations = total_iterations
        state.verified_facts = final_check.get("verified", [])
        state.refuted_facts = final_check.get("refuted", [])
        state.sources = sources
        logger.info(
            "Research complete",
            iterations=total_iterations,
            complexity=complexity,
            confidence=state.confidence_score,
            evidence_count=state.evidence_count,
            source_diversity=state.source_diversity,
            contradictions=len(state.contradictions),
        )

        return {
            "report": final_check.get("report", report),
            "sources": sources,
            "iterations": total_iterations,
            "verified_facts": final_check.get("verified", []),
            "refuted_facts": final_check.get("refuted", []),
            "confidence_score": state.confidence_score,
            "evidence_count": state.evidence_count,
            "source_diversity": state.source_diversity,
            "contradictions": state.contradictions,
        }

    # ------------------------------------------------------------------
    # LLM call with cumulative context — via Unified LLM Gateway
    # ------------------------------------------------------------------
    async def _llm_call(
        self, system: str, user: str, max_tokens: int = 2048, retries: int = 2
    ) -> str:
        """LLM inference via Unified LLM Gateway (handles OpenRouter/vLLM routing)."""
        messages = [{"role": "system", "content": system}]
        if self._research_context:
            ctx = "\n".join(self._research_context[-6:])
            messages.append({"role": "user", "content": f"Контекст исследования:\n{ctx}"})
            messages.append({"role": "assistant", "content": "Понял, учитываю контекст."})
        messages.append({"role": "user", "content": user})

        return await route_llm(
            "",
            messages=messages,
            task_type="research",
            max_tokens=max_tokens,
            temperature=0.2,
        )

    # ------------------------------------------------------------------
    # Adaptive depth
    # ------------------------------------------------------------------
    async def _estimate_complexity(self, question: str) -> str:
        result = await self._llm_call(
            system=(
                "Оцени сложность исследовательского вопроса. "
                "Ответь ОДНИМ словом: simple, medium или complex."
            ),
            user=question,
            max_tokens=10,
            retries=1,
        )
        level = result.strip().lower().rstrip(".")
        return level if level in _DEPTH_PROFILES else "medium"

    # ------------------------------------------------------------------
    # Decompose
    # ------------------------------------------------------------------
    async def _decompose(self, question: str) -> List[str]:
        result = await self._llm_call(
            system=(
                "Ты — планировщик исследований. Разбей вопрос пользователя на 2-6 "
                "конкретных поисковых подзапроса. Каждый на отдельной строке. "
                "Без нумерации, без пояснений, только запросы."
            ),
            user=question,
            max_tokens=256,
        )
        return [line.strip() for line in result.split("\n") if line.strip()]

    # ------------------------------------------------------------------
    # Multi-perspective query reformulation
    # ------------------------------------------------------------------
    async def _reformulate_queries(
        self, question: str, sub_queries: List[str]
    ) -> List[str]:
        if not sub_queries:
            return []
        queries_text = "\n".join(f"- {q}" for q in sub_queries)
        result = await self._llm_call(
            system=(
                "Ты — планировщик исследований. Для каждого запроса создай 1 альтернативную "
                "формулировку, которая ищет ту же информацию с другой стороны. "
                "Например: 'причины X' → 'последствия X', 'X vs Y' → 'преимущества Y над X'. "
                "Каждый запрос на отдельной строке. Без нумерации, без пояснений."
            ),
            user=f"ОСНОВНОЙ ВОПРОС: {question}\n\nПОДЗАПРОСЫ:\n{queries_text}",
            max_tokens=256,
        )
        reformulated = [line.strip() for line in result.split("\n") if line.strip()]
        original_set = {q.lower() for q in sub_queries}
        unique = [q for q in reformulated if q.lower() not in original_set]
        return unique[:len(sub_queries)]

    # ------------------------------------------------------------------
    # Synthesis with source citations
    # ------------------------------------------------------------------
    async def _synthesize(
        self, question: str, evidence: List[str], verification: str
    ) -> str:
        evidence_text = apply_token_budget(evidence)
        return await self._llm_call(
            system=(
                "Ты — исследователь-аналитик. На основе собранных данных и результатов "
                "верификации напиши структурированный отчёт на РУССКОМ ЯЗЫКЕ.\n\n"
                "Правила:\n"
                "- Каждый ключевой факт ДОЛЖЕН сопровождаться ссылкой [N] на источник\n"
                "- В конце добавь секцию ИСТОЧНИКИ со списком: [N] описание/URL\n"
                "- Противоречивые данные отмечай явно: '⚠️ Противоречие: ...'\n"
                "- Структура: Резюме → Ключевые факты → Детали → Противоречия → Выводы → Источники\n"
                "- Если данных недостаточно — прямо укажи это"
            ),
            user=(
                f"ВОПРОС: {question}\n\n"
                f"ВЕРИФИКАЦИЯ ФАКТОВ:\n{verification}\n\n"
                f"СОБРАННЫЕ ДАННЫЕ:\n{evidence_text}"
            ),
            max_tokens=3072,
        )

    # ------------------------------------------------------------------
    # Self-critique → revise cycle
    # ------------------------------------------------------------------
    async def _self_critique(self, question: str, report: str) -> str:
        return await self._llm_call(
            system=(
                "Ты — критический рецензент. Проверь отчёт по критериям:\n"
                "1. Есть ли фактические противоречия внутри отчёта?\n"
                "2. Есть ли необоснованные выводы (утверждения без источников)?\n"
                "3. Достаточно ли аргументирован каждый пункт?\n"
                "4. Есть ли логические ошибки?\n"
                "Дай конкретную критику. Если всё хорошо — ответь 'none'."
            ),
            user=f"ВОПРОС: {question}\n\nОТЧЁТ:\n{report}",
            max_tokens=1024,
        )

    async def _revise_report(self, report: str, critique: str) -> str:
        result = await self._llm_call(
            system=(
                "Ты — редактор. Улучши отчёт на основе критики. "
                "Исправь слабые места, добавь обоснования. "
                "Сохрани структуру и ссылки [N]. Ответ на РУССКОМ ЯЗЫКЕ."
            ),
            user=f"ОТЧЁТ:\n{report}\n\nКРИТИКА:\n{critique}",
            max_tokens=3072,
        )
        self._research_context.append("Отчёт пересмотрен по результатам самокритики.")
        return result

    # ------------------------------------------------------------------
    # Gap analysis
    # ------------------------------------------------------------------
    async def _find_gaps(self, question: str, report: str) -> str:
        return await self._llm_call(
            system=(
                "Ты — критик-рецензент. Прочитай исследовательский отчёт и определи, "
                "какие важные вопросы ОСТАЛИСЬ БЕЗ ОТВЕТА. "
                "Выведи 1-3 поисковых запроса для заполнения пробелов. "
                "Если пробелов нет — ответь 'none'."
            ),
            user=f"ИСХОДНЫЙ ВОПРОС: {question}\n\nОТЧЁТ:\n{report}",
            max_tokens=256,
        )

    async def _refine(self, question: str, report: str, new_evidence: List[str]) -> str:
        evidence_text = "\n\n".join(new_evidence)
        result = await self._llm_call(
            system=(
                "Ты — редактор-аналитик. Обнови исследовательский отчёт, "
                "интегрировав новые данные. Сохрани ссылки [N] и добавь новые. "
                "Не удаляй существующие подтверждённые факты. "
                "Ответ на РУССКОМ ЯЗЫКЕ."
            ),
            user=(
                f"ВОПРОС: {question}\n\n"
                f"ТЕКУЩИЙ ОТЧЁТ:\n{report}\n\n"
                f"НОВЫЕ ДАННЫЕ:\n{evidence_text}"
            ),
            max_tokens=3072,
        )
        self._research_context.append(f"Отчёт дополнен данными из {len(new_evidence)} источников.")
        return result
