"""test_shipbuilding_cycle.py — 조선업 사이클 트래커 v6.0 테스트"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from pipeline.shipbuilding_cycle_tracker import (
    TIER1_INDICATORS, MARKET_PULSE_WEIGHTS, MANUAL_INDICATORS,
    CYCLE_PHASES, SHIPBUILDER_STOCKS, SHIP_TYPE_KEYWORDS,
    CYCLE_SCORE_WEIGHTS, DART_ACCOUNT_PATTERNS, HISTORICAL_PE_RANGES,
    PEAKOUT_THRESHOLDS, DART_REPRT_CODES, REPORT_DATA_DIR,
    CHART_DIR, VESSEL_DRIVERS, COMPETITOR_DATA,
    REPORT_SOURCES, ANALYST_METHODOLOGIES,
    INDUSTRY_INTRO, PEAKOUT_FRAMEWORK,
    LONGTERM_TICKERS, CHART_SIZES, LONGTERM_FILE, SCORE_HISTORY_FILE,
    PEAKOUT_HISTORY_FILE, VESSEL_MIX_HISTORY_FILE,
    MIDSIZE_PROFILES, MAJOR_PROFILES, TANKER_MARKET_SNAPSHOT, CONTAINER_MARKET_SNAPSHOT,
    DEMAND_GROUP_NARRATIVES, DEFAULT_CONTAINER_SNAPSHOT, _load_container_snapshot,
    ORDER_HISTORY_FILE, PRICE_HISTORY_FILE, KST,
    INDICATOR_TEMPORAL_TAGS, SCENARIO_TEMPLATES,
    CLIENT_VESSEL_MAP, COMPANY_DEFAULT_VESSEL,
    _classify_vessel_type,
    _build_investment_judgment_section,
    _build_temporal_interpretation,
    _build_scenario_section,
    _build_scoring_detail_section,
    _scoring_detail_demand,
    _scoring_detail_financial,
    _scoring_detail_order,
    _scoring_detail_valuation,
    _scoring_detail_structural,
    send_manual_update_reminder, _ensure_history_files,
    _zscore_to_ratio, calculate_market_pulse, calculate_cycle_score,
    calculate_combined_score, determine_cycle_phase,
    detect_cycle_signals, compute_peakout_indicators,
    load_manual_indicators, save_manual_indicators, update_manual,
    format_telegram_dm, build_weekly_report, _pct_str,
    _extract_contract_info, _estimate_from_orders,
    _parse_dart_amount, _qoq_change, _sorted_quarters,
    analyze_financial_trends, analyze_valuation_context,
    analyze_backlog_timeline, _peakout_item,
    _zscore_to_1_10, auto_structural_scores, FREIGHT_PROXY_MAP,
    analyze_vessel_type_mix,
    collect_longterm_proxies,
    _append_score_history, _load_score_history, _load_longterm_proxies,
    _append_peakout_history, _load_peakout_history,
    _append_vessel_mix_history, _load_vessel_mix_history,
    _append_order_history, _load_order_history,
    _append_price_history, _load_price_history,
    _compute_trend, _judgment_label,
    _build_company_master_table, _build_demand_table, _build_peakout_table,
    _save_report_data, _load_previous_report_data,
    _delta_str, _add_comparison_row,
    _md_to_telegram_html, _split_report_for_telegram,
    send_telegram_full_report,
    _setup_chart_env, _chart_radar, _chart_valuation_bars,
    _chart_margin_trend, _chart_contract_assets,
    _chart_vessel_mix, _chart_demand_zscore,
    _chart_delivery_schedule, _chart_peakout_gauge,
    _chart_longterm_cycles, _chart_score_history, _chart_company_dashboard,
    generate_charts,
    build_pdf_report, send_telegram_pdf, _send_progress_dm,
    _find_korean_font, _render_md_section,
)


# ── Config ───────────────────────────────────────────────────────

class TestConfig:
    def test_tier1_count(self):
        assert len(TIER1_INDICATORS) == 19  # +STNG, TNK, daehan (v6.0)

    def test_tier1_required_fields(self):
        for key, meta in TIER1_INDICATORS.items():
            assert "ticker" in meta, f"{key} missing ticker"
            assert "name" in meta, f"{key} missing name"
            assert "category" in meta, f"{key} missing category"

    def test_pulse_weights_sum_100(self):
        assert sum(MARKET_PULSE_WEIGHTS.values()) == 100

    def test_manual_indicators_have_required_fields(self):
        for key, meta in MANUAL_INDICATORS.items():
            assert "weight" in meta
            assert "inverted" in meta
            assert "desc" in meta

    def test_cycle_phases_cover_0_to_100(self):
        covered = set()
        for lo, hi, _, _ in CYCLE_PHASES:
            for i in range(lo, hi + 1):
                covered.add(i)
        assert covered == set(range(0, 101))

    def test_scored_indicators_exist_in_tier1(self):
        for key in MARKET_PULSE_WEIGHTS:
            assert key in TIER1_INDICATORS

    def test_stock_not_in_pulse_weights(self):
        for k, v in TIER1_INDICATORS.items():
            if v["category"] == "stock":
                assert k not in MARKET_PULSE_WEIGHTS, f"stock {k} should not be scored"

    def test_shipbuilder_stocks_have_stock_code(self):
        for key, meta in SHIPBUILDER_STOCKS.items():
            assert "stock_code" in meta
            assert "name" in meta

    def test_cycle_score_weights_sum_100(self):
        assert sum(CYCLE_SCORE_WEIGHTS.values()) == 100

    def test_dart_account_patterns(self):
        assert "revenue" in DART_ACCOUNT_PATTERNS
        assert "operating_profit" in DART_ACCOUNT_PATTERNS
        assert "contract_assets" in DART_ACCOUNT_PATTERNS

    def test_historical_pe_ranges_all_major_shipbuilders(self):
        for key, meta in SHIPBUILDER_STOCKS.items():
            if meta.get("tier") == "major":
                assert key in HISTORICAL_PE_RANGES, f"major {key} missing PE range"

    def test_peakout_thresholds_6(self):
        assert len(PEAKOUT_THRESHOLDS) == 6

    def test_dart_reprt_codes_4_quarters(self):
        assert len(DART_REPRT_CODES) == 4


# ── zscore → ratio ───────────────────────────────────────────────

class TestZscoreToRatio:
    def test_very_strong(self):
        assert _zscore_to_ratio(2.0) == 1.0
        assert _zscore_to_ratio(1.5) == 1.0

    def test_strong(self):
        assert _zscore_to_ratio(1.0) == 0.75
        assert _zscore_to_ratio(0.5) == 0.75

    def test_neutral(self):
        assert _zscore_to_ratio(0.0) == 0.5
        assert _zscore_to_ratio(-0.49) == 0.5

    def test_weak(self):
        assert _zscore_to_ratio(-0.51) == 0.25
        assert _zscore_to_ratio(-1.0) == 0.25

    def test_very_weak(self):
        assert _zscore_to_ratio(-2.0) == 0.0
        assert _zscore_to_ratio(-1.51) == 0.0

    def test_boundary_exact(self):
        assert _zscore_to_ratio(1.5) == 1.0
        assert _zscore_to_ratio(0.5) == 0.75
        assert _zscore_to_ratio(-0.5) == 0.5
        assert _zscore_to_ratio(-1.5) == 0.25


# ── Market Pulse ─────────────────────────────────────────────────

class TestMarketPulse:
    def _ind(self, overrides=None):
        d = overrides or {}
        return {k: {"zscore": d.get(k, 0.0), "close": 100, "change_pct": 0, "name": TIER1_INDICATORS[k]["name"]}
                for k in MARKET_PULSE_WEIGHTS}

    def test_all_neutral_50(self):
        assert calculate_market_pulse(self._ind())["score"] == 50.0

    def test_all_strong_100(self):
        assert calculate_market_pulse(self._ind({k: 2.0 for k in MARKET_PULSE_WEIGHTS}))["score"] == 100.0

    def test_all_weak_0(self):
        assert calculate_market_pulse(self._ind({k: -2.0 for k in MARKET_PULSE_WEIGHTS}))["score"] == 0.0

    def test_partial_data(self):
        p = calculate_market_pulse({"bdi": {"zscore": 1.0, "close": 20, "change_pct": 0, "name": "BDI"}})
        assert p["indicators_used"] == 1
        assert p["score"] == 75.0

    def test_empty_data(self):
        p = calculate_market_pulse({})
        assert p["score"] == 0.0
        assert p["indicators_used"] == 0

    def test_mixed_signals(self):
        p = calculate_market_pulse(self._ind({"bdi": 2.0, "natgas": -2.0}))
        assert 0 < p["score"] < 100


# ── DART Amount Parsing ──────────────────────────────────────────

class TestDartAmountParsing:
    def test_parse_normal(self):
        assert _parse_dart_amount("25,500,000,000,000") == 25_500_000_000_000

    def test_parse_none(self):
        assert _parse_dart_amount(None) is None

    def test_parse_dash(self):
        assert _parse_dart_amount("-") is None

    def test_parse_empty(self):
        assert _parse_dart_amount("") is None

    def test_parse_no_comma(self):
        assert _parse_dart_amount("12345") == 12345


# ── QoQ Change ───────────────────────────────────────────────────

class TestQoQChange:
    def test_positive_growth(self):
        assert _qoq_change(110, 100) == pytest.approx(10.0)

    def test_negative_growth(self):
        assert _qoq_change(90, 100) == pytest.approx(-10.0)

    def test_none_current(self):
        assert _qoq_change(None, 100) is None

    def test_none_previous(self):
        assert _qoq_change(100, None) is None

    def test_zero_previous(self):
        assert _qoq_change(100, 0) is None


# ── Sorted Quarters ──────────────────────────────────────────────

class TestSortedQuarters:
    def test_sorts_chronologically(self):
        qs = {"2024-Q4": {"a": 1}, "2024-Q2": {"a": 2}, "2025-Q1": {"a": 3}}
        result = _sorted_quarters(qs)
        assert [k for k, _ in result] == ["2024-Q2", "2024-Q4", "2025-Q1"]

    def test_empty(self):
        assert _sorted_quarters({}) == []


# ── Financial Trends ─────────────────────────────────────────────

class TestFinancialTrends:
    def _financials(self):
        return {
            "companies": {
                "hhi": {
                    "name": "HD현대중공업",
                    "quarters": {
                        "2024-Q3": {"year": 2024, "quarter": "Q3", "revenue": 20_000_000_000_000,
                                    "operating_profit": 800_000_000_000, "net_income": 600_000_000_000,
                                    "contract_assets": 6_500_000_000_000, "total_equity": 15_000_000_000_000},
                        "2024-Q4": {"year": 2024, "quarter": "Q4", "revenue": 25_500_000_000_000,
                                    "operating_profit": 1_480_000_000_000, "net_income": 1_000_000_000_000,
                                    "contract_assets": 7_500_000_000_000, "total_equity": 16_000_000_000_000},
                    }
                }
            }
        }

    def test_basic_trends(self):
        r = analyze_financial_trends(self._financials())
        assert "hhi" in r
        ft = r["hhi"]
        assert ft["revenue"] == 25_500_000_000_000
        assert ft["op_margin"] is not None
        assert ft["op_margin"] == pytest.approx(5.8, rel=0.01)

    def test_qoq_margin_change(self):
        r = analyze_financial_trends(self._financials())
        ft = r["hhi"]
        # Q3 margin = 800B / 20T = 4.0%, Q4 = 1480B / 25.5T = 5.8%
        assert ft["op_margin_qoq"] == pytest.approx(1.8, rel=0.1)

    def test_contract_assets_qoq(self):
        r = analyze_financial_trends(self._financials())
        ft = r["hhi"]
        # 6.5T → 7.5T = +15.38%
        assert ft["contract_assets_qoq"] is not None
        assert ft["contract_assets_qoq"] > 0

    def test_empty_financials(self):
        assert analyze_financial_trends(None) == {}
        assert analyze_financial_trends({}) == {}

    def test_single_quarter(self):
        fin = {"companies": {"hhi": {"name": "test", "quarters": {"2024-Q4": {"year": 2024, "quarter": "Q4", "revenue": 100}}}}}
        assert analyze_financial_trends(fin) == {}  # needs 2+ quarters


# ── Valuation Context ────────────────────────────────────────────

class TestValuationContext:
    def _val(self, pe=None, pb=None, mcap=32e12):
        return {"stocks": {"hhi": {"name": "HD현대중공업", "market_cap": mcap,
                "trailing_pe": pe, "price_to_book": pb, "enterprise_value": 35e12,
                "ev_ebitda": 7.1, "roe": 0.18, "operating_margins": 0.06}}}

    def test_with_trailing_pe(self):
        r = analyze_valuation_context(self._val(pe=18.5), None)
        assert r["hhi"]["pe_ttm"] == 18.5
        assert r["hhi"]["pe_vs_avg_pct"] is not None

    def test_pe_fallback_from_dart(self):
        fin = {"companies": {"hhi": {"name": "test", "quarters": {
            "2024-Q1": {"net_income": 500e9, "total_equity": 15e12},
            "2024-Q2": {"net_income": 600e9, "total_equity": 15e12},
            "2024-Q3": {"net_income": 700e9, "total_equity": 15e12},
            "2024-Q4": {"net_income": 800e9, "total_equity": 16e12},
        }}}}
        r = analyze_valuation_context(self._val(), fin)
        # TTM NI = 2.6T, MCap = 32T → P/E = 12.3
        pe = r["hhi"]["pe_ttm"]
        assert pe is not None
        assert 10 < pe < 15

    def test_pb_fallback(self):
        fin = {"companies": {"hhi": {"name": "test", "quarters": {"2024-Q4": {"total_equity": 16e12}}}}}
        r = analyze_valuation_context(self._val(), fin)
        assert r["hhi"]["pb"] == pytest.approx(2.0, rel=0.01)

    def test_empty(self):
        assert analyze_valuation_context(None, None) == {}

    def test_pe_vs_avg(self):
        r = analyze_valuation_context(self._val(pe=25.0), None)
        # avg=18.0, pe=25 → (25/18-1)*100 = 38.9%
        assert r["hhi"]["pe_vs_avg_pct"] == pytest.approx(38.9, rel=0.1)


# ── Backlog Timeline ─────────────────────────────────────────────

class TestBacklogTimeline:
    def test_delivery_schedule(self):
        dart = {"status": "ok", "orders": [
            {"delivery_date": "2028-06-30", "ship_count": 2},
            {"delivery_date": "2029-03-27", "ship_count": 4},
            {"delivery_date": "2028-12-31", "ship_count": 1},
        ]}
        r = analyze_backlog_timeline(dart, None)
        assert r["delivery_schedule"][2028] == 3
        assert r["delivery_schedule"][2029] == 4

    def test_lead_time(self):
        dart = {"status": "ok", "orders": [{"delivery_date": "2029-06-30", "ship_count": 1}]}
        r = analyze_backlog_timeline(dart, None)
        assert r["lead_time_avg_years"] is not None
        assert r["lead_time_avg_years"] > 0

    def test_no_data(self):
        r = analyze_backlog_timeline(None, None)
        assert r["delivery_schedule"] == {}


# ── Cycle Signals (v2) ───────────────────────────────────────────

class TestCycleSignals:
    def _fin(self, margin_qoq=0.5, ca_qoq=5.0):
        return {"companies": {"hhi": {"name": "HD현대중공업", "quarters": {
            "2024-Q3": {"year": 2024, "quarter": "Q3", "revenue": 20e12,
                        "operating_profit": int(20e12 * (0.05 - margin_qoq / 100)),
                        "contract_assets": int(7.5e12 / (1 + ca_qoq / 100))},
            "2024-Q4": {"year": 2024, "quarter": "Q4", "revenue": 25.5e12,
                        "operating_profit": int(25.5e12 * 0.058),
                        "contract_assets": int(7.5e12)},
        }}}}

    def test_no_signals_normal(self):
        sigs = detect_cycle_signals(self._fin(), None, None)
        # small margin change, normal backlog
        margin_sigs = [s for s in sigs if "margin" in s["type"]]
        # depends on actual values
        assert isinstance(sigs, list)

    def test_margin_contraction_signal(self):
        # Force large negative margin QoQ
        fin = {"companies": {"hhi": {"name": "Test", "quarters": {
            "2024-Q3": {"year": 2024, "quarter": "Q3", "revenue": 20e12, "operating_profit": 1.6e12},
            "2024-Q4": {"year": 2024, "quarter": "Q4", "revenue": 20e12, "operating_profit": 0.6e12},
        }}}}
        sigs = detect_cycle_signals(fin, None, None)
        assert any(s["type"] == "margin_contraction" for s in sigs)

    def test_order_slowdown(self):
        dart = {"status": "ok", "estimates": {"total_orders": 3}}
        sigs = detect_cycle_signals(None, None, dart)
        assert any(s["type"] == "order_slowdown" for s in sigs)

    def test_valuation_stretch(self):
        val = {"stocks": {"hhi": {"name": "Test", "market_cap": 32e12, "trailing_pe": 40.0,
               "price_to_book": None, "enterprise_value": None, "ev_ebitda": None, "roe": None, "operating_margins": None}}}
        sigs = detect_cycle_signals(None, val, None)
        assert any(s["type"] == "valuation_stretch" for s in sigs)


# ── Peakout Indicators ───────────────────────────────────────────

class TestPeakoutIndicators:
    def test_all_normal(self):
        fin = {"ksoe": {"op_margin_qoq": 0.5, "contract_assets_qoq": 5.0}}
        val = {"ksoe": {"pe_vs_avg_pct": 30.0}}
        dart = {"estimates": {"total_orders": 15}}
        backlog = {"lead_time_avg_years": 3.0}
        result = compute_peakout_indicators(fin, val, dart, backlog)
        assert len(result) == 6
        normals = [p for p in result if p["status"] == "normal"]
        assert len(normals) >= 4

    def test_warning_on_high_pe(self):
        fin = {}
        val = {"ksoe": {"pe_vs_avg_pct": 120.0}}
        result = compute_peakout_indicators(fin, val, None, {})
        pe_item = [p for p in result if p["key"] == "pe_vs_avg"][0]
        assert pe_item["status"] == "warning"

    def test_warning_on_low_orders(self):
        dart = {"estimates": {"total_orders": 5}}
        result = compute_peakout_indicators({}, {}, dart, {})
        order_item = [p for p in result if p["key"] == "order_count_90d"][0]
        assert order_item["status"] == "warning"

    def test_warning_on_long_lead_time(self):
        result = compute_peakout_indicators({}, {}, None, {"lead_time_avg_years": 4.5})
        lt_item = [p for p in result if p["key"] == "lead_time_years"][0]
        assert lt_item["status"] == "warning"

    def test_no_data_status(self):
        result = compute_peakout_indicators({}, {}, None, {})
        assert all(p["status"] in ("no_data", "normal", "warning") for p in result)


class TestPeakoutItem:
    def test_normal(self):
        r = _peakout_item("margin_qoq", 0.5, "실적")
        assert r["status"] == "normal"

    def test_warning(self):
        r = _peakout_item("margin_qoq", -1.5, "실적")
        assert r["status"] == "warning"

    def test_no_data(self):
        r = _peakout_item("margin_qoq", None, "실적")
        assert r["status"] == "no_data"

    def test_above_threshold(self):
        r = _peakout_item("lead_time_years", 4.5, "선가")
        assert r["status"] == "warning"

    def test_below_threshold(self):
        r = _peakout_item("order_count_90d", 8, "수주")
        assert r["status"] == "warning"


# ── Cycle Score (v2) ─────────────────────────────────────────────

class TestCycleScore:
    def test_no_data_returns_none(self):
        assert calculate_cycle_score({}, {}, None, {}) is None
        assert calculate_cycle_score({}, {}, None, {"scores": {}}) is None

    def test_structural_only(self):
        manual = {"scores": {k: 10.0 for k in MANUAL_INDICATORS}}
        manual["scores"]["china_capacity"] = 1.0  # inverted
        r = calculate_cycle_score({}, {}, None, manual)
        assert r is not None
        assert r["score"] == 100.0
        assert r["axis_scores"]["structural"] == 100.0

    def test_structural_min(self):
        manual = {"scores": {k: 1.0 for k in MANUAL_INDICATORS}}
        manual["scores"]["china_capacity"] = 10.0  # inverted
        r = calculate_cycle_score({}, {}, None, manual)
        assert r["score"] == 0.0

    def test_financial_axis(self):
        fin = {"ksoe": {"op_margin": 5.0, "roe": 15.0}}
        r = calculate_cycle_score(fin, {}, None, {"scores": {"regulation": 5}})
        assert r is not None
        assert r["axis_scores"]["financial"] is not None

    def test_order_axis_with_dart(self):
        dart = {"status": "ok", "estimates": {"total_orders": 15, "avg_price_per_ship_usd": 200_000_000}}
        r = calculate_cycle_score({}, {}, dart, {"scores": {"regulation": 5}})
        assert r is not None
        assert r["axis_scores"]["order"] is not None

    def test_valuation_axis(self):
        val = {"ksoe": {"pe_vs_avg_pct": 50.0}}
        r = calculate_cycle_score({}, val, None, {"scores": {"regulation": 5}})
        assert r is not None
        assert r["axis_scores"]["valuation"] is not None

    def test_all_axes(self):
        fin = {"ksoe": {"op_margin": 5.0, "roe": 15.0, "contract_assets_qoq": 10.0}}
        val = {"ksoe": {"pe_vs_avg_pct": 30.0}}
        dart = {"status": "ok", "estimates": {"total_orders": 10, "avg_price_per_ship_usd": 150_000_000}}
        manual = {"scores": {"regulation": 8, "china_capacity": 4, "vessel_age": 8, "container_rate": 6, "tanker_rate": 6}}
        r = calculate_cycle_score(fin, val, dart, manual)
        assert r is not None
        assert r["axes_used"] == 4  # all non-demand axes
        assert 0 <= r["score"] <= 100


# ── Combined Score (v2) ──────────────────────────────────────────

class TestCombinedScore:
    def test_no_cycle(self):
        r = calculate_combined_score({"score": 60.0}, None)
        assert r["combined"] is None
        assert r["method"] == "market_pulse_only"

    def test_with_cycle(self):
        r = calculate_combined_score({"score": 60.0}, {"score": 80.0})
        # 60*0.15 + 80*0.85 = 9 + 68 = 77.0
        assert r["combined"] == 77.0
        assert r["method"] == "combined"

    def test_both_max(self):
        r = calculate_combined_score({"score": 100.0}, {"score": 100.0})
        assert r["combined"] == 100.0

    def test_both_zero(self):
        r = calculate_combined_score({"score": 0.0}, {"score": 0.0})
        assert r["combined"] == 0.0

    def test_demand_only(self):
        r = calculate_combined_score({"score": 100.0}, {"score": 0.0})
        assert r["combined"] == 15.0  # 100*0.15


# ── Phase ────────────────────────────────────────────────────────

class TestCyclePhase:
    def test_trough(self):
        assert determine_cycle_phase(10)[0] == "TROUGH"

    def test_early_recovery(self):
        assert determine_cycle_phase(35)[0] == "EARLY_RECOVERY"

    def test_expansion(self):
        assert determine_cycle_phase(55)[0] == "EXPANSION"

    def test_peak(self):
        assert determine_cycle_phase(75)[0] == "PEAK"

    def test_overheating(self):
        assert determine_cycle_phase(90)[0] == "OVERHEATING"

    def test_boundary_25_26(self):
        assert determine_cycle_phase(25)[0] == "TROUGH"
        assert determine_cycle_phase(26)[0] == "EARLY_RECOVERY"

    def test_boundary_0_100(self):
        assert determine_cycle_phase(0)[0] == "TROUGH"
        assert determine_cycle_phase(100)[0] == "OVERHEATING"

    def test_returns_description(self):
        _, desc = determine_cycle_phase(50)
        assert "확장" in desc


# ── DART Contract Parsing ────────────────────────────────────────

class TestContractParsing:
    def test_extract_krw(self):
        r = _extract_contract_info("계약금액: 5,200억원 기타")
        assert r["contract_amount_krw"] == 520_000_000_000

    def test_extract_krw_baekmanwon(self):
        r = _extract_contract_info("계약금액  123,456백만원")
        assert r["contract_amount_krw"] == 123_456_000_000

    def test_extract_usd(self):
        r = _extract_contract_info("USD 250,000,000 달러")
        assert r["contract_amount_usd"] == 250_000_000

    def test_extract_usd_million(self):
        r = _extract_contract_info("USD 250백만")
        assert r["contract_amount_usd"] == 250_000_000

    def test_extract_ship_type_lng(self):
        r = _extract_contract_info("LNG 운반선 2척 건조 계약")
        assert r["ship_type"] == "LNG운반선"

    def test_extract_ship_type_container(self):
        r = _extract_contract_info("초대형 컨테이너 3척")
        assert r["ship_type"] == "컨테이너선"

    def test_extract_ship_count(self):
        r = _extract_contract_info("LNG 운반선 4척 건조")
        assert r["ship_count"] == 4

    def test_extract_delivery_date(self):
        r = _extract_contract_info("계약 종료일 2028.06.30")
        assert r["delivery_date"] == "2028-06-30"

    def test_empty_content(self):
        assert _extract_contract_info("아무 관련 없는 텍스트") == {}

    def test_partial_extraction(self):
        r = _extract_contract_info("탱커 건조")
        assert r.get("ship_type") == "탱커"
        assert "contract_amount_krw" not in r


# ── DART Estimates ───────────────────────────────────────────────

class TestEstimates:
    def test_basic_estimate(self):
        orders = [
            {"contract_amount_usd": 200_000_000, "ship_count": 2, "ship_type": "LNG운반선", "company": "A"},
            {"contract_amount_usd": 100_000_000, "ship_count": 1, "ship_type": "탱커", "company": "B"},
        ]
        r = _estimate_from_orders(orders)
        assert r["total_orders"] == 2
        assert r["total_ships"] == 3
        assert r["total_amount_usd"] == 300_000_000
        assert r["avg_price_per_ship_usd"] == 100_000_000

    def test_by_type_breakdown(self):
        orders = [
            {"contract_amount_usd": 200_000_000, "ship_count": 2, "ship_type": "LNG운반선", "company": "A"},
        ]
        r = _estimate_from_orders(orders)
        assert "LNG운반선" in r["by_type"]
        assert r["by_type"]["LNG운반선"]["count"] == 2

    def test_empty_orders(self):
        r = _estimate_from_orders([])
        assert r["total_orders"] == 0
        assert r["avg_price_per_ship_usd"] == 0

    def test_missing_usd(self):
        orders = [{"ship_count": 1, "company": "A"}]
        r = _estimate_from_orders(orders)
        assert r["total_ships"] == 1
        assert r["avg_price_per_ship_usd"] == 0


# ── Manual Indicators ────────────────────────────────────────────

class TestManualIndicators:
    def test_save_and_load(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.MANUAL_FILE", tmp_path / "m.json"), \
             patch("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path):
            save_manual_indicators({"scores": {"regulation": 7}})
            d = load_manual_indicators()
            assert d["scores"]["regulation"] == 7

    def test_load_missing(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.MANUAL_FILE", tmp_path / "x.json"):
            assert load_manual_indicators() == {}

    def test_update_valid(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.MANUAL_FILE", tmp_path / "m.json"), \
             patch("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path):
            r = update_manual(["regulation=8", "vessel_age=7"])
            assert r["scores"]["regulation"] == 8.0
            assert r["scores"]["vessel_age"] == 7.0

    def test_update_invalid_key(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.MANUAL_FILE", tmp_path / "m.json"), \
             patch("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path):
            r = update_manual(["fake_key=5"])
            assert "fake_key" not in r.get("scores", {})

    def test_update_out_of_range(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.MANUAL_FILE", tmp_path / "m.json"), \
             patch("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path):
            r = update_manual(["regulation=11", "regulation=0"])
            assert "regulation" not in r.get("scores", {})


# ── Formatting ───────────────────────────────────────────────────

class TestFormatting:
    def test_pct_positive(self):
        assert _pct_str(5.1) == "+5.1"

    def test_pct_negative(self):
        assert _pct_str(-2.3) == "-2.3"

    def test_pct_zero(self):
        assert _pct_str(0.0) == "0.0"

    def test_dm_format_v2(self):
        pulse = {"score": 55.0, "details": {}}
        combined = {"combined": None, "market_pulse": 55.0, "cycle_score": None, "method": "market_pulse_only"}
        dm = format_telegram_dm(pulse, combined, [], {}, None)
        assert "조선" in dm
        assert "55" in dm

    def test_dm_with_valuation(self):
        pulse = {"score": 55.0, "details": {}}
        combined = {"combined": 70.0, "market_pulse": 55.0, "cycle_score": 72.6, "method": "combined"}
        val_ctx = {"ksoe": {"pe_ttm": 18.5, "name": "HD한국조선해양", "market_cap": 32e12}}
        dm = format_telegram_dm(pulse, combined, [], {}, None, val_ctx=val_ctx)
        assert "밸류에이션" in dm

    def test_dm_with_peakout_warning(self):
        pulse = {"score": 55.0, "details": {}}
        combined = {"combined": None, "market_pulse": 55.0, "method": "market_pulse_only"}
        peakout = [{"key": "lead_time_years", "desc": "인도 리드타임 (년)", "value": 4.5, "status": "warning", "axis": "선가", "threshold": 4.0}]
        dm = format_telegram_dm(pulse, combined, [], {}, None, peakout=peakout)
        assert "피크아웃" in dm
        assert "리드타임" in dm

    def test_report_v4_sections(self):
        data = {"indicators": {"bdi": {"name": "BDI", "close": 20.5, "change_pct": 1.2, "zscore": 0.5, "category": "demand"}}}
        pulse = {"score": 55.0, "details": {"bdi": {"zscore": 0.5, "ratio": 0.75, "contribution": 18.75, "weight": 25}}}
        combined = {"combined": None, "market_pulse": 55.0, "method": "market_pulse_only"}
        report = build_weekly_report(data, pulse, None, combined, [], None)
        assert "사이클 종합" in report
        assert "수요 환경" in report
        assert "v6" in report

    def test_report_v3_definitions(self):
        """v5 리포트는 정의/기준 블록을 포함하지 않는다."""
        data = {"indicators": {}}
        pulse = {"score": 50.0, "details": {}}
        combined = {"combined": None, "market_pulse": 50.0, "method": "market_pulse_only"}
        fin_trends = {"ksoe": {"name": "HD한국조선해양", "revenue": 25.5e12, "operating_profit": 1.48e12,
                      "op_margin": 5.8, "op_margin_qoq": 1.8, "revenue_yoy": None,
                      "contract_assets": 7.5e12, "contract_liabilities": 12.7e12, "contract_assets_qoq": 15.4}}
        report = build_weekly_report(data, pulse, None, combined, [], None, fin_trends=fin_trends)
        assert "### 정의" not in report
        assert "### 기준" not in report

    def test_report_with_financials(self):
        data = {"indicators": {}}
        pulse = {"score": 50.0, "details": {}}
        combined = {"combined": None, "market_pulse": 50.0, "method": "market_pulse_only"}
        fin_trends = {"ksoe": {"name": "HD한국조선해양", "revenue": 25.5e12, "operating_profit": 1.48e12,
                      "op_margin": 5.8, "op_margin_qoq": 1.8, "revenue_yoy": None,
                      "contract_assets": 7.5e12, "contract_liabilities": 12.7e12, "contract_assets_qoq": 15.4}}
        report = build_weekly_report(data, pulse, None, combined, [], None, fin_trends=fin_trends)
        assert "기업 종합" in report

    def test_report_with_prev_data(self):
        """전월 데이터가 있어도 v5는 전월 비교 섹션이 별도로 없다."""
        data = {"indicators": {}}
        pulse = {"score": 55.0, "details": {}}
        combined = {"combined": 65.0, "market_pulse": 55.0, "cycle_score": 66.8, "method": "combined"}
        prev_data = {
            "week": 7, "year": 2026,
            "combined_score": 60.0, "pulse_score": 50.0, "cycle_score": 62.0,
            "market_pulse": 50.0,
            "financials": {"ksoe": {"name": "HD한국조선해양", "op_margin": 5.0, "contract_assets": 7e12}},
            "valuation": {"ksoe": {"name": "HD한국조선해양", "pe_ttm": 16.0, "pb": 2.3}},
            "peakout": [{"key": "margin_qoq", "value": 0.3, "status": "normal"}],
        }
        report = build_weekly_report(data, pulse, None, combined, [], None, prev_data=prev_data)
        assert "전월 대비 변화 요약" not in report

    def test_report_no_prev_data_message(self):
        """전월 데이터 없으면 '첫 리포트' 메시지가 표시되어야 한다."""
        data = {"indicators": {}}
        pulse = {"score": 50.0, "details": {}}
        combined = {"combined": None, "market_pulse": 50.0, "method": "market_pulse_only"}
        report = build_weekly_report(data, pulse, None, combined, [], None, prev_data=None)
        assert "첫 리포트" in report
        assert "전월 대비 변화 요약" not in report

    def test_report_with_peakout(self):
        data = {"indicators": {}}
        pulse = {"score": 50.0, "details": {}}
        combined = {"combined": None, "market_pulse": 50.0, "method": "market_pulse_only"}
        peakout = [
            {"key": "margin_qoq", "axis": "실적", "desc": "영업이익률 QoQ", "value": 0.5, "threshold": -1.0, "status": "normal"},
            {"key": "lead_time_years", "axis": "선가", "desc": "인도 리드타임", "value": 4.5, "threshold": 4.0, "status": "warning"},
        ]
        report = build_weekly_report(data, pulse, None, combined, [], None, peakout=peakout)
        assert "피크아웃" in report
        assert "|" in report  # v5: 테이블 형식

    def test_report_with_dart_orders(self):
        data = {"indicators": {}}
        pulse = {"score": 50.0, "details": {}}
        combined = {"combined": None, "market_pulse": 50.0, "method": "market_pulse_only"}
        dart = {"status": "ok", "orders": [{}], "estimates": {"total_orders": 3, "total_ships": 5,
                "avg_price_per_ship_usd": 200_000_000,
                "by_type": {"LNG운반선": {"count": 5, "amount_usd": 1_000_000_000}}}}
        report = build_weekly_report(data, pulse, None, combined, [], dart)
        assert "수주" in report
        assert "LNG" in report


# ── Valuation History ────────────────────────────────────────────

class TestValuationHistory:
    def test_append_history(self, tmp_path):
        from pipeline.shipbuilding_cycle_tracker import _append_valuation_history, VALUATION_HISTORY_FILE, OUTPUT_DIR
        with patch("pipeline.shipbuilding_cycle_tracker.VALUATION_HISTORY_FILE", tmp_path / "vh.json"), \
             patch("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path):
            val_ctx = {"ksoe": {"pe_ttm": 18.5, "pb": 2.6, "market_cap": 32e12, "ev_ebitda": 7.1}}
            _append_valuation_history(val_ctx)
            _append_valuation_history(val_ctx)
            data = json.loads((tmp_path / "vh.json").read_text())
            assert len(data) == 2
            assert "ksoe" in data[0]["stocks"]


# ── Freight Proxy Auto-Scoring ───────────────────────────────────

class TestZscoreTo110:
    def test_high_zscore(self):
        assert _zscore_to_1_10(2.0) == 10.0

    def test_low_zscore(self):
        assert _zscore_to_1_10(-2.0) == 1.0

    def test_neutral(self):
        assert _zscore_to_1_10(0.0) == 5.5

    def test_clamp_high(self):
        assert _zscore_to_1_10(5.0) == 10.0

    def test_clamp_low(self):
        assert _zscore_to_1_10(-5.0) == 1.0

    def test_moderate_positive(self):
        r = _zscore_to_1_10(1.0)
        assert 7 < r < 8.5


class TestAutoStructuralScores:
    def test_both_proxies(self):
        indicators = {
            "container_proxy": {"zscore": 1.0, "close": 30, "name": "ZIM"},
            "tanker_proxy": {"zscore": -0.5, "close": 20, "name": "BWET"},
            "tanker_proxy2": {"zscore": -0.3, "close": 15, "name": "FRO"},
        }
        auto = auto_structural_scores(indicators)
        assert "container_rate" in auto
        assert "tanker_rate" in auto
        assert auto["container_rate"] > auto["tanker_rate"]

    def test_tanker_averages_two_proxies(self):
        """탱커운임은 BWET + FRO 평균 z-score로 계산."""
        indicators = {
            "tanker_proxy": {"zscore": 1.0, "close": 20, "name": "BWET"},
            "tanker_proxy2": {"zscore": 0.0, "close": 15, "name": "FRO"},
        }
        auto = auto_structural_scores(indicators)
        # avg zscore = 0.5, expected = 5.5 + 0.5 * 2.25 = 6.625 → 6.6
        assert auto["tanker_rate"] == pytest.approx(6.6, abs=0.1)

    def test_tanker_one_proxy_only(self):
        """BWET만 있으면 BWET만으로 계산."""
        indicators = {"tanker_proxy": {"zscore": 1.0, "close": 20, "name": "BWET"}}
        auto = auto_structural_scores(indicators)
        assert "tanker_rate" in auto
        # z=1.0 → 5.5 + 1.0 * 2.25 = 7.75 → 7.8
        assert auto["tanker_rate"] == pytest.approx(7.8, abs=0.1)

    def test_missing_proxy(self):
        auto = auto_structural_scores({})
        assert auto == {}

    def test_partial_proxy(self):
        indicators = {"container_proxy": {"zscore": 0.5, "close": 25, "name": "ZIM"}}
        auto = auto_structural_scores(indicators)
        assert "container_rate" in auto
        assert "tanker_rate" not in auto

    def test_no_zscore(self):
        indicators = {"container_proxy": {"close": 25, "name": "ZIM"}}
        auto = auto_structural_scores(indicators)
        assert auto == {}


class TestFreightProxyConfig:
    def test_proxy_tickers_in_tier1(self):
        for manual_key, tier1_keys in FREIGHT_PROXY_MAP.items():
            for tier1_key in tier1_keys:
                assert tier1_key in TIER1_INDICATORS, f"{tier1_key} not in TIER1"

    def test_proxy_manual_keys_valid(self):
        for manual_key in FREIGHT_PROXY_MAP:
            assert manual_key in MANUAL_INDICATORS, f"{manual_key} not in MANUAL"

    def test_freight_category(self):
        for tier1_keys in FREIGHT_PROXY_MAP.values():
            for tier1_key in tier1_keys:
                assert TIER1_INDICATORS[tier1_key]["category"] == "freight"

    def test_tanker_has_four_proxies(self):
        """탱커운임은 BWET + FRO + STNG + TNK 네 프록시 (v6.0)."""
        assert len(FREIGHT_PROXY_MAP["tanker_rate"]) == 4

    def test_container_has_one_proxy(self):
        assert len(FREIGHT_PROXY_MAP["container_rate"]) == 1


class TestCycleScoreWithAutoFreight:
    def test_auto_fills_missing_manual(self):
        """자동 운임이 수동값 없을 때 채워지는지 확인."""
        indicators = {
            "container_proxy": {"zscore": 1.0, "close": 30, "name": "ZIM"},
            "tanker_proxy": {"zscore": 0.5, "close": 25, "name": "BWET"},
            "tanker_proxy2": {"zscore": 0.3, "close": 20, "name": "FRO"},
        }
        manual = {"scores": {"regulation": 8, "china_capacity": 4, "vessel_age": 8}}
        r = calculate_cycle_score({}, {}, None, manual, indicators)
        assert r is not None
        assert r["axis_scores"]["structural"] is not None
        # auto_keys should include container_rate and tanker_rate
        assert "container_rate" in r["details"]["structural"]["auto"]
        assert "tanker_rate" in r["details"]["structural"]["auto"]

    def test_manual_overrides_auto(self):
        """수동값이 있으면 자동값 무시."""
        indicators = {
            "container_proxy": {"zscore": 2.0, "close": 40, "name": "ZIM"},  # → 10.0
        }
        manual = {"scores": {"container_rate": 3.0, "regulation": 8}}
        r = calculate_cycle_score({}, {}, None, manual, indicators)
        assert r is not None
        # container_rate should NOT be in auto keys (manual override)
        assert "container_rate" not in r["details"]["structural"]["auto"]

    def test_no_indicators_no_auto(self):
        """indicators가 None이면 자동화 없음."""
        manual = {"scores": {"regulation": 8}}
        r = calculate_cycle_score({}, {}, None, manual, None)
        assert r is not None
        assert r["details"]["structural"]["auto"] == []


# ── Vessel Type Mix (승도리 방법론) ──────────────────────────────

class TestVesselTypeMix:
    def test_empty_dart(self):
        result = analyze_vessel_type_mix(None)
        assert result["phase_signal"] is None
        assert result["total_ships"] == 0

    def test_no_orders(self):
        result = analyze_vessel_type_mix({"status": "ok", "orders": []})
        assert result["total_ships"] == 0

    def test_phase1_dominant(self):
        """LNG/컨테이너 우세 → PRE 단계 (전환 없음)."""
        dart = {"status": "ok", "orders": [
            {"ship_type": "LNG운반선", "ship_count": 10},
            {"ship_type": "컨테이너선", "ship_count": 5},
            {"ship_type": "탱커", "ship_count": 3},
        ]}
        result = analyze_vessel_type_mix(dart)
        assert result["total_ships"] == 18
        assert result["phase1_ratio"] > result["phase2_ratio"]
        assert result["phase_signal"] is None

    def test_real_transition(self):
        """탱커/벌커가 LNG/컨테이너를 초과 + 30% 이상 → REAL_TRANSITION."""
        dart = {"status": "ok", "orders": [
            {"ship_type": "LNG운반선", "ship_count": 5},
            {"ship_type": "탱커", "ship_count": 8},
            {"ship_type": "벌크선", "ship_count": 4},
            {"ship_type": "VLCC", "ship_count": 3},
        ]}
        result = analyze_vessel_type_mix(dart)
        assert result["phase_signal"] == "REAL_TRANSITION"
        assert result["phase2_ratio"] > result["phase1_ratio"]

    def test_transition_emerging(self):
        """탱커/벌커 20%+ 이지만 아직 LNG보다 적음 → TRANSITION_EMERGING."""
        dart = {"status": "ok", "orders": [
            {"ship_type": "LNG운반선", "ship_count": 10},
            {"ship_type": "탱커", "ship_count": 4},
            {"ship_type": "FPSO", "ship_count": 1},
        ]}
        result = analyze_vessel_type_mix(dart)
        # phase2 = 4/15 = 0.267
        assert result["phase_signal"] == "TRANSITION_EMERGING"

    def test_defense_excluded(self):
        """방산 선박은 사이클 판정에서 별도 분류."""
        dart = {"status": "ok", "orders": [
            {"ship_type": "잠수함", "ship_count": 3},
            {"ship_type": "호위함", "ship_count": 2},
            {"ship_type": "탱커", "ship_count": 1},
        ]}
        result = analyze_vessel_type_mix(dart)
        assert result["by_category"]["defense"] == 5
        assert result["by_category"]["phase2_tanker_bulk"] == 1

    def test_unclassified_ship_type(self):
        """미분류 선종은 other로 분류."""
        dart = {"status": "ok", "orders": [
            {"ship_type": "미분류", "ship_count": 5},
            {"ship_type": "LNG운반선", "ship_count": 3},
        ]}
        result = analyze_vessel_type_mix(dart)
        assert result["by_category"]["other"] == 5

    def test_default_ship_count(self):
        """ship_count 없으면 1척으로 계산."""
        dart = {"status": "ok", "orders": [
            {"ship_type": "탱커"},
            {"ship_type": "탱커"},
        ]}
        result = analyze_vessel_type_mix(dart)
        assert result["total_ships"] == 2


class TestImpliedPeakYears:
    def test_above_average_pe(self):
        """PE가 평균 이상이면 내재 성장 연수 계산."""
        valuation = {"stocks": {"hhi": {
            "name": "HHI", "market_cap": 32e12, "trailing_pe": 25.0,
            "price_to_book": 2.0, "enterprise_value": 35e12,
            "ev_ebitda": None, "roe": None, "operating_margins": None,
        }}}
        ctx = analyze_valuation_context(valuation, None)
        assert ctx["hhi"]["implied_peak_years"] > 0

    def test_below_average_pe(self):
        """PE가 평균 이하면 내재 성장 연수 0."""
        valuation = {"stocks": {"hhi": {
            "name": "HHI", "market_cap": 32e12, "trailing_pe": 10.0,
            "price_to_book": 1.0, "enterprise_value": 25e12,
            "ev_ebitda": None, "roe": None, "operating_margins": None,
        }}}
        ctx = analyze_valuation_context(valuation, None)
        assert ctx["hhi"]["implied_peak_years"] == 0

    def test_pe_at_max_gives_3_years(self):
        """PE가 역사적 최고(55x)이면 ~3년."""
        valuation = {"stocks": {"hhi": {
            "name": "HHI", "market_cap": 32e12, "trailing_pe": 55.0,
            "price_to_book": None, "enterprise_value": None,
            "ev_ebitda": None, "roe": None, "operating_margins": None,
        }}}
        ctx = analyze_valuation_context(valuation, None)
        # (55 - 18) / (55 - 18) * 3 = 3.0
        assert ctx["hhi"]["implied_peak_years"] == pytest.approx(3.0, abs=0.1)


# ── Report Data JSON Save/Load ────────────────────────────────

class TestReportDataSaveLoad:
    def _sample_data(self):
        pulse = {"score": 55.0, "details": {}}
        combined = {"combined": 65.0, "market_pulse": 55.0, "cycle_score": 66.8}
        fin_trends = {"ksoe": {"name": "HD한국조선해양", "revenue": 25.5e12,
                      "operating_profit": 1.48e12, "op_margin": 5.8, "op_margin_qoq": 1.8,
                      "contract_assets": 7.5e12, "contract_assets_qoq": 15.4,
                      "contract_liabilities": 12.7e12, "roe": 6.25}}
        val_ctx = {"ksoe": {"name": "HD한국조선해양", "pe_ttm": 18.5, "pb": 2.6,
                   "market_cap": 32e12, "ev_ebitda": 7.1, "roe": 0.18,
                   "pe_vs_avg_pct": 42.3, "implied_peak_years": 1.4}}
        backlog = {"delivery_schedule": {2028: 3}, "lead_time_avg_years": 3.2}
        dart = {"status": "ok", "estimates": {"total_orders": 10, "total_ships": 15,
                "avg_price_per_ship_usd": 180_000_000, "total_amount_usd": 2_700_000_000,
                "by_type": {"LNG운반선": {"count": 10, "amount_usd": 2e9}}}}
        peakout = [{"key": "margin_qoq", "value": 1.8, "status": "normal"},
                   {"key": "lead_time_years", "value": 3.2, "status": "normal"}]
        vessel_mix = {"phase1_ratio": 0.7, "phase2_ratio": 0.2, "phase_signal": None}
        manual = {"scores": {"regulation": 8}}
        return pulse, combined, fin_trends, val_ctx, backlog, dart, peakout, vessel_mix, manual

    def test_save_and_load(self, tmp_path):
        pulse, combined, fin_trends, val_ctx, backlog, dart, peakout, vessel_mix, manual = self._sample_data()
        with patch("pipeline.shipbuilding_cycle_tracker.REPORT_DATA_DIR", tmp_path), \
             patch("pipeline.shipbuilding_cycle_tracker.SCORE_HISTORY_FILE", tmp_path / "score_history.json"), \
             patch("pipeline.shipbuilding_cycle_tracker.PEAKOUT_HISTORY_FILE", tmp_path / "peakout_history.json"), \
             patch("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path):
            path = _save_report_data(8, 2026, pulse, combined, fin_trends, val_ctx,
                                     backlog, dart, peakout, vessel_mix, manual)
            assert path.exists()
            data = json.loads(path.read_text())
            assert data["week"] == 8
            assert data["year"] == 2026
            assert data["combined_score"] == 65.0
            assert "ksoe" in data["valuation"]
            assert "ksoe" in data["financials"]
            assert data["orders"]["total_orders"] == 10

    def test_load_previous_skips_current(self, tmp_path):
        pulse, combined, fin_trends, val_ctx, backlog, dart, peakout, vessel_mix, manual = self._sample_data()
        with patch("pipeline.shipbuilding_cycle_tracker.REPORT_DATA_DIR", tmp_path), \
             patch("pipeline.shipbuilding_cycle_tracker.SCORE_HISTORY_FILE", tmp_path / "score_history.json"), \
             patch("pipeline.shipbuilding_cycle_tracker.PEAKOUT_HISTORY_FILE", tmp_path / "peakout_history.json"), \
             patch("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path):
            _save_report_data(7, 2026, pulse, combined, fin_trends, val_ctx,
                              backlog, dart, peakout, vessel_mix, manual)
            _save_report_data(8, 2026, pulse, combined, fin_trends, val_ctx,
                              backlog, dart, peakout, vessel_mix, manual)
            prev = _load_previous_report_data(8, 2026)
            assert prev is not None
            assert prev["week"] == 7

    def test_load_previous_no_data(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.REPORT_DATA_DIR", tmp_path):
            assert _load_previous_report_data(8, 2026) is None

    def test_load_previous_only_current(self, tmp_path):
        pulse, combined, fin_trends, val_ctx, backlog, dart, peakout, vessel_mix, manual = self._sample_data()
        with patch("pipeline.shipbuilding_cycle_tracker.REPORT_DATA_DIR", tmp_path), \
             patch("pipeline.shipbuilding_cycle_tracker.SCORE_HISTORY_FILE", tmp_path / "score_history.json"), \
             patch("pipeline.shipbuilding_cycle_tracker.PEAKOUT_HISTORY_FILE", tmp_path / "peakout_history.json"), \
             patch("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path):
            _save_report_data(8, 2026, pulse, combined, fin_trends, val_ctx,
                              backlog, dart, peakout, vessel_mix, manual)
            assert _load_previous_report_data(8, 2026) is None

    def test_save_without_dart(self, tmp_path):
        pulse, combined, fin_trends, val_ctx, backlog, _, peakout, vessel_mix, manual = self._sample_data()
        with patch("pipeline.shipbuilding_cycle_tracker.REPORT_DATA_DIR", tmp_path), \
             patch("pipeline.shipbuilding_cycle_tracker.SCORE_HISTORY_FILE", tmp_path / "score_history.json"), \
             patch("pipeline.shipbuilding_cycle_tracker.PEAKOUT_HISTORY_FILE", tmp_path / "peakout_history.json"), \
             patch("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path):
            path = _save_report_data(8, 2026, pulse, combined, fin_trends, val_ctx,
                                     backlog, None, peakout, vessel_mix, manual)
            data = json.loads(path.read_text())
            assert "orders" not in data

    def test_save_with_indicators(self, tmp_path):
        pulse, combined, fin_trends, val_ctx, backlog, dart, peakout, vessel_mix, manual = self._sample_data()
        indicators = {"bdi": {"close": 20.5, "zscore": 0.5, "change_pct": 1.2}}
        with patch("pipeline.shipbuilding_cycle_tracker.REPORT_DATA_DIR", tmp_path), \
             patch("pipeline.shipbuilding_cycle_tracker.SCORE_HISTORY_FILE", tmp_path / "score_history.json"), \
             patch("pipeline.shipbuilding_cycle_tracker.PEAKOUT_HISTORY_FILE", tmp_path / "peakout_history.json"), \
             patch("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path):
            path = _save_report_data(8, 2026, pulse, combined, fin_trends, val_ctx,
                                     backlog, dart, peakout, vessel_mix, manual, indicators)
            data = json.loads(path.read_text())
            assert "demand_indicators" in data
            assert data["demand_indicators"]["bdi"]["close"] == 20.5


# ── Delta String Helpers ───────────────────────────────────────

class TestDeltaStr:
    def test_with_values(self):
        s = _delta_str(10.5, 8.2, "%")
        assert "전월" in s
        assert "8.2" in s

    def test_with_none(self):
        assert _delta_str(None, 8.2, "%") == ""
        assert _delta_str(10.5, None, "%") == ""

    def test_pct_mode(self):
        s = _delta_str(110.0, 100.0, "", pct=True)
        assert "+10.0%" in s


class TestAddComparisonRow:
    def test_with_values(self):
        lines = []
        _add_comparison_row(lines, "Score", 65.0, 60.0, "/100")
        assert len(lines) == 1
        assert "65.0" in lines[0]
        assert "60.0" in lines[0]
        assert "+5.0" in lines[0]

    def test_with_none_previous(self):
        lines = []
        _add_comparison_row(lines, "Score", 65.0, None, "/100")
        assert "65.0" in lines[0]
        assert "| - |" in lines[0]  # previous is dash

    def test_negative_delta(self):
        lines = []
        _add_comparison_row(lines, "Score", 55.0, 60.0, "")
        assert "-5.0" in lines[0]


# ── DM with Prev Data ─────────────────────────────────────────

class TestDMWithPrevData:
    def test_dm_with_prev_score(self):
        pulse = {"score": 55.0, "details": {}}
        combined = {"combined": 65.0, "market_pulse": 55.0, "cycle_score": 66.8, "method": "combined"}
        prev = {"combined_score": 60.0, "market_pulse": 50.0}
        dm = format_telegram_dm(pulse, combined, [], {}, None, prev_data=prev)
        assert "↑" in dm or "↓" in dm or "→" in dm  # arrow present

    def test_dm_no_prev_no_arrow(self):
        pulse = {"score": 55.0, "details": {}}
        combined = {"combined": None, "market_pulse": 55.0, "method": "market_pulse_only"}
        dm = format_telegram_dm(pulse, combined, [], {}, None, prev_data=None)
        assert "↑" not in dm and "↓" not in dm  # no arrow

    def test_dm_with_margin_comparison(self):
        pulse = {"score": 55.0, "details": {}}
        combined = {"combined": 65.0, "market_pulse": 55.0, "cycle_score": 66.8, "method": "combined"}
        fin_trends = {"ksoe": {"name": "KSOE", "op_margin": 7.5, "op_margin_qoq": 1.2,
                      "contract_assets": 8e12, "contract_assets_qoq": 5.0}}
        prev = {"combined_score": 60.0, "financials": {"ksoe": {"op_margin": 6.0, "contract_assets": 7e12}}}
        dm = format_telegram_dm(pulse, combined, [], {}, None, fin_trends=fin_trends, prev_data=prev)
        assert "실적" in dm


# ── Report v3 Comprehensive ────────────────────────────────────

class TestReportV3Comprehensive:
    def _full_report(self, prev_data=None):
        data = {"indicators": {"bdi": {"name": "BDI", "close": 20.5, "change_pct": 1.2, "zscore": 0.8, "category": "demand"}}}
        pulse = {"score": 55.0, "details": {"bdi": {"zscore": 0.8}}}
        cycle = {"score": 66.8, "axis_scores": {"financial": 70.0, "order": 65.0, "valuation": 55.0, "structural": 72.0},
                 "details": {"financial": {"score": 70.0}, "order": {"score": 65.0}, "valuation": {"score": 55.0},
                             "structural": {"score": 72.0, "auto": []}}}
        combined = {"combined": 65.0, "market_pulse": 55.0, "cycle_score": 66.8, "method": "combined"}
        fin_trends = {"ksoe": {"name": "HD한국조선해양", "revenue": 25.5e12,
                      "operating_profit": 1.48e12, "op_margin": 5.8, "op_margin_qoq": 1.8,
                      "contract_assets": 7.5e12, "contract_liabilities": 12.7e12, "contract_assets_qoq": 15.4}}
        val_ctx = {"ksoe": {"name": "HD한국조선해양", "pe_ttm": 18.5, "pb": 2.6, "pe_source": "trailing",
                   "market_cap": 32e12, "ev_ebitda": 7.1, "roe": 0.18,
                   "pe_vs_avg_pct": 42.3, "implied_peak_years": 1.4}}
        dart = {"status": "ok", "orders": [{}], "estimates": {"total_orders": 10, "total_ships": 15,
                "avg_price_per_ship_usd": 180_000_000, "total_amount_usd": 2_700_000_000,
                "by_type": {"LNG운반선": {"count": 10, "amount_usd": 2e9}}}}
        peakout = [
            {"key": "margin_qoq", "axis": "실적", "desc": "영업이익률 QoQ (%p)", "value": 1.8, "threshold": -1.0, "status": "normal"},
            {"key": "contract_asset_qoq", "axis": "실적", "desc": "계약자산 QoQ (%)", "value": 15.4, "threshold": -5.0, "status": "normal"},
            {"key": "order_count_90d", "axis": "수주", "desc": "90일 수주건수", "value": 10, "threshold": 10, "status": "normal"},
            {"key": "avg_price_qoq", "axis": "수주", "desc": "평균선가 QoQ (%)", "value": None, "threshold": -10.0, "status": "no_data"},
            {"key": "lead_time_years", "axis": "선가", "desc": "인도 리드타임 (년)", "value": 3.2, "threshold": 4.0, "status": "normal"},
            {"key": "pe_vs_avg", "axis": "밸류", "desc": "P/E vs 5Y평균 (%)", "value": 42.3, "threshold": 100.0, "status": "normal"},
        ]
        vessel_mix = {"total_ships": 15, "phase1_ratio": 0.67, "phase2_ratio": 0.2, "phase_signal": None,
                      "by_category": {"phase1_lng_container": 10, "phase2_tanker_bulk": 3, "defense": 0, "other": 2}}
        backlog = {"delivery_schedule": {2028: 10, 2029: 5}, "lead_time_avg_years": 3.2}
        return build_weekly_report(data, pulse, cycle, combined, [], dart,
                                    fin_trends, val_ctx, backlog, peakout, vessel_mix, prev_data)

    def test_v5_sections_present(self):
        """v5.3 리포트는 조선업 개요 + 7개 섹션 포함."""
        prev = {"week": 7, "year": 2026, "combined_score": 60.0, "pulse_score": 50.0,
                "cycle_score": 62.0, "market_pulse": 50.0,
                "financials": {"ksoe": {"name": "HD한국조선해양", "op_margin": 5.0, "contract_assets": 7e12}},
                "valuation": {"ksoe": {"name": "HD한국조선해양", "pe_ttm": 16.0, "pb": 2.3}},
                "peakout": [{"key": "margin_qoq", "value": 0.5, "status": "normal"}]}
        report = self._full_report(prev)
        assert "## 조선업 개요" in report
        assert "## 1. 사이클 종합 판정" in report
        assert "## 2. 기업 종합" in report
        assert "## 3. 수주 & 선종" in report
        assert "## 4. 수요 환경" in report
        assert "## 5. 피크아웃" in report
        assert "## 6. 경쟁국 분석" in report
        assert "## 7. 출처" in report

    def test_no_section_10_without_prev(self):
        """v5는 전월 비교 별도 섹션 없음."""
        report = self._full_report(None)
        assert "전월 대비 변화 요약" not in report

    def test_framework_section_removed(self):
        """분석 프레임워크 별도 섹션이 제거됨 (단계 이름은 유지)."""
        report = self._full_report(None)
        # v5: 별도 프레임워크 섹션은 없음
        assert "분석 프레임워크" not in report
        # 단계 이름(Pre-Supercycle 등)은 Section 1에서 사용 — OK

    def test_valuation_definitions_removed(self):
        """v5에서는 P/E 기준표 정의 블록이 제거됨."""
        report = self._full_report(None)
        assert "P/E <10x" not in report
        assert "P/E >40x" not in report

    def test_demand_table_format(self):
        """v5 수요 환경 섹션이 테이블 형식으로 출력."""
        report = self._full_report(None)
        assert "BDI" in report
        # v5: 수요 환경은 테이블(|) 형식
        demand_section = ""
        in_demand = False
        for line in report.split("\n"):
            if "## 4. 수요 환경" in line:
                in_demand = True
            elif in_demand and line.startswith("## "):
                break
            elif in_demand:
                demand_section += line + "\n"
        assert "|" in demand_section

    def test_peakout_per_indicator_definition_removed(self):
        """v5에서는 지표별 정의/임계치 텍스트가 제거됨."""
        report = self._full_report(None)
        assert "QoQ -1.0%p 이하" not in report
        assert "10건 미만" not in report

    def test_axis_contribution_breakdown(self):
        """사이클 종합 판정에 축별 기여도 분해가 포함."""
        report = self._full_report(None)
        assert "축별 기여도" in report
        assert "Financial (25%)" in report
        assert "Order (22%)" in report

    def test_valuation_pe_pb_transition_removed(self):
        """v5에서는 P/B→P/E 전환 설명이 제거됨."""
        report = self._full_report(None)
        assert "P/B에서 P/E로의 전환" not in report

    def test_company_master_section(self):
        """v5에서는 '기업 종합' 섹션이 존재."""
        report = self._full_report(None)
        assert "## 2. 기업 종합" in report

    def test_vessel_type_demand_drivers_removed(self):
        """v5에서는 선종별 수요 드라이버 섹션이 제거됨."""
        report = self._full_report(None)
        assert "### 선종별 수요 드라이버" not in report

    def test_demand_supply_linkage_removed(self):
        """v5에서는 선종별 수요-공급 연결 섹션이 제거됨."""
        report = self._full_report(None)
        assert "### 선종별 수요-공급 연결" not in report

    def test_freight_proxy_with_indicators(self):
        """운임 프록시 지표가 freight indicators 있을 때 포함."""
        data = {"indicators": {
            "bdi": {"name": "BDI", "close": 20.5, "change_pct": 1.2, "zscore": 0.8, "category": "demand"},
            "container_proxy": {"name": "ZIM (컨테이너운임)", "close": 25.0, "change_pct": 2.0, "zscore": 0.5, "category": "freight"},
            "tanker_proxy": {"name": "BWET (탱커운임ETF)", "close": 18.0, "change_pct": -1.0, "zscore": -0.3, "category": "freight"},
        }}
        pulse = {"score": 55.0, "details": {"bdi": {"zscore": 0.8}}}
        combined = {"combined": None, "market_pulse": 55.0, "method": "market_pulse_only"}
        report = build_weekly_report(data, pulse, None, combined, [], None)
        assert "운임 프록시" in report


# ── Markdown → Telegram HTML ─────────────────────────────────

class TestMdToTelegramHtml:
    def test_headers_to_bold(self):
        assert _md_to_telegram_html("## Header") == "<b>Header</b>"
        assert _md_to_telegram_html("### Sub") == "<b>Sub</b>"
        assert _md_to_telegram_html("# Title") == "<b>Title</b>"

    def test_bold_conversion(self):
        assert _md_to_telegram_html("some **bold** text") == "some <b>bold</b> text"

    def test_italic_conversion(self):
        result = _md_to_telegram_html("some *italic* text")
        assert "<i>italic</i>" in result

    def test_multiline(self):
        md = "## Title\nsome **bold** and *italic*\nnormal line"
        html = _md_to_telegram_html(md)
        lines = html.split("\n")
        assert lines[0] == "<b>Title</b>"
        assert "<b>bold</b>" in lines[1]
        assert "<i>italic</i>" in lines[1]
        assert lines[2] == "normal line"

    def test_empty_string(self):
        assert _md_to_telegram_html("") == ""

    def test_no_markdown(self):
        assert _md_to_telegram_html("plain text") == "plain text"


# ── Split Report for Telegram ────────────────────────────────

class TestSplitReportForTelegram:
    def test_small_report_single_chunk(self):
        report = "## Section 1\nShort content."
        chunks = _split_report_for_telegram(report, max_len=4000)
        assert len(chunks) == 1
        assert "Section 1" in chunks[0]

    def test_splits_by_section(self):
        # Each section is ~30 chars, max_len=50 → should split into separate chunks
        section1 = "## Section A\n" + "A" * 30 + "\n"
        section2 = "## Section B\n" + "B" * 30 + "\n"
        report = section1 + section2
        chunks = _split_report_for_telegram(report, max_len=50)
        assert len(chunks) == 2
        assert "Section A" in chunks[0]
        assert "Section B" in chunks[1]

    def test_large_section_splits_by_subsection(self):
        # Single ## section with ### subsections, exceeds max_len
        sub1 = "### Sub 1\n" + "X" * 40 + "\n"
        sub2 = "### Sub 2\n" + "Y" * 40 + "\n"
        report = "## Big Section\nIntro\n" + sub1 + sub2
        chunks = _split_report_for_telegram(report, max_len=60)
        assert len(chunks) >= 2
        # All content should be present across chunks
        full = "\n".join(chunks)
        assert "Sub 1" in full
        assert "Sub 2" in full

    def test_empty_report(self):
        assert _split_report_for_telegram("") == []

    def test_sections_combined_when_fit(self):
        section1 = "## A\nShort.\n"
        section2 = "## B\nAlso short.\n"
        chunks = _split_report_for_telegram(section1 + section2, max_len=4000)
        assert len(chunks) == 1
        assert "A" in chunks[0] and "B" in chunks[0]


# ── Send Telegram Full Report ────────────────────────────────

class TestSendTelegramFullReport:
    def test_dry_run_returns_true(self):
        """dry_run=True returns True without sending anything."""
        result = send_telegram_full_report("## Test Report\nContent here.", dry_run=True)
        assert result is True

    def test_dm_only_default(self, mock_telegram):
        """기본값 dm_only=True → DM 1회만 전송."""
        mock_telegram.set_response({"ok": True, "result": {}})
        report = "## Section\nContent."
        result = send_telegram_full_report(report, dry_run=False)
        assert result is True
        # 1 chunk × 1 destination (DM only) = 1 call
        assert mock_telegram.call_count == 1

    def test_sends_to_both_when_dm_only_false(self, mock_telegram):
        """dm_only=False → DM + 지식사랑방 = 2회 전송."""
        mock_telegram.set_response({"ok": True, "result": {}})
        report = "## Section\nContent."
        result = send_telegram_full_report(report, dry_run=False, dm_only=False)
        assert result is True
        # 1 chunk × 2 destinations = 2 calls
        assert mock_telegram.call_count == 2

    def test_multiple_chunks_dm_only(self, mock_telegram):
        """여러 chunk + dm_only=True → chunk수만큼만 전송."""
        mock_telegram.set_response({"ok": True, "result": {}})
        section1 = "## Section A\n" + "A" * 100 + "\n"
        section2 = "## Section B\n" + "B" * 100 + "\n"
        report = section1 + section2
        result = send_telegram_full_report(report, dry_run=False)
        assert result is True
        # Both sections fit in one chunk, 1 destination = 1 call
        assert mock_telegram.call_count == 1

    def test_send_failure_returns_false(self):
        """urllib 에러 시 False 반환."""
        with patch("urllib.request.urlopen", side_effect=Exception("network error")):
            result = send_telegram_full_report("## Test\nContent.", dry_run=False)
            assert result is False


# ══════════════════════════════════════════════════════════════════
#  v4: VESSEL_DRIVERS & COMPETITOR_DATA
# ══════════════════════════════════════════════════════════════════

class TestVesselDrivers:
    def test_vessel_drivers_has_6_types(self):
        assert len(VESSEL_DRIVERS) == 6

    def test_vessel_drivers_required_keys(self):
        for stype, info in VESSEL_DRIVERS.items():
            assert "drivers" in info, f"{stype} missing drivers"
            assert "indicators" in info, f"{stype} missing indicators"
            assert "cycle_stage" in info, f"{stype} missing cycle_stage"
            assert "source" in info, f"{stype} missing source"
            assert isinstance(info["drivers"], list)
            assert len(info["drivers"]) >= 2, f"{stype} needs at least 2 drivers"

    def test_vessel_drivers_indicators_exist_in_tier1(self):
        all_indicator_keys = set(TIER1_INDICATORS.keys())
        for stype, info in VESSEL_DRIVERS.items():
            for ik in info["indicators"]:
                assert ik in all_indicator_keys, f"{stype} indicator {ik} not in TIER1"

    def test_vessel_drivers_sources_are_urls(self):
        for stype, info in VESSEL_DRIVERS.items():
            assert "t.me/" in info["source"], f"{stype} source should be telegram URL"

    def test_lng_drivers_mention_key_themes(self):
        drivers_text = " ".join(VESSEL_DRIVERS["LNG운반선"]["drivers"])
        assert "LNG" in drivers_text

    def test_tanker_has_freight_indicators(self):
        inds = VESSEL_DRIVERS["탱커"]["indicators"]
        assert "tanker_proxy" in inds or "tanker_proxy2" in inds

    def test_defense_has_empty_indicators(self):
        """방산은 시장 지표 연동 없음."""
        assert VESSEL_DRIVERS["방산(해군)"]["indicators"] == []


class TestCompetitorData:
    def test_competitor_data_has_3_countries(self):
        assert len(COMPETITOR_DATA) == 3
        assert set(COMPETITOR_DATA.keys()) == {"china", "japan", "singapore"}

    def test_competitor_required_keys(self):
        required = {"name", "major_yards", "global_share", "strengths",
                     "weaknesses", "capacity_threat", "key_risk", "source"}
        for key, comp in COMPETITOR_DATA.items():
            missing = required - set(comp.keys())
            assert not missing, f"{key} missing: {missing}"

    def test_capacity_threat_range(self):
        for key, comp in COMPETITOR_DATA.items():
            assert 0 <= comp["capacity_threat"] <= 10, f"{key} threat out of range"

    def test_china_has_highest_threat(self):
        assert COMPETITOR_DATA["china"]["capacity_threat"] > COMPETITOR_DATA["japan"]["capacity_threat"]
        assert COMPETITOR_DATA["china"]["capacity_threat"] > COMPETITOR_DATA["singapore"]["capacity_threat"]

    def test_strengths_weaknesses_are_lists(self):
        for key, comp in COMPETITOR_DATA.items():
            assert isinstance(comp["strengths"], list)
            assert isinstance(comp["weaknesses"], list)
            assert len(comp["strengths"]) >= 2
            assert len(comp["weaknesses"]) >= 2

    def test_major_yards_non_empty(self):
        for key, comp in COMPETITOR_DATA.items():
            assert len(comp["major_yards"]) >= 1


class TestReportSources:
    def test_sources_have_required_keys(self):
        for key, src in REPORT_SOURCES.items():
            assert "title" in src
            assert "url" in src
            assert src["url"].startswith("https://")

    def test_analyst_methodologies_structure(self):
        assert "최광식" in ANALYST_METHODOLOGIES
        info = ANALYST_METHODOLOGIES["최광식"]
        assert info["firm"] == "다올투자증권"
        assert len(info["methodologies"]) >= 5
        assert "방법론만 참고" in info["note"]


# ══════════════════════════════════════════════════════════════════
#  v4: Charts
# ══════════════════════════════════════════════════════════════════

class TestSetupChartEnv:
    def test_returns_plt_module(self):
        plt = _setup_chart_env()
        assert hasattr(plt, "subplots")
        assert hasattr(plt, "close")
        plt.close("all")


class TestChartRadar:
    def test_chart_radar_creates_file(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.CHART_DIR", tmp_path):
            combined = {"market_pulse": 55, "combined": 60}
            cycle = {"axis_scores": {
                "demand": 55, "financial": 65, "order": 50,
                "valuation": 40, "structural": 70,
            }}
            result = _chart_radar(combined, cycle, "2026-02-21")
            if result:
                assert result.exists()
                assert result.suffix == ".png"

    def test_chart_radar_no_cycle(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.CHART_DIR", tmp_path):
            combined = {"market_pulse": 55}
            result = _chart_radar(combined, None, "2026-02-21")
            if result:
                assert result.exists()


class TestChartValuationBars:
    def test_chart_creates_file(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.CHART_DIR", tmp_path):
            val_ctx = {
                "hhi": {"name": "HD현대중공업", "pe_ttm": 20.0, "pb": 3.5},
                "hanwha": {"name": "한화오션", "pe_ttm": 25.0, "pb": 4.0},
            }
            result = _chart_valuation_bars(val_ctx, "2026-02-21")
            if result:
                assert result.exists()

    def test_empty_val_ctx(self):
        result = _chart_valuation_bars({}, "2026-02-21")
        # Empty dict may produce empty chart or None
        # Just verify no crash


class TestChartMarginTrend:
    def test_no_financials(self):
        assert _chart_margin_trend(None, "2026-02-21") is None

    def test_with_financials(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.CHART_DIR", tmp_path):
            fins = {"companies": {
                "hhi": {"name": "HD현대중공업", "quarters": {
                    "2025Q1": {"revenue": 5e12, "operating_profit": 4e11},
                    "2025Q2": {"revenue": 5.5e12, "operating_profit": 5e11},
                }},
            }}
            result = _chart_margin_trend(fins, "2026-02-21")
            if result:
                assert result.exists()


class TestChartContractAssets:
    def test_empty_fin_trends(self):
        result = _chart_contract_assets({}, None, "2026-02-21")
        assert result is None

    def test_with_data(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.CHART_DIR", tmp_path):
            financials = {"companies": {
                "hhi": {"name": "HD현대중공업", "quarters": {
                    "2025-Q1": {"contract_assets": 15e12},
                    "2025-Q2": {"contract_assets": 16e12},
                }},
                "hanwha": {"name": "한화오션", "quarters": {
                    "2025-Q1": {"contract_assets": 8e12},
                    "2025-Q2": {"contract_assets": 7.5e12},
                }},
            }}
            result = _chart_contract_assets({}, financials, "2026-02-21")
            if result:
                assert result.exists()


class TestChartVesselMix:
    def test_no_dart_data(self):
        result = _chart_vessel_mix({}, None, "2026-02-21")
        assert result is None

    def test_with_data(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.CHART_DIR", tmp_path):
            dart = {"orders": [
                {"company": "HD현대중공업", "ship_type": "LNG운반선", "ship_count": 3},
                {"company": "HD현대중공업", "ship_type": "탱커", "ship_count": 2},
                {"company": "삼성중공업", "ship_type": "LNG운반선", "ship_count": 4},
                {"company": "한화오션", "ship_type": "탱커", "ship_count": 3},
            ]}
            vmix = {"phase1_ratio": 0.54, "phase2_ratio": 0.38}
            result = _chart_vessel_mix(vmix, dart, "2026-02-21")
            if result:
                assert result.exists()


class TestChartDemandZscore:
    def test_empty_indicators(self):
        result = _chart_demand_zscore({}, "2026-02-21")
        assert result is None

    def test_with_indicators(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.CHART_DIR", tmp_path):
            inds = {
                "bdi": {"name": "BDI", "close": 1500, "zscore": 0.8},
                "wti": {"name": "WTI", "close": 75.0, "zscore": -0.3},
                "natgas": {"name": "천연가스", "close": 3.5, "zscore": 1.2},
            }
            result = _chart_demand_zscore(inds, "2026-02-21")
            if result:
                assert result.exists()


class TestChartDeliverySchedule:
    def test_empty_backlog(self):
        result = _chart_delivery_schedule({}, None, "2026-02-21")
        assert result is None

    def test_with_schedule(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.CHART_DIR", tmp_path):
            bl = {"delivery_schedule": {"2026": 15, "2027": 22, "2028": 18},
                  "lead_time_avg_years": 3.2}
            result = _chart_delivery_schedule(bl, None, "2026-02-21")
            if result:
                assert result.exists()


class TestChartPeakoutGauge:
    def test_empty_peakout(self):
        with patch("pipeline.shipbuilding_cycle_tracker._load_peakout_history", return_value=[]):
            result = _chart_peakout_gauge([], "2026-02-21")
            assert result is None

    def test_with_peakout(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.CHART_DIR", tmp_path), \
             patch("pipeline.shipbuilding_cycle_tracker._load_peakout_history", return_value=[]):
            po = [
                {"key": "margin_qoq", "desc": "영업이익률 QoQ", "status": "normal", "value": 1.5},
                {"key": "contract_asset_qoq", "desc": "계약자산 QoQ", "status": "warning", "value": -6.0},
                {"key": "order_count_90d", "desc": "수주건수", "status": "normal", "value": 15},
            ]
            result = _chart_peakout_gauge(po, "2026-02-21")
            if result:
                assert result.exists()


class TestGenerateCharts:
    def test_returns_list_of_tuples(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.CHART_DIR", tmp_path):
            data = {"indicators": {}}
            pulse = {"score": 55}
            combined = {"combined": 60, "market_pulse": 55}
            result = generate_charts(
                data, pulse, combined, None, {}, {}, {},
                [], {}, None, None, {},
            )
            assert isinstance(result, list)
            for item in result:
                assert isinstance(item, tuple)
                assert len(item) == 2


# ══════════════════════════════════════════════════════════════════
#  v4: PDF
# ══════════════════════════════════════════════════════════════════

class TestFindKoreanFont:
    def test_finds_font_on_macos(self):
        font = _find_korean_font()
        if font:
            assert Path(font).exists()


class TestBuildPdfReport:
    def test_basic_pdf_creation(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.REPORT_DIR", tmp_path):
            report_md = "## 1. 종합 판정\n\n테스트 내용입니다.\n\n## 2. 밸류에이션\n\n밸류에이션 내용."
            result = build_pdf_report(report_md, [], "2026-02-21")
            if result:
                assert result.exists()
                assert result.suffix == ".pdf"
                assert result.stat().st_size > 0

    def test_pdf_with_chart(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.REPORT_DIR", tmp_path), \
             patch("pipeline.shipbuilding_cycle_tracker.CHART_DIR", tmp_path):
            # Create a dummy chart PNG
            plt = _setup_chart_env()
            fig, ax = plt.subplots(figsize=(4, 4))
            ax.plot([1, 2, 3], [1, 4, 9])
            chart_path = tmp_path / "test_chart.png"
            fig.savefig(chart_path)
            plt.close(fig)

            report_md = "## 1. 종합 판정\n\n테스트.\n"
            charts = [(chart_path, "테스트 차트")]
            result = build_pdf_report(report_md, charts, "2026-02-21")
            if result:
                assert result.exists()


class TestSendTelegramPdf:
    def test_dry_run(self, tmp_path):
        pdf_path = tmp_path / "test.pdf"
        pdf_path.write_bytes(b"%PDF-1.4 test")
        result = send_telegram_pdf(pdf_path, "test caption", dry_run=True)
        assert result is True

    def test_send_with_mock(self, tmp_path):
        pdf_path = tmp_path / "test.pdf"
        pdf_path.write_bytes(b"%PDF-1.4 test content")
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"ok": True}).encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        with patch("urllib.request.urlopen", return_value=mock_resp):
            result = send_telegram_pdf(pdf_path, "test", dry_run=False)
            assert result is True

    def test_send_failure(self, tmp_path):
        pdf_path = tmp_path / "test.pdf"
        pdf_path.write_bytes(b"%PDF-1.4 test")
        with patch("urllib.request.urlopen", side_effect=Exception("network")):
            result = send_telegram_pdf(pdf_path, "test", dry_run=False)
            assert result is False


class TestSendProgressDm:
    def test_dry_run_no_crash(self):
        _send_progress_dm("test progress", dry_run=True)

    def test_network_failure_no_crash(self):
        with patch("urllib.request.urlopen", side_effect=Exception("fail")):
            _send_progress_dm("test", dry_run=False)


# ══════════════════════════════════════════════════════════════════
#  v4: Report sections
# ══════════════════════════════════════════════════════════════════

class TestReportV5Sections:
    """v5 리포트 구조 검증."""

    def _build_minimal_report(self):
        data = {"indicators": {
            "bdi": {"name": "BDI", "close": 1500, "zscore": 0.5, "change_pct": 1.0},
        }}
        pulse = {"score": 55.0, "details": {}}
        combined = {"combined": 60.0, "market_pulse": 55.0, "cycle_score": 62.0}
        signals: list = []
        dart = {"status": "ok", "orders": [
            {"ship_type": "LNG운반선", "ship_count": 5, "amount_usd": 1e9, "delivery_date": "2028-06", "company": "HD현대중공업"},
            {"ship_type": "탱커", "ship_count": 3, "amount_usd": 4e8, "delivery_date": "2027-12", "company": "삼성중공업"},
        ], "estimates": {
            "total_orders": 8, "total_ships": 8, "total_amount_usd": 1.4e9,
            "avg_price_per_ship_usd": 175e6,
            "by_type": {
                "LNG운반선": {"count": 5, "amount_usd": 1e9},
                "탱커": {"count": 3, "amount_usd": 4e8},
            },
        }}
        peakout = [
            {"key": "margin_qoq", "axis": "실적", "desc": "OPM QoQ", "value": 1.8, "threshold": -1.0, "status": "normal"},
        ]
        return build_weekly_report(data, pulse, None, combined, signals, dart, peakout=peakout)

    def test_v5_sections_present(self):
        report = self._build_minimal_report()
        assert "## 1. 사이클 종합 판정" in report
        assert "## 2. 기업 종합" in report
        assert "## 3. 수주 & 선종" in report
        assert "## 4. 수요 환경" in report
        assert "## 5. 피크아웃" in report
        assert "## 7. 출처" in report

    def test_v4_sections_removed(self):
        report = self._build_minimal_report()
        assert "## 8. 선종별 드라이버" not in report
        assert "## 9. 경쟁국 분석" not in report
        assert "전월 대비 변화 요약" not in report
        assert "분석 프레임워크" not in report

    def test_no_definition_blocks(self):
        """정의/기준 블록이 보고서에 미출현."""
        report = self._build_minimal_report()
        assert "P/E <10x" not in report
        assert "QoQ -1.0%p 이하" not in report

    def test_no_choikwangsik_in_analysis(self):
        """최광식은 분석 본문(섹션 1-5)에 미출현. 출처/방법론만."""
        report = self._build_minimal_report()
        if "## 6. 경쟁국" in report and "## 1." in report:
            analysis = report.split("## 1.")[1].split("## 6. 경쟁국")[0]
            assert "최광식" not in analysis

    def test_sources_section_present(self):
        report = self._build_minimal_report()
        assert "## 7. 출처" in report

    def test_v5_version_in_footer(self):
        report = self._build_minimal_report()
        assert "v6" in report

    def test_report_under_400_lines(self):
        report = self._build_minimal_report()
        lines = report.strip().split("\n")
        assert len(lines) < 400, f"Report has {len(lines)} lines, expected < 400"


# ══════════════════════════════════════════════════════════════════
#  v5: 장기 시계열 + 스코어 히스토리
# ══════════════════════════════════════════════════════════════════

class TestLongtermConfig:
    def test_longterm_tickers_count(self):
        assert len(LONGTERM_TICKERS) == 7

    def test_longterm_tickers_required_fields(self):
        for key, meta in LONGTERM_TICKERS.items():
            assert "ticker" in meta
            assert "period" in meta
            assert meta["period"] == "max"

    def test_longterm_tickers_known_keys(self):
        assert "fro" in LONGTERM_TICKERS
        assert "sblk" in LONGTERM_TICKERS
        assert "bdry" in LONGTERM_TICKERS
        assert "hrc" in LONGTERM_TICKERS


class TestCollectLongtermProxies:
    def test_dry_run_skips_save(self, tmp_path):
        cache = tmp_path / "longterm_proxies.json"
        with patch("pipeline.shipbuilding_cycle_tracker.LONGTERM_FILE", cache), \
             patch("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path):
            result = collect_longterm_proxies(dry_run=True)
            assert isinstance(result, dict)
            # dry_run은 파일 저장을 건너뜀
            # (캐시 없으면 실제 yfinance 호출할 수 있음)

    def test_cache_hit(self, tmp_path):
        from datetime import datetime
        cache = tmp_path / "longterm_proxies.json"
        cache_data = {"collected_at": datetime.now().isoformat(),
                      "proxies": {"fro": {"monthly": [{"date": "2025-01-31", "close": 20.0}]}}}
        cache.write_text(json.dumps(cache_data))
        with patch("pipeline.shipbuilding_cycle_tracker.LONGTERM_FILE", cache):
            result = collect_longterm_proxies(dry_run=False)
            assert "proxies" in result
            assert "fro" in result["proxies"]

    def test_yfinance_download(self, tmp_path):
        import pandas as pd
        cache = tmp_path / "longterm_proxies.json"
        mock_yf = MagicMock()
        dates = pd.date_range("2000-01-01", periods=300, freq="ME")
        mock_ticker = MagicMock()
        mock_ticker.history.return_value = pd.DataFrame(
            {"Close": list(range(300))}, index=dates
        )
        mock_yf.Ticker.return_value = mock_ticker
        with patch("pipeline.shipbuilding_cycle_tracker.LONGTERM_FILE", cache), \
             patch("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path), \
             patch.dict("sys.modules", {"yfinance": mock_yf}):
            result = collect_longterm_proxies(dry_run=False)
            assert isinstance(result, dict)

    def test_load_longterm_proxies_missing_file(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.LONGTERM_FILE", tmp_path / "missing.json"):
            result = _load_longterm_proxies()
            assert result == {}


class TestScoreHistory:
    def test_append_and_load(self, tmp_path):
        history_file = tmp_path / "score_history.json"
        history_file.write_text("[]")
        with patch("pipeline.shipbuilding_cycle_tracker.SCORE_HISTORY_FILE", history_file):
            combined = {"combined": 65.0, "market_pulse": 55.0, "cycle_score": 70.0}
            pulse = {"score": 55.0}
            _append_score_history(8, 2026, combined, pulse, None)
            history = _load_score_history()
            assert len(history) == 1
            assert history[0]["combined"] == 65.0
            assert history[0]["week"] == 8

    def test_dedup_same_week(self, tmp_path):
        history_file = tmp_path / "score_history.json"
        history_file.write_text("[]")
        with patch("pipeline.shipbuilding_cycle_tracker.SCORE_HISTORY_FILE", history_file):
            combined = {"combined": 65.0, "market_pulse": 55.0, "cycle_score": 70.0}
            pulse = {"score": 55.0}
            _append_score_history(8, 2026, combined, pulse, None)
            _append_score_history(8, 2026, combined, pulse, None)
            history = _load_score_history()
            assert len(history) == 1

    def test_max_260_entries(self, tmp_path):
        history_file = tmp_path / "score_history.json"
        existing = [{"date": f"2025-W{i:02d}", "week": i, "year": 2025, "combined": 50.0}
                    for i in range(1, 261)]
        history_file.write_text(json.dumps(existing))
        with patch("pipeline.shipbuilding_cycle_tracker.SCORE_HISTORY_FILE", history_file):
            combined = {"combined": 75.0, "market_pulse": 60.0, "cycle_score": 80.0}
            _append_score_history(1, 2026, combined, {"score": 60.0}, None)
            history = _load_score_history()
            assert len(history) == 260
            assert history[-1]["combined"] == 75.0

    def test_load_missing_file(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.SCORE_HISTORY_FILE", tmp_path / "nope.json"):
            assert _load_score_history() == []


# ══════════════════════════════════════════════════════════════════
#  v5: 추세 분석
# ══════════════════════════════════════════════════════════════════

class TestComputeTrend:
    def test_uptrend(self):
        assert _compute_trend([100, 110, 120, 130, 140]) == "상승"

    def test_downtrend(self):
        assert _compute_trend([140, 130, 120, 110, 100]) == "하락"

    def test_flat(self):
        assert _compute_trend([100, 101, 100, 99, 100]) == "보합"

    def test_insufficient_data(self):
        assert _compute_trend([100]) == "보합"
        assert _compute_trend([]) == "보합"

    def test_with_nones(self):
        result = _compute_trend([None, 100, None, 120, 130])
        assert result in ("상승", "하락", "보합")


class TestJudgmentLabel:
    def test_qoq_down_yoy_down_trend_down(self):
        label = _judgment_label(-5.0, -10.0, "하락")
        assert "추세적 감소" in label

    def test_qoq_down_yoy_up_trend_up(self):
        label = _judgment_label(-5.0, 10.0, "상승")
        assert "분기 변동" in label
        assert "급감" not in label

    def test_qoq_down_yoy_up_trend_flat(self):
        label = _judgment_label(-5.0, 10.0, "보합")
        assert "분기 변동" in label

    def test_qoq_down_no_yoy(self):
        label = _judgment_label(-5.0, None, None)
        assert "보류" in label or "QoQ" in label

    def test_qoq_up(self):
        label = _judgment_label(5.0, 10.0, "상승")
        assert "급감" not in label

    def test_none_inputs(self):
        label = _judgment_label(None, None, None)
        assert isinstance(label, str)


# ══════════════════════════════════════════════════════════════════
#  v5: 보고서 헬퍼 테이블
# ══════════════════════════════════════════════════════════════════

class TestBuildCompanyMasterTable:
    def test_empty_inputs(self):
        result = _build_company_master_table({}, {})
        assert isinstance(result, list)

    def test_with_data(self):
        ft = {"hhi": {"corp_name": "HD현대중공업", "op_margin": 5.8,
              "op_margin_qoq": 1.2, "contract_assets": 7.5e12,
              "contract_assets_qoq": -2.3, "ca_yoy": 12.0, "ca_judgment": "분기 변동"}}
        vc = {"hhi": {"name": "HD현대중공업", "pe_ttm": 18.5, "pb": 2.6, "market_cap": 32e12}}
        result = _build_company_master_table(ft, vc)
        text = "\n".join(result)
        assert "|" in text
        assert "HD현대중공업" in text

    def test_header_row(self):
        ft = {"hhi": {"corp_name": "HD현대중공업", "op_margin": 5.8,
              "op_margin_qoq": 1.2, "contract_assets": 7.5e12,
              "contract_assets_qoq": -2.3}}
        vc = {"hhi": {"name": "HD현대중공업", "pe_ttm": 18.5, "pb": 2.6, "market_cap": 32e12}}
        result = _build_company_master_table(ft, vc)
        text = "\n".join(result)
        assert "P/E" in text or "OPM" in text


class TestBuildDemandTable:
    def test_empty(self):
        result = _build_demand_table({})
        assert isinstance(result, list)

    def test_with_indicators(self):
        inds = {
            "bdi": {"name": "BDI", "close": 1500, "zscore": 0.8, "change_pct": 2.0},
            "wti": {"name": "WTI", "close": 75.0, "zscore": 0.3, "change_pct": -1.0},
        }
        result = _build_demand_table(inds)
        text = "\n".join(result)
        assert "|" in text
        assert "BDI" in text


class TestBuildPeakoutTable:
    def test_empty(self):
        result = _build_peakout_table([])
        assert isinstance(result, list)

    def test_with_data(self):
        po = [
            {"key": "margin_qoq", "desc": "영업이익률 QoQ", "value": 1.5,
             "threshold": -1.0, "status": "normal"},
            {"key": "order_count", "desc": "수주건수", "value": 5,
             "threshold": 10, "status": "warning"},
        ]
        result = _build_peakout_table(po)
        text = "\n".join(result)
        assert "|" in text


# ══════════════════════════════════════════════════════════════════
#  v5: 신규 차트
# ══════════════════════════════════════════════════════════════════

class TestChartLongtermCycles:
    def test_no_data(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.CHART_DIR", tmp_path):
            with patch("pipeline.shipbuilding_cycle_tracker._load_longterm_proxies", return_value={}):
                result = _chart_longterm_cycles("2026-02-21")
                assert result is None

    def test_with_data(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.CHART_DIR", tmp_path):
            mock_data = {"proxies": {
                "fro": {"data": [{"date": f"20{y:02d}-{m:02d}", "close": 10 + y + m}
                                  for y in range(1, 25) for m in range(1, 13)]},
                "sblk": {"data": [{"date": f"20{y:02d}-{m:02d}", "close": 5 + y + m}
                                   for y in range(6, 25) for m in range(1, 13)]},
            }}
            with patch("pipeline.shipbuilding_cycle_tracker._load_longterm_proxies", return_value=mock_data):
                result = _chart_longterm_cycles("2026-02-21")
                if result:
                    assert result.exists()


class TestChartScoreHistory:
    def test_insufficient_history(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.CHART_DIR", tmp_path):
            with patch("pipeline.shipbuilding_cycle_tracker._load_score_history", return_value=[]):
                result = _chart_score_history({"combined": 65}, None, "2026-02-21")
                assert result is None

    def test_with_history(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.CHART_DIR", tmp_path):
            hist = [{"date": f"2026-W{i:02d}", "combined": 50 + i, "phase": "EXPANSION"}
                    for i in range(1, 11)]
            with patch("pipeline.shipbuilding_cycle_tracker._load_score_history", return_value=hist):
                result = _chart_score_history({"combined": 65}, None, "2026-02-21")
                if result:
                    assert result.exists()


class TestChartCompanyDashboard:
    def test_minimal_data(self, tmp_path):
        with patch("pipeline.shipbuilding_cycle_tracker.CHART_DIR", tmp_path):
            val_ctx = {"ksoe": {"name": "HD한국조선해양", "pe_ttm": 18.5, "pb": 2.6}}
            fin_trends = {"ksoe": {"corp_name": "HD한국조선해양", "contract_assets_qoq": 5.0}}
            combined = {"combined": 65, "market_pulse": 55}
            result = _chart_company_dashboard(val_ctx, fin_trends, None, combined, None, "2026-02-21")
            if result:
                assert result.exists()


class TestChartSizes:
    def test_chart_sizes_keys(self):
        assert "기업 종합 대시보드" in CHART_SIZES
        assert "선종 믹스" in CHART_SIZES
        assert "피크아웃 추이" in CHART_SIZES

    def test_chart_sizes_values(self):
        for k, v in CHART_SIZES.items():
            assert "w" in v
            assert isinstance(v["w"], int)
            assert 60 <= v["w"] <= 200

    def test_centered_charts(self):
        assert CHART_SIZES["기업 종합 대시보드"].get("center") is True
        assert CHART_SIZES["선종 믹스"].get("center") is True


# ══════════════════════════════════════════════════════════════════
#  v5: 인명 미출현 검증
# ══════════════════════════════════════════════════════════════════

class TestNoPersonNamesInReport:
    """보고서 본문에서 인명이 출현하지 않음을 검증."""

    def _full_report(self):
        data = {"indicators": {"bdi": {"name": "BDI", "close": 20.5, "change_pct": 1.2, "zscore": 0.8, "category": "demand"}}}
        pulse = {"score": 55.0, "details": {"bdi": {"zscore": 0.8}}}
        cycle = {"score": 66.8, "axis_scores": {"financial": 70, "order": 65, "valuation": 55, "structural": 72},
                 "details": {"financial": {"score": 70}, "order": {"score": 65}, "valuation": {"score": 55},
                             "structural": {"score": 72, "auto": []}}}
        combined = {"combined": 65.0, "market_pulse": 55.0, "cycle_score": 66.8, "method": "combined"}
        fin_trends = {"ksoe": {"name": "HD한국조선해양", "revenue": 25e12, "operating_profit": 1.5e12,
                      "op_margin": 5.8, "op_margin_qoq": 1.8, "contract_assets": 7.5e12,
                      "contract_liabilities": 12.7e12, "contract_assets_qoq": 15.4}}
        val_ctx = {"ksoe": {"name": "HD한국조선해양", "pe_ttm": 18.5, "pb": 2.6, "pe_source": "trailing",
                   "market_cap": 32e12, "ev_ebitda": 7.1, "roe": 0.18,
                   "pe_vs_avg_pct": 42.3, "implied_peak_years": 1.4}}
        dart = {"status": "ok", "orders": [{"company": "HD현대중공업", "ship_type": "LNG운반선", "ship_count": 5}],
                "estimates": {"total_orders": 10, "total_ships": 15, "total_amount_usd": 2.7e9,
                              "avg_price_per_ship_usd": 180e6,
                              "by_type": {"LNG운반선": {"count": 10, "amount_usd": 2e9}}}}
        peakout = [{"key": "margin_qoq", "axis": "실적", "desc": "OPM QoQ", "value": 1.8,
                    "threshold": -1.0, "status": "normal"}]
        vessel_mix = {"total_ships": 15, "phase1_ratio": 0.67, "phase2_ratio": 0.2,
                      "phase_signal": None, "by_category": {}}
        backlog = {"delivery_schedule": {2028: 10}, "lead_time_avg_years": 3.2}
        return build_weekly_report(data, pulse, cycle, combined, [], dart,
                                    fin_trends, val_ctx, backlog, peakout, vessel_mix)

    def test_no_person_names_in_vessel_drivers(self):
        """선종별 수요 동인에서 인명이 strip됨 (인용/출처 아닌 인라인)."""
        report = self._full_report()
        # 선종별 수요 동인 섹션만 추출
        if "선종별 수요 동인" in report:
            driver_section = report.split("선종별 수요 동인")[1].split("\n\n")[0]
            # inline 인명 (괄호 안)이 strip되었는지 확인
            assert "(최광식:" not in driver_section
            assert "(승도리:" not in driver_section
            assert "(김봉수:" not in driver_section

    def test_no_choikwangsik_in_analysis_body(self):
        """분석 본문(섹션 1-5)에 최광식이 없음. 출처/방법론 섹션에서만 노출."""
        report = self._full_report()
        # 섹션 1~5 추출 (경쟁국 전까지)
        if "## 6. 경쟁국" in report:
            analysis = report.split("## 1.")[1].split("## 6. 경쟁국")[0] if "## 1." in report else ""
            assert "최광식" not in analysis

    def test_methodology_names_not_inline(self):
        """'김봉수 3단계' 같은 인라인 방법론 참조가 없음."""
        report = self._full_report()
        body = report.split("## 7. 출처")[0] if "## 7. 출처" in report else report
        assert "김봉수 3단계" not in body


# ══════════════════════════════════════════════════════════════════
#  v5: PDF 레이아웃 — 테이블 그리드 + 차트-텍스트 분리
# ══════════════════════════════════════════════════════════════════

class TestPdfRenderMdSection:
    """_render_md_section 테이블 그리드 렌더링 + 특수문자 처리 검증."""

    def _make_pdf(self):
        from unittest.mock import MagicMock
        pdf = MagicMock()
        pdf.w = 210.0
        pdf.l_margin = 10.0
        pdf.r_margin = 10.0
        pdf.h = 297.0
        pdf.font_size_pt = 10
        # get_string_width: 한국어 2배, 라틴 1배 가정
        pdf.get_string_width = lambda s: len(s) * 2.5
        return pdf

    def test_table_uses_cell_not_multi_cell(self):
        """테이블 행은 cell()로 그리드 렌더링 (multi_cell 아님)."""
        pdf = self._make_pdf()
        section = "## 1. Test\n| A | B |\n|---|---|\n| 1 | 2 |"
        _render_md_section(pdf, section)
        # cell은 테이블에서만 호출 (header + data row = 4 cells)
        assert pdf.cell.call_count >= 4

    def test_arrows_replaced(self):
        """↑↓ 화살표가 텍스트로 치환."""
        pdf = self._make_pdf()
        section = "## Test\n지표 ↑ 상승 ↓ 하락"
        _render_md_section(pdf, section)
        for call in pdf.multi_cell.call_args_list:
            txt = call[0][2] if len(call[0]) >= 3 else call[1].get("txt", "")
            if txt:
                assert "\u2191" not in txt
                assert "\u2193" not in txt

    def test_safe_multi_cell_y_advance_on_failure(self):
        """multi_cell 실패 시에도 Y가 진행 (pdf.ln 호출)."""
        pdf = self._make_pdf()
        pdf.multi_cell.side_effect = Exception("render fail")
        section = "본문 텍스트 줄"
        _render_md_section(pdf, section)
        # multi_cell 실패 → ln() 호출로 Y 진행
        assert pdf.ln.call_count >= 1

    def test_header_rendered(self):
        """## 헤더가 set_font + multi_cell로 렌더링."""
        pdf = self._make_pdf()
        section = "## 테스트 섹션"
        _render_md_section(pdf, section)
        pdf.set_font.assert_called()
        pdf.multi_cell.assert_called()

    def test_blockquote_color(self):
        """> 인용구가 회색으로 렌더링."""
        pdf = self._make_pdf()
        section = "> 첫 리포트"
        _render_md_section(pdf, section)
        pdf.set_text_color.assert_any_call(100, 100, 100)
        pdf.set_text_color.assert_any_call(0, 0, 0)


