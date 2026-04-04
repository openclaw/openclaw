"""Unit tests for UniversalParser and source adapters (v11.6 + v4 improvements)."""
import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.parsers.universal import (
    ResearchItem,
    HabrAdapter,
    RedditAdapter,
    GitHubAdapter,
    StackOverflowAdapter,
    HackerNewsAdapter,
    UniversalParser,
)


# ---------------------------------------------------------------------------
# ResearchItem
# ---------------------------------------------------------------------------
def test_research_item_dedup_key():
    item = ResearchItem(title="Test", url="https://example.com/Page/", source="test")
    assert item.key == "https://example.com/page"
    print("[PASS] ResearchItem dedup key")


# ---------------------------------------------------------------------------
# Habr adapter
# ---------------------------------------------------------------------------
def test_habr_parse_rss():
    adapter = HabrAdapter()
    xml = """<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>Habr</title>
        <item>
          <title>Test Post</title>
          <link>https://habr.com/ru/articles/1/</link>
          <description>&lt;p&gt;Hello world&lt;/p&gt;</description>
          <author>user1</author>
          <pubDate>Mon, 01 Jan 2026 00:00:00 +0000</pubDate>
          <category>Python</category>
          <category>ML</category>
        </item>
        <item>
          <title>Another Post</title>
          <link>https://habr.com/ru/articles/2/</link>
          <description>Short desc</description>
        </item>
      </channel>
    </rss>"""
    items = adapter._parse_rss(xml, limit=10)
    assert len(items) == 2
    assert items[0].title == "Test Post"
    assert items[0].source == "habr"
    assert "Hello world" in items[0].summary
    assert "Python" in items[0].tags
    print("[PASS] HabrAdapter RSS parsing")


def test_habr_parse_invalid_xml():
    adapter = HabrAdapter()
    items = adapter._parse_rss("not xml at all", limit=10)
    assert items == []
    print("[PASS] HabrAdapter invalid XML returns empty")


# ---------------------------------------------------------------------------
# Reddit adapter
# ---------------------------------------------------------------------------
def test_reddit_fetch_sub_parse():
    adapter = RedditAdapter()
    assert adapter.name == "reddit"
    assert "MachineLearning" in adapter.DEFAULT_SUBREDDITS
    assert "LanguageTechnology" in adapter.DEFAULT_SUBREDDITS
    print("[PASS] RedditAdapter config")


# ---------------------------------------------------------------------------
# GitHub adapter
# ---------------------------------------------------------------------------
def test_github_adapter_headers():
    adapter = GitHubAdapter()
    headers = adapter._headers()
    assert "User-Agent" in headers
    assert headers["User-Agent"] == "OpenClawBot/1.0"
    print("[PASS] GitHubAdapter headers")


# ---------------------------------------------------------------------------
# StackOverflow adapter (v4)
# ---------------------------------------------------------------------------
def test_stackoverflow_adapter_name():
    adapter = StackOverflowAdapter()
    assert adapter.name == "stackoverflow"
    print("[PASS] StackOverflowAdapter name")


def test_stackoverflow_adapter_api_url():
    adapter = StackOverflowAdapter()
    assert "stackexchange.com" in adapter._API
    print("[PASS] StackOverflowAdapter API URL")


# ---------------------------------------------------------------------------
# HackerNews adapter (v4)
# ---------------------------------------------------------------------------
def test_hackernews_adapter_name():
    adapter = HackerNewsAdapter()
    assert adapter.name == "hackernews"
    print("[PASS] HackerNewsAdapter name")


def test_hackernews_adapter_api_url():
    adapter = HackerNewsAdapter()
    assert "algolia.com" in adapter._API
    print("[PASS] HackerNewsAdapter API URL")


# ---------------------------------------------------------------------------
# UniversalParser
# ---------------------------------------------------------------------------
def test_universal_parser_adapter_names():
    parser = UniversalParser()
    names = parser.adapter_names
    assert "habr" in names
    assert "github" in names
    assert "reddit" in names
    assert "semantic_scholar" in names
    assert "arxiv" in names
    assert "openalex" in names
    # v4: new adapters
    assert "stackoverflow" in names
    assert "hackernews" in names
    print("[PASS] UniversalParser has all 8 adapters")


def test_universal_parser_get_adapter():
    parser = UniversalParser()
    assert parser.get_adapter("arxiv") is not None
    assert parser.get_adapter("stackoverflow") is not None
    assert parser.get_adapter("hackernews") is not None
    assert parser.get_adapter("nonexistent") is None
    print("[PASS] UniversalParser get_adapter")


def test_universal_parser_adapter_count():
    parser = UniversalParser()
    assert len(parser.adapter_names) == 8  # v4: 6 original + 2 new
    print("[PASS] UniversalParser 8 adapters total")


# ---------------------------------------------------------------------------
# Run all
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except Exception as e:
            print(f"[FAIL] {t.__name__}: {e}")
            failed += 1
    print(f"\n{'='*40}")
    print(f"Total: {passed + failed}, Passed: {passed}, Failed: {failed}")
    if failed:
        sys.exit(1)
