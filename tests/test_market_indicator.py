"""Tests for pipeline/market_indicator_tracker.py — market indicator tracker."""
import json
import sys
from datetime import datetime
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Ensure scripts/ is importable
SCRIPTS_DIR = str(Path(__file__).resolve().parent.parent / "scripts")
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from pipeline.market_indicator_tracker import (
    INDICATORS,
    KR3Y_CONFIG,
    DDR5_CONFIG,
    DERIVED_CONFIGS,
    DM_SECTIONS,
    CREDIT_SIGNAL_ZONES,
    ZSCORE_THRESHOLD,
    DAILY_CHANGE_THRESHOLD,
    CHANGE_THRESHOLD_OVERRIDES,
    GPR_CONFIG,
    EPU_US_CONFIG,
    EPU_GLOBAL_CONFIG,
    _DM_NAMES,
    detect_anomalies,
    generate_summary,
    save_indicators,
    fetch_credit_data,
    update_credit_csv,
    calculate_derived,
    fetch_gpr_index,
    fetch_epu_index,
    _get_indicator_name,
    _zscore_dot,
    _format_value,
    _dm_row,
    _get_anomaly_desc,
)


# ── INDICATORS config ──────────────────────────────────────────────

class TestIndicatorsConfig:
    def test_has_22_indicators(self):
        assert len(INDICATORS) == 22

    def test_all_have_required_fields(self):
        for key, cfg in INDICATORS.items():
            assert "ticker" in cfg, f"{key} missing ticker"
            assert "name" in cfg, f"{key} missing name"
            assert "category" in cfg, f"{key} missing category"

    def test_categories(self):
        categories = {cfg["category"] for cfg in INDICATORS.values()}
        for cat in ["변동성", "금리", "환율", "커머디티", "주가지수", "한국"]:
            assert cat in categories, f"missing category: {cat}"
        assert "원자재" not in categories, "원자재는 커머디티로 통합됨"
        assert "미국지수" not in categories, "주가지수로 통합됨"
        assert "아시아" not in categories, "주가지수로 통합됨"

    def test_regions(self):
        regions = {cfg["region"] for cfg in INDICATORS.values()}
        assert "global" in regions
        assert "korea" in regions
        assert "asia" in regions
        korea_keys = [k for k, v in INDICATORS.items() if v["region"] == "korea"]
        assert "KOSPI" in korea_keys
        assert "KOSDAQ" in korea_keys
        assert "USDKRW" in korea_keys

    def test_new_indicators_present(self):
        for key in ["SOFR", "NATGAS", "BDI", "SOXX", "NIKKEI", "HSI", "SSEC",
                     "USDJPY", "EURUSD", "WTI", "SPX", "NDX"]:
            assert key in INDICATORS, f"{key} missing"

    def test_kr3y_config(self):
        assert KR3Y_CONFIG["name"] == "한국 국채3년"
        assert KR3Y_CONFIG["region"] == "korea"

    def test_derived_configs(self):
        assert "GSRATIO" in DERIVED_CONFIGS
        assert "BWSPREAD" in DERIVED_CONFIGS
        assert DERIVED_CONFIGS["GSRATIO"]["calc"] == "divide"
        assert DERIVED_CONFIGS["BWSPREAD"]["calc"] == "subtract"

    def test_dm_sections_cover_all_standard_keys(self):
        """DM_SECTIONS should include all non-helper indicator keys."""
        dm_keys = set()
        for _, keys in DM_SECTIONS:
            dm_keys.update(keys)
        for key in INDICATORS:
            assert key in dm_keys, f"{key} missing from DM_SECTIONS"

    def test_credit_signal_zones_cover_full_range(self):
        assert CREDIT_SIGNAL_ZONES[0][0] == 0
        assert CREDIT_SIGNAL_ZONES[-1][1] == 100
        for i in range(len(CREDIT_SIGNAL_ZONES) - 1):
            assert CREDIT_SIGNAL_ZONES[i][1] == CREDIT_SIGNAL_ZONES[i + 1][0]


# ── helper functions ──────────────────────────────────────────────

