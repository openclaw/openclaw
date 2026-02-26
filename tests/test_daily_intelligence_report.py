#!/usr/bin/env python3
"""Tests for daily_intelligence_report v2.0."""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

# Path setup
_TESTS_DIR = Path(__file__).resolve().parent
_SCRIPTS_DIR = _TESTS_DIR.parent / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))
sys.path.insert(0, str(_SCRIPTS_DIR / "pipeline"))

from pipeline.daily_intelligence_report import (
    SECTOR_MAP,
    _LABEL_MAP,
    _calc_market_temperature,
    _clean_llm_text,
    _fmt_ind,
    _fmt_num,
    _load_market_data,
    _load_geo_data,
    _load_social_data,
    _load_hypotheses,
    _brief_anomaly,
    _pest_fallback,
    _split_message,
    build_sector_factcheck,
    build_falsification,
    build_executive_summary,
    collect_ops_section_brief,
)


# ── Fixtures ─────────────────────────────────────────────────────────

def _sample_market_data() -> dict:
    return {
        "indicators": {
            "VIX": {"close": 17.93, "change_pct": -8.29, "zscore": -0.58},
            "SPX": {"close": 6946.13, "change_pct": 0.81, "zscore": 0.77},
            "NDX": {"close": 23152.08, "change_pct": 1.26, "zscore": 0.33},
            "US10Y": {"close": 4.05, "change_pct": 0.37, "zscore": -1.15},
            "US2Y": {"close": 3.45, "change_pct": 0.0, "zscore": -0.38},
            "DXY": {"close": 97.59, "change_pct": -0.3, "zscore": 0.58},
            "USDKRW": {"close": 1423.18, "change_pct": -1.17, "zscore": -2.04},
            "USDJPY": {"close": 155.94, "change_pct": 0.04, "zscore": 0.76},
            "EURUSD": {"close": 1.18, "change_pct": 0.39, "zscore": -0.29},
            "KOSPI": {"close": 6218.43, "change_pct": 2.21, "zscore": 2.11},
            "KOSDAQ": {"close": 1188.87, "change_pct": 2.03, "zscore": 1.83},
            "KR3Y": {"close": 3.12, "change_pct": -1.08, "zscore": 0.48},
            "SOFR": {"close": 3.59, "change_pct": 0.0, "zscore": -0.18},
            "CD91": {"close": 2.8, "change_pct": 0.0, "zscore": 0},
            "CP91": {"close": 3.11, "change_pct": 0.0, "zscore": 0},
            "KRC3Y": {"close": 3.71, "change_pct": -0.67, "zscore": 0},
            "CRSPRD": {"close": 0.59, "change_pct": 0.0, "zscore": 0},
            "GOLD": {"close": 5200.7, "change_pct": 0.87, "zscore": 1.1},
            "SILVER": {"close": 89.56, "change_pct": 2.4, "zscore": 0.52},
            "COPPER": {"close": 6.02, "change_pct": 1.61, "zscore": 1.21},
            "WTI": {"close": 65.51, "change_pct": -0.18, "zscore": 0.81},
            "NATGAS": {"close": 2.87, "change_pct": -1.54, "zscore": -0.6},
            "BDI": {"close": 11.68, "change_pct": -1.6, "zscore": 0.86},
            "SOXX": {"close": 368.0, "change_pct": 1.65, "zscore": 1.58},
            "DDR5": {"close": 39.333, "change_pct": 1.72, "zscore": 0},
            "NIKKEI": {"close": 58932.99, "change_pct": 0.6, "zscore": 1.55},
            "HSI": {"close": 26649.73, "change_pct": -0.43, "zscore": -0.8},
            "SSEC": {"close": 4144.08, "change_pct": -0.08, "zscore": 0.82},
            "GPR": {"close": 76.86, "change_pct": 7.24, "zscore": -0.7},
            "EPU_US": {"close": 725.27, "change_pct": 2.43, "zscore": 2.08},
            "EPU_GLOBAL": {"close": 389.43, "change_pct": 25.01, "zscore": 0.61},
        },
        "anomalies": [
            {"ticker": "VIX", "type": "high_change", "detail": "VIX 19.55→17.93 (-8.29%) 급락", "severity": "high"},
            {"ticker": "GPR", "type": "high_change", "detail": "GPR 71.67→76.86 (+7.24%) 급등", "severity": "high"},
            {"ticker": "EPU_GLOBAL", "type": "high_change", "detail": "EPU(글로벌) +25.01% 급등", "severity": "high"},
            {"ticker": "KOSPI", "type": "combined", "detail": "코스피 +2.21% 급등, z=2.1", "severity": "medium"},
        ],
        "credit_data": {
            "date": "2026/02/24",
            "credit_balance": 31.51,
            "ratio": 29.2,
            "ratio_change": 0.33,
            "signal": "매수 고려",
        },
    }


