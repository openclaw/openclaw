"""
Universal Research Engine — unified multi-source parser for OpenClaw Bot v11.6.

Adapter-based architecture: each source implements SourceAdapter ABC.
UniversalParser orchestrates concurrent fetches, deduplication, and ranking.

Supported sources:
  - Habr (RSS)
  - GitHub (REST API)
  - Reddit (JSON API)
  - Semantic Scholar (REST API)
  - arXiv (Atom XML API)
  - OpenAlex (REST API)
"""

from __future__ import annotations

import asyncio
import os
import re

from src.utils.async_utils import taskgroup_gather
import ssl
import xml.etree.ElementTree as ET
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from urllib.parse import quote_plus

import certifi

import aiohttp
import structlog

logger = structlog.get_logger("parsers.universal")

_DEFAULT_TIMEOUT = 20


# ─── Unified data model ───────────────────────────────────────────────


@dataclass
class ResearchItem:
    """Universal research item — unified across all sources."""

    title: str
    url: str
    source: str  # adapter name, e.g. "semantic_scholar", "arxiv"
    summary: str = ""
    authors: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    score: float = 0.0  # normalized relevance/popularity
    published: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def key(self) -> str:
        """Deduplication key (URL-based)."""
        return self.url.rstrip("/").lower()


# ─── Abstract adapter ─────────────────────────────────────────────────


class SourceAdapter(ABC):
    """Abstract base for all source adapters."""

    name: str = ""

    @abstractmethod
    async def fetch(
        self, query: str, limit: int = 20, timeout: int = _DEFAULT_TIMEOUT
    ) -> list[ResearchItem]:
        ...


# ─── Habr adapter (RSS) ──────────────────────────────────────────────


class HabrAdapter(SourceAdapter):
    name = "habr"

    _RSS_BASE = "https://habr.com/ru/rss/articles/"
    _SEARCH_RSS = "https://habr.com/ru/rss/search/?q={query}&target_type=posts"

    async def fetch(
        self, query: str = "", limit: int = 20, timeout: int = _DEFAULT_TIMEOUT
    ) -> list[ResearchItem]:
        url = self._SEARCH_RSS.format(query=quote_plus(query)) if query else self._RSS_BASE

        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=timeout)
            ) as session:
                async with session.get(url) as resp:
                    if resp.status != 200:
                        logger.warning("habr_rss_failed", status=resp.status)
                        return []
                    xml_text = await resp.text()
        except Exception as e:
            logger.warning("habr_fetch_error", error=str(e))
            return []

        return self._parse_rss(xml_text, limit)

    def _parse_rss(self, xml_text: str, limit: int) -> list[ResearchItem]:
        items: list[ResearchItem] = []
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError as e:
            logger.warning("habr_xml_error", error=str(e))
            return []

        channel = root.find("channel")
        elements = channel.findall("item") if channel is not None else root.findall(".//item")

        for el in elements[:limit]:
            title = _xml_text(el, "title")
            link = _xml_text(el, "link")
            if not title or not link:
                continue
            desc = _xml_text(el, "description")
            summary = re.sub(r"<[^>]+>", "", desc)[:500] if desc else ""
            author = _xml_text(el, "author") or _xml_text(
                el, "{http://purl.org/dc/elements/1.1/}creator"
            )
            tags = [c.text for c in el.findall("category") if c.text]

            items.append(
                ResearchItem(
                    title=title,
                    url=link,
                    source=self.name,
                    summary=summary,
                    authors=[author] if author else [],
                    tags=tags,
                    published=_xml_text(el, "pubDate"),
                )
            )

        logger.info("habr_parsed", count=len(items))
        return items


# ─── GitHub adapter (REST API) ────────────────────────────────────────


