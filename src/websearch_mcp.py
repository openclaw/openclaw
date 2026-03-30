"""
MCP Server: Web Search via DuckDuckGo (free, no API key required).
Exposes `web_search`, `web_news_search`, `web_search_answers`, and `web_fetch`
tools for the OpenClaw pipeline.
Uses the `duckduckgo_search` library.

v4 improvements (2026-03-30):
  - Retry logic with exponential backoff for DuckDuckGo rate limits
  - Time-filtered search (day/week/month/year)
  - DuckDuckGo Instant Answers tool for quick factual lookups
  - LRU result cache (configurable TTL) to avoid redundant searches
  - Deduplication of search results by URL
  - Enhanced error messages with retry context

web_fetch strategy (in order):
  1. Jina Reader (r.jina.ai/<url>) — zero-config, returns clean Markdown, no JS issues.
  2. Plain HTTP via urllib — fallback for Jina failures.
Both routes strip excess whitespace before returning to save LLM tokens.
"""

import asyncio
import hashlib
import json
import re
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

try:
    from duckduckgo_search import DDGS
except ImportError:
    print("[WebSearch MCP] ERROR: duckduckgo_search not installed. Run: pip install duckduckgo_search", file=sys.stderr)
    sys.exit(1)

server = Server("websearch-server")

# Maximum characters returned by web_fetch (≈ 32 k chars ≈ 8 k tokens)
_WEB_FETCH_MAX_CHARS = 32_000

# Jina Reader base URL — prepend to any target URL for clean Markdown output
_JINA_BASE = "https://r.jina.ai/"

# ---------------------------------------------------------------------------
# Retry configuration
# ---------------------------------------------------------------------------
_MAX_RETRIES = 3
_RETRY_BASE_DELAY = 1.0  # seconds, doubles each retry

# ---------------------------------------------------------------------------
# LRU result cache — avoids redundant DuckDuckGo calls in multi-query research
# ---------------------------------------------------------------------------
_CACHE_TTL_SECONDS = 300  # 5 minutes
_CACHE_MAX_SIZE = 128
_search_cache: dict[str, tuple[float, Any]] = {}


def _cache_key(prefix: str, **kwargs: Any) -> str:
    """Build a deterministic cache key from call parameters."""
    raw = f"{prefix}:" + json.dumps(kwargs, sort_keys=True, default=str)
    return hashlib.md5(raw.encode()).hexdigest()  # noqa: S324 — non-security use


def _cache_get(key: str) -> Any | None:
    """Return cached value if still fresh, else None."""
    entry = _search_cache.get(key)
    if entry is None:
        return None
    ts, value = entry
    if time.monotonic() - ts > _CACHE_TTL_SECONDS:
        _search_cache.pop(key, None)
        return None
    return value


def _cache_put(key: str, value: Any) -> None:
    """Store value in cache, evicting oldest entries if over capacity."""
    if len(_search_cache) >= _CACHE_MAX_SIZE:
        oldest_key = min(_search_cache, key=lambda k: _search_cache[k][0])
        _search_cache.pop(oldest_key, None)
    _search_cache[key] = (time.monotonic(), value)


# ---------------------------------------------------------------------------
# Result deduplication
# ---------------------------------------------------------------------------

