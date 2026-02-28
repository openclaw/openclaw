"""test_semiconductor_cycle.py — 반도체 사이클 트래커 테스트."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from pipeline.semiconductor_cycle_tracker import (
    SEMI_CONFIG,
    SEMI_TIER1_INDICATORS, SEMI_MARKET_PULSE_WEIGHTS,
    SEMI_CYCLE_WEIGHTS, SEMI_MANUAL_INDICATORS,
    SEMI_PEAKOUT, SEMI_HISTORICAL_PE, SEMI_DART_TARGETS,
    SEMI_SCENARIOS, SEMI_CHART_SIZES,
    _KR_TICKERS,
    calculate_cycle_score,
    analyze_financial_trends, analyze_valuation_context,
    analyze_memory_cycle, compute_peakout_indicators,
    build_semi_report, show_status,
)
from shared.cycle_base import (
    calculate_market_pulse_generic, calculate_combined_score,
    determine_cycle_phase, load_json_safe, save_json_atomic,
    zscore_to_ratio,
)


# ══════════════════════════════════════════════════════════════════
#  Config 검증
# ══════════════════════════════════════════════════════════════════

class TestSemiConfig:
    def test_tier1_count(self):
        assert len(SEMI_TIER1_INDICATORS) == 15

    def test_tier1_required_fields(self):
        for key, meta in SEMI_TIER1_INDICATORS.items():
            assert "ticker" in meta, f"{key} missing ticker"
            assert "name" in meta, f"{key} missing name"
            assert "category" in meta, f"{key} missing category"

    def test_tier1_categories(self):
        valid = {"demand", "ai_demand", "foundry", "equipment", "networking", "kr_memory", "kr_equipment"}
        for key, meta in SEMI_TIER1_INDICATORS.items():
            assert meta["category"] in valid, f"{key} has invalid category: {meta['category']}"

    def test_kr_tickers_in_tier1(self):
        for kr in _KR_TICKERS:
            if kr in SEMI_TIER1_INDICATORS:
                ticker = SEMI_TIER1_INDICATORS[kr]["ticker"]
                assert ".KS" in ticker or kr in SEMI_DART_TARGETS

    def test_pulse_weights_sum_100(self):
        assert sum(SEMI_MARKET_PULSE_WEIGHTS.values()) == 100

    def test_pulse_weights_subset_of_tier1(self):
        for key in SEMI_MARKET_PULSE_WEIGHTS:
            assert key in SEMI_TIER1_INDICATORS, f"{key} not in tier1"

    def test_cycle_weights_sum_100(self):
        assert sum(SEMI_CYCLE_WEIGHTS.values()) == 100

    def test_cycle_weights_keys(self):
        expected = {"demand", "financial", "order", "valuation", "structural"}
        assert set(SEMI_CYCLE_WEIGHTS.keys()) == expected

    def test_config_domain(self):
        assert SEMI_CONFIG.domain == "semiconductor"
        assert SEMI_CONFIG.emoji == "💎"


class TestSemiManualIndicators:
    def test_required_fields(self):
        for key, meta in SEMI_MANUAL_INDICATORS.items():
            assert "name" in meta, f"{key} missing name"
            assert "weight" in meta, f"{key} missing weight"
            assert "desc" in meta, f"{key} missing desc"
            assert "inverted" in meta, f"{key} missing inverted"

    def test_weights_sum_100(self):
        total = sum(m["weight"] for m in SEMI_MANUAL_INDICATORS.values())
        assert total == 100

    def test_has_inverted(self):
        inverted = [k for k, m in SEMI_MANUAL_INDICATORS.items() if m["inverted"]]
        assert len(inverted) >= 1  # china_restriction, geopolitical_risk


class TestSemiPeakoutThresholds:
    def test_count(self):
        assert len(SEMI_PEAKOUT) == 6

    def test_required_fields(self):
        for key, thresh in SEMI_PEAKOUT.items():
            assert "warning" in thresh, f"{key} missing warning"
            assert "desc" in thresh, f"{key} missing desc"

    def test_direction_specified(self):
        for key, thresh in SEMI_PEAKOUT.items():
            assert "above" in thresh or "below" in thresh, f"{key} missing direction"


class TestSemiHistoricalPE:
    def test_required_fields(self):
        for key, pe in SEMI_HISTORICAL_PE.items():
            assert "avg" in pe, f"{key} missing avg"
            assert "min" in pe, f"{key} missing min"
            assert "max" in pe, f"{key} missing max"

    def test_range_valid(self):
        for key, pe in SEMI_HISTORICAL_PE.items():
            assert pe["min"] < pe["avg"] < pe["max"], f"{key}: invalid range"

    def test_major_companies(self):
        assert "samsung" in SEMI_HISTORICAL_PE
        assert "skhynix" in SEMI_HISTORICAL_PE


class TestSemiDartTargets:
    def test_count(self):
        assert len(SEMI_DART_TARGETS) == 6

    def test_required_fields(self):
        for key, target in SEMI_DART_TARGETS.items():
            assert "code" in target, f"{key} missing code"
            assert "name" in target, f"{key} missing name"
            assert "focus" in target, f"{key} missing focus"


class TestSemiScenarios:
    def test_three_scenarios(self):
        assert set(SEMI_SCENARIOS.keys()) == {"bull", "base", "bear"}

    def test_required_fields(self):
        for key, tmpl in SEMI_SCENARIOS.items():
            assert "label" in tmpl
            assert "probability" in tmpl
            assert "score_delta" in tmpl
            assert "drivers" in tmpl
            assert len(tmpl["drivers"]) >= 1

    def test_base_delta_zero(self):
        assert SEMI_SCENARIOS["base"]["score_delta"] == 0

    def test_bull_positive(self):
        assert SEMI_SCENARIOS["bull"]["score_delta"] > 0

    def test_bear_negative(self):
        assert SEMI_SCENARIOS["bear"]["score_delta"] < 0


# ══════════════════════════════════════════════════════════════════
#  Market Pulse (반도체)
# ══════════════════════════════════════════════════════════════════

class TestSemiMarketPulse:
    def _ind(self, overrides=None):
        d = overrides or {}
        return {k: {"zscore": d.get(k, 0.0), "close": 100, "name": SEMI_TIER1_INDICATORS[k]["name"]}
                for k in SEMI_MARKET_PULSE_WEIGHTS}

    def test_all_neutral_50(self):
        result = calculate_market_pulse_generic(self._ind(), SEMI_MARKET_PULSE_WEIGHTS)
        assert result["score"] == 50.0

    def test_all_strong_100(self):
        strong = {k: 2.0 for k in SEMI_MARKET_PULSE_WEIGHTS}
        assert calculate_market_pulse_generic(self._ind(strong), SEMI_MARKET_PULSE_WEIGHTS)["score"] == 100.0

    def test_all_weak_0(self):
        weak = {k: -2.0 for k in SEMI_MARKET_PULSE_WEIGHTS}
        assert calculate_market_pulse_generic(self._ind(weak), SEMI_MARKET_PULSE_WEIGHTS)["score"] == 0.0


# ══════════════════════════════════════════════════════════════════
#  Cycle Score (반도체)
# ══════════════════════════════════════════════════════════════════

class TestSemiCycleScore:
    def test_with_financial_data(self):
        fin_trends = {
            "samsung": {"name": "삼성전자", "op_margin": 15.0, "roe": 10.0},
            "skhynix": {"name": "SK하이닉스", "op_margin": 20.0, "roe": 15.0},
        }
        val_ctx = {
            "samsung": {"name": "삼성전자", "pe_vs_avg_pct": 10.0},
        }
        manual = {"scores": {"ai_infra_demand": 8, "china_restriction": 5,
                              "process_advance": 7, "supply_tightness": 6, "geopolitical_risk": 4}}
        indicators = {
            "asml": {"zscore": 1.0}, "lrcx": {"zscore": 0.5},
            "amat": {"zscore": 0.0}, "klac": {"zscore": -0.5},
        }
        result = calculate_cycle_score(fin_trends, val_ctx, manual, indicators)
        assert result is not None
        assert 0 <= result["score"] <= 100
        assert result["axes_used"] >= 3

    def test_empty_data_returns_none(self):
        result = calculate_cycle_score({}, {}, {"scores": {}}, {})
        assert result is None

    def test_partial_axes(self):
        fin_trends = {
            "samsung": {"name": "삼성전자", "op_margin": 25.0, "roe": 18.0},
        }
        result = calculate_cycle_score(fin_trends, {}, {"scores": {}}, {})
        assert result is not None
        assert result["axes_used"] == 1  # financial only


# ══════════════════════════════════════════════════════════════════
#  Analysis (반도체)
# ══════════════════════════════════════════════════════════════════

class TestSemiAnalysis:
    def _financials(self):
        return {
            "companies": {
                "samsung": {
                    "name": "삼성전자",
                    "quarters": {
                        "2025Q3": {"revenue": 70_000_000, "operating_profit": 14_000_000,
                                   "net_income": 10_000_000, "total_equity": 300_000_000},
                        "2025Q4": {"revenue": 80_000_000, "operating_profit": 20_000_000,
                                   "net_income": 15_000_000, "total_equity": 320_000_000},
                    },
                },
                "skhynix": {
                    "name": "SK하이닉스",
                    "quarters": {
                        "2025Q3": {"revenue": 15_000_000, "operating_profit": 3_000_000,
                                   "net_income": 2_000_000, "total_equity": 50_000_000},
                        "2025Q4": {"revenue": 18_000_000, "operating_profit": 5_000_000,
                                   "net_income": 3_500_000, "total_equity": 55_000_000},
                    },
                },
            },
        }

    def test_financial_trends(self):
        ft = analyze_financial_trends(self._financials())
        assert "samsung" in ft
        assert "skhynix" in ft
        assert ft["samsung"]["revenue_qoq"] == pytest.approx(14.285714, rel=0.01)
        assert ft["samsung"]["op_margin"] is not None

    def test_financial_trends_empty(self):
        assert analyze_financial_trends(None) == {}
        assert analyze_financial_trends({}) == {}

    def test_valuation_context(self):
        val = {
            "stocks": {
                "samsung": {"name": "삼성전자", "per": 15.0, "pbr": 1.2, "pe_vs_avg_pct": 25.0},
            },
        }
        result = analyze_valuation_context(val, None)
        assert "samsung" in result
        assert result["samsung"]["per"] == 15.0

    def test_memory_cycle(self):
        result = analyze_memory_cycle(self._financials())
        assert "samsung" in result
        assert result["samsung"]["margin_trend"] in ("improving", "declining")

    def test_peakout_indicators(self):
        ft = analyze_financial_trends(self._financials())
        val_ctx = {"samsung": {"pe_vs_avg_pct": 25.0}}
        peakout = compute_peakout_indicators(ft, val_ctx)
        assert len(peakout) == 6
        pe_item = next(p for p in peakout if p["key"] == "pe_vs_avg")
        assert pe_item["value"] == 25.0


# ══════════════════════════════════════════════════════════════════
#  리포트 빌드
# ══════════════════════════════════════════════════════════════════

class TestSemiReport:
    def test_report_build(self):
        data = {"indicators": {
            "soxx": {"name": "SOXX", "close": 550.0, "change_pct": 1.5, "zscore": 0.8, "category": "demand"},
        }}
        pulse = {"score": 60.0, "details": {}}
        cycle = {"score": 55.0, "axis_scores": {"financial": 60, "order": 50, "valuation": 45, "structural": 55}}
        combined = {"combined": 56.0, "market_pulse": 60.0, "cycle_score": 55.0, "note": "test"}
        fin_trends = {"samsung": {"name": "삼성전자", "latest_quarter": "2025Q4",
                                   "revenue_qoq": 10.0, "op_margin": 25.0, "roe": 15.0}}
        val_ctx = {"samsung": {"name": "삼성전자", "per": 12.0, "pbr": 1.5, "pe_vs_avg_pct": 0.0}}
        peakout = [{"key": "pe_vs_avg", "desc": "P/E vs 20Y평균 (%)", "value": 0.0, "status": "OK", "warning": 100.0}]
        memory_cycle = {"samsung": {"name": "삼성전자", "margin_trend": "improving",
                                     "recent_margins": [20.0, 25.0], "revenue_trend": "growing"}}
        manual = {"scores": {"ai_infra_demand": 8}}

        report = build_semi_report(data, pulse, cycle, combined, fin_trends, val_ctx,
                                    peakout, memory_cycle, manual)

        assert "# 반도체 사이클 분석 리포트" in report
        assert "종합 판정" in report
        assert "5축 분석" in report
        assert "기업별 실적" in report
        assert "삼성전자" in report
        assert "EXPANSION" in report or "EARLY_RECOVERY" in report

    def test_report_no_cycle(self):
        data = {"indicators": {}}
        pulse = {"score": 50.0, "details": {}}
        combined = {"combined": None, "market_pulse": 50.0, "cycle_score": None, "note": "pulse only"}
        report = build_semi_report(data, pulse, None, combined, {}, {}, [], {}, {"scores": {}})
        assert "# 반도체 사이클 분석 리포트" in report


# ══════════════════════════════════════════════════════════════════
#  Status
# ══════════════════════════════════════════════════════════════════

class TestSemiStatus:
    def test_status_no_data(self, capsys):
        """No data → prints help message without error."""
        with patch("pipeline.semiconductor_cycle_tracker.load_json_safe", return_value={}):
            with patch("pipeline.semiconductor_cycle_tracker.load_manual_indicators",
                       return_value={"scores": {}, "updated_at": None}):
                show_status()
        captured = capsys.readouterr()
        assert "수집 데이터 없음" in captured.out