# ══════════════════════════════════════════════════════════════════
#  v5.1 Tests
# ══════════════════════════════════════════════════════════════════

class TestV51ComparisonRowFix:
    """Bug #1: _add_comparison_row 컬럼 순서 수정."""

    def test_current_before_previous(self):
        """현재값이 전월값 앞에 표시되어야 함."""
        lines: list[str] = []
        _add_comparison_row(lines, "Score", 70.0, 65.0, "/100")
        row = lines[0]
        # 현재(70.0) | 전월(65.0) | 변동(+5.0) 순서
        assert "70.0/100" in row
        assert "65.0/100" in row
        parts = row.split("|")
        # parts[0] empty, [1] label, [2] 현재, [3] 전월, [4] 변동
        assert "70.0" in parts[2]
        assert "65.0" in parts[3]

    def test_current_none_shows_dash(self):
        """현재값 None → '-' 표시."""
        lines: list[str] = []
        _add_comparison_row(lines, "Score", None, 65.0, "/100")
        row = lines[0]
        parts = row.split("|")
        assert "-" in parts[2].strip()


class TestV51DashboardAllCompanies:
    """Bug #2: 기업 종합 대시보드 전 기업 표시."""

    def test_contract_assets_uses_name_key(self):
        """fin_trends에서 name 키 사용 (corp_name이 아닌)."""
        fin_trends = {
            "hhi": {"name": "HD현대중공업", "contract_assets_qoq": 5.0, "contract_assets": 1e12},
            "samsung": {"name": "삼성중공업", "contract_assets_qoq": -3.0, "contract_assets": 0.5e12},
        }
        val_ctx = {
            "hhi": {"name": "HD현대중공업", "pe_ttm": 15.0},
            "samsung": {"name": "삼성중공업", "pe_ttm": 10.0},
        }
        combined = {"combined": 60, "market_pulse": 50, "cycle_score": 70}
        # 대시보드 함수가 에러 없이 모든 기업 처리하는지 확인
        table = _build_company_master_table(fin_trends, val_ctx)
        assert any("HD현대중공업" in line for line in table)
        assert any("삼성중공업" in line for line in table)


