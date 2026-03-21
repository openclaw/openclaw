"""
Deep Research Pipeline for OpenClaw.
Multi-step iterative research with parallel search, fact verification,
cumulative context, self-critique, and source citation.

Enhanced flow (v3 — with page-level enrichment & token budget):
 1. Estimate complexity → set adaptive depth
 2. Decompose question into sub-queries
 2a. **Multi-perspective reformulation** — rephrase each sub-query from 2-3 angles
 3. Parallel search (web + memory + **academic**) for all sub-queries
 3a. **Page enrichment** — fetch full content of top result URLs via web_fetch
 3b. **Evidence scoring** — weight each evidence piece by relevance & source diversity
 3c. **Contradiction detection** across gathered evidence
 4. Verify key claims via cross-search
 5. Synthesize report with source citations [N] (token budget guarded)
 6. Self-critique → revise report
 7. Gap analysis → targeted follow-up searches → refine
 7a. **Adaptive stopping** — stop when confidence threshold is met
 8. **Confidence calibration** — compute overall confidence score
 9. Final fact-check pass before delivery

Triggered by /research command or when Planner detects complex factual questions.
"""

import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import aiohttp
import structlog

logger = structlog.get_logger("DeepResearch")

# ---------------------------------------------------------------------------
# Evidence tracking (improvement: structured evidence chain)
# ---------------------------------------------------------------------------

@dataclass
class EvidencePiece:
    """A single piece of evidence with provenance and confidence."""
    query: str
    source_type: str  # "web", "memory", "academic"
    content: str
    confidence: float = 0.5  # 0.0–1.0
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
    confidence_score: float = 0.0  # overall 0.0–1.0
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

# Confidence threshold for adaptive stopping
_CONFIDENCE_THRESHOLD = 0.75

# v3: Page enrichment constants
_EVIDENCE_TOKEN_BUDGET_CHARS = 96_000   # max chars fed to _synthesize
_MAX_PAGES_TO_FETCH = 3                 # top URLs to enrich per research session
_MIN_USEFUL_CONTENT_CHARS = 200         # discard fetched pages shorter than this
_MAX_ENRICHED_CONTENT_CHARS = 8_000     # max chars kept per fetched page
_WEB_FETCH_REQUEST_CHARS = _MAX_ENRICHED_CONTENT_CHARS * 2  # ask for 2× then trim
_FIRECRAWL_API_URL = "https://api.firecrawl.dev/v1/scrape"
_TOKEN_BUDGET_TRUNCATION_NOTICE = "[...TRUNCATED FOR TOKEN BUDGET...]"  # appended when trimmed