class TestHelpers:
    def test_get_indicator_name_standard(self):
        assert _get_indicator_name("VIX") == "VIX 공포지수"
        assert _get_indicator_name("NATGAS") == "천연가스"

    def test_get_indicator_name_kr3y(self):
        assert _get_indicator_name("KR3Y") == "한국 국채3년"

    def test_get_indicator_name_derived(self):
        assert _get_indicator_name("GSRATIO") == "금은비"
        assert _get_indicator_name("BWSPREAD") == "B-W스프레드"

    def test_get_indicator_name_unknown(self):
        assert _get_indicator_name("UNKNOWN") == "UNKNOWN"

    def test_zscore_dot_normal(self):
        assert _zscore_dot(0.5) == "·"
        assert _zscore_dot(-1.0) == "·"

    def test_zscore_dot_watch(self):
        assert _zscore_dot(1.5) == "◇"
        assert _zscore_dot(-1.8) == "◇"

    def test_zscore_dot_alert(self):
        assert _zscore_dot(2.0) == "◆"
        assert _zscore_dot(-3.0) == "◆"

    def test_format_value_rates(self):
        assert _format_value("US10Y", 4.08) == "4.08%"
        assert _format_value("SOFR", 3.595) == "3.60%"

    def test_format_value_indices(self):
        assert _format_value("KOSPI", 5350.5) == "5,350"
        assert _format_value("NIKKEI", 38678.2) == "38,678"
        assert _format_value("SPX", 6050.5) == "6,050"
        assert _format_value("NDX", 19876.3) == "19,876"

    def test_format_value_commodities(self):
        assert _format_value("GOLD", 2932.5) == "$2,932.5"
        assert _format_value("NATGAS", 2.94) == "$2.94"

    def test_format_value_gsratio(self):
        assert _format_value("GSRATIO", 89.4) == "89.4"

    def test_format_value_fx(self):
        assert _format_value("USDJPY", 149.32) == "149.32"
        assert _format_value("EURUSD", 1.0845) == "1.08"
        assert _format_value("DXY", 97.94) == "97.94"

    def test_format_value_wti(self):
        assert _format_value("WTI", 71.50) == "$71.5"


# ── detect_anomalies ───────────────────────────────────────────────

class TestDetectAnomalies:
    def test_no_anomalies_normal_data(self):
        indicators = {
            "VIX": {"close": 20.0, "prev": 19.8, "change_pct": 1.0, "ma20": 19.5, "zscore": 0.5},
            "US10Y": {"close": 4.1, "prev": 4.09, "change_pct": 0.24, "ma20": 4.08, "zscore": 0.3},
        }
        anomalies = detect_anomalies(indicators)
        assert len(anomalies) == 0

    def test_zscore_breach(self):
        indicators = {
            "VIX": {"close": 30.0, "prev": 25.0, "change_pct": 1.0, "ma20": 18.0, "zscore": 2.5},
        }
        anomalies = detect_anomalies(indicators)
        assert len(anomalies) >= 1
        assert any(a["type"] == "zscore_breach" for a in anomalies)

    def test_high_change(self):
        indicators = {
            "USDKRW": {"close": 1460, "prev": 1420, "change_pct": 2.82, "ma20": 1440, "zscore": 0.5},
        }
        anomalies = detect_anomalies(indicators)
        assert len(anomalies) >= 1
        assert any(a["type"] == "high_change" for a in anomalies)

    def test_combined_anomaly(self):
        """An indicator with both zscore breach and high change should produce 1 combined anomaly."""
        indicators = {
            "COPPER": {"close": 6.0, "prev": 5.5, "change_pct": 9.09, "ma20": 5.0, "zscore": 3.0},
        }
        anomalies = detect_anomalies(indicators)
        assert len(anomalies) == 1
        assert anomalies[0]["type"] == "combined"
        assert "z=" in anomalies[0]["detail"]
        assert "급등" in anomalies[0]["detail"]

    def test_severity_high_for_extreme_zscore(self):
        indicators = {
            "VIX": {"close": 40.0, "prev": 38.0, "change_pct": 1.0, "ma20": 18.0, "zscore": 3.5},
        }
        anomalies = detect_anomalies(indicators)
        zscore_anomalies = [a for a in anomalies if a["type"] == "zscore_breach"]
        assert zscore_anomalies[0]["severity"] == "high"

    def test_severity_medium_for_moderate_zscore(self):
        indicators = {
            "VIX": {"close": 25.0, "prev": 24.5, "change_pct": 1.0, "ma20": 18.0, "zscore": 2.1},
        }
        anomalies = detect_anomalies(indicators)
        zscore_anomalies = [a for a in anomalies if a["type"] == "zscore_breach"]
        assert zscore_anomalies[0]["severity"] == "medium"

    def test_severity_high_for_extreme_change(self):
        indicators = {
            "GOLD": {"close": 5500, "prev": 5200, "change_pct": 5.77, "ma20": 5300, "zscore": 1.0},
        }
        anomalies = detect_anomalies(indicators)
        change_anomalies = [a for a in anomalies if a["type"] == "high_change"]
        assert change_anomalies[0]["severity"] == "high"

    def test_negative_zscore_breach(self):
        indicators = {
            "DXY": {"close": 95.0, "prev": 96.0, "change_pct": -1.04, "ma20": 102.0, "zscore": -2.5},
        }
        anomalies = detect_anomalies(indicators)
        assert len(anomalies) >= 1
        assert "하락" in anomalies[0]["detail"]

    def test_kr3y_anomaly_detection(self):
        """KR3Y (non-yfinance) should also trigger anomaly detection."""
        indicators = {
            "KR3Y": {"close": 3.5, "prev": 3.0, "change_pct": 16.67, "ma20": 3.1, "zscore": 2.5},
        }
        anomalies = detect_anomalies(indicators)
        assert len(anomalies) >= 1
        assert any("한국 국채3년" in a["detail"] for a in anomalies)

    def test_derived_anomaly_detection(self):
        """Derived indicators (GSRATIO, BWSPREAD) should trigger anomalies."""
        indicators = {
            "GSRATIO": {"close": 95.0, "prev": 90.0, "change_pct": 5.56, "ma20": 88.0, "zscore": 2.5},
        }
        anomalies = detect_anomalies(indicators)
        assert len(anomalies) >= 1
        assert any("금은비" in a["detail"] for a in anomalies)

    def test_credit_signal_caution(self):
        """Credit ratio >= 35% should trigger anomaly."""
        credit_data = {"ratio": 37.5, "signal": "주의"}
        anomalies = detect_anomalies({}, credit_data=credit_data)
        assert len(anomalies) == 1
        assert anomalies[0]["type"] == "credit_signal"
        assert anomalies[0]["severity"] == "medium"

    def test_credit_signal_sell_warning(self):
        """Credit ratio >= 40% should trigger high severity anomaly."""
        credit_data = {"ratio": 42.0, "signal": "매도 경고"}
        anomalies = detect_anomalies({}, credit_data=credit_data)
        assert len(anomalies) == 1
        assert anomalies[0]["severity"] == "high"

    def test_credit_no_anomaly_normal(self):
        """Credit ratio < 35% should not trigger anomaly."""
        credit_data = {"ratio": 28.5, "signal": "매수 고려"}
        anomalies = detect_anomalies({}, credit_data=credit_data)
        assert len(anomalies) == 0

    def test_credit_none_no_error(self):
        """credit_data=None should not cause errors."""
        anomalies = detect_anomalies({}, credit_data=None)
        assert len(anomalies) == 0