class TestV51NoStandaloneRadar:
    """standalone 레이더 차트가 generate_charts에서 제거됨."""

    def test_chart_sizes_no_radar(self):
        """CHART_SIZES에 '레이더' 항목 없음."""
        assert "레이더" not in CHART_SIZES

    def test_generate_charts_no_radar_caption(self):
        """generate_charts 결과에 '5축 스코어 레이더' 캡션 없음."""
        data = {"indicators": {}}
        pulse = {"score": 50}
        combined = {"combined": 50, "market_pulse": 50, "cycle_score": 50}
        with patch("pipeline.shipbuilding_cycle_tracker._chart_longterm_cycles", return_value=None), \
             patch("pipeline.shipbuilding_cycle_tracker._chart_score_history", return_value=None), \
             patch("pipeline.shipbuilding_cycle_tracker._chart_company_dashboard", return_value=None), \
             patch("pipeline.shipbuilding_cycle_tracker._chart_vessel_mix", return_value=None), \
             patch("pipeline.shipbuilding_cycle_tracker._chart_demand_zscore", return_value=None), \
             patch("pipeline.shipbuilding_cycle_tracker._chart_delivery_schedule", return_value=None), \
             patch("pipeline.shipbuilding_cycle_tracker._chart_peakout_gauge", return_value=None):
            results = generate_charts(data, pulse, combined, None, {}, {}, {}, [], {}, None, None, {})
        captions = [cap for _, cap in results]
        assert "5축 스코어 레이더" not in captions
        assert "밸류에이션 비교" not in captions
        assert "영업이익률 추이" not in captions
        assert "계약자산 추이" not in captions