def _sample_geo_data() -> dict:
    return {
        "pentagon_index": {"doughcon": 3, "label": "ROUND HOUSE"},
        "gpr_epu": {"gpr": 76.86, "gpr_zscore": -0.7, "epu_us": 725.27, "epu_us_zscore": 2.08},
        "anomalies": [{"region": "pentagon", "type": "doughcon", "severity": "high", "value": 3}],
        "alert_level": "watch",
    }


def _sample_social_data() -> dict:
    return {
        "sentiment": 35,
        "keywords": ["투자", "실적", "매출", "반도체", "주가"],
        "blog_count": 10,
        "blog_titles": ["엔비디아 GPU 블랙웰의 미스테리"],
    }


# ── Tests ────────────────────────────────────────────────────────────


class TestSectorMap(unittest.TestCase):
    def test_sector_count(self):
        self.assertEqual(len(SECTOR_MAP), 8)

    def test_all_sectors_have_indicators(self):
        for name, cfg in SECTOR_MAP.items():
            self.assertIn("indicators", cfg, f"{name} missing indicators")
            self.assertIsInstance(cfg["indicators"], list)
            self.assertGreater(len(cfg["indicators"]), 0)

    def test_korea_has_credit(self):
        self.assertTrue(SECTOR_MAP["한국"].get("credit"))

    def test_it_semi_has_company(self):
        self.assertEqual(SECTOR_MAP["IT반도체"].get("company_subcategory"), "반도체")


class TestFmtInd(unittest.TestCase):
    def test_normal_value(self):
        indicators = {"SPX": {"close": 6946.13, "change_pct": 0.81, "zscore": 0.77}}
        result = _fmt_ind("SPX", indicators, set())
        self.assertEqual(result, "SPX 6946")

    def test_change_above_threshold(self):
        indicators = {"NDX": {"close": 23152, "change_pct": 1.26, "zscore": 0.33}}
        result = _fmt_ind("NDX", indicators, set())
        self.assertIn("+1.3", result)

    def test_z_score_flag(self):
        indicators = {"KOSPI": {"close": 6218, "change_pct": 2.21, "zscore": 2.11}}
        result = _fmt_ind("KOSPI", indicators, set())
        self.assertIn("z2.1", result)
        self.assertIn("!", result)

    def test_high_severity_flag(self):
        indicators = {"VIX": {"close": 17.93, "change_pct": -8.29, "zscore": -0.58}}
        result = _fmt_ind("VIX", indicators, {"VIX"})
        self.assertIn("!", result)
        self.assertIn("▼8.3", result)

    def test_label_map(self):
        indicators = {"USDKRW": {"close": 1423, "change_pct": -1.17, "zscore": -2.04}}
        result = _fmt_ind("USDKRW", indicators, set())
        self.assertTrue(result.startswith("KRW "))

    def test_missing_indicator(self):
        result = _fmt_ind("MISSING", {}, set())
        self.assertEqual(result, "MISSING -")

    def test_none_entry(self):
        result = _fmt_ind("X", {"X": None}, set())
        self.assertEqual(result, "X -")

    def test_negative_z_flag(self):
        indicators = {"X": {"close": 100, "change_pct": -1.5, "zscore": -2.5}}
        result = _fmt_ind("X", indicators, set())
        self.assertIn("z-2.5", result)
        self.assertIn("!", result)

    def test_small_change_no_display(self):
        indicators = {"X": {"close": 100, "change_pct": 0.5, "zscore": 0.3}}
        result = _fmt_ind("X", indicators, set())
        self.assertEqual(result, "X 100.0")