# ── generate_summary ───────────────────────────────────────────────

class TestGenerateSummary:
    def test_basic_summary(self):
        indicators = {
            "VIX": {"close": 20.23, "prev": 19.62, "change_pct": 3.11, "ma20": 18.5, "zscore": 1.2},
            "US10Y": {"close": 4.08, "prev": 4.08, "change_pct": -0.10, "ma20": 4.1, "zscore": -0.3},
            "USDKRW": {"close": 1448, "prev": 1445, "change_pct": 0.21, "ma20": 1440, "zscore": 0.5},
        }
        summary = generate_summary(indicators, [])
        assert "VIX" in summary
        assert "이상치 없음" in summary

    def test_summary_with_anomalies(self):
        indicators = {
            "VIX": {"close": 30.0, "prev": 25.0, "change_pct": 20.0, "ma20": 18.0, "zscore": 2.5},
        }
        anomalies = [{"ticker": "VIX", "type": "zscore_breach", "detail": "test"}]
        summary = generate_summary(indicators, anomalies)
        assert "이상치 1건" in summary

    def test_summary_with_kr3y(self):
        indicators = {
            "KR3Y": {"close": 3.14, "prev": 3.1, "change_pct": 1.29, "ma20": 3.0, "zscore": 0.5},
        }
        summary = generate_summary(indicators, [])
        assert "한국 국채3년" in summary

    def test_summary_with_credit(self):
        credit = {"ratio": 28.7, "signal": "매수 고려", "credit_balance": 30.0, "deposit": 105.0}
        summary = generate_summary({}, [], credit_data=credit)
        assert "신용비율" in summary
        assert "매수 고려" in summary


# ── save_indicators ────────────────────────────────────────────────

