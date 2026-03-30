"""
Enhanced Research Pipeline — heuristic quality & validation layer.

Works alongside deep_research.py (main research orchestrator):
- deep_research.py: LLM-driven pipeline (decompose → search → verify → synthesize)
- research_enhanced.py: CPU-only heuristic analysis (evidence scoring, cross-validation, metrics)

Use EvidenceQualityScorer and ResearchQualityMetrics as post-processing
for DeepResearchPipeline output — no extra LLM calls required.

Classes:
- MultiPerspectiveResearcher: advocate/critic/synthesizer pipeline (LLM)
- EvidenceQualityScorer: heuristic evidence scoring (no LLM)
- CrossValidator: claim extraction + cross-source validation
- ResearchQualityMetrics: coverage, depth, consistency metrics (no LLM)
"""

import asyncio
import json
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import aiohttp
import structlog

from src.llm_gateway import route_llm

logger = structlog.get_logger("ResearchEnhanced")


# ────────────────────────────────────────────────────────────────────
# Dataclasses
# ────────────────────────────────────────────────────────────────────

@dataclass
class MultiPerspectiveResult:
    """Result of multi-perspective research."""

    advocate_view: str
    critic_view: str
    synthesis: str
    confidence: float
    perspectives_used: int


@dataclass
class EvidenceScore:
    """Quality score breakdown for a single piece of evidence."""

    reliability: float
    recency: float
    specificity: float
    cross_refs: float
    total_score: float


@dataclass
class ClaimValidation:
    """Validation result for a single claim."""

    claim: str
    confidence: float
    supporting_sources: List[str]
    contradicting_sources: List[str]
    status: str  # "confirmed", "refuted", "uncertain"


@dataclass
class ValidationResult:
    """Aggregated validation results."""

    claims: List[ClaimValidation]
    overall_confidence: float
    validated_count: int
    refuted_count: int


@dataclass
class QualityMetrics:
    """Research report quality metrics."""

    coverage: float
    depth: float
    source_diversity: float
    citation_density: float
    consistency: float
    novelty: float
    total_score: float


# ────────────────────────────────────────────────────────────────────
# LLM helper (shared by classes that need inference)
# ────────────────────────────────────────────────────────────────────

async def _llm_call(
    model: str,
    system: str,
    user: str,
    *,
    max_tokens: int = 2048,
    temperature: float = 0.2,
    retries: int = 2,
    vllm_url: str = "",
) -> str:
    """Shared LLM inference via cloud gateway with retry-backoff.

    The vllm_url parameter is accepted for backwards compatibility but unused.
    """
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]

    for attempt in range(retries + 1):
        try:
            result = await route_llm(
                "",
                messages=messages,
                model=model,
                task_type="research",
                max_tokens=max_tokens,
                temperature=temperature,
            )
            return result.strip() if result else ""
        except Exception as exc:
            if attempt < retries:
                logger.warning("LLM retry on error", error=str(exc), attempt=attempt)
                await asyncio.sleep(2**attempt)
                continue
            logger.error("LLM call failed after retries", error=str(exc))
            return ""

    return ""


# ────────────────────────────────────────────────────────────────────
# 1. MultiPerspectiveResearcher
# ────────────────────────────────────────────────────────────────────