class TestLoadMarketData(unittest.TestCase):
    def test_loads_indicators(self):
        with tempfile.TemporaryDirectory() as tmp:
            mkt_dir = Path(tmp) / "market-indicators"
            mkt_dir.mkdir()
            data = {
                "indicators": {"VIX": {"close": 17.93}},
                "anomalies": [{"ticker": "VIX"}],
                "credit_data": {"ratio": 29.2},
            }
            (mkt_dir / "2026-02-26.json").write_text(json.dumps(data))
            with patch("pipeline.daily_intelligence_report.MEMORY", Path(tmp)):
                result = _load_market_data()
                self.assertEqual(result["indicators"]["VIX"]["close"], 17.93)
                self.assertEqual(len(result["anomalies"]), 1)
                self.assertEqual(result["credit_data"]["ratio"], 29.2)

    def test_empty_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch("pipeline.daily_intelligence_report.MEMORY", Path(tmp)):
                result = _load_market_data()
                self.assertEqual(result, {})

    def test_legacy_format_fallback(self):
        """If 'indicators' key missing, data dict itself is used."""
        with tempfile.TemporaryDirectory() as tmp:
            mkt_dir = Path(tmp) / "market-indicators"
            mkt_dir.mkdir()
            data = {"VIX": {"close": 17.93}}
            (mkt_dir / "2026-02-26.json").write_text(json.dumps(data))
            with patch("pipeline.daily_intelligence_report.MEMORY", Path(tmp)):
                result = _load_market_data()
                self.assertIn("VIX", result["indicators"])


class TestLoadGeoData(unittest.TestCase):
    def test_loads_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            geo_dir = Path(tmp) / "geopolitical"
            geo_dir.mkdir()
            data = {"pentagon_index": {"doughcon": 3}}
            (geo_dir / "2026-02-26.json").write_text(json.dumps(data))
            with patch("pipeline.daily_intelligence_report.MEMORY", Path(tmp)):
                result = _load_geo_data()
                self.assertEqual(result["pentagon_index"]["doughcon"], 3)

    def test_excludes_watchlist(self):
        with tempfile.TemporaryDirectory() as tmp:
            geo_dir = Path(tmp) / "geopolitical"
            geo_dir.mkdir()
            (geo_dir / "watchlist.json").write_text(json.dumps({"ignore": True}))
            (geo_dir / "2026-02-26.json").write_text(json.dumps({"doughcon": 3}))
            with patch("pipeline.daily_intelligence_report.MEMORY", Path(tmp)):
                result = _load_geo_data()
                self.assertNotIn("ignore", result)