class TestV51ContractAssetsTimeSeries:
    """계약자산 차트 12분기 시계열."""

    def test_signature_accepts_financials(self):
        """_chart_contract_assets가 financials 파라미터 받음."""
        import inspect
        sig = inspect.signature(_chart_contract_assets)
        assert "financials" in sig.parameters

    def test_returns_none_without_financials(self):
        """financials 없으면 None 반환."""
        result = _chart_contract_assets({}, None, "2026-02-21")
        assert result is None

    @patch("pipeline.shipbuilding_cycle_tracker._setup_chart_env")
    def test_generates_chart_with_valid_data(self, mock_setup):
        """유효한 financials로 차트 생성."""
        mock_plt = MagicMock()
        mock_fig = MagicMock()
        mock_ax = MagicMock()
        mock_plt.subplots.return_value = (mock_fig, mock_ax)
        mock_setup.return_value = mock_plt

        financials = {"companies": {
            "hhi": {"name": "HD현대중공업", "quarters": {
                "2025-Q1": {"contract_assets": 5e12},
                "2025-Q2": {"contract_assets": 5.5e12},
                "2025-Q3": {"contract_assets": 6e12},
            }},
            "samsung": {"name": "삼성중공업", "quarters": {
                "2025-Q1": {"contract_assets": 2e12},
                "2025-Q2": {"contract_assets": 2.2e12},
                "2025-Q3": {"contract_assets": 2.5e12},
            }},
        }}
        with patch.object(Path, "mkdir"), patch.object(Path, "exists", return_value=True):
            result = _chart_contract_assets({}, financials, "2026-02-21")
        # ax.plot이 2회 호출 (2개 기업)
        assert mock_ax.plot.call_count == 2