def _dedup_results(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove duplicate results by normalized URL."""
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for r in results:
        url = (r.get("href") or r.get("link") or r.get("url") or "").rstrip("/").lower()
        if url and url in seen:
            continue
        if url:
            seen.add(url)
        unique.append(r)
    return unique


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="web_fetch",
            description=(
                "Fetch the full readable content of a web page as clean Markdown. "
                "Uses Jina Reader (r.jina.ai) as the primary route — it renders JavaScript, "
                "bypasses most bot-protection walls, and returns LLM-friendly Markdown. "
                "Falls back to a plain HTTP request if Jina is unavailable. "
                "Use this after web_search to read the full text of the most relevant pages."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to fetch",
                    },
                    "max_chars": {
                        "type": "integer",
                        "description": f"Maximum characters to return (default: {_WEB_FETCH_MAX_CHARS})",
                        "default": _WEB_FETCH_MAX_CHARS,
                    },
                },
                "required": ["url"],
            },
        ),
        Tool(
            name="web_search",
            description=(
                "Search the web using DuckDuckGo. Returns top results with title, URL, and snippet. "
                "Use for factual lookups, current events, documentation, and real-time data. "
                "Supports time filters (day/week/month/year) for recency-sensitive queries."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query string"
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of results to return (default: 5, max: 20)",
                        "default": 5,
                    },
                    "region": {
                        "type": "string",
                        "description": "Region for search results (default: wt-wt for worldwide). Use ru-ru for Russian results.",
                        "default": "wt-wt",
                    },
                    "timelimit": {
                        "type": "string",
                        "description": "Time filter: 'd' (past day), 'w' (past week), 'm' (past month), 'y' (past year). Omit for all time.",
                    },
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="web_news_search",
            description=(
                "Search recent news articles via DuckDuckGo News. "
                "Returns headlines, sources, and publication dates."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "News search query"
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of news results (default: 5)",
                        "default": 5,
                    },
                    "timelimit": {
                        "type": "string",
                        "description": "Time filter: 'd' (past day), 'w' (past week), 'm' (past month). Omit for default.",
                    },
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="web_search_answers",
            description=(
                "Get instant answers from DuckDuckGo for factual questions. "
                "Returns a direct answer with abstract, source URL, and related topics. "
                "Best for quick fact checks: definitions, dates, short factual answers."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Factual query for instant answer"
                    },
                },
                "required": ["query"],
            },
        ),
    ]


def _validate_url(url: str) -> None:
    """Raise ValueError if *url* is not a safe http(s) URL.

    Blocks:
    - Non-http(s) schemes (file://, ftp://, gopher://, ...)
    - Private/loopback/link-local IPv4 ranges (SSRF guard)
    - Private IPv6 addresses
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Unsupported scheme: {parsed.scheme!r}")
    host = parsed.hostname or ""
    # Block loopback and private ranges
    private_prefixes = (
        "localhost",
        "127.",
        "10.",
        "192.168.",
        "169.254.",  # link-local / cloud metadata
        "0.",        # 0.0.0.0
        "[::1]",
        "[fc",
        "[fd",
    )
    if any(host.lower().startswith(p) for p in private_prefixes):
        raise ValueError(f"Blocked private/loopback host: {host!r}")
    # Block 172.16.0.0/12
    if re.match(r"^172\.(1[6-9]|2\d|3[01])\.", host):
        raise ValueError(f"Blocked private host: {host!r}")


def _fetch_via_jina(url: str, max_chars: int) -> str:
    """Fetch page content via Jina Reader — returns clean Markdown."""
    _validate_url(url)
    jina_url = _JINA_BASE + url
    req = urllib.request.Request(
        jina_url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; OpenClawBot/1.0)",
            "Accept": "text/plain, text/markdown, */*",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310 -- URL validated by _validate_url
        raw = resp.read(max_chars + 4096).decode("utf-8", errors="replace")
    return raw[:max_chars]


def _fetch_via_plain_http(url: str, max_chars: int) -> str:
    """Fallback: plain HTTP fetch with minimal HTML stripping."""
    _validate_url(url)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; OpenClawBot/1.0)",
            "Accept": "text/html, text/plain, */*",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310 -- URL validated by _validate_url
        raw = resp.read(max_chars * 3).decode("utf-8", errors="replace")
    # Strip script/style blocks, then HTML tags
    raw = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", raw, flags=re.IGNORECASE | re.DOTALL)
    raw = re.sub(r"<[^>]+>", " ", raw)
    raw = re.sub(r"\s{3,}", "\n\n", raw)
    return raw.strip()[:max_chars]


def _sync_fetch(url: str, max_chars: int) -> str:
    """Try Jina Reader first, then plain HTTP. Rejects non-http(s) or private URLs."""
    try:
        _validate_url(url)
    except ValueError as exc:
        return f"[web_fetch error] Blocked URL: {exc}"
    try:
        return _fetch_via_jina(url, max_chars)
    except Exception:
        pass
    try:
        return _fetch_via_plain_http(url, max_chars)
    except Exception as exc:
        return f"[web_fetch error] Could not retrieve {url}: {exc}"


def _with_retry(fn, *args, **kwargs) -> Any:
    """Execute *fn* with exponential backoff on DuckDuckGo rate limits."""
    last_exc: Exception | None = None
    for attempt in range(_MAX_RETRIES):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            last_exc = exc
            err_str = str(exc).lower()
            # Only retry on rate-limit / transient errors
            if "ratelimit" in err_str or "429" in err_str or "timeout" in err_str:
                delay = _RETRY_BASE_DELAY * (2 ** attempt)
                time.sleep(delay)
                continue
            raise  # non-retryable — propagate immediately
    raise last_exc  # type: ignore[misc]


def _sync_search(
    query: str, max_results: int, region: str, timelimit: str | None = None,
) -> list[dict[str, Any]]:
    """Run DuckDuckGo text search synchronously with retry + caching."""
    ck = _cache_key("search", q=query, n=max_results, r=region, t=timelimit)
    cached = _cache_get(ck)
    if cached is not None:
        return cached

    def _do() -> list[dict[str, Any]]:
        with DDGS() as ddgs:
            kwargs: dict[str, Any] = {
                "keywords": query,
                "region": region,
                "max_results": min(max_results, 20),
            }
            if timelimit:
                kwargs["timelimit"] = timelimit
            return list(ddgs.text(**kwargs))

    results = _with_retry(_do)
    results = _dedup_results(results)
    _cache_put(ck, results)
    return results


def _sync_news(
    query: str, max_results: int, timelimit: str | None = None,
) -> list[dict[str, Any]]:
    """Run DuckDuckGo news search synchronously with retry + caching."""
    ck = _cache_key("news", q=query, n=max_results, t=timelimit)
    cached = _cache_get(ck)
    if cached is not None:
        return cached

    def _do() -> list[dict[str, Any]]:
        with DDGS() as ddgs:
            kwargs: dict[str, Any] = {
                "keywords": query,
                "max_results": min(max_results, 20),
            }
            if timelimit:
                kwargs["timelimit"] = timelimit
            return list(ddgs.news(**kwargs))

    results = _with_retry(_do)
    results = _dedup_results(results)
    _cache_put(ck, results)
    return results


def _sync_answers(query: str) -> list[dict[str, Any]]:
    """Get DuckDuckGo instant answers synchronously with retry + caching."""
    ck = _cache_key("answers", q=query)
    cached = _cache_get(ck)
    if cached is not None:
        return cached

    def _do() -> list[dict[str, Any]]:
        with DDGS() as ddgs:
            return list(ddgs.answers(query))

    results = _with_retry(_do)
    _cache_put(ck, results)
    return results


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "web_fetch":
        url = arguments.get("url", "").strip()
        if not url:
            return [TextContent(type="text", text="[web_fetch error] No URL provided.")]
        max_chars = int(arguments.get("max_chars", _WEB_FETCH_MAX_CHARS))
        loop = asyncio.get_event_loop()
        content = await loop.run_in_executor(None, _sync_fetch, url, max_chars)
        return [TextContent(type="text", text=content)]

    if name == "web_search":
        query = arguments["query"]
        max_results = arguments.get("max_results", 5)
        region = arguments.get("region", "wt-wt")
        timelimit = arguments.get("timelimit")

        loop = asyncio.get_event_loop()
        results = await loop.run_in_executor(
            None, _sync_search, query, max_results, region, timelimit,
        )

        if not results:
            return [TextContent(type="text", text="No results found.")]

        formatted = []
        for i, r in enumerate(results, 1):
            formatted.append(
                f"{i}. **{r.get('title', 'N/A')}**\n"
                f"   URL: {r.get('href', r.get('link', 'N/A'))}\n"
                f"   {r.get('body', r.get('snippet', ''))}"
            )
        return [TextContent(type="text", text="\n\n".join(formatted))]

    if name == "web_news_search":
        query = arguments["query"]
        max_results = arguments.get("max_results", 5)
        timelimit = arguments.get("timelimit")

        loop = asyncio.get_event_loop()
        results = await loop.run_in_executor(
            None, _sync_news, query, max_results, timelimit,
        )

        if not results:
            return [TextContent(type="text", text="No news results found.")]

        formatted = []
        for i, r in enumerate(results, 1):
            formatted.append(
                f"{i}. **{r.get('title', 'N/A')}**\n"
                f"   Source: {r.get('source', 'N/A')} | Date: {r.get('date', 'N/A')}\n"
                f"   URL: {r.get('url', r.get('link', 'N/A'))}\n"
                f"   {r.get('body', '')}"
            )
        return [TextContent(type="text", text="\n\n".join(formatted))]

    if name == "web_search_answers":
        query = arguments["query"]
        loop = asyncio.get_event_loop()
        results = await loop.run_in_executor(None, _sync_answers, query)

        if not results:
            return [TextContent(type="text", text="No instant answer available.")]

        formatted = []
        for r in results:
            text = r.get("text", "")
            url = r.get("url", "")
            line = f"**{text}**" if text else ""
            if url:
                line += f"\nSource: {url}"
            if line:
                formatted.append(line)
        return [TextContent(type="text", text="\n\n".join(formatted) or "No instant answer available.")]

    return [TextContent(type="text", text=f"Unknown tool: {name}")]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
