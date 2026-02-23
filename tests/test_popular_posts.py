#!/usr/bin/env python3
"""Tests for telegram_popular_posts pipeline."""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

# Path setup
_TESTS_DIR = Path(__file__).resolve().parent
_SCRIPTS_DIR = _TESTS_DIR.parent / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))
sys.path.insert(0, str(_SCRIPTS_DIR / "pipeline"))

from pipeline.telegram_popular_posts import (
    PopularPostParser,
    _first_line,
    _format_count,
    _parse_count,
    _split_message,
    _truncate,
    analyze_posts,
    cleanup_old_posts,
    compute_popularity_score,
    format_report,
    get_all_channel_avg_views,
    get_channel_stats,
    get_recent_posts,
    init_db,
    load_channels,
    load_state,
    parse_archive_page,
    rank_posts,
    save_posts,
    save_state,
    update_scores,
)

# ── Sample HTML snippets for parser tests ──────────────────────────────────────

SAMPLE_MESSAGE_HTML = """
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message text_not_supported_wrap js-widget_message"
       data-post="TestChannel/42">
    <div class="tgme_widget_message_bubble">
      <div class="tgme_widget_message_text js-message_text" dir="auto">
        Hello world from test channel
      </div>
      <div class="tgme_widget_message_reactions js-message_reactions">
        <span class="tgme_reaction">
          <i class="emoji"><b>👍</b></i>14
        </span>
        <span class="tgme_reaction">
          <i class="emoji"><b>❤</b></i>6
        </span>
      </div>
      <div class="tgme_widget_message_footer">
        <div class="tgme_widget_message_info">
          <span class="tgme_widget_message_views">4.62K</span>
          <span class="tgme_widget_message_meta">
            <a class="tgme_widget_message_date" href="https://t.me/TestChannel/42">
              <time datetime="2026-02-21T10:00:00+00:00" class="time">10:00</time>
            </a>
          </span>
        </div>
      </div>
    </div>
  </div>
</div>
"""

SAMPLE_MULTI_MSG_HTML = """
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message text_not_supported_wrap js-widget_message"
       data-post="Ch1/100">
    <div class="tgme_widget_message_bubble">
      <div class="tgme_widget_message_text js-message_text">First message</div>
      <div class="tgme_widget_message_footer">
        <div class="tgme_widget_message_info">
          <span class="tgme_widget_message_views">1.5K</span>
          <span class="tgme_widget_message_meta">
            <time datetime="2026-02-21T08:00:00+00:00"></time>
          </span>
        </div>
      </div>
    </div>
  </div>
</div>
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message text_not_supported_wrap js-widget_message"
       data-post="Ch1/101">
    <div class="tgme_widget_message_bubble">
      <div class="tgme_widget_message_text js-message_text">Second message</div>
      <div class="tgme_widget_message_footer">
        <div class="tgme_widget_message_info">
          <span class="tgme_widget_message_views">3K</span>
          <span class="tgme_widget_message_meta">
            <time datetime="2026-02-21T09:00:00+00:00"></time>
          </span>
        </div>
      </div>
    </div>
  </div>
</div>
"""

SAMPLE_PAGINATION_HTML = """
<a class="tme_messages_more" href="/s/TestCh?before=99" data-before="99">
  Load more
</a>
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message text_not_supported_wrap js-widget_message"
       data-post="TestCh/100">
    <div class="tgme_widget_message_bubble">
      <div class="tgme_widget_message_text js-message_text">Paginated post</div>
      <div class="tgme_widget_message_footer">
        <div class="tgme_widget_message_info">
          <span class="tgme_widget_message_views">500</span>
          <span class="tgme_widget_message_meta">
            <time datetime="2026-02-21T07:00:00+00:00"></time>
          </span>
        </div>
      </div>
    </div>
  </div>
</div>
"""

