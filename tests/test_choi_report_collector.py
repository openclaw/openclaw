"""test_choi_report_collector.py — 최광식 텔레그램 리포트 수집기 테스트"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from pipeline.choi_report_collector import (
    TelegramArchiveParser,
    parse_archive_page,
    _resolve_bitly,
    _is_pdf_url,
    _make_pdf_filename,
    _extract_tags,
    _extract_methods,
    _load_index,
    _save_index,
    _load_state,
    _save_state,
    _fetch_page,
    _download_pdf,
    _send_dm,
    collect_reports,
    show_stats,
    extract_methods_summary,
    METHOD_KEYWORDS,
    TAG_KEYWORDS,
    CHANNEL_URL,
    INDEX_FILE,
    STATE_FILE,
    OUTPUT_DIR,
    PDF_DIR,
)


# ── Mock HTML ─────────────────────────────────────────────────────

SAMPLE_HTML = """
<html>
<body>
<div class="tgme_widget_message_wrap">
  <div class="tgme_widget_message " data-post="HI_GS/5477">
    <div class="tgme_widget_message_text">
      HD현대중공업 4Q25 Review: 수주잔고 기반 이익 사이클 본격화
      <a href="https://bit.ly/HA4Q25RE">리포트 링크</a>
    </div>
    <time datetime="2026-02-20T09:30:00+09:00">Feb 20</time>
  </div>
</div>
<div class="tgme_widget_message_wrap">
  <div class="tgme_widget_message " data-post="HI_GS/5476">
    <div class="tgme_widget_message_text">
      한화오션 LNG 메가오더 수주 — 슈퍼사이클 2막 진입 신호
    </div>
    <time datetime="2026-02-19T14:00:00+09:00">Feb 19</time>
  </div>
</div>
<div class="tgme_widget_message_wrap">
  <div class="tgme_widget_message " data-post="HI_GS/5475">
    <div class="tgme_widget_message_text">
      탱커 국면 전환: CII 규제와 톤마일 효과
      <a href="https://bit.ly/tanker25">분석</a>
    </div>
    <time datetime="2026-02-18T10:00:00+09:00">Feb 18</time>
  </div>
