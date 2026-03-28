"""Search helpers for Deep Research Pipeline.

Extracted from deep_research.py — web, memory, academic and multi-source search.
"""

import asyncio
from typing import Any, Dict, List

import structlog

from src.utils.async_utils import taskgroup_gather

logger = structlog.get_logger("DeepResearch")


async def search_sub_query(
    mcp_client: Any,
    query: str,
    *,
    academic_enabled: bool = True,
    parsers_enabled: bool = True,
) -> Dict[str, str]:
    """Search web + memory + academic + multi-source for a single sub-query."""
    tasks = [
        web_search(mcp_client, query),
        memory_search(mcp_client, query),
    ]
    if academic_enabled:
        tasks.append(academic_search(query))
    if parsers_enabled:
        tasks.append(multi_source_search(query))

    results = await taskgroup_gather(*tasks, return_exceptions=True)
    web = results[0] if not isinstance(results[0], Exception) else ""
    mem = results[1] if not isinstance(results[1], Exception) else ""
    academic = ""
    multi_source = ""
    idx = 2
    if academic_enabled:
        if idx < len(results) and not isinstance(results[idx], Exception):
            academic = results[idx]
        idx += 1
    if parsers_enabled:
        if idx < len(results) and not isinstance(results[idx], Exception):
            multi_source = results[idx]
    return {
        "query": query, "web": web, "memory": mem,
        "academic": academic, "multi_source": multi_source,
    }


async def web_search(mcp_client: Any, query: str) -> str:
    """Execute web search via MCP tool."""
    try:
        result = await mcp_client.call_tool(
            "web_search", {"query": query, "max_results": 5, "region": "wt-wt"}
        )
        return result if result else "No results found."
    except Exception as e:
        logger.warning("Web search failed", query=query, error=str(e))
        return f"Search error: {e}"


async def memory_search(mcp_client: Any, query: str) -> str:
    """Search local memory bank."""
    try:
        result = await mcp_client.call_tool(
            "search_memory", {"query": query, "tier": "all", "top_k": 3}
        )
        return result if result else "No memory results."
    except Exception as e:
        return ""


async def academic_search(query: str) -> str:
    """Search academic papers via the research_paper_parser APIs."""
    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _academic_search_sync, query)
        return result
    except Exception as e:
        logger.debug("Academic search skipped", error=str(e))
        return ""


def _academic_search_sync(query: str) -> str:
    """Synchronous academic paper search — wraps research_paper_parser."""
    try:
        import sys
        import os
        scripts_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "scripts")
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


async def multi_source_search(query: str) -> str:
    """Search all sources via UniversalParser concurrently.

    Returns formatted text lines for pipeline context injection.
    """
    try:
        from src.parsers.universal import UniversalParser
        parser = UniversalParser()
        by_source = await parser.search(
            query, limit_per_source=5, sources=["habr", "github", "reddit"]
        )
    except Exception as e:
        logger.debug("UniversalParser unavailable", error=str(e))
        return ""

    lines: List[str] = []
    for source_name, items in by_source.items():
        for item in items[:3]:
            tag = source_name.capitalize()
            detail = item.summary[:200] if item.summary else item.title
            score_str = f" (↑{int(item.score)})" if item.score else ""
            lines.append(f"[{tag}] {item.title}{score_str}: {detail}")

    return "\n".join(lines) if lines else ""