class TestLoadSocialData(unittest.TestCase):
    def test_parses_sentiment(self):
        with tempfile.TemporaryDirectory() as tmp:
            pp_dir = Path(tmp) / "popular-posts" / "reports"
            pp_dir.mkdir(parents=True)
            report = "종합 감성: +15 (약간 긍정)\n\n*주요 키워드*\n투자 (12) · 실적 (8)\n"
            (pp_dir / "report-2026-02-26.md").write_text(report)
            with patch("pipeline.daily_intelligence_report.MEMORY", Path(tmp)):
                result = _load_social_data()
                self.assertEqual(result["sentiment"], 15)
                self.assertIn("투자", result["keywords"])

    def test_adds_twitter_sentiment(self):
        with tempfile.TemporaryDirectory() as tmp:
            pp_dir = Path(tmp) / "popular-posts" / "reports"
            pp_dir.mkdir(parents=True)
            (pp_dir / "r1.md").write_text("종합 감성: +15")
            tw_dir = Path(tmp) / "twitter-collector" / "reports"
            tw_dir.mkdir(parents=True)
            (tw_dir / "r1.md").write_text("종합 감성: +20")
            with patch("pipeline.daily_intelligence_report.MEMORY", Path(tmp)):
                result = _load_social_data()
                self.assertEqual(result["sentiment"], 35)

    def test_empty_reports(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch("pipeline.daily_intelligence_report.MEMORY", Path(tmp)):
                result = _load_social_data()
                self.assertEqual(result["sentiment"], 0)
                self.assertEqual(result["keywords"], [])


class TestLoadHypotheses(unittest.TestCase):
    def test_loads_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            hypo_dir = Path(tmp) / "hypotheses"
            hypo_dir.mkdir()
            data = [{"id": "h1", "domain": "investment", "status": "proposed",
                     "hypothesis": "test hypothesis"}]
            (hypo_dir / "hypothesis_2026-02-26.json").write_text(json.dumps(data))
            with patch("pipeline.daily_intelligence_report.MEMORY", Path(tmp)):
                result = _load_hypotheses()
                self.assertEqual(len(result), 1)
                self.assertEqual(result[0]["domain"], "investment")

    def test_filters_by_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            hypo_dir = Path(tmp) / "hypotheses"
            hypo_dir.mkdir()
            data = [
                {"id": "h1", "status": "proposed", "hypothesis": "active"},
                {"id": "h2", "status": "rejected", "hypothesis": "rejected"},
            ]
            (hypo_dir / "h.json").write_text(json.dumps(data))
            with patch("pipeline.daily_intelligence_report.MEMORY", Path(tmp)):
                result = _load_hypotheses()
                self.assertEqual(len(result), 1)
                self.assertEqual(result[0]["id"], "h1")


class TestBuildSectorFactcheck(unittest.TestCase):
    def test_all_sections(self):
        mkt = _sample_market_data()
        geo = _sample_geo_data()
        social = _sample_social_data()
        result = build_sector_factcheck(mkt, geo, social, ["NVDA", "INTC"])
        # Table sections present
        for section in ("금리", "환율", "주가지수", "한국", "원자재", "변동성"):
            self.assertIn(section, result)

    def test_has_dod_mom_yoy_header(self):
        mkt = _sample_market_data()
        result = build_sector_factcheck(mkt, {}, {}, [])
        self.assertIn("DoD", result)
        self.assertIn("MoM", result)
        self.assertIn("YoY", result)

    def test_has_doughcon_and_epu(self):
        mkt = _sample_market_data()
        geo = _sample_geo_data()
        result = build_sector_factcheck(mkt, geo, {}, [])
        self.assertIn("DOUGHCON 3", result)
        self.assertIn("EPU", result)

    def test_korea_has_credit(self):
        mkt = _sample_market_data()
        result = build_sector_factcheck(mkt, {}, {}, [])
        self.assertIn("신용29.2%", result)
        self.assertIn("매수 고려", result)

    def test_company_tickers(self):
        mkt = _sample_market_data()
        result = build_sector_factcheck(mkt, {}, {}, ["NVDA", "LITE"])
        self.assertIn("기업: NVDA,LITE", result)

    def test_flagged_markers(self):
        mkt = _sample_market_data()
        result = build_sector_factcheck(mkt, {}, {}, [])
        # VIX (high severity) and KOSPI (z=2.11) → ◆ marker
        self.assertIn("◆VIX", result)
        self.assertIn("◆KOSPI", result)

    def test_empty_data(self):
        result = build_sector_factcheck({}, {}, {}, [])
        # Table sections still present
        self.assertIn("금리", result)
        self.assertIn("환율", result)
        # Indicator rows show "-"
        self.assertIn(" -", result)


@patch("pipeline.daily_intelligence_report.llm_chat_with_fallback",
       return_value=("", "", "mock"))
class TestBuildFalsification(unittest.TestCase):
    """LLM mock으로 규칙 기반 플래그만 테스트 (LLM 실패 → 원문 fallback)."""
    def test_detects_high_severity(self, _mock):
        mkt = _sample_market_data()
        geo = _sample_geo_data()
        result = build_falsification(mkt, geo, [])
        self.assertIn("VIX", result)

    def test_detects_epu_spike(self, _mock):
        mkt = _sample_market_data()
        result = build_falsification(mkt, {}, [])
        self.assertIn("EPU", result)

    def test_max_4_flags(self, _mock):
        mkt = _sample_market_data()
        geo = _sample_geo_data()
        result = build_falsification(mkt, geo, [])
        flag_count = result.count("!")
        self.assertLessEqual(flag_count, 4)

    def test_no_action_with_clean_data(self, _mock):
        mkt = {
            "indicators": {"SPX": {"close": 100, "change_pct": 0.5, "zscore": 0.3}},
            "anomalies": [],
            "credit_data": {},
        }
        result = build_falsification(mkt, {}, [])
        self.assertIn("무행동", result)

    def test_doughcon_escalation(self, _mock):
        mkt = {"indicators": {}, "anomalies": [], "credit_data": {}}
        geo = {"pentagon_index": {"doughcon": 2}}
        result = build_falsification(mkt, geo, [])
        self.assertIn("DOUGHCON 2", result)

    def test_credit_divergence(self, _mock):
        mkt = {
            "indicators": {"KOSPI": {"close": 6000, "change_pct": 2.0, "zscore": 1.0}},
            "anomalies": [],
            "credit_data": {"signal": "매도 고려"},
        }
        result = build_falsification(mkt, {}, [])
        self.assertIn("신용", result)

    def test_vix_divergence(self, _mock):
        mkt = {
            "indicators": {
                "VIX": {"close": 15, "change_pct": -6.0, "zscore": -0.5},
                "SPX": {"close": 7000, "change_pct": 1.5, "zscore": 0.8},
            },
            "anomalies": [],
            "credit_data": {},
        }
        result = build_falsification(mkt, {}, [])
        self.assertIn("VIX", result)

    def test_investment_hypothesis_crosscheck(self, _mock):
        mkt = {"indicators": {}, "anomalies": [], "credit_data": {}}
        hypos = [{"domain": "investment", "hypothesis": "매수 타이밍 가설", "status": "proposed"}]
        result = build_falsification(mkt, {}, hypos)
        self.assertIn("가설검증", result)


class TestBriefAnomaly(unittest.TestCase):
    def test_surge(self):
        self.assertEqual(_brief_anomaly({"detail": "GPR 급등"}), "급등")

    def test_drop(self):
        self.assertEqual(_brief_anomaly({"detail": "VIX 급락"}), "급락")

    def test_breach(self):
        self.assertEqual(_brief_anomaly({"detail": "원/달러 이탈"}), "이탈")

    def test_fallback(self):
        result = _brief_anomaly({"detail": "something else happened"})
        self.assertLessEqual(len(result), 12)


class TestPestFallback(unittest.TestCase):
    def test_produces_four_lines(self):
        mkt = _sample_market_data()
        geo = _sample_geo_data()
        social = _sample_social_data()
        result = _pest_fallback(mkt, geo, social)
        lines = result.strip().split("\n")
        self.assertEqual(len(lines), 4)
        self.assertTrue(lines[0].startswith("P:"))
        self.assertTrue(lines[1].startswith("E:"))
        self.assertTrue(lines[2].startswith("S:"))
        self.assertTrue(lines[3].startswith("T:"))

    def test_directions(self):
        mkt = _sample_market_data()
        social = _sample_social_data()
        result = _pest_fallback(mkt, {}, social)
        # With VIX -8.3% and KOSPI +2.2%, E should be ▲
        self.assertIn("▲", result.split("\n")[1])
        # Sentiment +35, S should be ▲
        self.assertIn("▲", result.split("\n")[2])

    def test_empty_data(self):
        result = _pest_fallback({}, {}, {})
        lines = result.strip().split("\n")
        self.assertEqual(len(lines), 4)


class TestBuildExecutiveSummary(unittest.TestCase):
    @patch("pipeline.daily_intelligence_report.llm_chat_with_fallback")
    def test_llm_success(self, mock_llm):
        mock_llm.return_value = (
            "원라이너: 시장은 낙관의 바다에 떠 있다.\n"
            "판단: 관망 | 확신 중 | 유효 1주일\n"
            "무효화: VIX 25 돌파 시 재평가",
            "test-model", "",
        )
        result = build_executive_summary("fc", "pest", "falsification", {})
        self.assertIn("원라이너:", result)
        self.assertIn("판단:", result)
        self.assertIn("무효화:", result)

    @patch("pipeline.daily_intelligence_report.llm_chat_with_fallback")
    def test_llm_failure_fallback(self, mock_llm):
        mock_llm.side_effect = Exception("timeout")
        result = build_executive_summary("fc", "pest", "! flag1\n! flag2\n! flag3", {})
        self.assertIn("판단:", result)
        self.assertIn("원라이너:", result)
        self.assertIn("무효화:", result)

    @patch("pipeline.daily_intelligence_report.llm_chat_with_fallback")
    def test_fallback_no_flags(self, mock_llm):
        mock_llm.side_effect = Exception("timeout")
        result = build_executive_summary("fc", "pest", "무행동", {})
        self.assertIn("무행동", result)
        self.assertIn("원라이너:", result)

    @patch("pipeline.daily_intelligence_report.llm_chat_with_fallback")
    def test_strips_markdown(self, mock_llm):
        mock_llm.return_value = (
            "**원라이너:** 테스트 원라이너\n**판단:** 관망 | 확신 중 | 유효 1주일\n**무효화:** 테스트",
            "test-model", "",
        )
        result = build_executive_summary("fc", "pest", "! flag", {})
        self.assertNotIn("**", result)
        self.assertIn("판단:", result)


class TestCollectOpsSectionBrief(unittest.TestCase):
    @patch("pipeline.daily_intelligence_report.check_gateway")
    @patch("pipeline.daily_intelligence_report.subprocess.run")
    def test_format(self, mock_run, mock_gw):
        mock_gw.return_value = True
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "123\n456\n789\n"
        mock_run.return_value = mock_result
        with tempfile.TemporaryDirectory() as tmp:
            with patch("pipeline.daily_intelligence_report.MEMORY", Path(tmp)):
                result = collect_ops_section_brief(Path("/dev/null"))
                self.assertIn("GW", result)
                self.assertIn("W3/5", result)
                self.assertIn("블로그", result)
                self.assertIn("가설", result)

    @patch("pipeline.daily_intelligence_report.check_gateway")
    @patch("pipeline.daily_intelligence_report.subprocess.run")
    def test_gateway_down(self, mock_run, mock_gw):
        mock_gw.return_value = False
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stdout = ""
        mock_run.return_value = mock_result
        with tempfile.TemporaryDirectory() as tmp:
            with patch("pipeline.daily_intelligence_report.MEMORY", Path(tmp)):
                result = collect_ops_section_brief(Path("/dev/null"))
                self.assertIn("W0/5", result)


class TestFmtNum(unittest.TestCase):
    def test_float(self):
        self.assertEqual(_fmt_num(17.93), "17.9")

    def test_none(self):
        self.assertEqual(_fmt_num(None), "-")

    def test_custom_format(self):
        self.assertEqual(_fmt_num(1423.18, ".0f"), "1423")


class TestSplitMessageV2(unittest.TestCase):
    def test_short(self):
        chunks = _split_message("short")
        self.assertEqual(len(chunks), 1)

    def test_long(self):
        text = "\n".join(f"line {i}" for i in range(500))
        chunks = _split_message(text, max_len=500)
        self.assertGreater(len(chunks), 1)
        for chunk in chunks:
            self.assertLessEqual(len(chunk), 500)


class TestBuildDailyReport(unittest.TestCase):
    @patch("pipeline.daily_intelligence_report.llm_chat_with_fallback")
    @patch("pipeline.daily_intelligence_report.check_gateway")
    @patch("pipeline.daily_intelligence_report.subprocess.run")
    def test_report_structure(self, mock_run, mock_gw, mock_llm):
        """Full report should have all 5 sections."""
        mock_llm.return_value = (
            "P: 정책 불확실 ▼\nE: 시장 강세 ▲\nS: 감성 긍정 ▲\nT: 기술 상승 ▲",
            "test-model", "",
        )
        mock_gw.return_value = True
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "123\n"
        mock_run.return_value = mock_result

        with tempfile.TemporaryDirectory() as tmp:
            # Set up market data
            mkt_dir = Path(tmp) / "market-indicators"
            mkt_dir.mkdir()
            (mkt_dir / "2026-02-26.json").write_text(json.dumps({
                "indicators": _sample_market_data()["indicators"],
                "anomalies": _sample_market_data()["anomalies"],
                "credit_data": _sample_market_data()["credit_data"],
            }))
            # Set up geo data
            geo_dir = Path(tmp) / "geopolitical"
            geo_dir.mkdir()
            (geo_dir / "2026-02-26.json").write_text(json.dumps(_sample_geo_data()))

            db_path = Path(tmp) / "test.db"
            conn = sqlite3.connect(str(db_path))
            conn.execute("CREATE TABLE IF NOT EXISTS dummy (id INTEGER)")
            conn.close()

            with patch("pipeline.daily_intelligence_report.MEMORY", Path(tmp)):
                from pipeline.daily_intelligence_report import build_daily_report
                report = build_daily_report(db_path)
                self.assertIn("인텔리전스 리포트", report)
                self.assertIn("°C", report)  # temperature gauge
                self.assertIn("팩트체크", report)
                self.assertIn("PEST", report)
                self.assertIn("반증", report)
                self.assertIn("총괄", report)
                self.assertIn("📎", report)  # ops section
                # Should be under 4096 chars
                self.assertLess(len(report), 4096)


class TestCalcMarketTemperature(unittest.TestCase):
    def test_neutral_with_empty_data(self):
        temp, label = _calc_market_temperature({}, {}, {})
        self.assertEqual(temp, 50.0)
        self.assertEqual(label, "미지근")

    def test_hot_with_low_vix_and_positive_momentum(self):
        mkt = {"indicators": {
            "VIX": {"close": 12, "change_pct": -5},
            "SPX": {"close": 7000, "change_pct": 2.0},
            "KOSPI": {"close": 6000, "change_pct": 2.5},
            "NDX": {"close": 23000, "change_pct": 1.5},
        }}
        social = {"sentiment": 20}
        temp, label = _calc_market_temperature(mkt, {"pentagon_index": {"doughcon": 5}}, social)
        self.assertGreater(temp, 65)
        self.assertIn(label, ("온기", "과열"))

    def test_cold_with_high_vix_and_negative_sentiment(self):
        mkt = {"indicators": {
            "VIX": {"close": 35, "change_pct": 10},
            "SPX": {"close": 6000, "change_pct": -3.0},
            "KOSPI": {"close": 5000, "change_pct": -2.0},
            "EPU_US": {"close": 800, "zscore": 3.0},
        }}
        social = {"sentiment": -15}
        temp, label = _calc_market_temperature(mkt, {"pentagon_index": {"doughcon": 1}}, social)
        self.assertLess(temp, 35)
        self.assertIn(label, ("냉기", "공포"))

    def test_bounded_0_100(self):
        # Extreme hot case
        mkt = {"indicators": {
            "VIX": {"close": 5},
            "SPX": {"close": 8000, "change_pct": 10},
            "KOSPI": {"close": 8000, "change_pct": 10},
            "NDX": {"close": 30000, "change_pct": 10},
        }}
        temp, _ = _calc_market_temperature(mkt, {"pentagon_index": {"doughcon": 5}}, {"sentiment": 40})
        self.assertLessEqual(temp, 100)
        self.assertGreaterEqual(temp, 0)

    def test_doughcon_contribution(self):
        # DOUGHCON 5 vs DOUGHCON 1
        mkt = {"indicators": {}}
        temp_safe, _ = _calc_market_temperature(mkt, {"pentagon_index": {"doughcon": 5}}, {})
        temp_danger, _ = _calc_market_temperature(mkt, {"pentagon_index": {"doughcon": 1}}, {})
        self.assertGreater(temp_safe, temp_danger)


class TestCleanLlmText(unittest.TestCase):
    def test_removes_chinese(self):
        result = _clean_llm_text("시장 情绪이 개선되고 있다")
        self.assertNotIn("情", result)
        self.assertNotIn("绪", result)
        self.assertIn("시장", result)

    def test_removes_hiragana(self):
        result = _clean_llm_text("심리에を미칠 수 있다")
        self.assertNotIn("を", result)
        self.assertIn("심리", result)

    def test_removes_markdown(self):
        result = _clean_llm_text("**판단:** 관망")
        self.assertNotIn("**", result)
        self.assertIn("판단:", result)

    def test_collapses_whitespace(self):
        result = _clean_llm_text("a   b    c")
        self.assertEqual(result, "a b c")

    def test_preserves_korean_and_ascii(self):
        result = _clean_llm_text("KOSPI +2.2%, 코스피 상승")
        self.assertEqual(result, "KOSPI +2.2%, 코스피 상승")


if __name__ == "__main__":
    unittest.main()