class MultiPerspectiveResearcher:
    """Research from multiple perspectives to avoid confirmation bias.

    From EvoScientist (2026): Uses different "personas" to analyze the
    same question:
    - Advocate: finds supporting evidence
    - Critic: finds counterarguments and weaknesses
    - Synthesizer: merges perspectives into balanced view
    """

    def __init__(self, model: str, vllm_url: str = "") -> None:
        self.model = model

    async def research(
        self,
        question: str,
        initial_evidence: Optional[List[str]] = None,
    ) -> MultiPerspectiveResult:
        """Research *question* from multiple perspectives."""
        evidence = initial_evidence or []
        evidence_block = "\n---\n".join(evidence) if evidence else "Нет предварительных данных."

        # Run sequentially (single-GPU constraint)
        advocate_view = await self._advocate_perspective(question, evidence_block)
        critic_view = await self._critic_perspective(question, evidence_block)
        synthesis = await self._synthesize(question, advocate_view, critic_view)
        confidence = self._estimate_confidence(advocate_view, critic_view, synthesis)

        logger.info(
            "Multi-perspective research complete",
            question=question[:80],
            confidence=confidence,
        )

        return MultiPerspectiveResult(
            advocate_view=advocate_view,
            critic_view=critic_view,
            synthesis=synthesis,
            confidence=confidence,
            perspectives_used=3,
        )

    # -- perspectives -----------------------------------------------------

    async def _advocate_perspective(self, question: str, evidence: str) -> str:
        """Find and emphasize supporting evidence."""
        return await _llm_call(
            self.model,
            system=(
                "Ты — адвокат гипотезы. Твоя задача — найти и подчеркнуть все "
                "аргументы, факты и свидетельства, ПОДДЕРЖИВАЮЩИЕ тезис или "
                "подтверждающие правильность вопроса пользователя.\n\n"
                "Правила:\n"
                "- Ссылайся на конкретные данные из предоставленных источников\n"
                "- Формулируй аргументы чётко и структурированно\n"
                "- Если данных мало — укажи, но всё равно представь "
                "наилучшую защиту позиции"
            ),
            user=(
                f"ВОПРОС: {question}\n\n"
                f"ИМЕЮЩИЕСЯ ДАННЫЕ:\n{evidence}"
            ),
            max_tokens=1536,
            temperature=0.3,
        )

    async def _critic_perspective(self, question: str, evidence: str) -> str:
        """Find weaknesses, counterarguments, and gaps."""
        return await _llm_call(
            self.model,
            system=(
                "Ты — критик-скептик. Твоя задача — найти ВСЕ слабости, "
                "контраргументы, пробелы и потенциальные ошибки в данных.\n\n"
                "Правила:\n"
                "- Укажи на отсутствующие данные и необоснованные допущения\n"
                "- Найди контрпримеры и противоречия\n"
                "- Оцени надёжность источников\n"
                "- Если аргументы выглядят убедительно — ищи скрытые слабости"
            ),
            user=(
                f"ВОПРОС: {question}\n\n"
                f"ИМЕЮЩИЕСЯ ДАННЫЕ:\n{evidence}"
            ),
            max_tokens=1536,
            temperature=0.3,
        )

    async def _synthesize(
        self, question: str, advocate_view: str, critic_view: str,
    ) -> str:
        """Synthesize balanced conclusion from both perspectives."""
        return await _llm_call(
            self.model,
            system=(
                "Ты — нейтральный синтезатор. Тебе даны два анализа одного "
                "и того же вопроса: от адвоката (поддерживающий) и от критика "
                "(скептический). Твоя задача — создать СБАЛАНСИРОВАННЫЙ вывод.\n\n"
                "Правила:\n"
                "- Интегрируй сильные аргументы обеих сторон\n"
                "- Явно отметь, где стороны согласны и где расходятся\n"
                "- Укажи уровень достоверности каждого вывода "
                "(высокий / средний / низкий)\n"
                "- Дай финальную взвешенную оценку\n"
                "- Ответ на РУССКОМ ЯЗЫКЕ"
            ),
            user=(
                f"ВОПРОС: {question}\n\n"
                f"ПОЗИЦИЯ АДВОКАТА:\n{advocate_view}\n\n"
                f"ПОЗИЦИЯ КРИТИКА:\n{critic_view}"
            ),
            max_tokens=2048,
            temperature=0.2,
        )

    # -- helpers ----------------------------------------------------------

    @staticmethod
    def _estimate_confidence(
        advocate_view: str, critic_view: str, synthesis: str,
    ) -> float:
        """Heuristic confidence based on perspective balance."""
        if not synthesis:
            return 0.0

        adv_len = len(advocate_view)
        crit_len = len(critic_view)
        if adv_len == 0 and crit_len == 0:
            return 0.0

        # Balance ratio: closer to 1.0 means perspectives are equally rich
        balance = min(adv_len, crit_len) / max(adv_len, crit_len) if max(adv_len, crit_len) > 0 else 0.0

        # Longer synthesis → more thorough analysis
        synth_factor = min(len(synthesis) / 1000.0, 1.0)

        # Confidence markers in synthesis text
        high_markers = ["высокий", "подтверждено", "уверенно", "однозначно"]
        low_markers = ["низкий", "неясно", "недостаточно", "противоречи"]
        high_count = sum(1 for m in high_markers if m in synthesis.lower())
        low_count = sum(1 for m in low_markers if m in synthesis.lower())
        marker_adj = (high_count - low_count) * 0.05

        confidence = 0.4 * balance + 0.4 * synth_factor + 0.2 + marker_adj
        return round(max(0.0, min(1.0, confidence)), 2)