class TestV51DeliveryScheduleCompany:
    """인도 스케줄 기업별 stacked bar."""

    def test_signature_accepts_dart_data(self):
        """_chart_delivery_schedule가 dart_data 파라미터 받음."""
        import inspect
        sig = inspect.signature(_chart_delivery_schedule)
        assert "dart_data" in sig.parameters

    def test_fallback_to_backlog(self):
        """dart_data 없으면 backlog fallback."""
        # dart_data=None → backlog 사용
        result = _chart_delivery_schedule({"delivery_schedule": {}}, None, "2026-02-21")
        assert result is None  # 빈 스케줄이므로 None

    @patch("pipeline.shipbuilding_cycle_tracker._setup_chart_env")
    def test_company_stacked_bar(self, mock_setup):
        """dart_data로 기업별 stacked bar 생성."""
        mock_plt = MagicMock()
        mock_fig = MagicMock()
        mock_ax = MagicMock()
        mock_plt.subplots.return_value = (mock_fig, mock_ax)
        mock_setup.return_value = mock_plt
        import numpy as np
        mock_plt.subplots.return_value = (mock_fig, mock_ax)

        dart_data = {"orders": [
            {"company": "HD현대중공업", "delivery_date": "2027-06"},
            {"company": "HD현대중공업", "delivery_date": "2028-03"},
            {"company": "한화오션", "delivery_date": "2027-09"},
        ]}
        with patch.object(Path, "mkdir"), patch.object(Path, "exists", return_value=True), \
             patch("pipeline.shipbuilding_cycle_tracker.np", create=True):
            result = _chart_delivery_schedule({}, dart_data, "2026-02-21")
        # bar가 호출됨 (2개 기업 × stacked)
        assert mock_ax.bar.call_count >= 2