</div>
</body>
</html>
"""

EMPTY_HTML = "<html><body><p>Nothing here</p></body></html>"


# ── HTML Parser Tests ─────────────────────────────────────────────

class TestTelegramArchiveParser:
    def test_parse_messages(self):
        msgs = parse_archive_page(SAMPLE_HTML)
        assert len(msgs) == 3

    def test_msg_id_extraction(self):
        msgs = parse_archive_page(SAMPLE_HTML)
        ids = [m["msg_id"] for m in msgs]
        assert 5477 in ids
        assert 5476 in ids
        assert 5475 in ids

    def test_date_extraction(self):
        msgs = parse_archive_page(SAMPLE_HTML)
        msg = next(m for m in msgs if m["msg_id"] == 5477)
        assert msg["date"] == "2026-02-20"

    def test_link_extraction(self):
        msgs = parse_archive_page(SAMPLE_HTML)
        msg = next(m for m in msgs if m["msg_id"] == 5477)
        assert any("bit.ly" in l for l in msg["links"])

    def test_text_extraction(self):
        msgs = parse_archive_page(SAMPLE_HTML)
        msg = next(m for m in msgs if m["msg_id"] == 5477)
        assert "HD현대중공업" in msg["text"]
        assert "수주잔고" in msg["text"]

    def test_empty_page(self):
        msgs = parse_archive_page(EMPTY_HTML)
        assert len(msgs) == 0

    def test_no_link_message(self):
        msgs = parse_archive_page(SAMPLE_HTML)
        msg = next(m for m in msgs if m["msg_id"] == 5476)
        assert len(msg["links"]) == 0


# ── Tag Extraction Tests ──────────────────────────────────────────

class TestTagExtraction:
    def test_company_tags(self):
        tags = _extract_tags("HD현대중공업 4Q25 실적 발표")
        assert "HD현대중공업" in tags
        assert "실적" in tags

    def test_vessel_type_tags(self):
        tags = _extract_tags("LNG운반선 수주 확대, 컨테이너선 시장 전환")
        assert "LNG" in tags
        assert "컨테이너" in tags

    def test_empty_text(self):
        tags = _extract_tags("")
        assert tags == []

    def test_multiple_tags(self):
        tags = _extract_tags("한화오션 잠수함 방산 수주 해양 플랜트")
        assert "한화오션" in tags
        assert "잠수함" in tags
        assert "방산" in tags
        assert "해양" in tags


# ── Method Extraction Tests ───────────────────────────────────────

class TestMethodExtraction:
    def test_backlog_cycle(self):
        methods = _extract_methods("수주잔고 기반 이익 사이클 분석")
        assert "backlog_cycle" in methods

    def test_supercycle(self):
        methods = _extract_methods("슈퍼사이클 2막론 진입 신호")
        assert "supercycle" in methods

    def test_tanker_structural(self):
        methods = _extract_methods("탱커 국면 전환 분석")
        assert "tanker_structural" in methods

    def test_regulation(self):
        methods = _extract_methods("EEXI 규제 영향과 CII 등급 하락")
        assert "regulation_impact" in methods

    def test_ton_mile(self):
        methods = _extract_methods("톤마일 수요 증가")
        assert "ton_mile" in methods

    def test_multiple_methods(self):
        methods = _extract_methods("수주잔고와 신조선가 상승, 슈퍼사이클 2막")
        assert "backlog_cycle" in methods
        assert "newbuild_price" in methods
        assert "supercycle" in methods

    def test_no_duplicates(self):
        methods = _extract_methods("탱커 국면과 탱커국면 동일 개념")
        assert methods.count("tanker_structural") == 1

    def test_empty_text(self):
        methods = _extract_methods("")
        assert methods == []

    def test_defense_catalyst(self):
        methods = _extract_methods("MASGA 프로그램과 K-방산 수출")
        assert "defense_catalyst" in methods

    def test_lng_mega_order(self):
        methods = _extract_methods("LNG 메가오더 수주 확대")
        assert "lng_mega_order" in methods

    def test_vessel_age(self):
        methods = _extract_methods("선령 20년 이상 노후선 비율")
        assert "vessel_age" in methods


# ── Bit.ly Resolution Tests ───────────────────────────────────────

class TestBitlyResolution:
    def test_is_pdf_url_true(self):
        assert _is_pdf_url("https://example.com/report.pdf") is True
        assert _is_pdf_url("https://example.com/file.PDF") is True

    def test_is_pdf_url_false(self):
        assert _is_pdf_url("https://example.com/page.html") is False
        assert _is_pdf_url("https://example.com/") is False

    def test_is_pdf_url_query_param(self):
        assert _is_pdf_url("https://example.com/view?file=report.pdf&type=pdf") is True

    def test_make_pdf_filename_from_bitly(self):
        fname = _make_pdf_filename(5477, "https://bit.ly/HA4Q25RE")
        assert fname == "HA4Q25RE.pdf"

    def test_make_pdf_filename_fallback(self):
        fname = _make_pdf_filename(5477, "https://bit.ly/")
        assert fname == "msg_5477.pdf"


# ── Index Management Tests ────────────────────────────────────────

class TestIndexManagement:
    def test_load_empty_index(self, tmp_path):
        with patch("pipeline.choi_report_collector.INDEX_FILE", tmp_path / "index.json"):
            idx = _load_index()
            assert idx["reports"] == []
            assert idx["last_msg_id"] == 0

    def test_save_and_load_index(self, tmp_path):
        idx_file = tmp_path / "index.json"
        with patch("pipeline.choi_report_collector.INDEX_FILE", idx_file), \
             patch("pipeline.choi_report_collector.OUTPUT_DIR", tmp_path):
            idx = {"reports": [{"msg_id": 100, "text": "test"}], "last_msg_id": 100, "total_reports": 1}
            _save_index(idx)
            loaded = _load_index()
            assert loaded["total_reports"] == 1
            assert loaded["reports"][0]["msg_id"] == 100
            assert loaded["last_updated"] is not None

    def test_load_corrupted_index(self, tmp_path):
        idx_file = tmp_path / "index.json"
        idx_file.write_text("not valid json")
        with patch("pipeline.choi_report_collector.INDEX_FILE", idx_file):
            idx = _load_index()
            assert idx["reports"] == []

    def test_save_and_load_state(self, tmp_path):
        state_file = tmp_path / "state.json"
        with patch("pipeline.choi_report_collector.STATE_FILE", state_file), \
             patch("pipeline.choi_report_collector.OUTPUT_DIR", tmp_path):
            state = {"last_collected_msg_id": 5477, "pages_fetched": 3}
            _save_state(state)
            loaded = _load_state()
            assert loaded["last_collected_msg_id"] == 5477
            assert loaded["last_run"] is not None


# ── Collection Tests ──────────────────────────────────────────────

class TestCollection:
    def test_collect_new_reports(self, tmp_path):
        """Test collecting reports from mock HTML."""
        with patch("pipeline.choi_report_collector.INDEX_FILE", tmp_path / "index.json"), \
             patch("pipeline.choi_report_collector.STATE_FILE", tmp_path / "state.json"), \
             patch("pipeline.choi_report_collector.OUTPUT_DIR", tmp_path), \
             patch("pipeline.choi_report_collector.PDF_DIR", tmp_path / "pdfs"), \
             patch("pipeline.choi_report_collector._fetch_page") as mock_fetch, \
             patch("pipeline.choi_report_collector._resolve_bitly", return_value=None):
            # First page returns messages, second returns empty
            mock_fetch.side_effect = [SAMPLE_HTML, EMPTY_HTML]
            summary = collect_reports(full=True)
            assert summary["new_reports"] == 3
            assert summary["total_reports"] == 3

    def test_collect_idempotent(self, tmp_path):
        """Collecting the same messages twice should not duplicate."""
        with patch("pipeline.choi_report_collector.INDEX_FILE", tmp_path / "index.json"), \
             patch("pipeline.choi_report_collector.STATE_FILE", tmp_path / "state.json"), \
             patch("pipeline.choi_report_collector.OUTPUT_DIR", tmp_path), \
             patch("pipeline.choi_report_collector.PDF_DIR", tmp_path / "pdfs"), \
             patch("pipeline.choi_report_collector._fetch_page") as mock_fetch, \
             patch("pipeline.choi_report_collector._resolve_bitly", return_value=None):
            mock_fetch.side_effect = [SAMPLE_HTML, EMPTY_HTML, SAMPLE_HTML, EMPTY_HTML]
            collect_reports(full=True)
            summary = collect_reports(full=True)
            assert summary["new_reports"] == 0
            assert summary["total_reports"] == 3

    def test_collect_with_pdf_download(self, tmp_path):
        """Test that PDF downloads are attempted for resolved bit.ly URLs."""
        with patch("pipeline.choi_report_collector.INDEX_FILE", tmp_path / "index.json"), \
             patch("pipeline.choi_report_collector.STATE_FILE", tmp_path / "state.json"), \
             patch("pipeline.choi_report_collector.OUTPUT_DIR", tmp_path), \
             patch("pipeline.choi_report_collector.PDF_DIR", tmp_path / "pdfs"), \
             patch("pipeline.choi_report_collector._fetch_page") as mock_fetch, \
             patch("pipeline.choi_report_collector._resolve_bitly") as mock_resolve, \
             patch("pipeline.choi_report_collector._download_pdf") as mock_dl:
            mock_fetch.side_effect = [SAMPLE_HTML, EMPTY_HTML]
            mock_resolve.return_value = "https://example.com/report.pdf"
            mock_dl.return_value = "pdfs/HA4Q25RE.pdf"
            summary = collect_reports(full=True)
            assert summary["pdfs_downloaded"] >= 1

    def test_collect_stops_at_known(self, tmp_path):
        """Non-full collection stops at last known message ID."""
        idx_file = tmp_path / "index.json"
        state_file = tmp_path / "state.json"
        # Pre-seed state with msg 5477 as last known
        state_file.write_text(json.dumps({"last_collected_msg_id": 5477, "pages_fetched": 1}))
        idx_file.write_text(json.dumps({
            "reports": [{"msg_id": 5477, "text": "existing"}],
            "last_msg_id": 5477, "total_reports": 1,
        }))
        with patch("pipeline.choi_report_collector.INDEX_FILE", idx_file), \
             patch("pipeline.choi_report_collector.STATE_FILE", state_file), \
             patch("pipeline.choi_report_collector.OUTPUT_DIR", tmp_path), \
             patch("pipeline.choi_report_collector.PDF_DIR", tmp_path / "pdfs"), \
             patch("pipeline.choi_report_collector._fetch_page") as mock_fetch, \
             patch("pipeline.choi_report_collector._resolve_bitly", return_value=None):
            # All messages have id <= 5477 so should stop
            mock_fetch.return_value = SAMPLE_HTML
            summary = collect_reports(full=False)
            # Only msg 5476 and 5475 are new (5477 already exists)
            assert summary["new_reports"] == 2


# ── Stats Tests ───────────────────────────────────────────────────

class TestStats:
    def test_stats_empty(self, tmp_path):
        with patch("pipeline.choi_report_collector.INDEX_FILE", tmp_path / "index.json"), \
             patch("pipeline.choi_report_collector.STATE_FILE", tmp_path / "state.json"):
            result = show_stats()
            assert "No reports collected" in result

    def test_stats_with_data(self, tmp_path):
        idx_file = tmp_path / "index.json"
        idx_file.write_text(json.dumps({
            "reports": [
                {"msg_id": 1, "date": "2026-01-01", "text": "test", "methods": ["backlog_cycle"], "pdf_path": None},
                {"msg_id": 2, "date": "2026-02-01", "text": "test2", "methods": [], "pdf_path": "pdfs/a.pdf"},
            ],
            "last_msg_id": 2, "total_reports": 2,
        }))
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"last_run": "2026-02-21T12:00:00"}))
        with patch("pipeline.choi_report_collector.INDEX_FILE", idx_file), \
             patch("pipeline.choi_report_collector.STATE_FILE", state_file):
            result = show_stats()
            assert "2건" in result
            assert "backlog_cycle" in result


# ── Extract Methods Summary Tests ─────────────────────────────────

class TestExtractMethodsSummary:
    def test_extract_methods_summary(self, tmp_path):
        idx_file = tmp_path / "index.json"
        idx_file.write_text(json.dumps({
            "reports": [
                {"msg_id": 1, "date": "2026-01-01", "text": "수주잔고 분석", "methods": ["backlog_cycle"]},
                {"msg_id": 2, "date": "2026-02-01", "text": "신조선가 동향", "methods": ["newbuild_price"]},
                {"msg_id": 3, "date": "2026-02-15", "text": "수주잔고와 톤마일", "methods": ["backlog_cycle", "ton_mile"]},
            ],
            "last_msg_id": 3, "total_reports": 3,
        }))
        with patch("pipeline.choi_report_collector.INDEX_FILE", idx_file):
            refs = extract_methods_summary()
            assert "backlog_cycle" in refs
            assert len(refs["backlog_cycle"]) == 2
            assert "newbuild_price" in refs
            assert "ton_mile" in refs


# ── Method Keywords Coverage ──────────────────────────────────────

class TestMethodKeywordsCoverage:
    def test_all_methods_have_ids(self):
        """All METHOD_KEYWORDS values should be non-empty strings."""
        for kw, method_id in METHOD_KEYWORDS.items():
            assert isinstance(method_id, str) and len(method_id) > 0, f"Bad method_id for {kw}"

    def test_tag_keywords_not_empty(self):
        assert len(TAG_KEYWORDS) >= 10


# ── DM Send Tests ─────────────────────────────────────────────────

class TestDMSend:
    def test_send_dm_success(self):
        with patch("pipeline.choi_report_collector.urllib.request.urlopen") as mock_open:
            mock_resp = MagicMock()
            mock_resp.status = 200
            mock_resp.__enter__ = MagicMock(return_value=mock_resp)
            mock_resp.__exit__ = MagicMock(return_value=False)
            mock_open.return_value = mock_resp
            assert _send_dm("test message") is True

    def test_send_dm_failure(self):
        import urllib.error
        with patch("pipeline.choi_report_collector.urllib.request.urlopen",
                   side_effect=urllib.error.URLError("fail")):
            assert _send_dm("test") is False