class TestSaveIndicators:
    def test_save_creates_file(self, tmp_path):
        with patch("pipeline.market_indicator_tracker.OUTPUT_DIR", tmp_path):
            indicators = {"VIX": {"close": 20.0, "change_pct": 1.0}}
            filepath = save_indicators(indicators, [], "test summary")
            assert filepath.exists()
            data = json.loads(filepath.read_text(encoding="utf-8"))
            assert data["indicators"]["VIX"]["close"] == 20.0
            assert data["summary"] == "test summary"

    def test_save_includes_anomalies(self, tmp_path):
        with patch("pipeline.market_indicator_tracker.OUTPUT_DIR", tmp_path):
            anomalies = [{"ticker": "VIX", "type": "zscore_breach", "detail": "test"}]
            filepath = save_indicators({}, anomalies, "summary")
            data = json.loads(filepath.read_text(encoding="utf-8"))
            assert len(data["anomalies"]) == 1

    def test_save_includes_credit_data(self, tmp_path):
        with patch("pipeline.market_indicator_tracker.OUTPUT_DIR", tmp_path):
            credit = {"ratio": 28.7, "signal": "매수 고려", "credit_balance": 30.0}
            filepath = save_indicators({}, [], "summary", credit_data=credit)
            data = json.loads(filepath.read_text(encoding="utf-8"))
            assert data["credit_data"]["ratio"] == 28.7
            assert data["credit_data"]["signal"] == "매수 고려"


# ── fetch_credit_data ─────────────────────────────────────────────

class TestFetchCreditData:
    def test_reads_csv(self, tmp_path):
        csv_content = "date,credit_balance,deposit,ratio\n2026/02/04,30.2,100.8,29.96\n2026/02/05,30.1,104.9,28.66\n"
        csv_file = tmp_path / "test.csv"
        csv_file.write_text(csv_content)
        with patch("pipeline.market_indicator_tracker.CREDIT_CSV", csv_file):
            data = fetch_credit_data()
            assert data is not None
            assert data["credit_balance"] == 30.1
            assert data["deposit"] == 104.9
            assert data["ratio"] == 28.66
            assert data["signal"] == "매수 고려"

    def test_signal_zones(self, tmp_path):
        """Test different signal zones."""
        for ratio, expected_signal in [(25.0, "매수 고려"), (32.0, "중립"), (37.0, "주의"), (42.0, "매도 경고")]:
            csv_content = f"date,credit_balance,deposit,ratio\n2026/01/01,30,100,30\n2026/02/05,30,100,{ratio}\n"
            csv_file = tmp_path / "test.csv"
            csv_file.write_text(csv_content)
            with patch("pipeline.market_indicator_tracker.CREDIT_CSV", csv_file):
                data = fetch_credit_data()
                assert data["signal"] == expected_signal, f"ratio={ratio} expected {expected_signal}, got {data['signal']}"

    def test_ratio_change(self, tmp_path):
        csv_content = "date,credit_balance,deposit,ratio\n2026/02/04,30.2,100.8,29.96\n2026/02/05,30.1,104.9,28.66\n"
        csv_file = tmp_path / "test.csv"
        csv_file.write_text(csv_content)
        with patch("pipeline.market_indicator_tracker.CREDIT_CSV", csv_file):
            data = fetch_credit_data()
            assert abs(data["ratio_change"] - (-1.3)) < 0.01

    def test_missing_csv(self, tmp_path):
        with patch("pipeline.market_indicator_tracker.CREDIT_CSV", tmp_path / "nonexistent.csv"):
            data = fetch_credit_data()
            assert data is None


# ── update_credit_csv ─────────────────────────────────────────