class GitHubAdapter(SourceAdapter):
    name = "github"

    _API = "https://api.github.com"

    async def fetch(
        self, query: str = "language:python stars:>100", limit: int = 20, timeout: int = _DEFAULT_TIMEOUT
    ) -> list[ResearchItem]:
        limit = min(limit, 100)
        url = f"{self._API}/search/repositories?q={quote_plus(query)}&sort=stars&order=desc&per_page={limit}"
        headers = self._headers()

        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=timeout), headers=headers
            ) as session:
                async with session.get(url) as resp:
                    if resp.status in (403, 429):
                        logger.warning("github_rate_limited")
                        return []
                    if resp.status != 200:
                        logger.warning("github_search_failed", status=resp.status)
                        return []
                    data = await resp.json()
        except Exception as e:
            logger.warning("github_fetch_error", error=str(e))
            return []

        items: list[ResearchItem] = []
        for repo in data.get("items", [])[:limit]:
            lic = repo.get("license") or {}
            items.append(
                ResearchItem(
                    title=repo.get("full_name", ""),
                    url=repo.get("html_url", ""),
                    source=self.name,
                    summary=repo.get("description", "") or "",
                    tags=repo.get("topics", []),
                    score=float(repo.get("stargazers_count", 0)),
                    published=repo.get("created_at", ""),
                    extra={
                        "language": repo.get("language", "") or "",
                        "stars": repo.get("stargazers_count", 0),
                        "forks": repo.get("forks_count", 0),
                        "license": lic.get("spdx_id", ""),
                    },
                )
            )

        logger.info("github_parsed", count=len(items))
        return items

    @staticmethod
    def _headers() -> dict[str, str]:
        headers: dict[str, str] = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "OpenClawBot/1.0",
        }
        token = os.environ.get("GITHUB_TOKEN", "")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers


# ─── Reddit adapter (JSON API) ────────────────────────────────────────


class RedditAdapter(SourceAdapter):
    name = "reddit"

    _BASE = "https://www.reddit.com"
    _USER_AGENT = "OpenClawBot/1.0 (research parser)"
    DEFAULT_SUBREDDITS = [
        "MachineLearning",
        "LocalLLaMA",
        "artificial",
        "algotrading",
        "MLOps",
        "LanguageTechnology",
    ]

    async def fetch(
        self,
        query: str = "",
        limit: int = 20,
        timeout: int = _DEFAULT_TIMEOUT,
        subreddits: list[str] | None = None,
    ) -> list[ResearchItem]:
        subs = subreddits or self.DEFAULT_SUBREDDITS
        per_sub = max(limit // len(subs), 5)
        all_posts: list[ResearchItem] = []

        for sub in subs:
            posts = await self._fetch_sub(sub, query, per_sub, timeout)
            all_posts.extend(posts)
            await asyncio.sleep(0.5)  # respect rate limits

        all_posts.sort(key=lambda p: p.score, reverse=True)
        return all_posts[:limit]

    async def _fetch_sub(
        self, subreddit: str, query: str, limit: int, timeout: int
    ) -> list[ResearchItem]:
        limit = min(limit, 100)
        if query:
            url = f"{self._BASE}/r/{subreddit}/search.json?q={quote_plus(query)}&restrict_sr=1&sort=relevance&limit={limit}"
        else:
            url = f"{self._BASE}/r/{subreddit}/hot.json?limit={limit}"

        headers = {"User-Agent": self._USER_AGENT}
        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=timeout), headers=headers
            ) as session:
                async with session.get(url) as resp:
                    if resp.status == 429:
                        logger.warning("reddit_rate_limited", subreddit=subreddit)
                        await asyncio.sleep(3)
                        return []
                    if resp.status != 200:
                        logger.warning("reddit_failed", status=resp.status, subreddit=subreddit)
                        return []
                    data = await resp.json()
        except Exception as e:
            logger.warning("reddit_error", error=str(e), subreddit=subreddit)
            return []

        items: list[ResearchItem] = []
        for child in data.get("data", {}).get("children", [])[:limit]:
            d = child.get("data", {})
            title = d.get("title", "")
            if not title:
                continue
            permalink = d.get("permalink", "")
            full_url = f"{self._BASE}{permalink}" if permalink else d.get("url", "")

            items.append(
                ResearchItem(
                    title=title,
                    url=full_url,
                    source=self.name,
                    summary=d.get("selftext", "")[:500],
                    authors=[d.get("author", "")],
                    tags=[d.get("link_flair_text", "") or ""],
                    score=float(d.get("score", 0)),
                    extra={
                        "subreddit": d.get("subreddit", ""),
                        "num_comments": d.get("num_comments", 0),
                        "created_utc": d.get("created_utc", 0.0),
                    },
                )
            )

        logger.info("reddit_parsed", count=len(items), subreddit=subreddit)
        return items