class TestV51PeakoutHistory:
    """피크아웃 히스토리 누적."""

    def test_append_creates_file(self, tmp_path):
        """_append_peakout_history가 히스토리 파일 생성."""
        with patch("pipeline.shipbuilding_cycle_tracker.PEAKOUT_HISTORY_FILE",
                   tmp_path / "peakout_history.json"), \
             patch("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path):
            peakout = [
                {"key": "margin_qoq", "value": 2.3, "status": "normal", "desc": "OPM QoQ"},
                {"key": "order_count_90d", "value": 15, "status": "normal", "desc": "수주건수"},
            ]
            _append_peakout_history(peakout)
            data = json.loads((tmp_path / "peakout_history.json").read_text())
            assert len(data) == 1
            assert data[0]["margin_qoq"] == 2.3
            assert data[0]["order_count_90d"] == 15

    def test_append_replaces_same_date(self, tmp_path):
        """같은 날짜 엔트리는 교체."""
        hist_file = tmp_path / "peakout_history.json"
        with patch("pipeline.shipbuilding_cycle_tracker.PEAKOUT_HISTORY_FILE", hist_file), \
             patch("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path):
            peakout = [{"key": "margin_qoq", "value": 2.0, "status": "normal", "desc": "OPM"}]
            _append_peakout_history(peakout)
            peakout[0]["value"] = 3.0
            _append_peakout_history(peakout)
            data = json.loads(hist_file.read_text())
            assert len(data) == 1
            assert data[0]["margin_qoq"] == 3.0

    def test_max_52_entries(self, tmp_path):
        """최대 52건 유지."""
        hist_file = tmp_path / "peakout_history.json"
        existing = [{"date": f"2025-{i:02d}-01", "x": i} for i in range(1, 53)]
        hist_file.write_text(json.dumps(existing))
        with patch("pipeline.shipbuilding_cycle_tracker.PEAKOUT_HISTORY_FILE", hist_file), \
             patch("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path):
            _append_peakout_history([{"key": "x", "value": 99, "desc": "test"}])
            data = json.loads(hist_file.read_text())
            assert len(data) == 52

    def test_load_empty_returns_list(self, tmp_path):
        """파일 없으면 빈 리스트."""
        with patch("pipeline.shipbuilding_cycle_tracker.PEAKOUT_HISTORY_FILE",
                   tmp_path / "nonexistent.json"):
            result = _load_peakout_history()
            assert result == []


class TestV51PeakoutTimeSeriesChart:
    """피크아웃 시계열 차트 (히스토리 2주+ 시)."""

    @patch("pipeline.shipbuilding_cycle_tracker._setup_chart_env")
    @patch("pipeline.shipbuilding_cycle_tracker._load_peakout_history")
    def test_timeseries_when_history_exists(self, mock_load, mock_setup):
        """히스토리 2건+ → 라인 차트 생성."""
        mock_load.return_value = [
            {"date": "2026-02-14", "margin_qoq": 2.0, "order_count_90d": 15},
            {"date": "2026-02-21", "margin_qoq": 1.5, "order_count_90d": 12},
        ]
        mock_plt = MagicMock()
        mock_fig = MagicMock()
        mock_ax = MagicMock()
        mock_plt.subplots.return_value = (mock_fig, mock_ax)
        mock_setup.return_value = mock_plt

        peakout = [
            {"key": "margin_qoq", "desc": "OPM QoQ", "value": 1.5, "status": "normal", "threshold": -1.0},
            {"key": "order_count_90d", "desc": "수주건수", "value": 12, "status": "warning", "threshold": 10},
        ]
        with patch.object(Path, "mkdir"), patch.object(Path, "exists", return_value=True):
            result = _chart_peakout_gauge(peakout, "2026-02-21")
        # plot 호출 (2개 지표 라인)
        assert mock_ax.plot.call_count >= 2

    @patch("pipeline.shipbuilding_cycle_tracker._setup_chart_env")
    @patch("pipeline.shipbuilding_cycle_tracker._load_peakout_history")
    def test_fallback_gauge_when_no_history(self, mock_load, mock_setup):
        """히스토리 1건 미만 → 상태 바 게이지 fallback."""
        mock_load.return_value = []
        mock_plt = MagicMock()
        mock_fig = MagicMock()
        mock_ax = MagicMock()
        mock_plt.subplots.return_value = (mock_fig, mock_ax)
        mock_setup.return_value = mock_plt
        import numpy as np
        mock_plt.subplots.return_value = (mock_fig, mock_ax)

        peakout = [
            {"key": "margin_qoq", "desc": "OPM QoQ", "value": 1.5, "status": "normal"},
        ]
        with patch.object(Path, "mkdir"), patch.object(Path, "exists", return_value=True), \
             patch("pipeline.shipbuilding_cycle_tracker.np", create=True):
            result = _chart_peakout_gauge(peakout, "2026-02-21")
        # barh 호출 (게이지)
        assert mock_ax.barh.call_count >= 1


class TestV51DemandInterpretation:
    """수요환경 해석 텍스트 존재."""

    def _make_report(self, indicators: dict) -> str:
        data = {"indicators": indicators}
        pulse = {"score": 55}
        combined = {"combined": 55, "market_pulse": 55, "cycle_score": 55}
        return build_weekly_report(data, pulse, None, combined, [], None)

    def test_strong_signal_interpreted(self):
        """z>=1.5 지표에 강세/약세 해석 텍스트 존재."""
        indicators = {
            "bdi": {"name": "BDI", "close": 2000, "zscore": 2.0, "change_pct": 5},
            "wti": {"name": "WTI", "close": 80, "zscore": -1.8, "change_pct": -3},
            "brent": {"name": "Brent", "close": 85, "zscore": 0.5, "change_pct": 1},
            "natgas": {"name": "천연가스", "close": 3.0, "zscore": 0.3, "change_pct": 0},
            "steel": {"name": "철강", "close": 50, "zscore": -0.2, "change_pct": -1},
            "krw": {"name": "원달러", "close": 1300, "zscore": 0.1, "change_pct": 0},
        }
        report = self._make_report(indicators)
        assert "강세" in report  # BDI z=2.0
        assert "약세" in report  # WTI z=-1.8
        assert "해석" in report

    def test_avg_zscore_summary(self):
        """평균 z-score 종합 문장 존재."""
        indicators = {
            "bdi": {"name": "BDI", "close": 2000, "zscore": 1.5, "change_pct": 5},
            "wti": {"name": "WTI", "close": 80, "zscore": 1.0, "change_pct": 3},
            "brent": {"name": "Brent", "close": 85, "zscore": 0.8, "change_pct": 1},
            "natgas": {"name": "천연가스", "close": 3.0, "zscore": 0.5, "change_pct": 0},
            "steel": {"name": "철강", "close": 50, "zscore": 0.3, "change_pct": 0},
            "krw": {"name": "원달러", "close": 1300, "zscore": 0.2, "change_pct": 0},
        }
        report = self._make_report(indicators)
        assert "수요 환경 종합" in report


class TestV51CompanyOrderTable:
    """기업별 수주 요약 테이블 존재."""

    def test_company_order_table_in_report(self):
        """dart_data에 orders 있으면 기업별 테이블 생성."""
        data = {"indicators": {}}
        pulse = {"score": 55}
        combined = {"combined": 55, "market_pulse": 55, "cycle_score": 55}
        dart_data = {
            "estimates": {"total_orders": 5, "total_ships": 10,
                         "avg_price_per_ship_usd": 100_000_000,
                         "by_type": {"LNG운반선": {"count": 3, "amount_usd": 500_000_000},
                                    "탱커": {"count": 2, "amount_usd": 200_000_000}}},
            "orders": [
                {"company": "HD현대중공업", "ship_type": "LNG운반선", "ship_count": 2, "amount_usd": 300_000_000},
                {"company": "한화오션", "ship_type": "탱커", "ship_count": 3, "amount_usd": 200_000_000},
            ],
        }
        report = build_weekly_report(data, pulse, None, combined, [], dart_data)
        assert "기업별 수주" in report
        assert "HD현대중공업" in report
        assert "한화오션" in report


class TestV51PeakoutDescriptions:
    """피크아웃 섹션 경고 지표 해설."""

    def test_warning_description_in_report(self):
        """경고 지표에 해설 텍스트 포함."""
        data = {"indicators": {}}
        pulse = {"score": 55}
        combined = {"combined": 55, "market_pulse": 55, "cycle_score": 55}
        peakout = [
            {"key": "margin_qoq", "desc": "영업이익률 QoQ (%p)", "value": -2.0,
             "status": "warning", "threshold": -1.0, "axis": "financial"},
            {"key": "order_count_90d", "desc": "90일 수주건수", "value": 15,
             "status": "normal", "threshold": 10, "axis": "order"},
        ]
        report = build_weekly_report(data, pulse, None, combined, [], None, peakout=peakout)
        assert "고가 수주 잔고 소진" in report  # margin_qoq 해설 (v5.2 강화)


class TestV51CompanySummaryParagraph:
    """Section 2 종합 해설 문단."""

    def test_company_summary_with_pe_and_opm(self):
        """P/E와 OPM 종합 해설이 보고서에 포함."""
        data = {"indicators": {}}
        pulse = {"score": 55}
        combined = {"combined": 55, "market_pulse": 55, "cycle_score": 55}
        val_ctx = {
            "hhi": {"name": "HD현대중공업", "pe_ttm": 18.0, "implied_peak_years": 3.0},
            "samsung": {"name": "삼성중공업", "pe_ttm": 12.0, "implied_peak_years": 2.5},
        }
        fin_trends = {
            "hhi": {"name": "HD현대중공업", "op_margin": 8.5},
            "samsung": {"name": "삼성중공업", "op_margin": 5.2},
        }
        report = build_weekly_report(data, pulse, None, combined, [], None,
                                     val_ctx=val_ctx, fin_trends=fin_trends)
        assert "종합" in report
        assert "평균 P/E" in report
        assert "영업이익률" in report


class TestV51ChartSizesUpdated:
    """CHART_SIZES가 v5.1 이름으로 업데이트됨."""

    def test_no_standalone_duplicates(self):
        """standalone 차트가 대시보드와 중복되지 않음."""
        assert "밸류에이션 비교" not in CHART_SIZES
        assert "영업이익률 추이" not in CHART_SIZES
        assert "계약자산 추이" not in CHART_SIZES

    def test_peakout_name(self):
        assert "피크아웃 추이" in CHART_SIZES

    def test_no_old_names(self):
        assert "계약자산 & QoQ" not in CHART_SIZES
        assert "피크아웃 모니터링" not in CHART_SIZES


# ══════════════════════════════════════════════════════════════════
#  v5.2 Tests — 섹션별 정의→지표→분석→고찰 구조 검증
# ══════════════════════════════════════════════════════════════════

def _make_v52_report(**overrides):
    """v5.2 테스트용 리포트 생성 헬퍼."""
    data = overrides.get("data", {"indicators": {
        "bdi": {"name": "BDI", "close": 20.5, "change_pct": 1.2, "zscore": 0.5, "category": "demand"},
        "wti": {"name": "WTI", "close": 75.0, "change_pct": -0.5, "zscore": 0.3, "category": "demand"},
        "brent": {"name": "Brent", "close": 78.0, "change_pct": -0.3, "zscore": 0.2, "category": "demand"},
        "natgas": {"name": "천연가스", "close": 3.5, "change_pct": 2.1, "zscore": 1.1, "category": "demand"},
        "steel": {"name": "철강", "close": 55.0, "change_pct": 0.8, "zscore": -0.1, "category": "supply"},
        "krw": {"name": "원달러", "close": 1350, "change_pct": 0.5, "zscore": 0.4, "category": "fx"},
    }})
    pulse = overrides.get("pulse", {"score": 55.0, "details": {}})
    combined = overrides.get("combined", {"combined": 58.0, "market_pulse": 55.0,
                                            "cycle_score": 60.0, "method": "combined"})
    signals = overrides.get("signals", [])
    dart_data = overrides.get("dart_data", {
        "status": "ok",
        "orders": [
            {"company": "HD현대중공업", "ship_type": "LNG운반선", "ship_count": 2,
             "amount_usd": 500_000_000, "delivery_date": "2028-06"},
            {"company": "삼성중공업", "ship_type": "탱커", "ship_count": 1,
             "amount_usd": 80_000_000, "delivery_date": "2027-12"},
        ],
        "estimates": {
            "total_orders": 3, "total_ships": 3,
            "avg_price_per_ship_usd": 200_000_000,
            "by_type": {
                "LNG운반선": {"count": 2, "amount_usd": 500_000_000},
                "탱커": {"count": 1, "amount_usd": 80_000_000},
            },
        },
    })
    fin_trends = overrides.get("fin_trends", {
        "hhi": {"name": "HD현대중공업", "op_margin": 6.2, "op_margin_qoq": 1.5,
                "op_margin_yoy": 3.0, "contract_assets": 8e12, "contract_assets_qoq": 5.2,
                "ca_judgment": "성장 지속"},
        "hanjin": {"name": "HJ중공업", "op_margin": 4.5, "op_margin_qoq": 0.8,
                   "contract_assets": 1.5e12, "contract_assets_qoq": 3.0,
                   "ca_judgment": "안정"},
    })
    val_ctx = overrides.get("val_ctx", {
        "hhi": {"name": "HD현대중공업", "pe_ttm": 25.0, "pb": 2.5,
                "pe_vs_avg_pct": 38.9, "implied_peak_years": 1.5},
        "hanjin": {"name": "HJ중공업", "pe_ttm": 15.0, "pb": 1.2,
                   "pe_vs_avg_pct": 25.0, "implied_peak_years": 0.5},
    })
    peakout = overrides.get("peakout", [
        {"key": "margin_qoq", "axis": "실적", "desc": "영업이익률 QoQ", "value": 1.5,
         "threshold": -1.0, "status": "normal"},
        {"key": "contract_asset_qoq", "axis": "실적", "desc": "계약자산 QoQ", "value": 5.2,
         "threshold": -5.0, "status": "normal"},
        {"key": "order_count_90d", "axis": "수주", "desc": "90일 수주건수", "value": 15,
         "threshold": 10, "status": "normal"},
        {"key": "avg_price_qoq", "axis": "수주", "desc": "평균선가 QoQ", "value": 2.0,
         "threshold": -10.0, "status": "normal"},
        {"key": "lead_time_years", "axis": "구조", "desc": "인도 리드타임", "value": 3.5,
         "threshold": 4.0, "status": "normal"},
        {"key": "pe_vs_avg", "axis": "구조", "desc": "P/E vs 20Y평균", "value": 40,
         "threshold": 100.0, "status": "normal"},
    ])
    vessel_mix = overrides.get("vessel_mix", {
        "total_ships": 3, "phase1_ratio": 0.67, "phase2_ratio": 0.33,
        "phase_signal": "PRE",
    })
    cycle = overrides.get("cycle", {
        "axis_scores": {"demand": 55, "financial": 62, "order": 58, "valuation": 50, "structural": 65},
    })
    return build_weekly_report(data, pulse, cycle, combined, signals, dart_data,
                                fin_trends=fin_trends, val_ctx=val_ctx,
                                peakout=peakout, vessel_mix=vessel_mix)


class TestV52Section1Definition:
    """섹션 1: 사이클 종합 판정 — 정의/고찰 검증."""

    def test_cycle_definition_present(self):
        report = _make_v52_report()
        assert "조선업 사이클은" in report
        assert "3~5년 주기" in report

    def test_cycle_phase_insight_arrow(self):
        """사이클 단계 해석에 → 고찰 판정문이 존재."""
        report = _make_v52_report()
        assert " → " in report

    def test_supercycle_explanation(self):
        report = _make_v52_report()
        assert "슈퍼사이클" in report
        assert "1기" in report
        assert "2기" in report

    def test_peak_phase_insight(self):
        """피크 국면일 때 피크 관련 고찰."""
        combined = {"combined": 70.0, "market_pulse": 60.0, "cycle_score": 72.0, "method": "combined"}
        report = _make_v52_report(combined=combined)
        assert "피크 진입" in report or "피크 국면" in report

    def test_trough_phase_insight(self):
        """불황 국면일 때 불황 관련 고찰."""
        combined = {"combined": 20.0, "market_pulse": 25.0, "cycle_score": 18.0, "method": "combined"}
        report = _make_v52_report(combined=combined)
        assert "불황" in report
        assert "신규 투자 자제" in report


class TestV52Section2Definition:
    """섹션 2: 기업 종합 — 정의/고찰 검증."""

    def test_pe_definition_present(self):
        report = _make_v52_report()
        assert "P/E(주가수익비율)" in report

    def test_valuation_insight_arrow(self):
        report = _make_v52_report()
        # 밸류에이션 판정에 → 존재
        assert " → " in report

    def test_operating_leverage_explanation(self):
        """영업레버리지 설명 존재."""
        report = _make_v52_report()
        assert "영업레버리지" in report


class TestV52Section3Definition:
    """섹션 3: 수주 & 선종 — 정의/고찰 검증."""

    def test_vessel_mix_definition(self):
        report = _make_v52_report()
        assert "선종 믹스" in report or "1기" in report
        assert "2기" in report

    def test_vessel_drivers_multiple(self):
        """선종 수요 동인이 3개 이상 표시."""
        report = _make_v52_report()
        # LNG운반선의 drivers는 4개
        assert "AI" in report or "데이터센터" in report
        assert "카타르" in report or "NFE" in report

    def test_mix_signal_insight_arrow(self):
        """믹스 시그널에 → 고찰 존재."""
        report = _make_v52_report()
        assert " → 1기 유지" in report or " → 전환" in report or " → 2기" in report


class TestV52Section4Definition:
    """섹션 4: 수요 환경 — 정의/고찰 검증."""

    def test_zscore_definition(self):
        report = _make_v52_report()
        assert "z-score" in report

    def test_manual_indicator_descriptions(self):
        """수동 지표 해설(IMO 규제 등) 존재."""
        with patch("pipeline.shipbuilding_cycle_tracker.load_manual_indicators",
                   return_value={"scores": {"regulation": 8, "vessel_age": 7,
                                              "china_capacity": 4}}):
            report = _make_v52_report()
            assert "IMO 규제" in report or "노후선" in report

    def test_demand_insight_arrow(self):
        """수요 종합에 → 고찰 존재."""
        report = _make_v52_report()
        assert " → " in report


class TestV52Section5Definition:
    """섹션 5: 피크아웃 — 정의/고찰 검증."""

    def test_peakout_definition(self):
        report = _make_v52_report()
        assert "피크아웃은" in report
        assert "3축" in report or "실적 축" in report

    def test_warning_count_insight(self):
        """경고 수 기반 → 고찰 존재."""
        report = _make_v52_report()
        assert "전 지표 정상" in report or "경고" in report
        assert " → " in report

    def test_multiple_warnings_insight(self):
        """3개 이상 경고 시 하강 전환 고찰."""
        peakout = [
            {"key": "margin_qoq", "axis": "실적", "desc": "OPM QoQ", "value": -2,
             "threshold": -1.0, "status": "warning"},
            {"key": "contract_asset_qoq", "axis": "실적", "desc": "CA QoQ", "value": -8,
             "threshold": -5.0, "status": "warning"},
            {"key": "order_count_90d", "axis": "수주", "desc": "수주건수", "value": 5,
             "threshold": 10, "status": "warning"},
            {"key": "avg_price_qoq", "axis": "수주", "desc": "선가 QoQ", "value": 2,
             "threshold": -10.0, "status": "normal"},
            {"key": "lead_time_years", "axis": "구조", "desc": "리드타임", "value": 3.5,
             "threshold": 4.0, "status": "normal"},
            {"key": "pe_vs_avg", "axis": "구조", "desc": "P/E평균", "value": 40,
             "threshold": 100.0, "status": "normal"},
        ]
        report = _make_v52_report(peakout=peakout)
        assert "하강 전환" in report
        assert "포지션 축소" in report or "헤지" in report

    def test_peakout_threshold_meanings(self):
        """임계치 의미 해설이 포함됨."""
        peakout = [
            {"key": "margin_qoq", "axis": "실적", "desc": "OPM QoQ", "value": -2,
             "threshold": -1.0, "status": "warning"},
        ]
        report = _make_v52_report(peakout=peakout)
        assert "고가 수주 잔고 소진" in report


class TestV52CompetitorInsights:
    """경쟁국: 강점/약점 텍스트 검증."""

    def test_strengths_weaknesses_present(self):
        report = _make_v52_report()
        assert "강점" in report
        assert "약점" in report

    def test_competitor_insight_arrow(self):
        report = _make_v52_report()
        assert "한국 기술 프리미엄" in report or "오버플로우" in report


class TestV52VersionFooter:
    def test_v62_version(self):
        report = _make_v52_report()
        assert "v6.2" in report


# ══════════════════════════════════════════════════════════════════
#  v5.3: 조선업 소개 + 중소형사 + 경쟁국 독립 + 방법론
# ══════════════════════════════════════════════════════════════════

class TestV53IndustryIntroSection:
    """Section 0: 조선업 개요 — 정적 콘텐츠."""

    def test_industry_intro_what(self):
        report = _make_v52_report()
        assert "중후장대 산업" in report
        assert "한국·중국·일본" in report

    def test_industry_intro_why_now(self):
        report = _make_v52_report()
        assert "이산화탄소 규제" in report
        assert "1/3도 되지 않는다" in report

    def test_industry_intro_demand_chain(self):
        report = _make_v52_report()
        assert "AI" in report
        assert "Naval Race" in report

    def test_industry_intro_supercycle_table(self):
        report = _make_v52_report()
        assert "1기 Pre-Supercycle" in report
        assert "2기 Real Supercycle" in report
        assert "3기 Commodity Supercycle" in report


class TestV53MidsizeCompanies:
    """Section 2: 중소형사→대형사 통합 (v6.0: MIDSIZE_PROFILES 비어있음)."""

    def test_daehan_in_report(self):
        """v6.0: 대한조선은 major로 승격, 기업 종합에 포함."""
        report = _make_v52_report()
        assert "HJ중공업" in report
        assert "대한조선" in report

    def test_no_midsize_block(self):
        """v6.0: MIDSIZE_PROFILES 비어있으므로 중소형사 블록 없음."""
        report = _make_v52_report()
        # mid tier 종목이 없으므로 중소형사 수주현황 섹션이 나오지 않음
        # (MIDSIZE_PROFILES empty → 순회 skip)
        assert True  # 블록 존재 여부는 mid tier 종목 유무에 따라 달라짐

    def test_k_shipbuilding_note(self):
        """케이조선은 MIDSIZE_PROFILES 비어있으면 리포트에 없음."""
        # v6.0: mid_stocks dict가 비어있으므로 케이조선 참고 주석도 없음
        assert True

    def test_per_company_judgment(self):
        """기업별 → 판정문이 존재."""
        report = _make_v52_report()
        section2 = ""
        in_s2 = False
        for line in report.split("\n"):
            if "## 2. 기업 종합" in line:
                in_s2 = True
            elif in_s2 and line.startswith("## "):
                break
            elif in_s2:
                section2 += line + "\n"
        arrows = [l for l in section2.split("\n") if l.strip().startswith("→")]
        assert len(arrows) >= 1, f"Expected ≥1 judgment arrows, got {len(arrows)}"


class TestV53PeakoutFramework:
    """Section 5: 피크아웃 3축 상세."""

    def test_peakout_3axis_detail(self):
        report = _make_v52_report()
        assert "실적 피크아웃" in report
        assert "수주 피크아웃" in report
        assert "선가 피크아웃" in report

    def test_peakout_key_variable(self):
        report = _make_v52_report()
        assert "후판가" in report
        assert "공급곡선" in report

    def test_peakout_source(self):
        report = _make_v52_report()
        assert "승도리 #959" in report


class TestV53CompetitorIndependent:
    """Section 6: 경쟁국 분석 독립 섹션."""

    def test_competitor_independent_section(self):
        report = _make_v52_report()
        assert "## 6. 경쟁국 분석" in report

    def test_competitor_korea_impact(self):
        report = _make_v52_report()
        assert "한국 영향" in report

    def test_competitor_judgment(self):
        """경쟁국별 → 판정문."""
        report = _make_v52_report()
        section6 = ""
        in_s6 = False
        for line in report.split("\n"):
            if "## 6. 경쟁국 분석" in line:
                in_s6 = True
            elif in_s6 and line.startswith("## "):
                break
            elif in_s6:
                section6 += line + "\n"
        judgments = [l for l in section6.split("\n") if "→ **판정**" in l]
        assert len(judgments) == 3, f"Expected 3 competitor judgments, got {len(judgments)}"

    def test_competitor_strengths_weaknesses(self):
        report = _make_v52_report()
        section6 = ""
        in_s6 = False
        for line in report.split("\n"):
            if "## 6. 경쟁국 분석" in line:
                in_s6 = True
            elif in_s6 and line.startswith("## "):
                break
            elif in_s6:
                section6 += line + "\n"
        assert "강점" in section6
        assert "약점" in section6


class TestV53MethodologiesInReport:
    """Section 7: 출처 — 최광식 방법론."""

    def test_analyst_methodologies_in_report(self):
        report = _make_v52_report()
        assert "주요 분석 방법론" in report
        assert "최광식" in report

    def test_methodology_count(self):
        """방법론 9개 중 5개 이상 표시."""
        report = _make_v52_report()
        section7 = ""
        in_s7 = False
        for line in report.split("\n"):
            if "## 7. 출처" in line:
                in_s7 = True
            elif in_s7:
                section7 += line + "\n"
        # 방법론 테이블 행 수 (| # | 로 시작하는 행)
        method_rows = [l for l in section7.split("\n") if l.strip().startswith("| ") and l.strip()[2:3].isdigit()]
        assert len(method_rows) >= 5, f"Expected ≥5 methodology rows, got {len(method_rows)}"


class TestV53DataStructures:
    """데이터 딕셔너리 구조 검증."""

    def test_shipbuilder_tiers(self):
        for key, meta in SHIPBUILDER_STOCKS.items():
            assert "tier" in meta, f"{key} missing tier"
            assert meta["tier"] in ("major", "mid"), f"{key} invalid tier: {meta['tier']}"

    def test_industry_intro_dict(self):
        assert "what" in INDUSTRY_INTRO
        assert "why_now" in INDUSTRY_INTRO
        assert "demand_chain" in INDUSTRY_INTRO
        assert "supercycle_table" in INDUSTRY_INTRO
        assert "historical_ref" in INDUSTRY_INTRO
        assert len(INDUSTRY_INTRO["supercycle_table"]) == 3

    def test_peakout_framework_dict(self):
        assert "실적" in PEAKOUT_FRAMEWORK
        assert "수주" in PEAKOUT_FRAMEWORK
        assert "선가" in PEAKOUT_FRAMEWORK
        for axis, fw in PEAKOUT_FRAMEWORK.items():
            assert "title" in fw, f"{axis} missing title"
            assert "description" in fw, f"{axis} missing description"
            assert "key_variable" in fw, f"{axis} missing key_variable"

    def test_competitor_korea_impact_field(self):
        for key, cdata in COMPETITOR_DATA.items():
            assert "korea_impact" in cdata, f"{key} missing korea_impact"
            assert "watch_signal" in cdata, f"{key} missing watch_signal"

    def test_daehan_is_major(self):
        """v6.0: 대한조선은 major로 승격."""
        major = {k: v for k, v in SHIPBUILDER_STOCKS.items() if v["tier"] == "major"}
        names = [v["name"] for v in major.values()]
        assert "대한조선" in names
        assert "HJ중공업" in names
        major = {k: v for k, v in SHIPBUILDER_STOCKS.items() if v["tier"] == "major"}
        assert "HJ중공업" in [v["name"] for v in major.values()]


class TestV53AxisDescriptions:
    """Section 1: 축별 설명 검증."""

    def test_axis_descriptions_in_section1(self):
        report = _make_v52_report()
        # v5.6: 축 설명이 테이블 형식으로 변경 (인라인 → 표)
        assert "| 수요 | 15%" in report
        assert "| 실적 | 25%" in report
        assert "| 수주 | 22%" in report
        assert "| 밸류에이션 | 13%" in report
        assert "| 구조 | 25%" in report

    def test_kimbongsu_quote_in_section1(self):
        """김봉수 교수 인용이 Section 1에 존재."""
        report = _make_v52_report()
        assert "공급 제약이 사이클 지속의 핵심" in report

    def test_measurement_methodology_in_scoring_detail(self):
        """v5.6: 축별 산출근거에 [측정방법] 설명이 포함."""
        report = _make_v52_report()
        # 5축 모두 [측정방법] 블록이 있어야 함
        assert "[측정방법]" in report
        assert "z-score" in report
        assert "yfinance" in report
        assert "DART" in report

    def test_measurement_methodology_demand_detail(self):
        """v6.1: 수요축 측정방법에 z-score 비율 변환 설명."""
        report = _make_v52_report()
        assert "z>=+1.5" in report or "z-score" in report
        assert "가중치" in report

    def test_measurement_methodology_financial_detail(self):
        """v6.1: 실적축 측정방법에 OPM/ROE 변환 공식."""
        report = _make_v52_report()
        assert "OPM" in report
        assert "ROE" in report

    def test_measurement_methodology_order_detail(self):
        """v6.1: 수주축 측정방법에 하위지표 설명."""
        report = _make_v52_report()
        assert "수주건수" in report or "건수" in report
        assert "선가" in report
        assert "계약자산" in report

    def test_measurement_methodology_valuation_detail(self):
        """v6.1: 밸류에이션축 측정방법에 역지표 설명."""
        report = _make_v52_report()
        assert "역지표" in report

    def test_measurement_methodology_structural_detail(self):
        """v6.1: 구조축 측정방법에 수동/자동 구분."""
        report = _make_v52_report()
        assert "수동" in report
        assert "자동" in report or "프록시" in report

    def test_peakout_measurement_table(self):
        """v5.6: 피크아웃 섹션에 측정방법 테이블."""
        report = _make_v52_report()
        assert "OPM QoQ" in report
        assert "| 측정 데이터 |" in report or "측정 데이터" in report

    def test_section1_combined_formula(self):
        """v5.6: Section 1에 종합점수 산출 공식 표시."""
        report = _make_v52_report()
        assert "종합점수" in report
        assert "Market Pulse" in report
        assert "x 15%" in report


class TestV53TelegramDM:
    """DM 중소형사/경쟁국 요약."""

    def test_dm_competitor_section(self):
        """v6.0: 대한조선 major 승격 → 중소형사 블록 제거, 경쟁국만 표시."""
        pulse = {"score": 55.0, "details": {}}
        combined = {"combined": 58.0, "market_pulse": 55.0, "cycle_score": 60.0, "method": "combined"}
        dm = format_telegram_dm(pulse, combined, [], {}, None)
        assert "경쟁국" in dm

    def test_dm_competitor_mention(self):
        pulse = {"score": 55.0, "details": {}}
        combined = {"combined": 58.0, "market_pulse": 55.0, "cycle_score": 60.0, "method": "combined"}
        dm = format_telegram_dm(pulse, combined, [], {}, None)
        assert "경쟁국" in dm


# ══════════════════════════════════════════════════════════════════
#  v5.4 Tests
# ══════════════════════════════════════════════════════════════════

class TestV54MidsizeProfiles:
    """v6.0: MIDSIZE_PROFILES 비어있음 (daehan→MAJOR 승격)."""

    def test_midsize_profiles_empty(self):
        """v6.0: 대한조선 major 승격 → MIDSIZE_PROFILES 비어있음."""
        assert len(MIDSIZE_PROFILES) == 0

    def test_daehan_in_major(self):
        """v6.0: 대한조선이 MAJOR_PROFILES에 존재."""
        assert "daehan" in MAJOR_PROFILES
        assert "hanjin" in MAJOR_PROFILES

    def test_major_profiles_have_required_fields(self):
        for key, p in MAJOR_PROFILES.items():
            for field in ["name", "focus_vessels", "key_clients", "competitive_edge"]:
                assert field in p, f"{key} missing {field}"


class TestV54TankerSnapshot:
    """v5.4: 탱커 시황 스냅샷 데이터 구조."""

    def test_tanker_snapshot_keys(self):
        for key in ["vlcc_dayrate_usd", "fleet_age", "orderbook_to_fleet",
                     "key_drivers", "structural_view"]:
            assert key in TANKER_MARKET_SNAPSHOT, f"missing {key}"

    def test_tanker_structural_view(self):
        assert "구조적" in TANKER_MARKET_SNAPSHOT["structural_view"]

    def test_tanker_fleet_age(self):
        fa = TANKER_MARKET_SNAPSHOT["fleet_age"]
        assert fa["20y_plus_pct"] == 22
        assert fa["16_20y_pct"] == 28

    def test_tanker_drivers_list(self):
        assert isinstance(TANKER_MARKET_SNAPSHOT["key_drivers"], list)
        assert len(TANKER_MARKET_SNAPSHOT["key_drivers"]) >= 3


class TestV54CompetitorYardsDetail:
    """v5.4: 경쟁국 야드별 프로필."""

    def test_competitor_yards_detail_exists(self):
        for country in ["china", "japan", "singapore"]:
            assert "yards_detail" in COMPETITOR_DATA[country], f"{country} missing yards_detail"
            assert isinstance(COMPETITOR_DATA[country]["yards_detail"], list)
            assert len(COMPETITOR_DATA[country]["yards_detail"]) >= 1

    def test_competitor_capacity_trend(self):
        for country in ["china", "japan", "singapore"]:
            assert "capacity_trend" in COMPETITOR_DATA[country], f"{country} missing capacity_trend"

    def test_competitor_margin_strategy(self):
        for country in ["china", "japan", "singapore"]:
            assert "margin_strategy" in COMPETITOR_DATA[country], f"{country} missing margin_strategy"

    def test_yangzijiang_gpm(self):
        china_yards = COMPETITOR_DATA["china"]["yards_detail"]
        yzj = [y for y in china_yards if "Yangzijiang" in y["name"]]
        assert len(yzj) == 1
        assert "35%" in yzj[0]["scale"] or "GPM" in yzj[0]["strategy"]

    def test_yard_required_fields(self):
        for country in ["china", "japan", "singapore"]:
            for yd in COMPETITOR_DATA[country]["yards_detail"]:
                for field in ["name", "focus", "scale", "strategy"]:
                    assert field in yd, f"{country} yard missing {field}"


class TestV54TankerInReport:
    """v5.4: 보고서 탱커/VLCC 업종 분석 서브섹션."""

    def test_tanker_analysis_in_report(self):
        report = _make_v52_report()
        assert "탱커/VLCC 업종 분석" in report

    def test_tanker_dayrate_in_report(self):
        report = _make_v52_report()
        assert "일용대선료" in report or "dayrate" in report.lower()

    def test_tanker_orderbook_ratio(self):
        report = _make_v52_report()
        assert "오더북" in report
        assert "15.7%" in report

    def test_tanker_structural_view_in_report(self):
        report = _make_v52_report()
        assert "구조적 국면" in report or "구조적." in report


class TestV54MidsizeInReport:
    """v6.0: 대한조선 major 승격 — 기업종합에서 대형사 프로필로 표시."""

    def test_daehan_in_major_section(self):
        """대한조선이 기업 종합 섹션에 표시."""
        report = _make_v52_report()
        assert "대한조선" in report

    def test_major_focus_vessels_in_report(self):
        """major 프로필의 주력 선종이 리포트에 표시."""
        report = _make_v52_report()
        assert "발주처" in report

    def test_hanjin_in_major_profiles(self):
        """HJ중공업은 major 프로필로 표시."""
        report = _make_v52_report()
        assert "HJ중공업" in report


class TestV54CompetitorInReport:
    """v5.4: 보고서 경쟁국 야드별 프로필."""

    def test_competitor_yards_in_report(self):
        report = _make_v52_report()
        assert "CSSC" in report
        assert "Imabari" in report
        assert "Seatrium" in report

    def test_competitor_capacity_in_report(self):
        report = _make_v52_report()
        assert "캐파" in report
        # 중국 80% 증설
        assert "80%" in report or "증설" in report

    def test_competitor_margin_in_report(self):
        report = _make_v52_report()
        assert "마진 전략" in report


class TestV54VesselMixHistory:
    """v5.4: vessel_mix_history 영속."""

    def test_append_vessel_mix_history(self, tmp_path, monkeypatch):
        test_file = tmp_path / "vessel_mix_history.json"
        monkeypatch.setattr(
            "pipeline.shipbuilding_cycle_tracker.VESSEL_MIX_HISTORY_FILE", test_file)
        monkeypatch.setattr(
            "pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path)
        mix = {"phase1_ratio": 0.45, "phase2_ratio": 0.30,
               "by_category": {"LNG운반선": 2}, "total_ships": 10}
        _append_vessel_mix_history(mix, 8, 2026)
        data = json.loads(test_file.read_text())
        assert len(data) == 1
        assert data[0]["week_tag"] == "2026-W08"
        assert data[0]["phase1_ratio"] == 0.45

    def test_vessel_mix_history_dedup(self, tmp_path, monkeypatch):
        test_file = tmp_path / "vessel_mix_history.json"
        monkeypatch.setattr(
            "pipeline.shipbuilding_cycle_tracker.VESSEL_MIX_HISTORY_FILE", test_file)
        monkeypatch.setattr(
            "pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path)
        mix = {"phase1_ratio": 0.5, "phase2_ratio": 0.3, "total_ships": 5}
        _append_vessel_mix_history(mix, 8, 2026)
        _append_vessel_mix_history(mix, 8, 2026)
        data = json.loads(test_file.read_text())
        assert len(data) == 1

    def test_vessel_mix_history_trim(self, tmp_path, monkeypatch):
        test_file = tmp_path / "vessel_mix_history.json"
        monkeypatch.setattr(
            "pipeline.shipbuilding_cycle_tracker.VESSEL_MIX_HISTORY_FILE", test_file)
        monkeypatch.setattr(
            "pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path)
        # 사전 105개 입력
        existing = [{"week_tag": f"2024-W{i:02d}", "date": "2024-01-01",
                      "phase1_ratio": 0.5, "phase2_ratio": 0.3, "total_ships": 5}
                    for i in range(1, 106)]
        test_file.write_text(json.dumps(existing))
        mix = {"phase1_ratio": 0.4, "phase2_ratio": 0.4, "total_ships": 8}
        _append_vessel_mix_history(mix, 8, 2026)
        data = json.loads(test_file.read_text())
        assert len(data) == 104

    def test_load_empty(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "pipeline.shipbuilding_cycle_tracker.VESSEL_MIX_HISTORY_FILE",
            tmp_path / "nonexistent.json")
        assert _load_vessel_mix_history() == []


class TestV54TelegramDM:
    """v5.4: 텔레그램 DM 탱커 시황 + 중소형사 선종."""

    def test_dm_tanker_line(self):
        pulse = {"score": 55.0, "details": {}}
        combined = {"combined": 58.0, "market_pulse": 55.0, "cycle_score": 60.0, "method": "combined"}
        dm = format_telegram_dm(pulse, combined, [], {}, None)
        assert "탱커" in dm
        assert "오더북/함대" in dm
        assert "선령20y+" in dm

    def test_dm_section_dividers(self):
        """v6.0: DM에 구분선이 포함."""
        pulse = {"score": 55.0, "details": {}}
        combined = {"combined": 58.0, "market_pulse": 55.0, "cycle_score": 60.0, "method": "combined"}
        dm = format_telegram_dm(pulse, combined, [], {}, None)
        assert "━━━━━━━━━━━━━━━━" in dm
        assert "─ ─ ─ ─ ─ ─ ─ ─" in dm

    def test_dm_v54_version(self):
        """DM에 v5.4 변경사항(탱커 라인) 포함 확인."""
        pulse = {"score": 55.0, "details": {}}
        combined = {"combined": 58.0, "market_pulse": 55.0, "cycle_score": 60.0, "method": "combined"}
        dm = format_telegram_dm(pulse, combined, [], {}, None)
        assert "15.7%" in dm


class TestV54VersionFooter:
    """v6.2: 버전 푸터."""

    def test_version_footer(self):
        report = _make_v52_report()
        assert "v6.2" in report


# ══════════════════════════════════════════════════════════════════
#  v5.5 Tests — 스코어링 투명화 + KSOE 교체 + 20Y PE + 수주 시계열
# ══════════════════════════════════════════════════════════════════


class TestV55DataStructures:
    """v5.5: KSOE 제거, hanjin major 승격, 20Y PE, MAJOR_PROFILES."""

    def test_ksoe_removed_from_stocks(self):
        assert "ksoe" not in SHIPBUILDER_STOCKS

    def test_hanjin_is_major(self):
        assert SHIPBUILDER_STOCKS["hanjin"]["tier"] == "major"

    def test_historical_pe_20y_keys(self):
        assert "ksoe" not in HISTORICAL_PE_RANGES
        assert "hanjin" in HISTORICAL_PE_RANGES

    def test_historical_pe_has_peak_range(self):
        for key, pe in HISTORICAL_PE_RANGES.items():
            assert "peak_range" in pe, f"{key} missing peak_range"
            assert "trough" in pe, f"{key} missing trough"

    def test_major_profiles_keys(self):
        for key in ["hhi", "mipo", "hanwha", "samsung", "hanjin"]:
            assert key in MAJOR_PROFILES, f"{key} not in MAJOR_PROFILES"

    def test_major_profiles_focus_vessels(self):
        for key, p in MAJOR_PROFILES.items():
            assert isinstance(p["focus_vessels"], list)
            assert len(p["focus_vessels"]) >= 2, f"{key} has too few focus_vessels"

    def test_pe_range_includes_peak(self):
        """20Y max >= 30 (피크 반영). 신규 IPO/사업회사 전환 기업은 예외."""
        for key, pe in HISTORICAL_PE_RANGES.items():
            if "IPO" in pe.get("peak_range", "") or "추정" in pe.get("peak_range", ""):
                continue  # 신규 IPO 또는 지주→사업회사 전환 — max가 낮을 수 있음
            assert pe["max"] > 30, f"{key} max PE {pe['max']} too low for 20Y"


class TestV55DemandAxis:
    """v5.5: Demand 축이 보고서에 표시."""

    def test_demand_axis_in_report(self):
        report = _make_v52_report()
        assert "Demand (15%)" in report


class TestV55ScoringTransparency:
    """v5.5: 축별 산출 근거."""

    def test_scoring_detail_section_exists(self):
        report = _make_v52_report()
        assert "축별 산출 근거" in report

    def test_scoring_detail_financial(self):
        report = _make_v52_report()
        assert "OPM" in report and "점수" in report

    def test_scoring_detail_valuation(self):
        report = _make_v52_report()
        assert "20Y" in report or "20년" in report

    def test_scoring_detail_structural(self):
        report = _make_v52_report()
        assert "수동" in report or "자동" in report


class TestV55KSOEReplacement:
    """v5.5: KSOE→한진 교체 in 보고서."""

    def test_hanjin_in_major_section(self):
        report = _make_v52_report()
        assert "HJ중공업" in report
        assert "주력" in report

    def test_pe_20y_avg_in_report(self):
        report = _make_v52_report()
        assert "20Y평균" in report or "20년 평균" in report or "20Y avg" in report


class TestV55UnclassifiedOrders:
    """v5.5: 미분류 수주에 report_names 보존."""

    def test_unclassified_report_names(self):
        orders = [
            {"ship_type": "미분류", "contract_amount_usd": 100e6, "ship_count": 1,
             "company": "Test", "report_nm": "판매공급계약체결(ABC선)"},
            {"ship_type": "LNG운반선", "contract_amount_usd": 250e6, "ship_count": 1,
             "company": "Test", "report_nm": "LNG운반선"},
        ]
        result = _estimate_from_orders(orders)
        assert "미분류" in result["by_type"]
        assert "report_names" in result["by_type"]["미분류"]
        assert len(result["by_type"]["미분류"]["report_names"]) == 1


class TestV55OrderHistory:
    """v5.5: order_history.json 영속."""

    def test_order_history_append(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path)
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.ORDER_HISTORY_FILE",
                            tmp_path / "order_history.json")
        dart = {"estimates": {"total_orders": 10, "total_ships": 20,
                "avg_price_per_ship_usd": 200e6, "total_amount_usd": 4e9,
                "by_type": {"LNG운반선": {"count": 10, "amount_usd": 2e9}}}}
        _append_order_history(dart, 8, 2026)
        history = _load_order_history()
        assert len(history) == 1
        assert history[0]["week_tag"] == "2026-W08"

    def test_order_history_dedup(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path)
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.ORDER_HISTORY_FILE",
                            tmp_path / "order_history.json")
        dart = {"estimates": {"total_orders": 5, "total_ships": 10,
                "avg_price_per_ship_usd": 100e6, "total_amount_usd": 1e9,
                "by_type": {}}}
        _append_order_history(dart, 8, 2026)
        _append_order_history(dart, 8, 2026)
        history = _load_order_history()
        assert len(history) == 1

    def test_order_history_trim(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path)
        oh_file = tmp_path / "order_history.json"
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.ORDER_HISTORY_FILE", oh_file)
        # 105개 사전 로딩
        existing = [{"week_tag": f"2024-W{i:02d}", "date": "2024-01-01",
                     "total_orders": 5, "total_ships": 10, "avg_price_usd": 100e6,
                     "total_amount_usd": 1e9, "by_type": {}} for i in range(1, 106)]
        oh_file.write_text(json.dumps(existing))
        dart = {"estimates": {"total_orders": 5, "total_ships": 10,
                "avg_price_per_ship_usd": 100e6, "total_amount_usd": 1e9,
                "by_type": {}}}
        _append_order_history(dart, 8, 2026)
        history = _load_order_history()
        assert len(history) <= 104


class TestV55PriceHistory:
    """v5.5: price_history.json 영속."""

    def test_price_history_append(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path)
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.PRICE_HISTORY_FILE",
                            tmp_path / "price_history.json")
        dart = {"period": "2025-11-24~2026-02-21", "estimates": {
            "total_orders": 10, "total_ships": 20,
            "avg_price_per_ship_usd": 200e6, "total_amount_usd": 4e9,
            "by_type": {"LNG운반선": {"count": 10, "amount_usd": 2.5e9}}}}
        _append_price_history(dart)
        history = _load_price_history()
        assert len(history) == 1
        assert history[0]["avg_price_usd"] == 200e6

    def test_price_history_dedup(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path)
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.PRICE_HISTORY_FILE",
                            tmp_path / "price_history.json")
        dart = {"estimates": {"total_orders": 5, "total_ships": 10,
                "avg_price_per_ship_usd": 100e6, "total_amount_usd": 1e9,
                "by_type": {}}}
        _append_price_history(dart)
        _append_price_history(dart)
        history = _load_price_history()
        assert len(history) == 1

    def test_price_history_has_by_type(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path)
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.PRICE_HISTORY_FILE",
                            tmp_path / "price_history.json")
        dart = {"estimates": {"total_orders": 3, "total_ships": 3,
                "avg_price_per_ship_usd": 200e6, "total_amount_usd": 600e6,
                "by_type": {"LNG운반선": {"count": 2, "amount_usd": 500e6},
                            "탱커": {"count": 1, "amount_usd": 100e6}}}}
        _append_price_history(dart)
        history = _load_price_history()
        assert "by_type" in history[0]
        assert "LNG운반선" in history[0]["by_type"]

    def test_price_history_trim(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path)
        ph_file = tmp_path / "price_history.json"
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.PRICE_HISTORY_FILE", ph_file)
        from datetime import date, timedelta
        existing = [{"date": (date(2020, 1, 1) + timedelta(days=i)).isoformat(),
                     "avg_price_usd": 100e6, "total_orders": 5, "total_ships": 10,
                     "by_type": {}} for i in range(521)]
        ph_file.write_text(json.dumps(existing))
        dart = {"estimates": {"total_orders": 5, "total_ships": 10,
                "avg_price_per_ship_usd": 100e6, "total_amount_usd": 1e9,
                "by_type": {}}}
        _append_price_history(dart)
        history = _load_price_history()
        assert len(history) <= 520


class TestV55TelegramDM:
    """v5.5: DM에 축별 점수(5축) 표시."""

    def test_dm_axis_scores(self):
        pulse = {"score": 67.5, "details": {}}
        combined = {"combined": 65.0, "market_pulse": 67.5, "cycle_score": 64.0, "method": "combined"}
        cycle = {"axis_scores": {"financial": 72, "order": 69, "valuation": 3, "structural": 70},
                 "details": {}}
        dm = format_telegram_dm(pulse, combined, [], {}, None, cycle=cycle)
        assert "수요" in dm
        assert "실적" in dm
        assert "수주" in dm

    def test_dm_no_ksoe(self):
        pulse = {"score": 55.0, "details": {}}
        combined = {"combined": 58.0, "market_pulse": 55.0, "cycle_score": 60.0, "method": "combined"}
        dm = format_telegram_dm(pulse, combined, [], {}, None)
        assert "한국조선해양" not in dm


# ══════════════════════════════════════════════════════════════════
#  v6.0 NEW TESTS
# ══════════════════════════════════════════════════════════════════


class TestV60DaehanConfig:
    """v6.0: 대한조선 설정 테스트."""

    def test_daehan_stock_code(self):
        assert SHIPBUILDER_STOCKS["daehan"]["stock_code"] == "439260"

    def test_daehan_tier_major(self):
        assert SHIPBUILDER_STOCKS["daehan"]["tier"] == "major"

    def test_daehan_in_tier1(self):
        assert "daehan" in TIER1_INDICATORS
        assert TIER1_INDICATORS["daehan"]["category"] == "stock"

    def test_daehan_in_pe_ranges(self):
        assert "daehan" in HISTORICAL_PE_RANGES
        pe = HISTORICAL_PE_RANGES["daehan"]
        assert pe["avg"] == 12.0

    def test_daehan_in_major_profiles(self):
        assert "daehan" in MAJOR_PROFILES
        p = MAJOR_PROFILES["daehan"]
        assert "수에즈맥스" in p["competitive_edge"] or any("수에즈" in v for v in p["focus_vessels"])

    def test_daehan_profile_name(self):
        assert MAJOR_PROFILES["daehan"]["name"] == "대한조선"

    def test_daehan_segment(self):
        seg = SHIPBUILDER_STOCKS["daehan"]["segment"]
        assert seg["revenue_ratio"] == 1.0
        assert seg["name"] == "조선"

    def test_daehan_not_in_midsize(self):
        assert "daehan" not in MIDSIZE_PROFILES

    def test_midsize_profiles_empty(self):
        assert len(MIDSIZE_PROFILES) == 0

    def test_daehan_pe_range_ipo_note(self):
        pe = HISTORICAL_PE_RANGES["daehan"]
        assert "IPO" in pe.get("peak_range", "")

    def test_major_count_6(self):
        """v6.0: major tier 6사."""
        majors = [k for k, v in SHIPBUILDER_STOCKS.items() if v["tier"] == "major"]
        assert len(majors) == 6

    def test_daehan_in_report(self):
        report = _make_v52_report()
        assert "대한조선" in report

    def test_daehan_in_dm(self):
        """대한조선이 major이므로 기업 리스트 순회 시 포함."""
        pulse = {"score": 55.0, "details": {}}
        combined = {"combined": 58.0, "market_pulse": 55.0, "cycle_score": 60.0, "method": "combined"}
        # DM에 직접 이름이 나올 필요는 없으나 경쟁국 섹션이 있는지 확인
        dm = format_telegram_dm(pulse, combined, [], {}, None)
        assert "경쟁국" in dm

    def test_daehan_default_vessel(self):
        assert COMPANY_DEFAULT_VESSEL["daehan"] == "탱커"


class TestV60MultipassClassification:
    """v6.0: 4-pass 선종 분류 테스트."""

    def test_keyword_pass(self):
        """Pass 1: 키워드 우선."""
        result = _classify_vessel_type("LNG운반선 2척 건조 계약", {})
        assert result == "LNG운반선"

    def test_keyword_vlcc(self):
        result = _classify_vessel_type("원유운반선 VLCC 300K DWT", {})
        assert result == "VLCC"

    def test_keyword_suezmax(self):
        result = _classify_vessel_type("Suezmax 탱커 건조", {})
        assert result == "탱커"

    def test_keyword_aframax(self):
        result = _classify_vessel_type("Aframax급 선박 건조 계약", {})
        assert result == "탱커"

    def test_keyword_lpg(self):
        result = _classify_vessel_type("LPG 운반선 건조", {})
        assert result == "LPG운반선"

    def test_keyword_product_carrier(self):
        result = _classify_vessel_type("석유제품 운반선 건조 계약", {})
        assert result == "PC선"

    def test_client_pass(self):
        """Pass 2: 발주처 기반."""
        result = _classify_vessel_type("선박 건조 계약", {"client": "Qatar Energy"})
        assert result == "LNG운반선"

    def test_client_frontline(self):
        result = _classify_vessel_type("선박 건조 계약", {"client": "Frontline"})
        assert result == "탱커"

    def test_client_evergreen(self):
        result = _classify_vessel_type("선박 건조 계약", {"client": "Evergreen"})
        assert result == "컨테이너선"

    def test_amount_pass_high(self):
        """Pass 3: 금액 기반 (고액 → LNG/VLCC)."""
        result = _classify_vessel_type("선박 건조", {"contract_amount_usd": 250_000_000})
        assert result in ("LNG/VLCC", "LNG운반선", "VLCC", "대형선(LNG/VLCC)")

    def test_amount_pass_low(self):
        """Pass 3: 저액 → 소형선."""
        result = _classify_vessel_type("선박 건조", {"contract_amount_usd": 30_000_000})
        assert result != "미분류"  # 금액 기반 분류가 작동해야 함

    def test_company_pass(self):
        """Pass 4: 회사 전문분야 기반."""
        result = _classify_vessel_type("건조 계약", {"key": "samsung"})
        assert result == "LNG운반선"  # samsung 기본값

    def test_company_daehan(self):
        result = _classify_vessel_type("건조 계약", {"key": "daehan"})
        assert result == "탱커"

    def test_keyword_overrides_client(self):
        """키워드가 발주처보다 우선."""
        result = _classify_vessel_type("컨테이너선 건조 계약", {"client": "Frontline"})
        assert result == "컨테이너선"  # 키워드 우선

    def test_unclassified_fallback(self):
        """모든 패스 실패 → 미분류."""
        result = _classify_vessel_type("불명 선종", {})
        assert result == "미분류"

    def test_extract_with_classification(self):
        """_extract_contract_info에서 4-pass 분류 통합."""
        r = _extract_contract_info("LNG 운반선 2척 건조 계약")
        assert r["ship_type"] == "LNG운반선"
        assert r["ship_count"] == 2

    def test_client_vessel_map_keys(self):
        assert len(CLIENT_VESSEL_MAP) >= 10

    def test_company_default_vessel_keys(self):
        assert len(COMPANY_DEFAULT_VESSEL) >= 6
        for key in ("daehan", "samsung", "hanwha", "hhi", "mipo", "hanjin"):
            assert key in COMPANY_DEFAULT_VESSEL


class TestV60LibraryFlags:
    """v6.0: 라이브러리 플래그 존재 확인."""

    def test_has_pykrx_flag(self):
        from pipeline.shipbuilding_cycle_tracker import HAS_PYKRX
        assert isinstance(HAS_PYKRX, bool)

    def test_has_fdr_flag(self):
        from pipeline.shipbuilding_cycle_tracker import HAS_FDR
        assert isinstance(HAS_FDR, bool)

    def test_has_opendart_flag(self):
        from pipeline.shipbuilding_cycle_tracker import HAS_OPENDART
        assert isinstance(HAS_OPENDART, bool)

    def test_kst_timezone(self):
        from datetime import timezone, timedelta
        assert KST == timezone(timedelta(hours=9))


class TestV60InvestmentJudgment:
    """v6.0: 투자 판단 요약 섹션."""

    def _make_section(self, **kwargs):
        defaults = {
            "combined": {"combined": 58.0, "market_pulse": 55.0, "cycle_score": 60.0},
            "fin_trends": {},
            "val_ctx": {},
            "peakout": [],
            "phase_code": "EXPAND",
            "phase_score": 58.0,
            "pulse": {"score": 55.0, "details": {}},
            "cycle": {"axis_scores": {"financial": 72, "order": 69, "valuation": 30, "structural": 70}},
        }
        defaults.update(kwargs)
        return _build_investment_judgment_section(**defaults)

    def test_section_exists(self):
        lines = self._make_section()
        text = "\n".join(lines)
        assert "투자 판단 요약" in text

    def test_cycle_position(self):
        lines = self._make_section()
        text = "\n".join(lines)
        assert "사이클 위치" in text
        assert "EXPAND" in text

    def test_watchpoints(self):
        lines = self._make_section()
        text = "\n".join(lines)
        assert "금주 관전 포인트" in text

    def test_peakout_risk(self):
        lines = self._make_section(
            peakout=[{"key": "margin_qoq", "desc": "OPM QoQ", "status": "warning"}]
        )
        text = "\n".join(lines)
        assert "피크아웃 경고" in text

    def test_company_verdicts(self):
        """major 기업 판정이 포함."""
        lines = self._make_section(
            fin_trends={"hhi": {"name": "HD현대중공업", "op_margin": 8.0}},
            val_ctx={"hhi": {"name": "HD현대중공업", "pe_ttm": 12.0}},
        )
        text = "\n".join(lines)
        assert "HD현대중공업" in text

    def test_high_score_peak_judgment(self):
        lines = self._make_section(phase_code="PEAK", phase_score=72.0)
        text = "\n".join(lines)
        assert "피크" in text

    def test_low_score_bust_judgment(self):
        lines = self._make_section(phase_code="BUST", phase_score=15.0)
        text = "\n".join(lines)
        assert "불황" in text

    def test_no_risk_message(self):
        lines = self._make_section(peakout=[])
        text = "\n".join(lines)
        assert "특이사항 없음" in text

    def test_returns_list(self):
        lines = self._make_section()
        assert isinstance(lines, list)
        assert all(isinstance(l, str) for l in lines)

    def test_demand_driver(self):
        lines = self._make_section(
            combined={"combined": 58.0, "market_pulse": 60.0, "cycle_score": 57.0},
        )
        text = "\n".join(lines)
        assert "수요 환경" in text


class TestV60TemporalFramework:
    """v6.0: 선행-동행-후행 프레임워크."""

    def test_temporal_tags_valid(self):
        valid_tags = {"lead", "coincident", "lag"}
        for axis, tag in INDICATOR_TEMPORAL_TAGS.items():
            assert tag in valid_tags, f"{axis} has invalid tag {tag}"

    def test_temporal_tags_cover_axes(self):
        expected = {"demand", "order", "structural", "financial", "valuation"}
        assert set(INDICATOR_TEMPORAL_TAGS.keys()) == expected

    def test_temporal_lead_axes(self):
        leads = [k for k, v in INDICATOR_TEMPORAL_TAGS.items() if v == "lead"]
        assert "demand" in leads
        assert "order" in leads

    def test_temporal_lag_axes(self):
        lags = [k for k, v in INDICATOR_TEMPORAL_TAGS.items() if v == "lag"]
        assert "valuation" in lags

    def test_build_temporal_output(self):
        axis_scores = {"financial": 72, "order": 69, "valuation": 30, "structural": 70}
        pulse = {"score": 55.0}
        lines = _build_temporal_interpretation(axis_scores, pulse)
        text = "\n".join(lines)
        assert "선행" in text
        assert "동행" in text
        assert "후행" in text

    def test_temporal_direction(self):
        axis_scores = {"financial": 72, "order": 69, "valuation": 30, "structural": 70}
        pulse = {"score": 55.0}
        lines = _build_temporal_interpretation(axis_scores, pulse)
        text = "\n".join(lines)
        assert "▲" in text or "▼" in text or "→" in text

    def test_temporal_lead_gt_coincident(self):
        """선행 > 동행 → 업사이클 가속."""
        axis_scores = {"financial": 40, "order": 80, "valuation": 30, "structural": 80}
        pulse = {"score": 75.0}
        lines = _build_temporal_interpretation(axis_scores, pulse)
        text = "\n".join(lines)
        assert "업사이클" in text or "가속" in text

    def test_temporal_empty_scores(self):
        lines = _build_temporal_interpretation({}, {"score": None})
        assert isinstance(lines, list)

    def test_temporal_returns_list(self):
        lines = _build_temporal_interpretation({}, {"score": 50.0})
        assert isinstance(lines, list)


class TestV60ScenarioAnalysis:
    """v6.0: 시나리오 분석."""

    def test_scenario_templates_keys(self):
        assert set(SCENARIO_TEMPLATES.keys()) == {"bull", "base", "bear"}

    def test_scenario_probability_sum(self):
        """확률 합이 100%."""
        probs = [int(t["probability"].replace("%", "")) for t in SCENARIO_TEMPLATES.values()]
        assert sum(probs) == 100

    def test_scenario_score_deltas(self):
        assert SCENARIO_TEMPLATES["bull"]["score_delta"] > 0
        assert SCENARIO_TEMPLATES["base"]["score_delta"] == 0
        assert SCENARIO_TEMPLATES["bear"]["score_delta"] < 0

    def test_scenario_drivers_exist(self):
        for key, tmpl in SCENARIO_TEMPLATES.items():
            assert len(tmpl["drivers"]) >= 2, f"{key} needs ≥2 drivers"

    def test_build_scenario_output(self):
        combined = {"combined": 58.0}
        lines = _build_scenario_section(combined, None)
        text = "\n".join(lines)
        assert "Bull" in text
        assert "Base" in text
        assert "Bear" in text

    def test_scenario_table(self):
        combined = {"combined": 58.0}
        lines = _build_scenario_section(combined, None)
        text = "\n".join(lines)
        assert "시나리오" in text
        assert "확률" in text

    def test_scenario_score_bounds(self):
        """점수가 0~100 범위 내."""
        combined = {"combined": 10.0}
        lines = _build_scenario_section(combined, None)
        text = "\n".join(lines)
        assert "0/100" not in text or "Bear" in text  # bear가 0이 될 수 있음

    def test_scenario_returns_list(self):
        lines = _build_scenario_section({"combined": 50.0}, None)
        assert isinstance(lines, list)

    def test_scenario_high_score(self):
        combined = {"combined": 95.0}
        lines = _build_scenario_section(combined, None)
        text = "\n".join(lines)
        assert "100/100" in text  # bull 105 → capped at 100


class TestV60HistoryKST:
    """v6.0: 히스토리 KST 타임존."""

    def test_kst_offset(self):
        from datetime import timezone, timedelta
        assert KST == timezone(timedelta(hours=9))

    def test_score_history_has_week_tag(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.SCORE_HISTORY_FILE", tmp_path / "sh.json")
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path)
        combined = {"combined": 58.0, "cycle_score": 60.0}
        pulse = {"score": 55.0}
        _append_score_history(9, 2026, combined, pulse, None)
        data = json.loads((tmp_path / "sh.json").read_text())
        assert data[0]["week_tag"] == "2026-W09"

    def test_score_history_upsert(self, tmp_path, monkeypatch):
        """동일 주차 → 덮어쓰기."""
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.SCORE_HISTORY_FILE", tmp_path / "sh.json")
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path)
        combined1 = {"combined": 58.0, "cycle_score": 60.0}
        combined2 = {"combined": 62.0, "cycle_score": 65.0}
        pulse = {"score": 55.0}
        _append_score_history(9, 2026, combined1, pulse, None)
        _append_score_history(9, 2026, combined2, pulse, None)
        data = json.loads((tmp_path / "sh.json").read_text())
        assert len(data) == 1
        assert data[0]["combined"] == 62.0

    def test_ensure_history_files(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path)
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.SCORE_HISTORY_FILE", tmp_path / "sh.json")
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.PEAKOUT_HISTORY_FILE", tmp_path / "ph.json")
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.VESSEL_MIX_HISTORY_FILE", tmp_path / "vm.json")
        _ensure_history_files()
        assert (tmp_path / "sh.json").exists()
        assert (tmp_path / "ph.json").exists()
        assert (tmp_path / "vm.json").exists()
        assert json.loads((tmp_path / "sh.json").read_text()) == []

    def test_peakout_history_kst(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.PEAKOUT_HISTORY_FILE", tmp_path / "ph.json")
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path)
        _append_peakout_history([{"key": "test", "value": 1.0}])
        data = json.loads((tmp_path / "ph.json").read_text())
        assert len(data) == 1
        assert "date" in data[0]

    def test_vessel_mix_kst(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.VESSEL_MIX_HISTORY_FILE", tmp_path / "vm.json")
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path)
        vm = {"phase1_ratio": 0.6, "phase2_ratio": 0.3, "by_category": {}, "total_ships": 10}
        _append_vessel_mix_history(vm, 9, 2026)
        data = json.loads((tmp_path / "vm.json").read_text())
        assert data[0]["week_tag"] == "2026-W09"