class TestUpdateCreditCsv:
    NAVER_HTML_SAMPLE = (
        '<table><tr>'
        '<td class="date">26.02.13</td>'
        '<td class="rate_down">992736</td>'
        '<td class="rate_down">37448</td>'
        '<td class="rate_up">310528</td>'
        '<td class="rate_up">114</td>'
        '</tr><tr>'
        '<td class="date">26.02.12</td>'
        '<td class="rate_up">1030184</td>'
        '<td class="rate_up">48550</td>'
        '<td class="rate_up">310414</td>'
        '<td class="rate_up">1467</td>'
        '</tr><tr>'
        '<td class="date">26.02.05</td>'
        '<td class="rate_up">1048667</td>'
        '<td class="rate_up">40495</td>'
        '<td class="rate_down">303712</td>'
        '<td class="rate_down">1462</td>'
        '</tr></table>'
    )

    def _make_csv(self, tmp_path, last_date="2026/02/05"):
        csv = tmp_path / "hist.csv"
        csv.write_text(
            f"date,credit_balance,deposit,ratio\n"
            f"{last_date},30.058326,104.866667,28.663370\n"
        )
        return csv

    def _mock_response(self, html):
        resp = MagicMock()
        resp.status_code = 200
        resp.content = html.encode("utf-8")
        resp.raise_for_status = MagicMock()
        return resp

    def test_appends_new_rows(self, tmp_path):
        """New dates after last CSV date are appended."""
        csv = self._make_csv(tmp_path)
        with patch("pipeline.market_indicator_tracker.CREDIT_CSV", csv), \
             patch("requests.get", return_value=self._mock_response(self.NAVER_HTML_SAMPLE)):
            added = update_credit_csv()
            assert added == 2  # 02/12 and 02/13 (02/05 skipped)
            lines = csv.read_text().strip().split("\n")
            assert len(lines) == 4  # header + original + 2 new
            # Check latest row
            last = lines[-1].split(",")
            assert last[0] == "2026/02/13"
            # 신용잔고 310528억원 = 31.0528조원
            assert abs(float(last[1]) - 31.0528) < 0.001
            # 예탁금 992736억원 = 99.2736조원
            assert abs(float(last[2]) - 99.2736) < 0.001

    def test_no_duplicates(self, tmp_path):
        """If CSV already has latest date, no rows appended."""
        csv = self._make_csv(tmp_path, last_date="2026/02/13")
        with patch("pipeline.market_indicator_tracker.CREDIT_CSV", csv), \
             patch("requests.get", return_value=self._mock_response(self.NAVER_HTML_SAMPLE)):
            added = update_credit_csv()
            assert added == 0
            lines = csv.read_text().strip().split("\n")
            assert len(lines) == 2  # header + original only

    def test_sorted_by_date(self, tmp_path):
        """New rows are appended in chronological order."""
        csv = self._make_csv(tmp_path)
        with patch("pipeline.market_indicator_tracker.CREDIT_CSV", csv), \
             patch("requests.get", return_value=self._mock_response(self.NAVER_HTML_SAMPLE)):
            update_credit_csv()
            lines = csv.read_text().strip().split("\n")
            dates = [l.split(",")[0] for l in lines[1:]]
            assert dates == sorted(dates)

    def test_ratio_calculated_correctly(self, tmp_path):
        """ratio = credit_balance / deposit * 100."""
        csv = self._make_csv(tmp_path)
        with patch("pipeline.market_indicator_tracker.CREDIT_CSV", csv), \
             patch("requests.get", return_value=self._mock_response(self.NAVER_HTML_SAMPLE)):
            update_credit_csv()
            lines = csv.read_text().strip().split("\n")
            for line in lines[2:]:  # skip header and original
                parts = line.split(",")
                credit = float(parts[1])
                deposit = float(parts[2])
                ratio = float(parts[3])
                expected = credit / deposit * 100
                assert abs(ratio - expected) < 0.01

    def test_missing_csv_returns_zero(self, tmp_path):
        """Returns 0 if CSV doesn't exist."""
        with patch("pipeline.market_indicator_tracker.CREDIT_CSV", tmp_path / "nope.csv"):
            added = update_credit_csv()
            assert added == 0

    def test_network_error_returns_zero(self, tmp_path):
        """Network error gracefully returns 0."""
        csv = self._make_csv(tmp_path)
        mock_resp = MagicMock()
        mock_resp.raise_for_status.side_effect = Exception("timeout")
        with patch("pipeline.market_indicator_tracker.CREDIT_CSV", csv), \
             patch("requests.get", return_value=mock_resp):
            added = update_credit_csv()
            assert added == 0

    def test_unparseable_html_returns_zero(self, tmp_path):
        """Empty/garbage HTML returns 0."""
        csv = self._make_csv(tmp_path)
        with patch("pipeline.market_indicator_tracker.CREDIT_CSV", csv), \
             patch("requests.get", return_value=self._mock_response("<html>no data</html>")):
            added = update_credit_csv()
            assert added == 0


# ── NATGAS threshold override ────────────────────────────────────

class TestNatgasThreshold:
    def test_natgas_override_exists(self):
        assert "NATGAS" in CHANGE_THRESHOLD_OVERRIDES
        assert CHANGE_THRESHOLD_OVERRIDES["NATGAS"] == 5.0

    def test_natgas_2pct_no_anomaly(self):
        """천연가스 2.3% 변동은 이상치가 아님 (임계값 5%)."""
        indicators = {
            "NATGAS": {"close": 2.94, "prev": 3.01, "change_pct": -2.33, "ma20": 3.0, "zscore": -0.5},
        }
        anomalies = detect_anomalies(indicators)
        change_anomalies = [a for a in anomalies if a["type"] == "high_change"]
        assert len(change_anomalies) == 0

    def test_natgas_5pct_triggers_anomaly(self):
        """천연가스 5% 이상 변동은 이상치 발생."""
        indicators = {
            "NATGAS": {"close": 2.80, "prev": 3.00, "change_pct": -6.67, "ma20": 3.0, "zscore": -1.0},
        }
        anomalies = detect_anomalies(indicators)
        change_anomalies = [a for a in anomalies if a["type"] == "high_change"]
        assert len(change_anomalies) == 1

    def test_other_indicators_use_default_threshold(self):
        """다른 지표는 기본 2% 임계값 사용."""
        indicators = {
            "VIX": {"close": 21.0, "prev": 20.0, "change_pct": 5.0, "ma20": 19.0, "zscore": 1.0},
        }
        anomalies = detect_anomalies(indicators)
        change_anomalies = [a for a in anomalies if a["type"] == "high_change"]
        assert len(change_anomalies) == 1


