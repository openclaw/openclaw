"""Page enrichment helpers for Deep Research Pipeline.

Extracted from deep_research.py — URL extraction, page fetch, Firecrawl, token budget.

v4 improvements (2026-03-30):
  - Smart URL prioritization: rank URLs by domain authority heuristics
  - Content quality scoring: skip low-quality pages, prefer long-form articles
  - Parallel batch fetching with semaphore to avoid thundering herd
  - Dedup fetched URLs across iterations
"""

from __future__ import annotations

import asyncio
import re
from typing import TYPE_CHECKING, List
from urllib.parse import urlparse

import structlog

from src.utils.async_utils import taskgroup_gather

if TYPE_CHECKING:
    from src.research._core import EvidencePiece, ResearchState

logger = structlog.get_logger("DeepResearch")

# v3: Page enrichment constants
_FIRECRAWL_API_URL = "https://api.firecrawl.dev/v1/scrape"
_MAX_PAGES_TO_FETCH = 5  # v4: increased from 3 for deeper enrichment
_MIN_USEFUL_CONTENT_CHARS = 200
_MAX_ENRICHED_CONTENT_CHARS = 8_000
_WEB_FETCH_REQUEST_CHARS = _MAX_ENRICHED_CONTENT_CHARS * 2
_TOKEN_BUDGET_TRUNCATION_NOTICE = "[...TRUNCATED FOR TOKEN BUDGET...]"
_EVIDENCE_TOKEN_BUDGET_CHARS = 96_000

# v4: Fetch concurrency limiter — avoid thundering herd on Jina/Firecrawl
_FETCH_SEMAPHORE_LIMIT = 3

# v4: High-value domains ranked by general authority for research
_DOMAIN_PRIORITY: dict[str, int] = {
    "arxiv.org": 10,
    "github.com": 9,
    "stackoverflow.com": 9,
    "docs.python.org": 8,
    "developer.mozilla.org": 8,
    "en.wikipedia.org": 8,
    "ru.wikipedia.org": 8,
    "habr.com": 7,
    "medium.com": 6,
    "news.ycombinator.com": 6,
    "reddit.com": 5,
    "dev.to": 5,
}


def _url_priority(url: str) -> int:
    """Return a priority score for URL (higher = better). Used for sorting."""
    try:
        host = urlparse(url).hostname or ""
        host = host.lower().lstrip("www.")
        for domain, score in _DOMAIN_PRIORITY.items():
            if host == domain or host.endswith("." + domain):
                return score
        return 3  # default for unknown domains
    except Exception:
        return 1


def extract_urls_from_search(evidence_pieces: List[str]) -> List[str]:
    """Extract unique http(s) URLs from raw evidence text blocks, sorted by domain priority."""
    url_pattern = re.compile(r'https?://[^\s\'"<>]+')
    seen: set = set()
    urls: List[str] = []
    for piece in evidence_pieces:
        for match in url_pattern.finditer(piece):
            url = match.group(0).rstrip(".,;)")
            if url not in seen:
                seen.add(url)
                urls.append(url)
    # v4: sort by domain priority (highest first)
    urls.sort(key=_url_priority, reverse=True)
    return urls


def _content_quality_score(content: str) -> float:
    """Heuristic quality score for fetched page content (0.0 - 1.0).

    Prefers: longer text, paragraphs, headers, code blocks.
    Penalizes: cookie banners, login walls, error pages.
    """
    if not content:
        return 0.0
    length = len(content)
    score = min(length / 4000.0, 1.0) * 0.4  # length component (max 0.4)

    # Structural indicators
    paragraphs = content.count("\n\n")
    score += min(paragraphs / 10.0, 1.0) * 0.2  # paragraph richness

    headers = len(re.findall(r"^#{1,3}\s", content, re.MULTILINE))
    score += min(headers / 3.0, 1.0) * 0.15  # markdown headers

    code_blocks = content.count("```")
    score += min(code_blocks / 4.0, 1.0) * 0.15  # code content

    # Penalty: junk indicators
    junk_patterns = ["cookie", "sign in", "log in", "subscribe", "403", "404", "access denied"]
    junk_hits = sum(1 for p in junk_patterns if p.lower() in content[:500].lower())
    score -= junk_hits * 0.1

    return max(0.0, min(1.0, score))