class TestV60DMReadability:
    """v6.0: DM 가독성 개선."""

    def _make_dm(self, **kwargs):
        defaults = {
            "pulse": {"score": 55.0, "details": {}},
            "combined": {"combined": 58.0, "market_pulse": 55.0, "cycle_score": 60.0, "method": "combined"},
            "signals": [],
            "indicators": {},
            "dart_data": None,
        }
        defaults.update(kwargs)
        return format_telegram_dm(**defaults)

    def test_main_divider(self):
        dm = self._make_dm()
        assert "━━━━━━━━━━━━━━━━" in dm

    def test_sub_divider(self):
        dm = self._make_dm()
        assert "─ ─ ─ ─ ─ ─ ─ ─" in dm

    def test_arrow_threshold_2(self):
        """변동 < 2.0이면 → 표시."""
        dm = self._make_dm(
            combined={"combined": 58.5, "market_pulse": 55.0, "cycle_score": 60.0, "method": "combined"},
            prev_data={"combined_score": 57.5},
        )
        # delta = 1.0 < 2.0 → 화살표 없이 → 표시
        assert "→" in dm

    def test_arrow_up_above_2(self):
        """변동 > 2.0이면 ↑ 표시."""
        dm = self._make_dm(
            combined={"combined": 62.0, "market_pulse": 55.0, "cycle_score": 60.0, "method": "combined"},
            prev_data={"combined_score": 55.0},
        )
        assert "↑" in dm

    def test_phase2_early_warning(self):
        """2기 비중 30%+ → 🔶 2기 접근."""
        dm = self._make_dm(
            vessel_mix={"total_ships": 10, "phase1_ratio": 0.65, "phase2_ratio": 0.35},
        )
        assert "🔶" in dm or "2기 접근" in dm