# ── dm_row helper ────────────────────────────────────────────────

class TestDmRow:
    def test_dm_row_basic(self):
        d = {"close": 20.23, "change_pct": 3.11, "mom_pct": 5.2, "yoy_pct": 12.3, "zscore": 0.5}
        row = _dm_row("VIX", d, set())
        assert "VIX" in row
        assert "+3.1" in row
        assert "+5.2" in row   # MoM
        assert "+12.3" in row  # YoY
        assert "·" in row

    def test_dm_row_alert(self):
        d = {"close": 30.0, "change_pct": 5.0, "mom_pct": 10.0, "yoy_pct": 20.0, "zscore": 2.5}
        row = _dm_row("VIX", d, {"VIX"})
        assert "◆" in row

    def test_dm_row_anomaly_overrides_zscore(self):
        """이상치이면 zscore 낮아도 ◆ 표시."""
        d = {"close": 20.23, "change_pct": 3.11, "mom_pct": 5.2, "yoy_pct": 12.3, "zscore": 0.5}
        row = _dm_row("VIX", d, {"VIX"})
        assert "◆" in row  # zscore 0.5지만 anomaly → ◆

    def test_dm_row_uses_english_short_name(self):
        d = {"close": 1448, "change_pct": 0.6, "mom_pct": 2.1, "yoy_pct": 8.5, "zscore": 0.3}
        row = _dm_row("USDKRW", d, set())
        assert "KRW" in row
        assert "1,448" in row

    def test_dm_row_spx(self):
        d = {"close": 6050.5, "change_pct": 1.2, "mom_pct": 3.0, "yoy_pct": 15.0, "zscore": 0.8}
        row = _dm_row("SPX", d, set())
        assert "S&P500" in row
        assert "6,050" in row

    def test_dm_row_mom_yoy_present(self):
        d = {"close": 100, "change_pct": 1.0, "mom_pct": -3.5, "yoy_pct": 22.1, "zscore": 0.1}
        row = _dm_row("GOLD", d, set())
        assert "-3.5" in row   # MoM
        assert "+22.1" in row  # YoY

    def test_dm_names_cover_all_indicators(self):
        all_keys = set(INDICATORS.keys()) | {"KR3Y", "GSRATIO", "BWSPREAD"}
        for key in all_keys:
            assert key in _DM_NAMES, f"{key} missing from _DM_NAMES"

    def test_dm_names_all_ascii(self):
        for key, name in _DM_NAMES.items():
            assert all(ord(c) < 128 for c in name), f"{key}: '{name}' contains non-ASCII"

    def test_dm_names_max_width(self):
        for key, name in _DM_NAMES.items():
            assert len(name) <= 7, f"{key}: '{name}' too long ({len(name)} > 7)"


# ── DDR5 config ────────────────────────────────────────────────

class TestDdr5Config:
    def test_ddr5_config_exists(self):
        assert DDR5_CONFIG["name"] == "DDR5 현물"
        assert DDR5_CONFIG["category"] == "커머디티"

    def test_ddr5_in_dm_names(self):
        assert "DDR5" in _DM_NAMES

    def test_ddr5_in_dm_sections(self):
        all_keys = set()
        for _, keys in DM_SECTIONS:
            all_keys.update(keys)
        assert "DDR5" in all_keys

    def test_ddr5_format_value(self):
        assert "$38.1" in _format_value("DDR5", 38.067)

    def test_get_indicator_name_ddr5(self):
        assert _get_indicator_name("DDR5") == "DDR5 현물"

    def test_dm_row_with_data_date(self):
        """data_date 필드가 있어도 _dm_row가 정상 동작."""
        d = {"close": 38.067, "change_pct": 0.09, "mom_pct": 0, "yoy_pct": 0,
             "zscore": 0, "data_date": "2026-02-13"}
        row = _dm_row("DDR5", d, set())
        assert "DDR5" in row
        assert "$38.1" in row


# ── _get_anomaly_desc ──────────────────────────────────────────