# ─── Semantic Scholar adapter (REST API) ──────────────────────────────


class SemanticScholarAdapter(SourceAdapter):
    name = "semantic_scholar"

    _API = "https://api.semanticscholar.org/graph/v1"
    _FIELDS = "title,url,abstract,authors,year,citationCount,fieldsOfStudy,openAccessPdf,publicationDate,tldr"

    async def fetch(
        self, query: str = "multi-agent systems", limit: int = 20, timeout: int = _DEFAULT_TIMEOUT
    ) -> list[ResearchItem]:
        limit = min(limit, 100)
        url = f"{self._API}/paper/search?query={quote_plus(query)}&limit={limit}&fields={self._FIELDS}"
        url += "&fieldsOfStudy=Computer Science"

        headers: dict[str, str] = {}
        api_key = os.environ.get("S2_API_KEY", "")
        if api_key:
            headers["x-api-key"] = api_key

        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=timeout), headers=headers
            ) as session:
                async with session.get(url) as resp:
                    if resp.status == 429:
                        logger.warning("s2_rate_limited")
                        return []
                    if resp.status != 200:
                        logger.warning("s2_search_failed", status=resp.status)
                        return []
                    data = await resp.json()
        except Exception as e:
            logger.warning("s2_fetch_error", error=str(e))
            return []

        items: list[ResearchItem] = []
        for paper in data.get("data", [])[:limit]:
            title = paper.get("title", "")
            if not title:
                continue

            paper_url = paper.get("url", "")
            tldr = paper.get("tldr") or {}
            abstract = tldr.get("text", "") or paper.get("abstract", "") or ""

            authors = [a.get("name", "") for a in paper.get("authors", []) if a.get("name")]
            fields = paper.get("fieldsOfStudy") or []
            pub_date = paper.get("publicationDate", "") or str(paper.get("year", ""))

            pdf_info = paper.get("openAccessPdf") or {}
            pdf_url = pdf_info.get("url", "")

            items.append(
                ResearchItem(
                    title=title,
                    url=paper_url,
                    source=self.name,
                    summary=abstract[:500],
                    authors=authors,
                    tags=fields,
                    score=float(paper.get("citationCount", 0)),
                    published=pub_date,
                    extra={
                        "citations": paper.get("citationCount", 0),
                        "paper_id": paper.get("paperId", ""),
                        "pdf_url": pdf_url,
                    },
                )
            )

        logger.info("s2_parsed", count=len(items))
        return items


# ─── arXiv adapter (Atom XML API) ─────────────────────────────────────


