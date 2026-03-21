"""
MCP Server: Web Search via DuckDuckGo (free, no API key required).
Exposes `web_search`, `web_news_search`, and `web_fetch` tools for the OpenClaw pipeline.
Uses the `duckduckgo_search` library.

web_fetch strategy (in order):
  1. Jina Reader (r.jina.ai/<url>) — zero-config, returns clean Markdown, no JS issues.
  2. Plain HTTP via urllib — fallback for Jina failures.
Both routes strip excess whitespace before returning to save LLM tokens.
"""

import asyncio
import json
import re
import sys
import urllib.request
import urllib.error
import urllib.parse
from typing import Any

from mcp.server import Server
from mcp.server.stdio import run_server
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
                "Use for factual lookups, current events, documentation, and real-time data."
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
                        "description": "Maximum number of results to return (default: 5, max: 10)",
                        "default": 5,
                    },
                    "region": {
                        "type": "string",
                        "description": "Region for search results (default: wt-wt for worldwide). Use ru-ru for Russian results.",
                        "default": "wt-wt",
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


def _sync_search(query: str, max_results: int, region: str) -> list[dict[str, Any]]:
    """Run DuckDuckGo text search synchronously (library is sync-only)."""
    with DDGS() as ddgs:
        results = list(ddgs.text(query, region=region, max_results=min(max_results, 10)))
    return results


def _sync_news(query: str, max_results: int) -> list[dict[str, Any]]:
    """Run DuckDuckGo news search synchronously."""
    with DDGS() as ddgs:
        results = list(ddgs.news(query, max_results=min(max_results, 10)))
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

        loop = asyncio.get_event_loop()
        results = await loop.run_in_executor(None, _sync_search, query, max_results, region)

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

    elif name == "web_news_search":
        query = arguments["query"]
        max_results = arguments.get("max_results", 5)

        loop = asyncio.get_event_loop()
        results = await loop.run_in_executor(None, _sync_news, query, max_results)

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

    return [TextContent(type="text", text=f"Unknown tool: {name}")]


async def main():
    await run_server(server)


if __name__ == "__main__":
    asyncio.run(main())