class TestGetAnomalyDesc:
    """_get_anomaly_desc가 모든 anomaly 타입을 올바르게 처리하는지 검증."""

    def _make_indicator(self, **overrides):
        base = {"close": 100, "prev": 98, "change_pct": 2.04, "ma20": 95, "zscore": 2.5}
        base.update(overrides)
        return base

    def test_combined_type(self):
        """combined 타입에서 변동률+z-score 모두 표시."""
        indicators = {"VIX": self._make_indicator(change_pct=5.2, zscore=2.8)}
        anomalies = [{"ticker": "VIX", "type": "combined", "detail": "...", "severity": "high"}]
        desc = _get_anomaly_desc("VIX", anomalies, indicators)
        assert "5.2%" in desc
        assert "2.8" in desc
        assert "급등" in desc

    def test_combined_type_drop(self):
        """combined 타입 하락 방향."""
        indicators = {"SPX": self._make_indicator(change_pct=-3.1, zscore=-2.3)}
        anomalies = [{"ticker": "SPX", "type": "combined", "detail": "...", "severity": "medium"}]
        desc = _get_anomaly_desc("SPX", anomalies, indicators)
        assert "급락" in desc
        assert "-3.1%" in desc

    def test_zscore_breach(self):
        indicators = {"GOLD": self._make_indicator(zscore=2.5)}
        anomalies = [{"ticker": "GOLD", "type": "zscore_breach", "detail": "...", "severity": "medium"}]
        desc = _get_anomaly_desc("GOLD", anomalies, indicators)
        assert "상방" in desc
        assert "2.5" in desc

    def test_high_change(self):
        indicators = {"WTI": self._make_indicator(change_pct=-4.5)}
        anomalies = [{"ticker": "WTI", "type": "high_change", "detail": "...", "severity": "medium"}]
        desc = _get_anomaly_desc("WTI", anomalies, indicators)
        assert "급락" in desc
        assert "-4.5%" in desc

    def test_credit_signal(self):
        anomalies = [{"ticker": "CREDIT", "type": "credit_signal", "detail": "신용비율 38.2% (주의)", "severity": "medium"}]
        desc = _get_anomaly_desc("CREDIT", anomalies, {})
        assert "38.2%" in desc

    def test_no_match(self):
        anomalies = [{"ticker": "VIX", "type": "zscore_breach", "detail": "...", "severity": "medium"}]
        desc = _get_anomaly_desc("GOLD", anomalies, {})
        assert desc == ""


# ── GPR / EPU config ───────────────────────────────────────────────

class TestGprEpuConfig:
    def test_gpr_config_exists(self):
        assert GPR_CONFIG["name"] == "GPR지수"
        assert GPR_CONFIG["category"] == "리스크"

    def test_epu_configs_exist(self):
        assert EPU_US_CONFIG["name"] == "EPU(미국)"
        assert EPU_GLOBAL_CONFIG["name"] == "EPU(글로벌)"

    def test_gpr_epu_in_dm_names(self):
        assert "GPR" in _DM_NAMES
        assert "EPU_US" in _DM_NAMES
        assert "EPU_GLOBAL" in _DM_NAMES

    def test_gpr_epu_dm_names_ascii_and_short(self):
        for key in ("GPR", "EPU_US", "EPU_GLOBAL"):
            name = _DM_NAMES[key]
            assert all(ord(c) < 128 for c in name), f"{key}: '{name}' non-ASCII"
            assert len(name) <= 7, f"{key}: '{name}' too long"

    def test_gpr_epu_in_dm_sections(self):
        all_keys = set()
        for _, keys in DM_SECTIONS:
            all_keys.update(keys)
        for key in ("GPR", "EPU_US", "EPU_GLOBAL"):
            assert key in all_keys, f"{key} missing from DM_SECTIONS"

    def test_get_indicator_name_gpr_epu(self):
        assert _get_indicator_name("GPR") == "GPR지수"
        assert _get_indicator_name("EPU_US") == "EPU(미국)"
        assert _get_indicator_name("EPU_GLOBAL") == "EPU(글로벌)"

    def test_format_value_gpr_epu(self):
        assert _format_value("GPR", 123.45) == "123.5"
        assert _format_value("EPU_US", 99.7) == "99.7"
        assert _format_value("EPU_GLOBAL", 250.3) == "250.3"


# ── fetch_gpr_index ───────────────────────────────────────────────