async def fetch_page_content(
    mcp_client, url: str, firecrawl_api_key: str | None,
    semaphore: asyncio.Semaphore | None = None,
) -> str:
    """Fetch full page content via web_fetch MCP tool or Firecrawl fallback.

    v4: respects semaphore for concurrent rate limiting.
    """
    async def _do_fetch() -> str:
        try:
            result = await mcp_client.call_tool(
                "web_fetch",
                {"url": url, "max_chars": _WEB_FETCH_REQUEST_CHARS},
            )
            if result and len(result) >= _MIN_USEFUL_CONTENT_CHARS:
                return result[:_MAX_ENRICHED_CONTENT_CHARS]
        except Exception:
            pass

        if firecrawl_api_key:
            firecrawl_content = await fetch_via_firecrawl(url, firecrawl_api_key)
            if firecrawl_content and len(firecrawl_content) >= _MIN_USEFUL_CONTENT_CHARS:
                return firecrawl_content[:_MAX_ENRICHED_CONTENT_CHARS]

        return ""

    if semaphore:
        async with semaphore:
            return await _do_fetch()
    return await _do_fetch()


async def fetch_via_firecrawl(url: str, api_key: str) -> str:
    """Use Firecrawl API to extract clean Markdown from JS-heavy pages."""
    try:
        import aiohttp as _aiohttp

        payload = {"url": url, "formats": ["markdown"], "onlyMainContent": True}
        headers = {
            "Authorization": f"Bearer {api_key}",
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


async def enrich_with_full_content(
    mcp_client,
    evidence: List[str],
    state: ResearchState,
    research_context: List[str],
    firecrawl_api_key: str | None,
) -> List[str]:
    """Fetch full page content for top URLs and append as new evidence blocks.

    v4: uses semaphore for concurrency, URL prioritization, content quality filter.
    """
    from src.research._core import EvidencePiece  # local to avoid circular

    urls = extract_urls_from_search(evidence)

    # v4: skip already-fetched URLs from previous iterations
    already_fetched = {e.query for e in state.evidence if e.source_type == "web_full"}
    urls = [u for u in urls if u not in already_fetched]

    urls_to_fetch = urls[:_MAX_PAGES_TO_FETCH]
    if not urls_to_fetch:
        return evidence

    semaphore = asyncio.Semaphore(_FETCH_SEMAPHORE_LIMIT)
    fetch_tasks = [
        fetch_page_content(mcp_client, u, firecrawl_api_key, semaphore)
        for u in urls_to_fetch
    ]
    results = await taskgroup_gather(*fetch_tasks, return_exceptions=True)

    enriched = list(evidence)
    fetched_count = 0
    for url, content in zip(urls_to_fetch, results):
        if isinstance(content, Exception) or not content:
            continue
        if len(content) < _MIN_USEFUL_CONTENT_CHARS:
            continue

        # v4: content quality gate
        quality = _content_quality_score(content)
        if quality < 0.15:
            logger.debug("Skipping low-quality page", url=url, quality=f"{quality:.2f}")
            continue

        enriched.append(f"[Full page: {url}] (quality: {quality:.2f})\n{content[:_MAX_ENRICHED_CONTENT_CHARS]}")
        state.add_evidence(EvidencePiece(
            query=url,
            source_type="web_full",
            content=content[:_MAX_ENRICHED_CONTENT_CHARS],
            confidence=min(0.5 + quality * 0.5, 0.95),  # v4: quality-based confidence
        ))
        fetched_count += 1

    if fetched_count:
        research_context.append(
            f"Загружено полное содержимое {fetched_count} страниц для обогащения доказательств."
        )
    logger.info("Page enrichment complete", fetched=fetched_count, total_urls=len(urls_to_fetch))
    return enriched


def apply_token_budget(evidence: List[str]) -> str:
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