# ────────────────────────────────────────────────────────────────────
# 2. EvidenceQualityScorer
# ────────────────────────────────────────────────────────────────────

class EvidenceQualityScorer:
    """Score evidence quality without LLM calls.

    Heuristic scoring based on:
    - Source reliability (known domains score higher)
    - Recency (newer = better for tech topics)
    - Specificity (detailed > vague)
    - Cross-reference count (mentioned in multiple sources)
    - Citation presence (has references)
    """

    TRUSTED_DOMAINS: Dict[str, float] = {
        "arxiv.org": 0.95,
        "github.com": 0.85,
        "stackoverflow.com": 0.80,
        "docs.python.org": 0.90,
        "huggingface.co": 0.85,
        "semanticscholar.org": 0.90,
        "wikipedia.org": 0.70,
        "developer.mozilla.org": 0.90,
        "pytorch.org": 0.85,
        "tensorflow.org": 0.85,
        "openai.com": 0.80,
        "deepmind.com": 0.85,
        "nature.com": 0.95,
        "science.org": 0.95,
        "ieee.org": 0.90,
        "acm.org": 0.90,
        "microsoft.com": 0.80,
        "google.com": 0.75,
        "reddit.com": 0.45,
        "medium.com": 0.50,
        "towardsdatascience.com": 0.55,
        "blog.": 0.50,
    }

    _DEFAULT_RELIABILITY = 0.5

    def score(
        self,
        evidence: str,
        source_url: str = "",
        published_date: str = "",
    ) -> EvidenceScore:
        """Score a single piece of evidence."""
        reliability = self._score_reliability(source_url)
        recency = self._score_recency(published_date)
        specificity = self._score_specificity(evidence)
        cross_refs = self._score_citations(evidence)

        total = (
            0.35 * reliability
            + 0.20 * recency
            + 0.25 * specificity
            + 0.20 * cross_refs
        )

        return EvidenceScore(
            reliability=round(reliability, 3),
            recency=round(recency, 3),
            specificity=round(specificity, 3),
            cross_refs=round(cross_refs, 3),
            total_score=round(total, 3),
        )

    def rank_evidence(self, evidence_list: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Rank evidence by quality score.

        Each dict should have at least ``"text"``; optional
        ``"source_url"`` and ``"published_date"``.
        """
        scored: List[Dict[str, Any]] = []
        for item in evidence_list:
            es = self.score(
                evidence=item.get("text", ""),
                source_url=item.get("source_url", ""),
                published_date=item.get("published_date", ""),
            )
            scored.append({**item, "quality_score": es})

        scored.sort(key=lambda x: x["quality_score"].total_score, reverse=True)
        return scored

    # -- individual scorers -----------------------------------------------

    def _score_reliability(self, url: str) -> float:
        if not url:
            return self._DEFAULT_RELIABILITY
        try:
            host = urlparse(url).hostname or ""
        except Exception:
            return self._DEFAULT_RELIABILITY

        host_lower = host.lower().lstrip("www.")

        for domain, score in self.TRUSTED_DOMAINS.items():
            if domain in host_lower:
                return score

        # Slight bump for HTTPS
        return self._DEFAULT_RELIABILITY + (0.05 if url.startswith("https") else 0.0)

    @staticmethod
    def _score_recency(published_date: str) -> float:
        if not published_date:
            return 0.5  # unknown → neutral

        try:
            raw = published_date.replace("Z", "+00:00")
            dt = datetime.fromisoformat(raw)
            # Ensure timezone-aware for comparison
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            return 0.5

        now = datetime.now(timezone.utc)
        age_days = (now - dt).days
        if age_days < 0:
            age_days = 0

        # Exponential decay: half-life ~365 days
        return round(max(0.1, math.exp(-0.0019 * age_days)), 3)

    @staticmethod
    def _score_specificity(text: str) -> float:
        if not text:
            return 0.0

        score = 0.0
        length = len(text)

        # Longer text tends to be more specific (up to a point)
        score += min(length / 2000.0, 0.3)

        # Numeric data suggests specificity
        numbers = len(re.findall(r"\d+\.?\d*", text))
        score += min(numbers / 20.0, 0.25)

        # Code blocks / technical content
        if "```" in text or "def " in text or "class " in text or "import " in text:
            score += 0.15

        # URLs in evidence (inline citations)
        urls = len(re.findall(r"https?://", text))
        score += min(urls / 5.0, 0.15)

        # Named entities (capitalised multi-word phrases) suggest detail
        named_entities = len(re.findall(r"[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+", text))
        score += min(named_entities / 10.0, 0.15)

        return round(min(score, 1.0), 3)

    @staticmethod
    def _score_citations(text: str) -> float:
        if not text:
            return 0.0

        score = 0.0

        # Bracketed references [1], [2], etc.
        bracket_refs = len(re.findall(r"\[\d+\]", text))
        score += min(bracket_refs / 5.0, 0.4)

        # URLs
        urls = len(re.findall(r"https?://\S+", text))
        score += min(urls / 5.0, 0.3)

        # DOI references
        dois = len(re.findall(r"10\.\d{4,}/\S+", text))
        score += min(dois / 3.0, 0.3)

        return round(min(score, 1.0), 3)


# ────────────────────────────────────────────────────────────────────
# 3. CrossValidator
# ────────────────────────────────────────────────────────────────────

class CrossValidator:
    """Cross-validate facts across multiple sources.

    For each key claim in a report:
    1. Extract the claim
    2. Search for corroborating evidence
    3. Search for contradicting evidence
    4. Assign confidence score
    """

    _MAX_CLAIMS = 8

    def __init__(
        self,
        model: str,
        mcp_client: Any = None,
        vllm_url: str = "",
    ) -> None:
        self.model = model
        self.mcp_client = mcp_client

    async def validate_claims(
        self, report: str, sources: List[str],
    ) -> ValidationResult:
        """Extract and validate claims from *report*."""
        claims_text = await self._extract_claims(report)
        claims = [
            c.strip() for c in claims_text.split("\n") if c.strip()
        ][: self._MAX_CLAIMS]

        if not claims:
            return ValidationResult(
                claims=[], overall_confidence=0.0,
                validated_count=0, refuted_count=0,
            )

        # Validate sequentially (avoids prompt flooding)
        validations: List[ClaimValidation] = []
        for claim in claims:
            cv = await self._validate_single_claim(claim, sources)
            validations.append(cv)

        validated = sum(1 for v in validations if v.status == "confirmed")
        refuted = sum(1 for v in validations if v.status == "refuted")
        total = len(validations)
        overall = sum(v.confidence for v in validations) / total if total else 0.0

        logger.info(
            "Cross-validation complete",
            total_claims=total, validated=validated, refuted=refuted,
        )

        return ValidationResult(
            claims=validations,
            overall_confidence=round(overall, 2),
            validated_count=validated,
            refuted_count=refuted,
        )

    async def _extract_claims(self, report: str) -> str:
        """Extract verifiable claims from text."""
        return await _llm_call(
            self.model,
            system=(
                "Извлеки из текста ключевые ФАКТИЧЕСКИЕ утверждения, "
                "которые можно проверить. Максимум 8 утверждений.\n"
                "Каждое утверждение — на отдельной строке.\n"
                "Без нумерации, без пояснений, только утверждения."
            ),
            user=report,
            max_tokens=512,
        )

    async def _validate_single_claim(
        self, claim: str, existing_sources: List[str],
    ) -> ClaimValidation:
        """Validate a single claim against sources and optional web search."""
        # If MCP client is available, try a quick web search for the claim
        web_evidence = ""
        if self.mcp_client:
            try:
                web_evidence = await self.mcp_client.call_tool(
                    "web_search", {"query": claim, "max_results": 3, "region": "wt-wt"},
                )
            except Exception as exc:
                logger.debug("Web search for claim validation failed", error=str(exc))

        sources_block = "\n".join(existing_sources[:10]) if existing_sources else "Нет источников."

        raw = await _llm_call(
            self.model,
            system=(
                "Ты — верификатор утверждений. Оцени ОДНО утверждение.\n"
                "Ответь строго в JSON:\n"
                '{"confidence": 0.0-1.0, '
                '"supporting": ["источник1", ...], '
                '"contradicting": ["источник1", ...], '
                '"status": "confirmed" | "refuted" | "uncertain"}'
            ),
            user=(
                f"УТВЕРЖДЕНИЕ: {claim}\n\n"
                f"ИЗВЕСТНЫЕ ИСТОЧНИКИ:\n{sources_block}\n\n"
                f"ДОПОЛНИТЕЛЬНЫЕ ДАННЫЕ ИЗ ПОИСКА:\n{web_evidence or 'Нет данных.'}"
            ),
            max_tokens=512,
            temperature=0.1,
        )

        return self._parse_claim_validation(claim, raw)

    @staticmethod
    def _parse_claim_validation(claim: str, raw: str) -> ClaimValidation:
        """Parse LLM JSON response into ClaimValidation."""
        try:
            start = raw.find("{")
            end = raw.rfind("}") + 1
            if start >= 0 and end > start:
                data = json.loads(raw[start:end])
                return ClaimValidation(
                    claim=claim,
                    confidence=float(data.get("confidence", 0.5)),
                    supporting_sources=data.get("supporting", []),
                    contradicting_sources=data.get("contradicting", []),
                    status=data.get("status", "uncertain"),
                )
        except (json.JSONDecodeError, ValueError, TypeError):
            logger.debug("Claim validation JSON parse failed", claim=claim[:60])

        return ClaimValidation(
            claim=claim,
            confidence=0.5,
            supporting_sources=[],
            contradicting_sources=[],
            status="uncertain",
        )


# ────────────────────────────────────────────────────────────────────
# 4. ResearchQualityMetrics
# ────────────────────────────────────────────────────────────────────

class ResearchQualityMetrics:
    """Compute quality metrics for research reports.

    All heuristic — no LLM calls — so this runs instantly.

    Metrics:
    - coverage: how many aspects of the question are addressed
    - depth: average detail level per aspect
    - source_diversity: variety of unique source types
    - citation_density: references per paragraph
    - consistency: no internal contradictions (heuristic)
    - novelty: information not already present in the original query
    """

    def compute(
        self,
        question: str,
        report: str,
        sources: List[str],
    ) -> QualityMetrics:
        """Compute quality metrics for the given *report*."""
        coverage = self._coverage(question, report)
        depth = self._depth(report)
        diversity = self._source_diversity(sources)
        citations = self._citation_density(report)
        consistency = self._consistency(report)
        novelty = self._novelty(question, report)

        total = (
            0.20 * coverage
            + 0.20 * depth
            + 0.15 * diversity
            + 0.15 * citations
            + 0.15 * consistency
            + 0.15 * novelty
        )

        return QualityMetrics(
            coverage=round(coverage, 3),
            depth=round(depth, 3),
            source_diversity=round(diversity, 3),
            citation_density=round(citations, 3),
            consistency=round(consistency, 3),
            novelty=round(novelty, 3),
            total_score=round(total, 3),
        )

    # -- individual metrics -----------------------------------------------

    @staticmethod
    def _coverage(question: str, report: str) -> float:
        """Fraction of question keywords found in the report."""
        q_words = set(
            w.lower()
            for w in re.findall(r"[a-zA-Zа-яА-ЯёЁ]{3,}", question)
        )
        if not q_words:
            return 1.0

        report_lower = report.lower()
        found = sum(1 for w in q_words if w in report_lower)
        return found / len(q_words)

    @staticmethod
    def _depth(report: str) -> float:
        """Heuristic depth: paragraph count, avg paragraph length, technical terms."""
        paragraphs = [p.strip() for p in report.split("\n\n") if p.strip()]
        if not paragraphs:
            return 0.0

        avg_len = sum(len(p) for p in paragraphs) / len(paragraphs)
        # Scale: 500-char average paragraph → 1.0
        length_score = min(avg_len / 500.0, 1.0)

        # Reward having multiple paragraphs (structure)
        structure_score = min(len(paragraphs) / 6.0, 1.0)

        return 0.6 * length_score + 0.4 * structure_score

    @staticmethod
    def _source_diversity(sources: List[str]) -> float:
        """Variety of unique sources."""
        if not sources:
            return 0.0

        unique = set()
        for s in sources:
            try:
                host = urlparse(s).hostname
                if host:
                    unique.add(host.lower().lstrip("www."))
                else:
                    # Not a URL — treat the whole string as a source key
                    unique.add(s.strip().lower()[:60])
            except Exception:
                unique.add(s.strip().lower()[:60])

        # 5+ unique sources → 1.0
        return min(len(unique) / 5.0, 1.0)

    @staticmethod
    def _citation_density(report: str) -> float:
        """References per paragraph."""
        paragraphs = [p for p in report.split("\n\n") if p.strip()]
        if not paragraphs:
            return 0.0

        refs = len(re.findall(r"\[\d+\]", report))
        density = refs / len(paragraphs)

        # 2+ refs per paragraph → 1.0
        return min(density / 2.0, 1.0)

    @staticmethod
    def _consistency(report: str) -> float:
        """Heuristic: flag contradiction markers. Higher = more consistent."""
        contradiction_markers = [
            "противореч", "однако", "но при этом", "тем не менее",
            "в то же время", "несмотря на", "вопреки", "⚠️",
            "contradiction", "however", "on the other hand",
        ]
        report_lower = report.lower()
        hits = sum(1 for m in contradiction_markers if m in report_lower)

        # 0 hits → 1.0; 5+ hits → 0.5 (contradictions aren't necessarily bad
        # if acknowledged, so floor at 0.5)
        return max(0.5, 1.0 - hits * 0.1)

    @staticmethod
    def _novelty(question: str, report: str) -> float:
        """How much info the report adds beyond the question itself."""
        q_words = set(
            w.lower()
            for w in re.findall(r"[a-zA-Zа-яА-ЯёЁ]{3,}", question)
        )
        r_words = set(
            w.lower()
            for w in re.findall(r"[a-zA-Zа-яА-ЯёЁ]{3,}", report)
        )

        if not r_words:
            return 0.0

        novel = r_words - q_words
        return min(len(novel) / max(len(r_words), 1), 1.0)
