"""Tests for pipeline/blog_monitor.py — RSS blog monitor."""
import json
import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

# Ensure scripts/ is importable
SCRIPTS_DIR = str(Path(__file__).resolve().parent.parent / "scripts")
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from pipeline.blog_monitor import (
    extract_log_no,
    filter_by_category,
    load_processed,
    save_processed,
    extract_insight,
    save_blog_insight,
    generate_summary_text,
)


# ── helpers ─────────────────────────────────────────────────────────

def _make_entry(title="테스트 글", link="https://blog.naver.com/ranto28/224188992845",
                summary="경제 관련 요약 텍스트입니다.", categories=None, guid=None):
    """Create a fake feedparser entry."""
    entry = SimpleNamespace()
    entry.title = title
    entry.link = link
    entry.summary = summary
    entry.id = guid or link
    entry.published = "Mon, 20 Feb 2026 09:00:00 +0900"
    if categories is None:
        categories = ["경제"]
    entry.tags = [{"term": c} for c in categories]
    return entry


# ── extract_log_no ──────────────────────────────────────────────────

class TestExtractLogNo:
    def test_standard_url(self):
        assert extract_log_no("https://blog.naver.com/ranto28/224188992845") == "224188992845"

    def test_trailing_slash(self):
        assert extract_log_no("https://blog.naver.com/ranto28/224188992845/") == "224188992845"

    def test_empty(self):
        assert extract_log_no("") == ""

    def test_no_number(self):
        result = extract_log_no("https://blog.naver.com/ranto28")
        assert result == "ranto28"


# ── filter_by_category ──────────────────────────────────────────────

class TestFilterByCategory:
    def test_include_economy(self):
        entries = [_make_entry(categories=["경제"])]
        assert len(filter_by_category(entries)) == 1

    def test_include_stock(self):
        entries = [_make_entry(categories=["주식"])]
        assert len(filter_by_category(entries)) == 1

    def test_exclude_food(self):
        entries = [_make_entry(title="맛집 추천", categories=["맛집"])]
        assert len(filter_by_category(entries)) == 0

    def test_exclude_daily(self):
        entries = [_make_entry(title="일상 기록", categories=["일상"])]
        assert len(filter_by_category(entries)) == 0

    def test_no_category_passes(self):
        """Entries without categories should pass (LLM judges later)."""
        entry = _make_entry(categories=[])
        entry.tags = []
        assert len(filter_by_category([entry])) == 1

    def test_mixed_entries(self):
        entries = [
            _make_entry(categories=["경제"]),
            _make_entry(title="맛집 탐방", categories=["맛집"]),
            _make_entry(categories=["국제정세"]),
        ]
        result = filter_by_category(entries)
        assert len(result) == 2


# ── processed state ─────────────────────────────────────────────────

class TestProcessedState:
    def test_load_empty(self, tmp_path):
        path = tmp_path / ".processed_blogs.json"
        with patch("pipeline.blog_monitor.PROCESSED_FILE", path):
            result = load_processed()
            assert result == set()

    def test_save_and_load(self, tmp_path):
        path = tmp_path / ".processed_blogs.json"
        with patch("pipeline.blog_monitor.PROCESSED_FILE", path):
            guids = {"guid1", "guid2", "guid3"}
            save_processed(guids)
            loaded = load_processed()
            assert loaded == guids

    def test_save_limits_to_500(self, tmp_path):
        path = tmp_path / ".processed_blogs.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        with patch("pipeline.blog_monitor.PROCESSED_FILE", path):
            guids = {f"guid_{i}" for i in range(600)}
            save_processed(guids)
            loaded = load_processed()
            assert len(loaded) == 500


# ── save_blog_insight ───────────────────────────────────────────────

class TestSaveBlogInsight:
    def test_save_creates_file(self, tmp_path):
        with patch("pipeline.blog_monitor.OUTPUT_DIR", tmp_path):
            entry = _make_entry()
            extracted = {
                "insight": "경제 인사이트 테스트",
                "methodology": "VIX 기반 분석",
                "tags": ["경제", "VIX"],
                "indicators": ["VIX"],
            }
            filepath = save_blog_insight(entry, extracted)
            assert filepath.exists()
            content = filepath.read_text(encoding="utf-8")
            assert "blog_insights" in content
            assert "핵심 인사이트" in content
            assert "경제 인사이트 테스트" in content

    def test_save_without_extraction(self, tmp_path):
        with patch("pipeline.blog_monitor.OUTPUT_DIR", tmp_path):
            entry = _make_entry()
            filepath = save_blog_insight(entry, None)
            assert filepath.exists()
            content = filepath.read_text(encoding="utf-8")
            assert "blog_insights" in content


# ── extract_insight ─────────────────────────────────────────────────

class TestExtractInsight:
    def test_returns_none_on_short_text(self):
        result = extract_insight("제목", "짧은", ["경제"])
        assert result is None

    @patch("pipeline.blog_monitor.llm_chat_with_fallback")
    def test_successful_extraction(self, mock_llm):
        mock_llm.return_value = (
            json.dumps({
                "insight": "테스트 인사이트",
                "methodology": "",
                "tags": ["태그1"],
                "indicators": ["VIX"],
            }),
            "gpt-5-mini",
            "",
        )
        result = extract_insight("제목", "충분히 긴 텍스트 " * 10, ["경제"])
        assert result is not None
        assert result["insight"] == "테스트 인사이트"

    @patch("pipeline.blog_monitor.llm_chat_with_fallback")
    def test_llm_failure_returns_none(self, mock_llm):
        mock_llm.return_value = ("", "", "timeout")
        result = extract_insight("제목", "충분히 긴 텍스트 " * 10, ["경제"])
        assert result is None