class TestFetchGprIndex:
    @staticmethod
    def _make_gpr_dataframe():
        """Create a pandas DataFrame mimicking GPR XLS data."""
        import pandas as pd
        return pd.DataFrame({
            "date": pd.date_range("2026-01-01", periods=25, freq="D"),
            "GPRD": [100 + i * 0.5 for i in range(25)],
        })

    def test_fetch_gpr_success(self):
        """Mock XLS download + pd.read_excel, verify parsing returns valid dict."""
        import pandas as pd
        df = self._make_gpr_dataframe()

        mock_resp = MagicMock()
        mock_resp.read.return_value = b"fake-xls-data"
        mock_resp.__enter__ = MagicMock(return_value=mock_resp)
        mock_resp.__exit__ = MagicMock(return_value=False)

        with patch("urllib.request.urlopen", return_value=mock_resp), \
             patch("pandas.read_excel", return_value=df):
            result = fetch_gpr_index()

        assert result, "fetch_gpr_index returned empty"
        assert "close" in result
        assert "prev" in result
        assert "change_pct" in result
        assert "data_date" in result
        assert "zscore" in result
        assert "ma20" in result
        assert result["close"] == 112.0   # 100 + 24*0.5
        assert result["prev"] == 111.5    # 100 + 23*0.5
        assert result["data_points"] == 25

    def test_fetch_gpr_error(self):
        """Network error should return {} without raising."""
        with patch("urllib.request.urlopen", side_effect=Exception("timeout")):
            result = fetch_gpr_index()
        assert result == {}

    def test_fetch_gpr_no_pandas(self):
        """If pandas is not importable, return {} gracefully."""
        import builtins
        real_import = builtins.__import__

        def mock_import(name, *args, **kwargs):
            if name == "pandas":
                raise ImportError("no pandas")
            return real_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=mock_import):
            result = fetch_gpr_index()
        assert result == {}


# ── fetch_epu_index ───────────────────────────────────────────────

class TestFetchEpuIndex:
    US_CSV = (
        "DATE,USEPUINDXD\n"
        "2026-01-01,95.3\n"
        "2026-01-02,97.1\n"
        "2026-01-03,102.5\n"
        "2026-01-04,98.8\n"
        "2026-01-05,100.2\n"
    )

    GLOBAL_CSV = (
        "DATE,GEPUCURRENT\n"
        "2026-01-01,220.5\n"
        "2026-02-01,235.8\n"
        "2026-03-01,.\n"
    )

    def _mock_urlopen(self, csv_map):
        """Return a mock urlopen that serves different CSVs based on URL."""
        def side_effect(req, **kwargs):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            for pattern, csv_text in csv_map.items():
                if pattern in url:
                    resp = MagicMock()
                    resp.read.return_value = csv_text.encode("utf-8")
                    resp.__enter__ = MagicMock(return_value=resp)
                    resp.__exit__ = MagicMock(return_value=False)
                    return resp
            raise Exception(f"unexpected URL: {url}")
        return side_effect

    def test_fetch_epu_success(self):
        """Mock CSV download, verify both US and Global EPU parsed."""
        mock_fn = self._mock_urlopen({
            "USEPUINDXD": self.US_CSV,
            "GEPUCURRENT": self.GLOBAL_CSV,
        })
        with patch("urllib.request.urlopen", side_effect=mock_fn):
            result = fetch_epu_index()

        assert "EPU_US" in result, "EPU_US missing"
        assert "EPU_GLOBAL" in result, "EPU_GLOBAL missing"

        us = result["EPU_US"]
        assert us["close"] == 100.2
        assert us["prev"] == 98.8
        assert "change_pct" in us
        assert us["data_date"] == "2026-01-05"
        assert us["data_points"] == 5

        gl = result["EPU_GLOBAL"]
        assert gl["close"] == 235.8   # "." row skipped
        assert gl["prev"] == 220.5
        assert gl["data_points"] == 2

    def test_fetch_epu_error(self):
        """Network error for all URLs should return {} without raising."""
        with patch("urllib.request.urlopen", side_effect=Exception("connection refused")):
            result = fetch_epu_index()
        assert result == {}

    def test_fetch_epu_partial_failure(self):
        """If one source fails, the other should still return."""
        def side_effect(req, **kwargs):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            if "USEPUINDXD" in url:
                raise Exception("timeout")
            resp = MagicMock()
            resp.read.return_value = self.GLOBAL_CSV.encode("utf-8")
            resp.__enter__ = MagicMock(return_value=resp)
            resp.__exit__ = MagicMock(return_value=False)
            return resp

        with patch("urllib.request.urlopen", side_effect=side_effect):
            result = fetch_epu_index()

        assert "EPU_US" not in result
        assert "EPU_GLOBAL" in result

    def test_fetch_epu_empty_csv(self):
        """CSV with only header should return empty."""
        empty_csv = "DATE,USEPUINDXD\n"
        mock_fn = self._mock_urlopen({
            "USEPUINDXD": empty_csv,
            "GEPUCURRENT": empty_csv.replace("USEPUINDXD", "GEPUCURRENT"),
        })
        with patch("urllib.request.urlopen", side_effect=mock_fn):
            result = fetch_epu_index()
        assert "EPU_US" not in result
        assert "EPU_GLOBAL" not in result