class ArxivAdapter(SourceAdapter):
    name = "arxiv"

    _API = "https://export.arxiv.org/api/query"
    _ATOM_NS = "http://www.w3.org/2005/Atom"
    _ARXIV_NS = "http://arxiv.org/schemas/atom"

    async def fetch(
        self, query: str = "multi-agent systems", limit: int = 20, timeout: int = _DEFAULT_TIMEOUT
    ) -> list[ResearchItem]:
        limit = min(limit, 100)
        # arXiv API uses Lucene syntax: spaces → OR, AND for conjunction.
        # Join words with AND for more targeted results.
        words = query.split()
        search_query = "+AND+".join(f"all:{quote_plus(w)}" for w in words)
        url = f"{self._API}?search_query={search_query}&sortBy=submittedDate&sortOrder=descending&max_results={limit}"

        try:
            ssl_ctx = ssl.create_default_context(cafile=certifi.where())
            connector = aiohttp.TCPConnector(ssl=ssl_ctx)
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=timeout), connector=connector
            ) as session:
                async with session.get(url) as resp:
                    if resp.status != 200:
                        logger.warning("arxiv_fetch_failed", status=resp.status)
                        return []
                    xml_text = await resp.text()
        except Exception as e:
            logger.warning("arxiv_fetch_error", error=str(e))
            return []

        return self._parse_atom(xml_text, limit)

    def _parse_atom(self, xml_text: str, limit: int) -> list[ResearchItem]:
        items: list[ResearchItem] = []
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError as e:
            logger.warning("arxiv_xml_error", error=str(e))
            return []

        ns = {"a": self._ATOM_NS, "arxiv": self._ARXIV_NS}

        for entry in root.findall("a:entry", ns)[:limit]:
            title_el = entry.find("a:title", ns)
            title = (title_el.text or "").strip().replace("\n", " ") if title_el is not None else ""
            if not title:
                continue

            # Get the abstract link (HTML page)
            link = ""
            pdf_link = ""
            for lnk in entry.findall("a:link", ns):
                if lnk.get("type") == "text/html":
                    link = lnk.get("href", "")
                elif lnk.get("title") == "pdf":
                    pdf_link = lnk.get("href", "")
            if not link:
                id_el = entry.find("a:id", ns)
                link = (id_el.text or "").strip() if id_el is not None else ""

            summary_el = entry.find("a:summary", ns)
            summary = (summary_el.text or "").strip().replace("\n", " ")[:500] if summary_el is not None else ""

            authors = []
            for author_el in entry.findall("a:author", ns):
                name_el = author_el.find("a:name", ns)
                if name_el is not None and name_el.text:
                    authors.append(name_el.text.strip())

            published_el = entry.find("a:published", ns)
            published = (published_el.text or "").strip() if published_el is not None else ""

            categories = [c.get("term", "") for c in entry.findall("a:category", ns)]

            primary_cat_el = entry.find("arxiv:primary_category", ns)
            primary_cat = primary_cat_el.get("term", "") if primary_cat_el is not None else ""

            items.append(
                ResearchItem(
                    title=title,
                    url=link,
                    source=self.name,
                    summary=summary,
                    authors=authors,
                    tags=categories,
                    published=published,
                    extra={
                        "pdf_url": pdf_link,
                        "primary_category": primary_cat,
                        "arxiv_id": link.split("/abs/")[-1] if "/abs/" in link else "",
                    },
                )
            )

        logger.info("arxiv_parsed", count=len(items))
        return items


# ─── OpenAlex adapter (REST API) ──────────────────────────────────────


class OpenAlexAdapter(SourceAdapter):
    name = "openalex"

    _API = "https://api.openalex.org"

    async def fetch(
        self, query: str = "multi-agent systems", limit: int = 20, timeout: int = _DEFAULT_TIMEOUT
    ) -> list[ResearchItem]:
        limit = min(limit, 100)
        url = (
            f"{self._API}/works?"
            f"search={quote_plus(query)}"
            f"&per_page={limit}"
            f"&sort=cited_by_count:desc"
            f"&filter=type:article"
            f"&select=id,doi,title,display_name,publication_date,cited_by_count,"
            f"authorships,concepts,open_access,primary_location"
        )
        headers = {
            "User-Agent": "OpenClawBot/1.0 (mailto:research@openclaw.ai)",
        }
        email = os.environ.get("OPENALEX_EMAIL", "")
        if email:
            url += f"&mailto={quote_plus(email)}"

        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=timeout), headers=headers
            ) as session:
                async with session.get(url) as resp:
                    if resp.status != 200:
                        logger.warning("openalex_failed", status=resp.status)
                        return []
                    data = await resp.json()
        except Exception as e:
            logger.warning("openalex_error", error=str(e))
            return []

        items: list[ResearchItem] = []
        for work in data.get("results", [])[:limit]:
            title = work.get("display_name", "") or work.get("title", "")
            if not title:
                continue

            doi = work.get("doi", "") or ""
            openalex_id = work.get("id", "") or ""
            work_url = doi if doi else openalex_id

            authors = []
            for authorship in work.get("authorships", [])[:10]:
                author_info = authorship.get("author", {})
                name = author_info.get("display_name", "")
                if name:
                    authors.append(name)

            concepts = [c.get("display_name", "") for c in work.get("concepts", [])[:5]]
            pub_date = work.get("publication_date", "")
            citations = work.get("cited_by_count", 0)

            oa = work.get("open_access") or {}
            oa_url = oa.get("oa_url", "")

            location = work.get("primary_location") or {}
            source_info = location.get("source") or {}

            items.append(
                ResearchItem(
                    title=title,
                    url=work_url,
                    source=self.name,
                    summary="",  # OpenAlex doesn't return abstracts in basic search
                    authors=authors,
                    tags=concepts,
                    score=float(citations),
                    published=pub_date,
                    extra={
                        "citations": citations,
                        "oa_url": oa_url,
                        "venue": source_info.get("display_name", ""),
                        "openalex_id": openalex_id,
                    },
                )
            )

        logger.info("openalex_parsed", count=len(items))
        return items


