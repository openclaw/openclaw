"""Page enrichment helpers for Deep Research Pipeline.

Extracted from deep_research.py — URL extraction, page fetch, Firecrawl, token budget.
"""

from __future__ import annotations

import asyncio
import re
from typing import TYPE_CHECKING, List

import structlog

if TYPE_CHECKING:
    from src.research._core import EvidencePiece, ResearchState

logger = structlog.get_logger("DeepResearch")

# v3: Page enrichment constants
_FIRECRAWL_API_URL = "https://api.firecrawl.dev/v1/scrape"
_MAX_PAGES_TO_FETCH = 3
_MIN_USEFUL_CONTENT_CHARS = 200
_MAX_ENRICHED_CONTENT_CHARS = 8_000
_WEB_FETCH_REQUEST_CHARS = _MAX_ENRICHED_CONTENT_CHARS * 2
_TOKEN_BUDGET_TRUNCATION_NOTICE = "[...TRUNCATED FOR TOKEN BUDGET...]"
_EVIDENCE_TOKEN_BUDGET_CHARS = 96_000


def extract_urls_from_search(evidence_pieces: List[str]) -> List[str]:
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


async def fetch_page_content(
    mcp_client, url: str, firecrawl_api_key: str | None
) -> str:
    """Fetch full page content via web_fetch MCP tool or Firecrawl fallback."""
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
    """Fetch full page content for top URLs and append as new evidence blocks."""
    from src.research._core import EvidencePiece  # local to avoid circular

    urls = extract_urls_from_search(evidence)
    urls_to_fetch = urls[:_MAX_PAGES_TO_FETCH]
    if not urls_to_fetch:
        return evidence

    fetch_tasks = [fetch_page_content(mcp_client, u, firecrawl_api_key) for u in urls_to_fetch]
    results = await asyncio.gather(*fetch_tasks, return_exceptions=True)

    enriched = list(evidence)
    fetched_count = 0
    for url, content in zip(urls_to_fetch, results):
        if isinstance(content, Exception) or not content:
            continue
        if len(content) < _MIN_USEFUL_CONTENT_CHARS:
            continue
        enriched.append(f"[Full page: {url}]\n{content[:_MAX_ENRICHED_CONTENT_CHARS]}")
        state.add_evidence(EvidencePiece(
            query=url,
            source_type="web_full",
            content=content[:_MAX_ENRICHED_CONTENT_CHARS],
            confidence=0.7,
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