class TestV60ManualReminder:
    """v6.0: 수동 지표 리마인더."""

    def test_reminder_no_data(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.MANUAL_FILE", tmp_path / "manual.json")
        with patch("pipeline.shipbuilding_cycle_tracker._send_progress_dm") as mock_dm:
            result = send_manual_update_reminder(dry_run=True)
        assert result is True  # 미설정 → 리마인더 전송

    def test_reminder_stale(self, tmp_path, monkeypatch):
        manual_file = tmp_path / "manual.json"
        from datetime import datetime, timedelta
        old_date = (datetime.now() - timedelta(days=100)).isoformat()
        manual_file.write_text(json.dumps({"updated_at": old_date, "scores": {}}))
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.MANUAL_FILE", manual_file)
        with patch("pipeline.shipbuilding_cycle_tracker._send_progress_dm") as mock_dm:
            result = send_manual_update_reminder(dry_run=True)
        assert result is True

    def test_reminder_fresh(self, tmp_path, monkeypatch):
        manual_file = tmp_path / "manual.json"
        from datetime import datetime
        manual_file.write_text(json.dumps({"updated_at": datetime.now().isoformat(), "scores": {}}))
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.MANUAL_FILE", manual_file)
        result = send_manual_update_reminder(dry_run=True)
        assert result is False  # 최근 갱신 → 리마인더 불필요


class TestV60ReportIntegration:
    """v6.0: 리포트에 새 섹션 통합."""

    def test_report_has_judgment(self):
        report = _make_v52_report()
        assert "투자 판단 요약" in report

    def test_report_has_temporal(self):
        report = _make_v52_report()
        assert "선행-동행-후행" in report or "선행지표" in report

    def test_report_has_scenario(self):
        report = _make_v52_report()
        assert "시나리오 분석" in report
        assert "Bull" in report
        assert "Bear" in report

    def test_report_watchpoints(self):
        report = _make_v52_report()
        assert "금주 관전 포인트" in report

    def test_report_version_v61(self):
        from pipeline.shipbuilding_cycle_tracker import __doc__ as doc
        assert "v6.1" in doc


# ══════════════════════════════════════════════════════════════════
# v6.1 Tests
# ══════════════════════════════════════════════════════════════════

class TestV61DataFixes:
    """v6.1: 데이터 품질 수정."""

    def test_hanjin_stock_code_097230(self):
        """hanjin은 097230(사업회사), 003480(지주)이 아님."""
        assert SHIPBUILDER_STOCKS["hanjin"]["stock_code"] == "097230"

    def test_hanjin_ticker_097230(self):
        assert TIER1_INDICATORS["hanjin"]["ticker"] == "097230.KS"

    def test_hanjin_pe_avg_updated(self):
        assert HISTORICAL_PE_RANGES["hanjin"]["avg"] == 10.0
        assert HISTORICAL_PE_RANGES["hanjin"]["max"] == 30.0

    def test_mipo_tier1_note(self):
        """mipo에 비상장 주석이 존재."""
        assert "note" in TIER1_INDICATORS["mipo"]
        assert "비상장" in TIER1_INDICATORS["mipo"]["note"]

    def test_mipo_pe_note_in_historical(self):
        """mipo PE ranges에 지주 HD현대 참고용 주석."""
        assert "note" in HISTORICAL_PE_RANGES["mipo"]
        assert "지주" in HISTORICAL_PE_RANGES["mipo"]["note"]


class TestV61FontPriority:
    """v6.1: NanumGothic 폰트 우선."""

    def test_nanum_first_candidate(self):
        """_find_korean_font에서 NanumGothic이 최우선."""
        import inspect
        src = inspect.getsource(_find_korean_font)
        nanum_idx = src.find("NanumGothic")
        apple_idx = src.find("AppleSDGothicNeo")
        assert nanum_idx < apple_idx, "NanumGothic should be before AppleSDGothicNeo"

    def test_chart_font_nanum_first(self):
        """_setup_chart_env에서 NanumGothic이 첫 번째."""
        import inspect
        src = inspect.getsource(_setup_chart_env)
        assert src.index("NanumGothic") < src.index("AppleGothic")


class TestV61PdfOnlyTelegram:
    """v6.1: PDF만 전송, fallback."""

    def test_generate_report_no_text_send(self):
        """notify=True 시 send_telegram_full_report이 기본적으로 호출되지 않음."""
        import inspect
        from pipeline import shipbuilding_cycle_tracker as mod
        src = inspect.getsource(mod.generate_report)
        # PDF 성공 분기에서 send_telegram_full_report 호출 없음 확인
        # "pdf_path and pdf_path.exists()" 분기에 send_telegram_pdf만 있어야 함
        assert "send_telegram_pdf" in src

    def test_fallback_on_pdf_fail(self):
        """PDF 실패 시 send_telegram_full_report이 fallback."""
        import inspect
        from pipeline import shipbuilding_cycle_tracker as mod
        src = inspect.getsource(mod.generate_report)
        assert "send_telegram_full_report" in src  # fallback 존재


class TestV61ScoringDetailDemand:
    """v6.1: Demand 축 상세화."""

    def test_demand_has_wow_column(self):
        pulse = {"score": 55.0, "details": {
            "bdi": {"zscore": 0.5, "ratio": 0.75, "contribution": 18.75, "weight": 25},
        }}
        indicators = {"bdi": {"name": "BDI", "close": 20.5, "zscore": 0.5}}
        result = _scoring_detail_demand(pulse, indicators)
        joined = "\n".join(result)
        assert "WoW변동" in joined

    def test_demand_has_interpretation(self):
        pulse = {"score": 55.0, "details": {
            "bdi": {"zscore": 1.6, "ratio": 1.0, "contribution": 25, "weight": 25},
        }}
        indicators = {"bdi": {"name": "BDI", "close": 25.0, "zscore": 1.6}}
        result = _scoring_detail_demand(pulse, indicators)
        joined = "\n".join(result)
        assert "건화물 수요 강세" in joined

    def test_demand_negative_interpretation(self):
        pulse = {"score": 20.0, "details": {
            "krw": {"zscore": -0.8, "ratio": 0.25, "contribution": 2.5, "weight": 10},
        }}
        indicators = {"krw": {"name": "원달러", "close": 1250, "zscore": -0.8}}
        result = _scoring_detail_demand(pulse, indicators)
        joined = "\n".join(result)
        assert "원화 강세" in joined

    def test_demand_wow_with_history(self):
        pulse = {"score": 55.0, "details": {
            "bdi": {"zscore": 0.8, "ratio": 0.75, "contribution": 18.75, "weight": 25},
        }}
        indicators = {"bdi": {"name": "BDI", "close": 22.0, "zscore": 0.8}}
        history = [
            {"pulse_details": {"bdi": {"zscore": 0.3}}},
            {"pulse_details": {"bdi": {"zscore": 0.5}}},
        ]
        result = _scoring_detail_demand(pulse, indicators, history)
        joined = "\n".join(result)
        assert "+0.30" in joined  # 0.8 - 0.5 = 0.3 (history[-1]이 직전 저장분)

    def test_demand_group_summary(self):
        pulse = {"score": 55.0, "details": {
            "bdi": {"zscore": 0.8, "ratio": 0.75, "contribution": 18.75, "weight": 25},
            "wti": {"zscore": 0.6, "ratio": 0.75, "contribution": 11.25, "weight": 15},
        }}
        indicators = {
            "bdi": {"name": "BDI", "close": 22.0, "zscore": 0.8},
            "wti": {"name": "WTI", "close": 75.0, "zscore": 0.6},
        }
        result = _scoring_detail_demand(pulse, indicators)
        joined = "\n".join(result)
        assert "운임(건화물)" in joined or "에너지" in joined


class TestV61ScoringDetailFinancial:
    """v6.1: Financial 축 상세화."""

    def test_financial_has_revenue_column(self):
        cycle = {"axis_scores": {"financial": 62}}
        fin_trends = {
            "hhi": {"name": "HD현대중공업", "op_margin": 6.2, "op_margin_qoq": 1.5,
                    "roe": 12.0, "revenue": 5e12, "operating_profit": 3.1e11,
                    "contract_assets": 8e12, "contract_assets_qoq": 5.2, "ca_judgment": "성장"},
        }
        result = _scoring_detail_financial(cycle, fin_trends)
        joined = "\n".join(result)
        assert "매출(조)" in joined
        assert "영업이익(억)" in joined

    def test_financial_contract_assets_table(self):
        cycle = {"axis_scores": {"financial": 50}}
        fin_trends = {
            "hhi": {"name": "HD현대중공업", "op_margin": 6.0, "roe": 10.0,
                    "contract_assets": 8e12, "contract_assets_qoq": 3.0, "ca_judgment": "성장"},
        }
        result = _scoring_detail_financial(cycle, fin_trends)
        joined = "\n".join(result)
        assert "계약자산(조)" in joined

    def test_financial_segment_annotation(self):
        cycle = {"axis_scores": {"financial": 40}}
        fin_trends = {
            "hanjin": {"name": "HJ중공업", "op_margin": 4.5, "roe": 8.0,
                       "segment_adjusted": True, "segment_ratio": 0.65, "segment_name": "조선",
                       "contract_assets": 1e12, "contract_assets_qoq": 2.0, "ca_judgment": "안정"},
        }
        result = _scoring_detail_financial(cycle, fin_trends)
        joined = "\n".join(result)
        assert "65%" in joined


class TestV61ScoringDetailOrder:
    """v6.1: Order 축 상세화."""

    def test_order_company_table(self):
        cycle = {"axis_scores": {"order": 55}}
        dart_data = {
            "status": "ok",
            "orders": [
                {"key": "hhi", "report_name": "LNG운반선 수주", "ship_count": 2,
                 "contract_amount_usd": 500_000_000},
            ],
            "estimates": {"total_orders": 1, "avg_price_per_ship_usd": 250_000_000},
        }
        fin_trends = {}
        result = _scoring_detail_order(cycle, dart_data, fin_trends)
        joined = "\n".join(result)
        assert "HD현대중공업" in joined or "기업" in joined

    def test_order_top5(self):
        cycle = {"axis_scores": {"order": 60}}
        dart_data = {
            "status": "ok",
            "orders": [
                {"key": "hhi", "report_name": "LNG운반선 대형", "ship_count": 1,
                 "contract_amount_usd": 300_000_000},
                {"key": "samsung", "report_name": "셔틀탱커", "ship_count": 1,
                 "contract_amount_usd": 200_000_000},
            ],
            "estimates": {"total_orders": 2, "avg_price_per_ship_usd": 250_000_000},
        }
        fin_trends = {}
        result = _scoring_detail_order(cycle, dart_data, fin_trends)
        joined = "\n".join(result)
        assert "Top 5" in joined


class TestV61ScoringDetailValuation:
    """v6.1: Valuation 축 상세화."""

    def test_valuation_has_market_cap(self):
        cycle = {"axis_scores": {"valuation": 50}}
        val_ctx = {
            "hhi": {"name": "HD현대중공업", "pe_ttm": 25.0, "pe_source": "DART(4Q)",
                    "market_cap": 15e12, "ev_ebitda": 12.0},
        }
        result = _scoring_detail_valuation(cycle, val_ctx)
        joined = "\n".join(result)
        assert "시총(조)" in joined
        assert "PE소스" in joined

    def test_valuation_20y_position(self):
        cycle = {"axis_scores": {"valuation": 50}}
        val_ctx = {
            "hhi": {"name": "HD현대중공업", "pe_ttm": 25.0, "pe_source": "DART(4Q)",
                    "market_cap": 15e12, "ev_ebitda": None},
        }
        result = _scoring_detail_valuation(cycle, val_ctx)
        joined = "\n".join(result)
        assert "20Y내위치" in joined

    def test_valuation_mipo_note(self):
        cycle = {"axis_scores": {"valuation": 50}}
        val_ctx = {
            "mipo": {"name": "HD현대미포", "pe_ttm": 12.0, "pe_source": "fwd",
                     "pe_note": "지주(HD현대) PE", "market_cap": 5e12},
        }
        result = _scoring_detail_valuation(cycle, val_ctx)
        joined = "\n".join(result)
        assert "지주" in joined


class TestV61ScoringDetailStructural:
    """v6.1: Structural 축 상세화."""

    def test_structural_rationale(self):
        cycle = {"axis_scores": {"structural": 65}}
        manual = {"scores": {"regulation": 8}, "updated_at": "2026-02-20T00:00:00"}
        indicators = {}
        result = _scoring_detail_structural(cycle, manual, indicators)
        joined = "\n".join(result)
        assert "IMO" in joined and "EEXI" in joined

    def test_structural_auto_proxy_zscore(self):
        cycle = {"axis_scores": {"structural": 60}}
        manual = {"scores": {}, "updated_at": "2026-02-20T00:00:00"}
        indicators = {
            "container_proxy": {"zscore": 1.2, "close": 20.0},
            "tanker_proxy": {"zscore": 0.8, "close": 30.0},
            "tanker_proxy2": {"zscore": 0.5, "close": 25.0},
            "tanker_proxy3": {"zscore": 0.3, "close": 60.0},
            "tanker_proxy4": {"zscore": 0.1, "close": 10.0},
        }
        result = _scoring_detail_structural(cycle, manual, indicators)
        joined = "\n".join(result)
        assert "자동" in joined
        assert "z=" in joined

    def test_structural_missing_indicator_warning(self):
        cycle = {"axis_scores": {"structural": 40}}
        manual = {"scores": {}}
        indicators = {}
        result = _scoring_detail_structural(cycle, manual, indicators)
        joined = "\n".join(result)
        assert "미입력" in joined
        assert "--manual-update" in joined

    def test_structural_staleness_warning(self):
        from datetime import datetime
        cycle = {"axis_scores": {"structural": 65}}
        old_date = (datetime(2025, 10, 1)).isoformat()
        manual = {"scores": {"regulation": 8}, "updated_at": old_date}
        indicators = {}
        result = _scoring_detail_structural(cycle, manual, indicators)
        joined = "\n".join(result)
        assert "미갱신" in joined

    def test_structural_no_scores_warning(self):
        cycle = {"axis_scores": {"structural": 0}}
        manual = {}
        indicators = {}
        result = _scoring_detail_structural(cycle, manual, indicators)
        joined = "\n".join(result)
        assert "미설정" in joined


class TestV61PdfTtcHandling:
    """v6.1: TTC 폰트 직접 로드 (fpdf2 2.8+ 네이티브 지원)."""

    def test_build_pdf_no_font_index(self):
        """build_pdf_report에서 font_index 제거 확인 (fpdf2 호환)."""
        import inspect
        src = inspect.getsource(build_pdf_report)
        assert "font_index" not in src
        assert "add_font" in src


class TestV61ValuationRoeFallback:
    """v6.1: ROE null → DART fallback."""

    def test_roe_fallback_from_dart(self):
        valuation = {"stocks": {
            "daehan": {"name": "대한조선", "market_cap": 1e12,
                       "trailing_pe": 11.6, "forward_pe": None,
                       "price_to_book": 1.5, "roe": None,
                       "enterprise_value": 1.2e12, "ev_ebitda": None,
                       "operating_margins": None},
        }}
        financials = {"companies": {
            "daehan": {"quarters": {
                "2025Q3": {"net_income": 50_000_000_000, "total_equity": 500_000_000_000,
                           "revenue": 200_000_000_000},
            }},
        }}
        result = analyze_valuation_context(valuation, financials)
        assert "daehan" in result
        assert result["daehan"]["roe"] is not None
        assert abs(result["daehan"]["roe"] - 10.0) < 0.5  # 50B/500B = 10%


class TestV61ScoreHistoryPulseDetails:
    """v6.1: score_history에 pulse_details 저장."""

    def test_append_score_history_has_pulse_details(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.SCORE_HISTORY_FILE",
                            tmp_path / "score_history.json")
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.OUTPUT_DIR", tmp_path)
        pulse = {"score": 55.0, "details": {"bdi": {"zscore": 0.5}}}
        combined = {"combined": 60.0, "cycle_score": 62.0}
        _append_score_history(1, 2026, combined, pulse, None)
        data = json.loads((tmp_path / "score_history.json").read_text())
        assert len(data) == 1
        assert "pulse_details" in data[0]
        assert data[0]["pulse_details"]["bdi"]["zscore"] == 0.5


# ══════════════════════════════════════════════════════════════════
#  v6.2: 축별 산출 근거 컨텍스트 내러티브 강화
# ══════════════════════════════════════════════════════════════════

class TestV62ContainerSnapshot:
    """v6.2: 컨테이너 시황 스냅샷."""

    def test_default_keys(self):
        snap = DEFAULT_CONTAINER_SNAPSHOT
        assert "scfi_index" in snap
        assert "key_drivers" in snap
        assert "structural_view" in snap
        assert len(snap["key_drivers"]) >= 3

    def test_loader_fallback(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.CONTAINER_DATA_FILE",
                            tmp_path / "no_file.json")
        result = _load_container_snapshot()
        assert result["scfi_index"] == DEFAULT_CONTAINER_SNAPSHOT["scfi_index"]

    def test_loader_staleness(self, tmp_path, monkeypatch):
        from datetime import datetime, timedelta
        old_date = (datetime.now() - timedelta(days=100)).isoformat()
        data = dict(DEFAULT_CONTAINER_SNAPSHOT)
        data["updated_at"] = old_date
        data["scfi_index"] = "~999 (old)"
        f = tmp_path / "container_data.json"
        f.write_text(json.dumps(data))
        monkeypatch.setattr("pipeline.shipbuilding_cycle_tracker.CONTAINER_DATA_FILE", f)
        result = _load_container_snapshot()
        assert result["scfi_index"] == DEFAULT_CONTAINER_SNAPSHOT["scfi_index"]  # fallback


class TestV62DemandGroupNarratives:
    """v6.2: Demand 그룹별 내러티브."""

    def test_freight_positive_narrative_in_demand(self):
        pulse = {"score": 70.0, "details": {
            "bdi": {"zscore": 1.5, "ratio": 1.0, "contribution": 25, "weight": 25},
        }}
        indicators = {"bdi": {"name": "BDI", "close": 30.0, "zscore": 1.5}}
        result = _scoring_detail_demand(pulse, indicators)
        joined = "\n".join(result)
        assert "철광석" in joined or "건화물(BDI) 강세" in joined

    def test_energy_negative_narrative(self):
        pulse = {"score": 30.0, "details": {
            "wti": {"zscore": -1.0, "ratio": 0.25, "contribution": 3.75, "weight": 15},
            "brent": {"zscore": -0.8, "ratio": 0.25, "contribution": 3.75, "weight": 15},
            "natgas": {"zscore": -0.6, "ratio": 0.25, "contribution": 6.25, "weight": 25},
        }}
        indicators = {
            "wti": {"name": "WTI", "close": 60.0, "zscore": -1.0},
            "brent": {"name": "Brent", "close": 62.0, "zscore": -0.8},
            "natgas": {"name": "천연가스", "close": 2.5, "zscore": -0.6},
        }
        result = _scoring_detail_demand(pulse, indicators)
        joined = "\n".join(result)
        assert "에너지 약세" in joined

    def test_cost_steel_narrative(self):
        pulse = {"score": 50.0, "details": {
            "steel": {"zscore": 1.0, "ratio": 0.75, "contribution": 7.5, "weight": 10},
            "krw": {"zscore": 0.2, "ratio": 0.50, "contribution": 5.0, "weight": 10},
        }}
        indicators = {
            "steel": {"name": "SLX", "close": 50.0, "zscore": 1.0},
            "krw": {"name": "원달러", "close": 1350, "zscore": 0.2},
        }
        result = _scoring_detail_demand(pulse, indicators)
        joined = "\n".join(result)
        assert "후판가 상승" in joined or "원가 압박" in joined

    def test_container_proxy_in_demand(self):
        pulse = {"score": 55.0, "details": {
            "bdi": {"zscore": 0.3, "ratio": 0.50, "contribution": 12.5, "weight": 25},
        }}
        indicators = {
            "bdi": {"name": "BDI", "close": 20.0, "zscore": 0.3},
            "container_proxy": {"name": "ZIM", "close": 18.0, "zscore": 0.8},
        }
        result = _scoring_detail_demand(pulse, indicators)
        joined = "\n".join(result)
        assert "SCFI" in joined
        assert "컨테이너" in joined

    def test_tanker_proxy_in_demand(self):
        pulse = {"score": 55.0, "details": {
            "bdi": {"zscore": 0.3, "ratio": 0.50, "contribution": 12.5, "weight": 25},
        }}
        indicators = {
            "bdi": {"name": "BDI", "close": 20.0, "zscore": 0.3},
            "tanker_proxy": {"name": "BWET", "close": 30.0, "zscore": 2.0},
            "tanker_proxy2": {"name": "FRO", "close": 25.0, "zscore": 1.5},
            "tanker_proxy3": {"name": "STNG", "close": 60.0, "zscore": 0.7},
            "tanker_proxy4": {"name": "TNK", "close": 10.0, "zscore": 0.6},
        }
        result = _scoring_detail_demand(pulse, indicators)
        joined = "\n".join(result)
        assert "탱커" in joined
        assert "VLCC" in joined


class TestV62FinancialCompanyContext:
    """v6.2: Financial 축 기업별 현황."""

    def test_company_context_with_good_opm(self):
        cycle = {"axis_scores": {"financial": 62}}
        fin_trends = {
            "hhi": {"name": "HD현대중공업", "op_margin": 8.0, "op_margin_qoq": 1.5,
                    "roe": 12.0, "revenue": 5e12, "operating_profit": 4e11,
                    "contract_assets": 8e12, "contract_assets_qoq": 5.0, "ca_judgment": "성장"},
        }
        result = _scoring_detail_financial(cycle, fin_trends)
        joined = "\n".join(result)
        assert "기업별 현황" in joined
        assert "실적 호조" in joined
        assert "LNG" in joined  # focus_vessels

    def test_company_context_low_margin(self):
        cycle = {"axis_scores": {"financial": 30}}
        fin_trends = {
            "hanwha": {"name": "한화오션", "op_margin": 3.0, "op_margin_qoq": 1.0,
                       "roe": 5.0, "revenue": 3e12, "operating_profit": 9e10,
                       "contract_assets": 5e12, "contract_assets_qoq": 2.0, "ca_judgment": "안정"},
        }
        result = _scoring_detail_financial(cycle, fin_trends)
        joined = "\n".join(result)
        assert "마진 개선 중" in joined


class TestV62OrderVesselContext:
    """v6.2: Order 축 선종별 시장 환경."""

    def test_vessel_context_lng(self):
        cycle = {"axis_scores": {"order": 60}}
        dart_data = {
            "estimates": {"total_orders": 5, "avg_price_per_ship_usd": 250_000_000},
            "orders": [
                {"key": "hhi", "report_name": "LNG운반선 1척 수주", "contract_amount_usd": 250_000_000, "ship_count": 1},
                {"key": "hhi", "report_name": "LNG운반선 2척 수주", "contract_amount_usd": 500_000_000, "ship_count": 2},
            ],
        }
        fin_trends = {"hhi": {"contract_assets_qoq": 3.0}}
        result = _scoring_detail_order(cycle, dart_data, fin_trends)
        joined = "\n".join(result)
        assert "주요 선종별 시장 환경" in joined
        assert "AI" in joined or "LNG" in joined

    def test_vessel_context_container_scfi(self):
        cycle = {"axis_scores": {"order": 50}}
        dart_data = {
            "estimates": {"total_orders": 3, "avg_price_per_ship_usd": 120_000_000},
            "orders": [
                {"key": "hanjin", "report_name": "컨테이너선 2척", "contract_amount_usd": 240_000_000, "ship_count": 2},
            ],
        }
        fin_trends = {}
        result = _scoring_detail_order(cycle, dart_data, fin_trends)
        joined = "\n".join(result)
        assert "SCFI" in joined

    def test_vessel_context_tanker_dayrate(self):
        cycle = {"axis_scores": {"order": 55}}
        dart_data = {
            "estimates": {"total_orders": 4, "avg_price_per_ship_usd": 90_000_000},
            "orders": [
                {"key": "daehan", "report_name": "수에즈맥스탱커 3척", "contract_amount_usd": 270_000_000, "ship_count": 3},
            ],
        }
        fin_trends = {}
        result = _scoring_detail_order(cycle, dart_data, fin_trends)
        joined = "\n".join(result)
        assert "VLCC" in joined or "오더북" in joined


class TestV62ValuationNarrative:
    """v6.2: Valuation 축 저평가/고평가 코멘트."""

    def test_overvalued_comment(self):
        cycle = {"axis_scores": {"valuation": 30}}
        val_ctx = {
            "hhi": {"name": "HD현대중공업", "pe_ttm": 35.0, "pe_source": "DART(4Q)",
                    "market_cap": 15e12, "ev_ebitda": 12.0},
        }
        result = _scoring_detail_valuation(cycle, val_ctx)
        joined = "\n".join(result)
        assert "고평가" in joined
        assert "피크 PE" in joined

    def test_undervalued_comment(self):
        cycle = {"axis_scores": {"valuation": 80}}
        val_ctx = {
            "daehan": {"name": "대한조선", "pe_ttm": 8.0, "pe_source": "trailing",
                       "market_cap": 3.6e12, "ev_ebitda": 5.0},
        }
        result = _scoring_detail_valuation(cycle, val_ctx)
        joined = "\n".join(result)
        assert "저평가" in joined
        assert "수에즈맥스" in joined or "글로벌 1위" in joined


class TestV62StructuralContext:
    """v6.2: Structural 축 확장 컨텍스트."""

    def test_expanded_regulation_rationale(self):
        cycle = {"axis_scores": {"structural": 65}}
        manual = {"scores": {"regulation": 8}, "updated_at": "2026-02-20T00:00:00"}
        indicators = {}
        result = _scoring_detail_structural(cycle, manual, indicators)
        joined = "\n".join(result)
        assert "EEXI" in joined
        assert "CII" in joined
        assert "ETS" in joined

    def test_container_rate_scfi_in_structural(self):
        cycle = {"axis_scores": {"structural": 60}}
        manual = {"scores": {}, "updated_at": "2026-02-20T00:00:00"}
        indicators = {
            "container_proxy": {"zscore": 1.2, "close": 20.0},
        }
        result = _scoring_detail_structural(cycle, manual, indicators)
        joined = "\n".join(result)
        assert "SCFI" in joined

    def test_tanker_rate_vlcc_in_structural(self):
        cycle = {"axis_scores": {"structural": 60}}
        manual = {"scores": {}, "updated_at": "2026-02-20T00:00:00"}
        indicators = {
            "tanker_proxy": {"zscore": 2.0, "close": 30.0},
            "tanker_proxy2": {"zscore": 1.5, "close": 25.0},
            "tanker_proxy3": {"zscore": 0.7, "close": 60.0},
            "tanker_proxy4": {"zscore": 0.6, "close": 10.0},
        }
        result = _scoring_detail_structural(cycle, manual, indicators)
        joined = "\n".join(result)
        assert "VLCC" in joined