# ─── StackOverflow adapter (REST API) ─────────────────────────────────


class StackOverflowAdapter(SourceAdapter):
    """Search StackOverflow questions via the public /search/excerpts API."""

    name = "stackoverflow"

    _API = "https://api.stackexchange.com/2.3"

    async def fetch(
        self, query: str = "", limit: int = 20, timeout: int = _DEFAULT_TIMEOUT
    ) -> list[ResearchItem]:
        limit = min(limit, 50)
        url = (
            f"{self._API}/search/excerpts"
            f"?order=desc&sort=relevance&q={quote_plus(query)}"
            f"&site=stackoverflow&pagesize={limit}&filter=default"
        )

        try:
            ssl_ctx = ssl.create_default_context(cafile=certifi.where())
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=timeout),
                connector=aiohttp.TCPConnector(ssl=ssl_ctx),
            ) as session:
                async with session.get(url) as resp:
                    if resp.status != 200:
                        logger.warning("stackoverflow_search_failed", status=resp.status)
                        return []
                    data = await resp.json()
        except Exception as e:
            logger.warning("stackoverflow_fetch_error", error=str(e))
            return []

        items: list[ResearchItem] = []
        for item_data in data.get("items", [])[:limit]:
            if item_data.get("item_type") != "question":
                continue
            qid = item_data.get("question_id", "")
            title = item_data.get("title", "")
            # HTML entity cleanup
            title = re.sub(r"&[a-z]+;", " ", title)
            excerpt = item_data.get("excerpt", "")
            excerpt = re.sub(r"<[^>]+>", "", excerpt)[:500]
            tags = item_data.get("tags", [])
            score = float(item_data.get("question_score", 0))
            answers = item_data.get("answer_count", 0)
            has_accepted = item_data.get("has_accepted_answer", False)

            items.append(
                ResearchItem(
                    title=title,
                    url=f"https://stackoverflow.com/questions/{qid}",
                    source=self.name,
                    summary=excerpt,
                    tags=tags,
                    score=score,
                    extra={
                        "answers": answers,
                        "has_accepted": has_accepted,
                        "score": int(score),
                    },
                )
            )

        logger.info("stackoverflow_parsed", count=len(items))
        return items


# ─── HackerNews adapter (Algolia API) ────────────────────────────────


class HackerNewsAdapter(SourceAdapter):
    """Search Hacker News stories via the free Algolia HN Search API."""

    name = "hackernews"

    _API = "https://hn.algolia.com/api/v1"

    async def fetch(
        self, query: str = "", limit: int = 20, timeout: int = _DEFAULT_TIMEOUT
    ) -> list[ResearchItem]:
        limit = min(limit, 50)
        url = (
            f"{self._API}/search"
            f"?query={quote_plus(query)}&tags=story&hitsPerPage={limit}"
        )

        try:
            ssl_ctx = ssl.create_default_context(cafile=certifi.where())
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=timeout),
                connector=aiohttp.TCPConnector(ssl=ssl_ctx),
            ) as session:
                async with session.get(url) as resp:
                    if resp.status != 200:
                        logger.warning("hackernews_search_failed", status=resp.status)
                        return []
                    data = await resp.json()
        except Exception as e:
            logger.warning("hackernews_fetch_error", error=str(e))
            return []

        items: list[ResearchItem] = []
        for hit in data.get("hits", [])[:limit]:
            title = hit.get("title", "")
            hn_url = hit.get("url", "")
            hn_id = hit.get("objectID", "")
            if not hn_url:
                hn_url = f"https://news.ycombinator.com/item?id={hn_id}"
            author = hit.get("author", "")
            points = hit.get("points", 0)
            comments = hit.get("num_comments", 0)
            created = hit.get("created_at", "")

            items.append(
                ResearchItem(
                    title=title,
                    url=hn_url,
                    source=self.name,
                    summary=f"{points} points, {comments} comments on HN",
                    authors=[author] if author else [],
                    score=float(points or 0),
                    published=created,
                    extra={
                        "hn_id": hn_id,
                        "points": points,
                        "comments": comments,
                        "hn_url": f"https://news.ycombinator.com/item?id={hn_id}",
                    },
                )
            )

        logger.info("hackernews_parsed", count=len(items))
        return items