SAMPLE_NO_TEXT_HTML = """
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message text_not_supported_wrap js-widget_message"
       data-post="ImgCh/50">
    <div class="tgme_widget_message_bubble">
      <div class="tgme_widget_message_footer">
        <div class="tgme_widget_message_info">
          <span class="tgme_widget_message_views">200</span>
          <span class="tgme_widget_message_meta">
            <time datetime="2026-02-21T06:00:00+00:00"></time>
          </span>
        </div>
      </div>
    </div>
  </div>
</div>
"""

SAMPLE_UNICODE_HTML = """
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message text_not_supported_wrap js-widget_message"
       data-post="KrCh/200">
    <div class="tgme_widget_message_bubble">
      <div class="tgme_widget_message_text js-message_text">
        🏹 #삼성전자 「반도체 사이클 턴어라운드 시작」
      </div>
      <div class="tgme_widget_message_footer">
        <div class="tgme_widget_message_info">
          <span class="tgme_widget_message_views">12.5K</span>
          <span class="tgme_widget_message_meta">
            <time datetime="2026-02-21T11:00:00+00:00"></time>
          </span>
        </div>
      </div>
    </div>
  </div>
</div>
"""


# ── Helper ─────────────────────────────────────────────────────────────────────

def _make_temp_db():
    """Create a temporary DB path for testing."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return Path(path)


# ═══════════════════════════════════════════════════════════════════════════════
# P0: Core functionality tests
# ═══════════════════════════════════════════════════════════════════════════════


class TestParseCount(unittest.TestCase):
    def test_plain_number(self):
        self.assertEqual(_parse_count("500"), 500)

    def test_k_suffix(self):
        self.assertEqual(_parse_count("12.5K"), 12500)

    def test_m_suffix(self):
        self.assertEqual(_parse_count("1.2M"), 1200000)

    def test_empty(self):
        self.assertEqual(_parse_count(""), 0)

    def test_invalid(self):
        self.assertEqual(_parse_count("abc"), 0)

    def test_lowercase(self):
        self.assertEqual(_parse_count("4.6k"), 4600)

    def test_plain_large(self):
        self.assertEqual(_parse_count("99999"), 99999)


class TestFormatCount(unittest.TestCase):
    def test_small(self):
        self.assertEqual(_format_count(500), "500")

    def test_thousands(self):
        self.assertEqual(_format_count(12500), "12.5K")

    def test_millions(self):
        self.assertEqual(_format_count(1200000), "1.2M")

    def test_zero(self):
        self.assertEqual(_format_count(0), "0")


class TestTruncate(unittest.TestCase):
    def test_short(self):
        self.assertEqual(_truncate("hello", 10), "hello")

    def test_exact(self):
        self.assertEqual(_truncate("12345", 5), "12345")

    def test_long(self):
        result = _truncate("hello world!", 6)
        self.assertEqual(len(result), 6)
        self.assertTrue(result.endswith("…"))


class TestFirstLine(unittest.TestCase):
    def test_simple(self):
        self.assertEqual(_first_line("First line\nSecond line"), "First line")

    def test_empty(self):
        self.assertEqual(_first_line(""), "(내용 없음)")

    def test_strips_symbols(self):
        result = _first_line("☞ Some text here")
        self.assertIn("Some text here", result)

    def test_truncates(self):
        long = "A" * 100
        result = _first_line(long, max_len=20)
        self.assertLessEqual(len(result), 20)


class TestPopularPostParser(unittest.TestCase):
    def test_basic_message(self):
        posts, _ = parse_archive_page(SAMPLE_MESSAGE_HTML)
        self.assertEqual(len(posts), 1)
        p = posts[0]
        self.assertEqual(p["channel_id"], "TestChannel")
        self.assertEqual(p["msg_id"], 42)
        self.assertIn("Hello world", p["text"])
        self.assertEqual(p["views"], 4620)
        self.assertEqual(p["link"], "https://t.me/TestChannel/42")

    def test_reactions(self):
        posts, _ = parse_archive_page(SAMPLE_MESSAGE_HTML)
        self.assertEqual(posts[0]["reactions"], 20)  # 14 + 6

    def test_date(self):
        posts, _ = parse_archive_page(SAMPLE_MESSAGE_HTML)
        self.assertIn("2026-02-21", posts[0]["date"])

    def test_multi_messages(self):
        posts, _ = parse_archive_page(SAMPLE_MULTI_MSG_HTML)
        self.assertEqual(len(posts), 2)
        self.assertEqual(posts[0]["msg_id"], 100)
        self.assertEqual(posts[1]["msg_id"], 101)
        self.assertEqual(posts[0]["views"], 1500)
        self.assertEqual(posts[1]["views"], 3000)

    def test_pagination(self):
        _, before = parse_archive_page(SAMPLE_PAGINATION_HTML)
        self.assertEqual(before, "99")

    def test_no_text_message(self):
        """Messages without text div should still be captured if they have msg_id."""
        posts, _ = parse_archive_page(SAMPLE_NO_TEXT_HTML)
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["text"], "")
        self.assertEqual(posts[0]["views"], 200)

    def test_unicode(self):
        posts, _ = parse_archive_page(SAMPLE_UNICODE_HTML)
        self.assertEqual(len(posts), 1)
        self.assertIn("삼성전자", posts[0]["text"])
        self.assertEqual(posts[0]["views"], 12500)

    def test_empty_html(self):
        posts, before = parse_archive_page("")
        self.assertEqual(posts, [])
        self.assertIsNone(before)


class TestComputePopularityScore(unittest.TestCase):
    def test_basic(self):
        score = compute_popularity_score(1000, 10, 0, 1000)
        self.assertGreater(score, 0)

    def test_high_views(self):
        low = compute_popularity_score(100, 0, 0, 1000)
        high = compute_popularity_score(10000, 0, 0, 1000)
        self.assertGreater(high, low)

    def test_recency_decay(self):
        recent = compute_popularity_score(1000, 0, 1, 1000)
        old = compute_popularity_score(1000, 0, 24, 1000)
        self.assertGreater(recent, old)

    def test_channel_normalization(self):
        """Small channel with few views relative to avg = low score."""
        big_ch = compute_popularity_score(5000, 0, 0, 10000)
        small_ch = compute_popularity_score(5000, 0, 0, 500)
        self.assertGreater(small_ch, big_ch)

    def test_zero_avg(self):
        """Should not divide by zero."""
        score = compute_popularity_score(1000, 0, 0, 0)
        self.assertGreater(score, 0)

    def test_reactions_boost(self):
        no_react = compute_popularity_score(1000, 0, 0, 1000)
        with_react = compute_popularity_score(1000, 50, 0, 1000)
        self.assertGreater(with_react, no_react)


# ── DB Tests ──────────────────────────────────────────────────────────────────

class TestDB(unittest.TestCase):
    def setUp(self):
        self.db_path = _make_temp_db()
        init_db(self.db_path)

    def tearDown(self):
        try:
            self.db_path.unlink()
        except OSError:
            pass

    def test_init_creates_table(self):
        with sqlite3.connect(str(self.db_path)) as conn:
            tables = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
            names = [t[0] for t in tables]
            self.assertIn("popular_posts", names)

    def test_save_and_read(self):
        posts = [{
            "channel_id": "test_ch", "channel_name": "Test Channel",
            "msg_id": 1, "text": "Hello", "views": 100, "reactions": 5,
            "date": "2026-02-21T10:00:00+00:00", "link": "https://t.me/test_ch/1",
        }]
        save_posts(posts, db_path=self.db_path)
        recent = get_recent_posts(hours=24, db_path=self.db_path)
        self.assertEqual(len(recent), 1)
        self.assertEqual(recent[0]["channel_id"], "test_ch")
        self.assertEqual(recent[0]["views"], 100)

    def test_upsert_views_increase(self):
        posts = [{"channel_id": "ch", "msg_id": 1, "views": 100,
                  "reactions": 0, "date": "", "link": "", "text": "x",
                  "channel_name": ""}]
        save_posts(posts, db_path=self.db_path)

        # Update with higher views
        posts[0]["views"] = 200
        save_posts(posts, db_path=self.db_path)

        recent = get_recent_posts(hours=24, db_path=self.db_path)
        self.assertEqual(len(recent), 1)
        self.assertEqual(recent[0]["views"], 200)

    def test_upsert_views_no_decrease(self):
        posts = [{"channel_id": "ch", "msg_id": 1, "views": 200,
                  "reactions": 0, "date": "", "link": "", "text": "x",
                  "channel_name": ""}]
        save_posts(posts, db_path=self.db_path)

        # Try to update with lower views
        posts[0]["views"] = 50
        save_posts(posts, db_path=self.db_path)

        recent = get_recent_posts(hours=24, db_path=self.db_path)
        self.assertEqual(recent[0]["views"], 200)  # should keep higher

    def test_channel_avg_views(self):
        posts = [
            {"channel_id": "ch1", "msg_id": i, "views": v,
             "reactions": 0, "date": "", "link": "", "text": f"msg{i}",
             "channel_name": "Ch1"}
            for i, v in [(1, 100), (2, 200), (3, 300)]
        ]
        save_posts(posts, db_path=self.db_path)
        avgs = get_all_channel_avg_views(db_path=self.db_path)
        self.assertIn("ch1", avgs)
        self.assertAlmostEqual(avgs["ch1"], 200.0, places=0)

    def test_update_scores(self):
        posts = [{"channel_id": "ch", "msg_id": 1, "views": 100,
                  "reactions": 0, "date": "", "link": "", "text": "x",
                  "channel_name": ""}]
        save_posts(posts, db_path=self.db_path)
        update_scores({("ch", 1): 42.5}, db_path=self.db_path)

        with sqlite3.connect(str(self.db_path)) as conn:
            score = conn.execute(
                "SELECT popularity_score FROM popular_posts WHERE msg_id=1"
            ).fetchone()[0]
            self.assertAlmostEqual(score, 42.5)

    def test_cleanup_old(self):
        # Insert a post and manually set scraped_at to 60 days ago
        posts = [{"channel_id": "ch", "msg_id": 1, "views": 100,
                  "reactions": 0, "date": "", "link": "", "text": "old",
                  "channel_name": ""}]
        save_posts(posts, db_path=self.db_path)

        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("""
                UPDATE popular_posts
                SET scraped_at = datetime('now', 'localtime', '-60 days')
                WHERE msg_id = 1
            """)
            conn.commit()

        cleanup_old_posts(days=30, db_path=self.db_path)

        with sqlite3.connect(str(self.db_path)) as conn:
            count = conn.execute(
                "SELECT COUNT(*) FROM popular_posts"
            ).fetchone()[0]
            self.assertEqual(count, 0)

    def test_channel_stats(self):
        posts = [
            {"channel_id": "ch1", "msg_id": i, "views": 1000 * i,
             "reactions": 0, "date": "", "link": "", "text": f"m{i}",
             "channel_name": "Channel One"}
            for i in range(1, 4)
        ]
        save_posts(posts, db_path=self.db_path)
        stats = get_channel_stats(db_path=self.db_path)
        self.assertEqual(len(stats), 1)
        self.assertEqual(stats[0]["post_count"], 3)
        self.assertEqual(stats[0]["max_views"], 3000)


# ═══════════════════════════════════════════════════════════════════════════════
# P1: Error handling & edge cases
# ═══════════════════════════════════════════════════════════════════════════════


class TestSplitMessage(unittest.TestCase):
    def test_short_message(self):
        chunks = _split_message("Hello", max_len=100)
        self.assertEqual(chunks, ["Hello"])

    def test_split_by_lines(self):
        text = "\n".join([f"Line {i}" for i in range(100)])
        chunks = _split_message(text, max_len=100)
        self.assertTrue(all(len(c) <= 100 for c in chunks))
        self.assertGreater(len(chunks), 1)

    def test_very_long_line(self):
        text = "A" * 5000
        chunks = _split_message(text, max_len=4096)
        self.assertTrue(all(len(c) <= 4096 for c in chunks))
        self.assertEqual("".join(chunks), text)

    def test_empty(self):
        chunks = _split_message("")
        self.assertEqual(chunks, [""])


class TestLLMAnalysis(unittest.TestCase):
    @patch("pipeline.telegram_popular_posts.llm_chat_with_fallback")
    def test_success(self, mock_llm):
        mock_llm.return_value = (
            json.dumps({
                "sentiment": 15,
                "sentiment_label": "약간 긍정",
                "keywords": [{"word": "반도체", "count": 5}],
                "stocks": [{"name": "삼성전자", "score": 30}],
                "summary": "반도체 분위기 좋음",
            }),
            "gpt-5-mini", "",
        )
        result = analyze_posts([{"text": "test", "views": 100,
                                 "channel_name": "ch"}])
        self.assertEqual(result["sentiment"], 15)
        self.assertEqual(len(result["keywords"]), 1)

    @patch("pipeline.telegram_popular_posts.llm_chat_with_fallback")
    def test_llm_failure(self, mock_llm):
        mock_llm.return_value = ("", "", "timeout")
        result = analyze_posts([{"text": "test", "views": 100,
                                 "channel_name": "ch"}])
        self.assertEqual(result["sentiment"], 0)
        self.assertIn("실패", result["sentiment_label"])

    @patch("pipeline.telegram_popular_posts.llm_chat_with_fallback")
    def test_bad_json(self, mock_llm):
        mock_llm.return_value = ("not valid json{}", "gpt-5-mini", "")
        result = analyze_posts([{"text": "test", "views": 100,
                                 "channel_name": "ch"}])
        self.assertIn("파싱 실패", result["sentiment_label"])

    def test_empty_posts(self):
        result = analyze_posts([])
        self.assertEqual(result["sentiment"], 0)

    @patch("pipeline.telegram_popular_posts.llm_chat_with_fallback")
    def test_code_fence_strip(self, mock_llm):
        mock_llm.return_value = (
            '```json\n{"sentiment":5,"sentiment_label":"약간 긍정",'
            '"keywords":[],"stocks":[],"summary":"ok"}\n```',
            "gpt-5-mini", "",
        )
        result = analyze_posts([{"text": "test", "views": 100,
                                 "channel_name": "ch"}])
        self.assertEqual(result["sentiment"], 5)


class TestFormatReport(unittest.TestCase):
    def test_basic_format(self):
        posts = [{
            "text": "Test post content", "views": 5000, "reactions": 10,
            "link": "https://t.me/ch/1", "channel_name": "TestCh",
            "channel_id": "ch", "popularity_score": 50.0,
        }]
        analysis = {
            "sentiment": 12, "sentiment_label": "약간 긍정",
            "keywords": [{"word": "반도체", "count": 5}],
            "stocks": [{"name": "삼성전자", "score": 30}],
            "summary": "테스트 요약",
        }
        report = format_report(posts, analysis, 10, 50)
        self.assertIn("인기 분석 리포트", report)
        self.assertIn("10개 채널", report)
        self.assertIn("50개 게시물", report)
        self.assertIn("+12", report)
        self.assertIn("반도체", report)
        self.assertIn("삼성전자", report)
        self.assertIn("TestCh", report)

    def test_empty_analysis(self):
        posts = [{
            "text": "Post", "views": 100, "reactions": 0,
            "link": "", "channel_name": "Ch",
            "channel_id": "ch", "popularity_score": 10.0,
        }]
        analysis = {"sentiment": 0, "sentiment_label": "", "keywords": [],
                     "stocks": [], "summary": ""}
        report = format_report(posts, analysis, 1, 1)
        self.assertIn("인기 분석 리포트", report)

    def test_no_posts(self):
        analysis = {"sentiment": 0, "sentiment_label": "", "keywords": [],
                     "stocks": [], "summary": ""}
        report = format_report([], analysis, 0, 0)
        self.assertIn("TOP 0", report)

    def test_negative_sentiment(self):
        analysis = {"sentiment": -42, "sentiment_label": "부정",
                     "keywords": [], "stocks": [], "summary": ""}
        report = format_report([], analysis, 1, 1)
        self.assertIn("-42", report)
        self.assertNotIn("+-42", report)


class TestLoadChannels(unittest.TestCase):
    def test_valid_file(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json",
                                         delete=False) as f:
            json.dump({"channels": [
                {"id": "ch1", "name": "Channel 1"},
                {"id": "ch2", "name": "Channel 2", "enabled": False},
            ]}, f)
            f.flush()
            channels = load_channels(Path(f.name))
        os.unlink(f.name)
        self.assertEqual(len(channels), 1)
        self.assertEqual(channels[0]["id"], "ch1")

    def test_missing_file(self):
        channels = load_channels(Path("/nonexistent/path.json"))
        self.assertEqual(channels, [])

    def test_invalid_json(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json",
                                         delete=False) as f:
            f.write("not json{{{")
            f.flush()
            channels = load_channels(Path(f.name))
        os.unlink(f.name)
        self.assertEqual(channels, [])


# ═══════════════════════════════════════════════════════════════════════════════
# P2: Integration & edge cases
# ═══════════════════════════════════════════════════════════════════════════════


class TestState(unittest.TestCase):
    def test_round_trip(self):
        with tempfile.TemporaryDirectory() as td:
            state_file = Path(td) / "state.json"
            with patch("pipeline.telegram_popular_posts.STATE_FILE", state_file), \
                 patch("pipeline.telegram_popular_posts.MEMORY_DIR", Path(td)):
                save_state({"last_run": "2026-02-21T10:00:00", "count": 42})
                loaded = load_state()
                self.assertEqual(loaded["count"], 42)

    def test_missing_state(self):
        with patch("pipeline.telegram_popular_posts.STATE_FILE",
                   Path("/nonexistent/state.json")):
            state = load_state()
            self.assertEqual(state, {})


class TestRankPosts(unittest.TestCase):
    def setUp(self):
        self.db_path = _make_temp_db()
        init_db(self.db_path)

    def tearDown(self):
        try:
            self.db_path.unlink()
        except OSError:
            pass

    def test_ranking_order(self):
        posts = [
            {"channel_id": "ch", "msg_id": 1, "views": 100,
             "reactions": 0, "date": "2026-02-21T10:00:00+00:00",
             "link": "", "text": "low", "channel_name": ""},
            {"channel_id": "ch", "msg_id": 2, "views": 10000,
             "reactions": 50, "date": "2026-02-21T10:00:00+00:00",
             "link": "", "text": "high", "channel_name": ""},
        ]
        save_posts(posts, db_path=self.db_path)
        ranked = rank_posts(hours=48, limit=10, db_path=self.db_path)
        self.assertGreaterEqual(len(ranked), 2)
        self.assertEqual(ranked[0]["msg_id"], 2)

    def test_empty_db(self):
        ranked = rank_posts(hours=24, limit=10, db_path=self.db_path)
        self.assertEqual(ranked, [])


class TestSendTelegram(unittest.TestCase):
    @patch("pipeline.telegram_popular_posts._send_telegram_text")
    def test_notify_calls_dm_and_group(self, mock_send):
        from pipeline.telegram_popular_posts import notify_telegram
        mock_send.return_value = True
        ok = notify_telegram("Test message")
        self.assertTrue(ok)
        # Should call at least twice (DM + group)
        self.assertGreaterEqual(mock_send.call_count, 2)

    @patch("pipeline.telegram_popular_posts._send_telegram_text")
    def test_notify_partial_failure(self, mock_send):
        from pipeline.telegram_popular_posts import notify_telegram
        mock_send.side_effect = [True, False]
        ok = notify_telegram("Test")
        self.assertFalse(ok)


class TestParserEdgeCases(unittest.TestCase):
    def test_nested_divs_in_text(self):
        html = """
        <div class="tgme_widget_message_wrap js-widget_message_wrap">
          <div class="tgme_widget_message text_not_supported_wrap js-widget_message"
               data-post="Ch/1">
            <div class="tgme_widget_message_bubble">
              <div class="tgme_widget_message_text js-message_text">
                <div>Nested <b>bold</b> text</div>
                Outer text
              </div>
              <div class="tgme_widget_message_footer">
                <div class="tgme_widget_message_info">
                  <span class="tgme_widget_message_views">999</span>
                  <span class="tgme_widget_message_meta">
                    <time datetime="2026-02-21T12:00:00+00:00"></time>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
        """
        posts, _ = parse_archive_page(html)
        self.assertEqual(len(posts), 1)
        self.assertIn("Nested", posts[0]["text"])
        self.assertIn("bold", posts[0]["text"])

    def test_no_views(self):
        """Messages without views span should default to 0."""
        html = """
        <div class="tgme_widget_message_wrap js-widget_message_wrap">
          <div class="tgme_widget_message text_not_supported_wrap js-widget_message"
               data-post="Ch/1">
            <div class="tgme_widget_message_bubble">
              <div class="tgme_widget_message_text js-message_text">
                Text without views
              </div>
            </div>
          </div>
        </div>
        """
        posts, _ = parse_archive_page(html)
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["views"], 0)

    def test_br_becomes_newline(self):
        html = """
        <div class="tgme_widget_message_wrap js-widget_message_wrap">
          <div class="tgme_widget_message text_not_supported_wrap js-widget_message"
               data-post="Ch/1">
            <div class="tgme_widget_message_bubble">
              <div class="tgme_widget_message_text js-message_text">
                Line one<br/>Line two
              </div>
              <div class="tgme_widget_message_footer">
                <div class="tgme_widget_message_info">
                  <span class="tgme_widget_message_views">100</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        """
        posts, _ = parse_archive_page(html)
        self.assertIn("Line one", posts[0]["text"])
        self.assertIn("Line two", posts[0]["text"])


class TestCLI(unittest.TestCase):
    @patch("pipeline.telegram_popular_posts.run_pipeline")
    def test_dry_run(self, mock_run):
        mock_run.return_value = {"channels": 5, "posts": 20}
        from pipeline.telegram_popular_posts import main
        with patch("sys.argv", ["prog", "--dry-run", "--limit-channels", "5"]):
            main()
        mock_run.assert_called_once_with(
            notify=False, dry_run=True, limit_channels=5,
        )

    @patch("pipeline.telegram_popular_posts.print_stats")
    def test_stats_mode(self, mock_stats):
        from pipeline.telegram_popular_posts import main
        with patch("sys.argv", ["prog", "--stats"]):
            main()
        mock_stats.assert_called_once()


class TestRunPipeline(unittest.TestCase):
    @patch("pipeline.telegram_popular_posts.load_channels")
    def test_no_channels_error(self, mock_load):
        mock_load.return_value = []
        from pipeline.telegram_popular_posts import run_pipeline
        result = run_pipeline()
        self.assertIn("error", result)

    @patch("pipeline.telegram_popular_posts.save_state")
    @patch("pipeline.telegram_popular_posts.load_state")
    @patch("pipeline.telegram_popular_posts.cleanup_old_reports")
    @patch("pipeline.telegram_popular_posts.cleanup_old_posts")
    @patch("pipeline.telegram_popular_posts.analyze_posts")
    @patch("pipeline.telegram_popular_posts.rank_posts")
    @patch("pipeline.telegram_popular_posts.save_posts")
    @patch("pipeline.telegram_popular_posts.scrape_all_channels")
    @patch("pipeline.telegram_popular_posts.init_db")
    @patch("pipeline.telegram_popular_posts.load_channels")
    def test_no_posts_graceful(self, mock_load, mock_init, mock_scrape,
                                mock_save, mock_rank, mock_analyze,
                                mock_clean_p, mock_clean_r,
                                mock_load_s, mock_save_s):
        mock_load.return_value = [{"id": "ch1", "name": "Ch1"}]
        mock_scrape.return_value = []
        mock_load_s.return_value = {}

        from pipeline.telegram_popular_posts import run_pipeline
        result = run_pipeline()
        self.assertEqual(result["posts"], 0)
        mock_save.assert_not_called()


if __name__ == "__main__":
    unittest.main()
