"""
Deep Research Pipeline for OpenClaw.
Multi-step iterative research with parallel search, fact verification,
cumulative context, self-critique, and source citation.

Flow:
1. Estimate complexity → set adaptive depth
2. Decompose question into sub-queries
3. Parallel search (web + memory) for all sub-queries
4. Verify key claims via cross-search
5. Synthesize report with source citations [N]
6. Self-critique → revise report
7. Gap analysis → targeted follow-up searches → refine
8. Final fact-check pass before delivery

Triggered by /research command or when Planner detects complex factual questions.
"""

import asyncio
import json
from typing import Any, Dict, List

import aiohttp
import structlog

logger = structlog.get_logger("DeepResearch")

# Depth profiles keyed by complexity level
_DEPTH_PROFILES = {
    "simple": {"max_iterations": 2, "max_sub_queries": 3, "max_gap_queries": 1},
    "medium": {"max_iterations": 4, "max_sub_queries": 5, "max_gap_queries": 2},
    "complex": {"max_iterations": 5, "max_sub_queries": 6, "max_gap_queries": 3},
}


class DeepResearchPipeline:
    """Iterative research pipeline with parallel search, fact verification and self-critique."""

    def __init__(self, vllm_url: str, model: str, mcp_client):
        self.vllm_url = vllm_url.rstrip("/")
        self.model = model
        self.mcp_client = mcp_client
        # Cumulative context carried across all LLM calls within one research session
        self._research_context: List[str] = []

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------
    async def research(
        self, question: str, status_callback=None
    ) -> Dict[str, Any]:
        """
        Returns {report, sources, iterations, verified_facts, refuted_facts}.
        """
        self._research_context = []

        # Step 0: Adaptive depth
        if status_callback:
            await status_callback("DeepResearch", self.model, "🔍 Оценка сложности...")
        complexity = await self._estimate_complexity(question)
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

        # Step 2: Parallel search for all sub-queries
        if status_callback:
            await status_callback(
                "DeepResearch", self.model,
                f"🔎 Параллельный поиск по {len(sub_queries)} запросам..."
            )
        search_results = await asyncio.gather(
            *[self._search_sub_query(sq) for sq in sub_queries]
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
            if res["web"] and res["web"] != "No results found.":
                sources.append(res["query"])

        self._research_context.append(
            f"Собраны данные по {len(sub_queries)} подзапросам, "
            f"найдено {len(sources)} результатов с веб-источниками."
        )

        # Step 3: Verify key facts from gathered evidence
        if status_callback:
            await status_callback("DeepResearch", self.model, "✅ Верификация фактов...")
        verification = await self._verify_facts(question, all_evidence)

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

        # Step 6: Iterative gap-filling
        iteration = 0
        for iteration in range(max_iterations - 1):
            if status_callback:
                await status_callback(
                    "DeepResearch", self.model,
                    f"🔄 Проверка #{iteration + 1}: ищу пробелы..."
                )

            gaps = await self._find_gaps(question, report)
            if not gaps or gaps.strip().lower() in ("none", "нет", "no gaps"):
                break

            gap_queries = [g.strip() for g in gaps.split("\n") if g.strip()][:max_gap_queries]
            gap_results = await asyncio.gather(
                *[self._search_sub_query(gq) for gq in gap_queries]
            )
            gap_evidence = [
                f"[Gap query: {r['query']}]\nWeb: {r['web']}" for r in gap_results
            ]
            all_evidence.extend(gap_evidence)
            for r in gap_results:
                if r["web"] and r["web"] != "No results found.":
                    sources.append(r["query"])

            report = await self._refine(question, report, gap_evidence)

        # Step 7: Final fact-check pass
        if status_callback:
            await status_callback("DeepResearch", self.model, "🔒 Финальная проверка фактов...")
        final_check = await self._final_fact_check(question, report, all_evidence)

        total_iterations = iteration + 1 if sub_queries else 0
        logger.info("Research complete", iterations=total_iterations, complexity=complexity)

        return {
            "report": final_check.get("report", report),
            "sources": sources,
            "iterations": total_iterations,
            "verified_facts": final_check.get("verified", []),
            "refuted_facts": final_check.get("refuted", []),
        }

    # ------------------------------------------------------------------
    # LLM call with retry & cumulative context
    # ------------------------------------------------------------------
    async def _llm_call(
        self, system: str, user: str, max_tokens: int = 2048, retries: int = 2
    ) -> str:
        """LLM inference with retry-backoff and cumulative context injection."""
        messages = [{"role": "system", "content": system}]
        # Inject cumulative context from the research session
        if self._research_context:
            ctx = "\n".join(self._research_context[-6:])
            messages.append({"role": "user", "content": f"Контекст исследования:\n{ctx}"})
            messages.append({"role": "assistant", "content": "Понял, учитываю контекст."})
        messages.append({"role": "user", "content": user})

        payload = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "max_tokens": max_tokens,
            "temperature": 0.2,
        }

        for attempt in range(retries + 1):
            try:
                async with aiohttp.ClientSession() as session:
                    timeout = aiohttp.ClientTimeout(total=120)
                    async with session.post(
                        f"{self.vllm_url}/chat/completions",
                        json=payload,
                        timeout=timeout,
                    ) as resp:
                        if resp.status == 200:
                            data = await resp.json()
                            return data["choices"][0]["message"]["content"].strip()
                        if attempt < retries:
                            logger.warning("LLM retry", status=resp.status, attempt=attempt)
                            await asyncio.sleep(2**attempt)
                            continue
                        return ""
            except Exception as e:
                if attempt < retries:
                    logger.warning("LLM retry on error", error=str(e), attempt=attempt)
                    await asyncio.sleep(2**attempt)
                    continue
                logger.error("LLM call failed after retries", error=str(e))
                return ""

        return ""

    # ------------------------------------------------------------------
    # Adaptive depth
    # ------------------------------------------------------------------
    async def _estimate_complexity(self, question: str) -> str:
        """Estimate question complexity: simple / medium / complex."""
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
        """Decompose a complex question into searchable sub-queries."""
        result = await self._llm_call(
            system=(
                "Ты — планировщик исследований. Разбей вопрос пользователя на 2-6 "
                "конкретных поисковых подзапроса. Каждый на отдельной строке. "
                "Без нумерации, без пояснений, только запросы."
            ),
            user=question,
            max_tokens=256,
        )
        queries = [line.strip() for line in result.split("\n") if line.strip()]
        return queries

    # ------------------------------------------------------------------
    # Parallel search helper
    # ------------------------------------------------------------------
    async def _search_sub_query(self, query: str) -> Dict[str, str]:
        """Search web + memory for a single sub-query in parallel."""
        web, mem = await asyncio.gather(
            self._web_search(query),
            self._memory_search(query),
        )
        return {"query": query, "web": web, "memory": mem}

    async def _web_search(self, query: str) -> str:
        """Execute web search via MCP tool."""
        try:
            result = await self.mcp_client.call_tool(
                "web_search", {"query": query, "max_results": 5, "region": "wt-wt"}
            )
            return result if result else "No results found."
        except Exception as e:
            logger.warning("Web search failed", query=query, error=str(e))
            return f"Search error: {e}"

    async def _memory_search(self, query: str) -> str:
        """Search local memory bank."""
        try:
            result = await self.mcp_client.call_tool(
                "search_memory", {"query": query, "tier": "all", "top_k": 3}
            )
            return result if result else "No memory results."
        except Exception as e:
            return ""

    # ------------------------------------------------------------------
    # Fact verification (cross-search confirmation)
    # ------------------------------------------------------------------
    async def _verify_facts(self, question: str, evidence: List[str]) -> str:
        """Extract key claims from evidence and cross-verify them."""
        evidence_text = "\n---\n".join(evidence[:8])
        result = await self._llm_call(
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
        self._research_context.append(f"Верификация: {result[:300]}")
        return result

    # ------------------------------------------------------------------
    # Synthesis with source citations
    # ------------------------------------------------------------------
    async def _synthesize(
        self, question: str, evidence: List[str], verification: str
    ) -> str:
        """Synthesize evidence into a report with [N] source citations."""
        evidence_text = "\n\n---\n\n".join(evidence)
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
        """LLM critically reviews its own report."""
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
        """Revise report based on self-critique."""
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
        """Self-critique: identify gaps in the current report."""
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
        """Refine report with new evidence."""
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

    # ------------------------------------------------------------------
    # Final fact-check pass
    # ------------------------------------------------------------------
    async def _final_fact_check(
        self, question: str, report: str, all_evidence: List[str]
    ) -> Dict[str, Any]:
        """Final verification: cross-check report claims against all evidence."""
        evidence_summary = "\n---\n".join(e[:500] for e in all_evidence[:10])
        result = await self._llm_call(
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
            # Try to extract JSON from response
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