# ─── Helpers ──────────────────────────────────────────────────────────


def _xml_text(element: ET.Element, tag: str) -> str:
    """Safely extract text from an XML element child."""
    child = element.find(tag)
    return (child.text or "").strip() if child is not None else ""


# ─── Universal Parser (orchestrator) ──────────────────────────────────


_ALL_ADAPTERS: list[type[SourceAdapter]] = [
    HabrAdapter,
    GitHubAdapter,
    RedditAdapter,
    SemanticScholarAdapter,
    ArxivAdapter,
    OpenAlexAdapter,
    StackOverflowAdapter,
    HackerNewsAdapter,
]


class UniversalParser:
    """Orchestrates concurrent research across multiple sources.

    Usage:
        parser = UniversalParser()
        results = await parser.search("multi-agent RAG", limit_per_source=20)
        for source_name, items in results.items():
            print(f"[{source_name}] {len(items)} results")
    """

    def __init__(self, adapters: list[SourceAdapter] | None = None):
        if adapters is not None:
            self._adapters = adapters
        else:
            self._adapters = [cls() for cls in _ALL_ADAPTERS]

    @property
    def adapter_names(self) -> list[str]:
        return [a.name for a in self._adapters]

    def get_adapter(self, name: str) -> SourceAdapter | None:
        for a in self._adapters:
            if a.name == name:
                return a
        return None

    async def search(
        self,
        query: str,
        limit_per_source: int = 20,
        sources: list[str] | None = None,
        timeout: int = _DEFAULT_TIMEOUT,
    ) -> dict[str, list[ResearchItem]]:
        """Run search across selected (or all) sources concurrently.

        Args:
            query: Search query text.
            limit_per_source: Max results per source.
            sources: List of adapter names to query. None = all.
            timeout: Per-source request timeout.

        Returns:
            Dict mapping source name → list of ResearchItems.
        """
        adapters = self._adapters
        if sources:
            adapters = [a for a in self._adapters if a.name in sources]

        tasks = [a.fetch(query, limit=limit_per_source, timeout=timeout) for a in adapters]
        results = await taskgroup_gather(*tasks, return_exceptions=True)

        output: dict[str, list[ResearchItem]] = {}
        for adapter, result in zip(adapters, results):
            if isinstance(result, Exception):
                logger.warning("adapter_error", adapter=adapter.name, error=str(result))
                output[adapter.name] = []
            else:
                output[adapter.name] = result

        total = sum(len(v) for v in output.values())
        logger.info("universal_search_done", query=query, total=total, sources=list(output.keys()))
        return output

    async def search_flat(
        self,
        query: str,
        limit: int = 50,
        sources: list[str] | None = None,
        timeout: int = _DEFAULT_TIMEOUT,
        deduplicate: bool = True,
    ) -> list[ResearchItem]:
        """Run search and return a single flat list, sorted by score descending.

        Optionally deduplicates by URL.
        """
        by_source = await self.search(query, limit_per_source=limit, sources=sources, timeout=timeout)
        all_items: list[ResearchItem] = []
        for items in by_source.values():
            all_items.extend(items)

        if deduplicate:
            seen: set[str] = set()
            unique: list[ResearchItem] = []
            for item in all_items:
                if item.key not in seen:
                    seen.add(item.key)
                    unique.append(item)
            all_items = unique

        all_items.sort(key=lambda x: x.score, reverse=True)
        return all_items[:limit]