class DeepResearchPipeline:
    """Iterative research pipeline with parallel search, fact verification and self-critique.

    V2 improvements:
    - Multi-perspective query reformulation
    - Evidence scoring & weighting
    - Contradiction detection
    - Source diversity tracking
    - Academic paper search integration (via research_paper_parser)
    - Adaptive stopping based on confidence threshold
    - Structured evidence chain (EvidencePiece / ResearchState)
    - Confidence calibration
    """

    def __init__(self, vllm_url: str, model: str, mcp_client):
        self.vllm_url = vllm_url.rstrip("/")
        self.model = model
        self.mcp_client = mcp_client
        # Cumulative context carried across all LLM calls within one research session
        self._research_context: List[str] = []
        # Academic search integration (lazy-loaded)
        self._academic_search_enabled = True
        # v3: optional Firecrawl API key for JS-heavy pages
        self._firecrawl_api_key: Optional[str] = os.environ.get("FIRECRAWL_API_KEY")

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

        # Step 1a: Multi-perspective reformulation (v2 improvement)
        if status_callback:
            await status_callback("DeepResearch", self.model, "🔄 Мульти-перспективная переформулировка...")
        reformulated = await self._reformulate_queries(question, sub_queries)
        all_queries = list(dict.fromkeys(sub_queries + reformulated))  # deduplicate preserving order
        all_queries = all_queries[:max_sub_queries + 3]  # allow a few extra
        logger.info("Queries after reformulation", total=len(all_queries), added=len(reformulated))

        # Step 2: Parallel search for all sub-queries (web + memory + academic)
        if status_callback:
            await status_callback(
                "DeepResearch", self.model,
                f"🔎 Параллельный поиск по {len(all_queries)} запросам..."
            )
        search_results = await asyncio.gather(
            *[self._search_sub_query(sq) for sq in all_queries]
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
            # Track evidence pieces
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

            # Include academic results if available
            if res.get("academic"):
                all_evidence.append(f"[Academic: {res['query']}]\n{res['academic']}")
                state.add_evidence(EvidencePiece(
                    query=res["query"], source_type="academic",
                    content=res["academic"], confidence=0.8,
                ))

        self._research_context.append(
            f"Собраны данные по {len(all_queries)} подзапросам, "
            f"найдено {len(sources)} результатов с веб-источниками, "
            f"всего {state.evidence_count} блоков доказательств."
        )

        # Step 2a: Page enrichment (v3) — fetch full content of top result URLs
        if status_callback:
            await status_callback("DeepResearch", self.model, "📄 Загрузка полного содержимого страниц...")
        all_evidence = await self._enrich_with_full_content(all_evidence, state)

        # Step 2b: Evidence scoring (v2 improvement)
        if status_callback:
            await status_callback("DeepResearch", self.model, "⚖️ Оценка релевантности доказательств...")
        scored_evidence = await self._score_evidence(question, all_evidence)

        # Step 2c: Contradiction detection (v2 improvement)
        if status_callback:
            await status_callback("DeepResearch", self.model, "⚡ Обнаружение противоречий...")
        contradictions = await self._detect_contradictions(question, all_evidence)
        state.contradictions = contradictions

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

        # Step 6: Iterative gap-filling with adaptive stopping
        iteration = 0
        for iteration in range(max_iterations - 1):
            # Adaptive stopping: compute confidence
            confidence = await self._estimate_confidence(question, report, all_evidence)
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
                state.add_evidence(EvidencePiece(
                    query=r["query"], source_type="web", content=r["web"],
                ))

            report = await self._refine(question, report, gap_evidence)

        # Step 7: Final confidence calibration
        state.confidence_score = await self._estimate_confidence(question, report, all_evidence)

        # Step 8: Final fact-check pass
        if status_callback:
            await status_callback("DeepResearch", self.model, "🔒 Финальная проверка фактов...")
        final_check = await self._final_fact_check(question, report, all_evidence)

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
        """Search web + memory + academic for a single sub-query in parallel."""
        tasks = [
            self._web_search(query),
            self._memory_search(query),
        ]
        if self._academic_search_enabled:
            tasks.append(self._academic_search(query))

        results = await asyncio.gather(*tasks, return_exceptions=True)
        web = results[0] if not isinstance(results[0], Exception) else ""
        mem = results[1] if not isinstance(results[1], Exception) else ""
        academic = ""
        if len(results) > 2 and not isinstance(results[2], Exception):
            academic = results[2]
        return {"query": query, "web": web, "memory": mem, "academic": academic}

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
    # Academic paper search (v2: connects deep research with parser)
    # ------------------------------------------------------------------
    async def _academic_search(self, query: str) -> str:
        """Search academic papers via the research_paper_parser APIs.

        This bridges DeepResearch with the existing paper parser for deeper
        evidence. Runs synchronously in a thread to avoid blocking the event loop.
        """
        if not self._academic_search_enabled:
            return ""
        try:
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(None, self._academic_search_sync, query)
            return result
        except Exception as e:
            logger.debug("Academic search skipped", error=str(e))
            return ""

    @staticmethod
    def _academic_search_sync(query: str) -> str:
        """Synchronous academic paper search — wraps research_paper_parser."""
        try:
            import sys
            import os
            scripts_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "scripts")
            if scripts_dir not in sys.path:
                sys.path.insert(0, scripts_dir)
            from research_paper_parser import Paper, fetch_semantic_scholar
            papers = fetch_semantic_scholar(query, limit=3)
            if not papers:
                return ""
            lines = []
            for p in papers[:3]:
                lines.append(f"- {p.title} ({p.published or 'n.d.'}) [{p.citations} citations]")
                if p.abstract:
                    lines.append(f"  {p.abstract[:200]}")
            return "\n".join(lines)
        except Exception:
            return ""

    # ------------------------------------------------------------------
    # Multi-perspective query reformulation (v2 improvement)
    # ------------------------------------------------------------------
    async def _reformulate_queries(
        self, question: str, sub_queries: List[str]
    ) -> List[str]:
        """Reformulate sub-queries from different perspectives for broader coverage."""
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
        # Deduplicate against originals
        original_set = {q.lower() for q in sub_queries}
        unique = [q for q in reformulated if q.lower() not in original_set]
        return unique[:len(sub_queries)]  # at most same count as originals

    # ------------------------------------------------------------------
    # Evidence scoring (v2 improvement)
    # ------------------------------------------------------------------
    async def _score_evidence(
        self, question: str, evidence: List[str]
    ) -> List[Dict[str, Any]]:
        """Score evidence pieces by relevance and reliability."""
        if not evidence:
            return []
        evidence_text = "\n---\n".join(e[:300] for e in evidence[:10])
        result = await self._llm_call(
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
                    score = float(parts[1].strip())
                    reason = parts[2].strip() if len(parts) > 2 else ""
                    scored.append({"index": idx, "score": score, "reason": reason})
                except (ValueError, IndexError):
                    continue
        self._research_context.append(
            f"Оценено {len(scored)} блоков доказательств по релевантности."
        )
        return scored

    # ------------------------------------------------------------------
    # Contradiction detection (v2 improvement)
    # ------------------------------------------------------------------
    async def _detect_contradictions(
        self, question: str, evidence: List[str]
    ) -> List[str]:
        """Detect contradictions between evidence pieces."""
        if len(evidence) < 2:
            return []
        evidence_text = "\n---\n".join(e[:400] for e in evidence[:10])
        result = await self._llm_call(
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
            self._research_context.append(
                f"Обнаружено {len(contradictions)} противоречий в доказательствах."
            )
        return contradictions

    # ------------------------------------------------------------------
    # Confidence estimation (v2 improvement — adaptive stopping)
    # ------------------------------------------------------------------
    async def _estimate_confidence(
        self, question: str, report: str, evidence: List[str]
    ) -> float:
        """Estimate confidence in the current report (0.0-1.0)."""
        result = await self._llm_call(
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
            # Extract float from response
            numbers = re.findall(r"0?\.\d+|1\.0|0\.0", result.strip())
            if numbers:
                return min(1.0, max(0.0, float(numbers[0])))
        except (ValueError, IndexError):
            pass
        return 0.5  # default medium confidence

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
    # ------------------------------------------------------------------
    # v3: Page enrichment helpers
    # ------------------------------------------------------------------
    def _extract_urls_from_search(self, evidence_pieces: List[str]) -> List[str]:
        """Extract unique http(s) URLs from raw evidence text blocks."""
        url_pattern = re.compile(r'https?://[^\s\'"<>]+')
        seen: set = set()
        urls: List[str] = []
        for piece in evidence_pieces:
            for match in url_pattern.finditer(piece):
                url = match.group(0).rstrip(".,;)")
                if url not in seen:
                    seen.add(url)
                    urls.append(url)
        return urls

    async def _fetch_page_content(self, url: str) -> str:
        """Fetch full page content via web_fetch MCP tool or Firecrawl fallback."""
        # Primary: use web_fetch tool (Jina Reader)
        try:
            result = await self.mcp_client.call_tool(
                "web_fetch",
                {"url": url, "max_chars": _WEB_FETCH_REQUEST_CHARS},
            )
            if result and len(result) >= _MIN_USEFUL_CONTENT_CHARS:
                return result[:_MAX_ENRICHED_CONTENT_CHARS]
        except Exception:
            pass

        # Fallback: Firecrawl (if API key set)
        if self._firecrawl_api_key:
            firecrawl_content = await self._fetch_via_firecrawl(url)
            if firecrawl_content and len(firecrawl_content) >= _MIN_USEFUL_CONTENT_CHARS:
                return firecrawl_content[:_MAX_ENRICHED_CONTENT_CHARS]

        return ""

    async def _fetch_via_firecrawl(self, url: str) -> str:
        """Use Firecrawl API to extract clean Markdown from JS-heavy pages."""
        try:
            import aiohttp as _aiohttp
            payload = {"url": url, "formats": ["markdown"], "onlyMainContent": True}
            headers = {
                "Authorization": f"Bearer {self._firecrawl_api_key}",
                "Content-Type": "application/json",
            }
            async with _aiohttp.ClientSession() as session:
                timeout = _aiohttp.ClientTimeout(total=30)
                async with session.post(
                    _FIRECRAWL_API_URL, json=payload, headers=headers, timeout=timeout
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        return data.get("data", {}).get("markdown", "")
        except Exception as exc:
            logger.debug("Firecrawl fetch failed", url=url, error=str(exc))
        return ""

    async def _enrich_with_full_content(
        self, evidence: List[str], state: "ResearchState"
    ) -> List[str]:
        """Fetch full page content for top URLs and append as new evidence blocks."""
        urls = self._extract_urls_from_search(evidence)
        urls_to_fetch = urls[:_MAX_PAGES_TO_FETCH]
        if not urls_to_fetch:
            return evidence

        fetch_tasks = [self._fetch_page_content(u) for u in urls_to_fetch]
        results = await asyncio.gather(*fetch_tasks, return_exceptions=True)

        enriched = list(evidence)  # copy
        fetched_count = 0
        for url, content in zip(urls_to_fetch, results):
            if isinstance(content, Exception) or not content:
                continue
            if len(content) < _MIN_USEFUL_CONTENT_CHARS:
                continue
            enriched.append(f"[Full page: {url}]\n{content[:_MAX_ENRICHED_CONTENT_CHARS]}")
            state.add_evidence(EvidencePiece(
                query=url, source_type="web_full", content=content[:_MAX_ENRICHED_CONTENT_CHARS],
                confidence=0.7,
            ))
            fetched_count += 1

        if fetched_count:
            self._research_context.append(
                f"Загружено полное содержимое {fetched_count} страниц для обогащения доказательств."
            )
        logger.info("Page enrichment complete", fetched=fetched_count, total_urls=len(urls_to_fetch))
        return enriched

    @staticmethod
    def _apply_token_budget(evidence: List[str]) -> str:
        """Join evidence blocks within _EVIDENCE_TOKEN_BUDGET_CHARS.

        Prevents context overflow when _synthesize sends all evidence to the LLM.
        Blocks are added in order (highest-priority first) until the budget is used up.
        """
        budget = _EVIDENCE_TOKEN_BUDGET_CHARS
        separator = "\n\n---\n\n"
        parts: List[str] = []
        used = 0
        for block in evidence:
            block_len = len(block) + len(separator)
            if used + block_len > budget:
                parts.append(_TOKEN_BUDGET_TRUNCATION_NOTICE)
                break
            parts.append(block)
            used += block_len
        return separator.join(parts)

    async def _synthesize(
        self, question: str, evidence: List[str], verification: str
    ) -> str:
        """Synthesize evidence into a report with [N] source citations."""
        evidence_text = self._apply_token_budget(evidence)
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
