"""test_petrochemical_cycle.py — 석유화학 사이클 트래커 테스트."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from pipeline.petrochemical_cycle_tracker import (
    PETRO_CONFIG,
    PETRO_TIER1_INDICATORS, PETRO_MARKET_PULSE_WEIGHTS,
    PETRO_CYCLE_WEIGHTS, PETRO_MANUAL_INDICATORS,
    PETRO_PEAKOUT, PETRO_HISTORICAL_PE, PETRO_DART_TARGETS,
    PETRO_SCENARIOS, PETRO_CHART_SIZES,
    _KR_TICKERS,
    calculate_cycle_score,
    analyze_financial_trends, analyze_valuation_context,
    analyze_spread_cycle, compute_peakout_indicators,
    build_petro_report, show_status,
)
from shared.cycle_base import (
    calculate_market_pulse_generic, calculate_combined_score,
    determine_cycle_phase, load_json_safe, save_json_atomic,
    zscore_to_ratio,
)


# ══════════════════════════════════════════════════════════════════
#  Config 검증
# ══════════════════════════════════════════════════════════════════

class TestPetroConfig:
    def test_tier1_count(self):
        assert len(PETRO_TIER1_INDICATORS) == 16

    def test_tier1_required_fields(self):
        for key, meta in PETRO_TIER1_INDICATORS.items():
            assert "ticker" in meta, f"{key} missing ticker"
            assert "name" in meta, f"{key} missing name"
            assert "category" in meta, f"{key} missing category"

    def test_tier1_categories(self):
        valid = {"feedstock", "demand", "global_chem", "kr_chem"}
        for key, meta in PETRO_TIER1_INDICATORS.items():
            assert meta["category"] in valid, f"{key} has invalid category: {meta['category']}"

    def test_kr_tickers_in_tier1(self):
        for kr in _KR_TICKERS:
            if kr in PETRO_TIER1_INDICATORS:
                ticker = PETRO_TIER1_INDICATORS[kr]["ticker"]
                assert ".KS" in ticker or kr in PETRO_DART_TARGETS

    def test_pulse_weights_sum_100(self):
        assert sum(PETRO_MARKET_PULSE_WEIGHTS.values()) == 100

    def test_pulse_weights_subset_of_tier1(self):
        for key in PETRO_MARKET_PULSE_WEIGHTS:
            assert key in PETRO_TIER1_INDICATORS, f"{key} not in tier1"

    def test_cycle_weights_sum_100(self):
        assert sum(PETRO_CYCLE_WEIGHTS.values()) == 100

    def test_cycle_weights_keys(self):
        expected = {"demand", "financial", "order", "valuation", "structural"}
        assert set(PETRO_CYCLE_WEIGHTS.keys()) == expected

    def test_config_domain(self):
        assert PETRO_CONFIG.domain == "petrochemical"
        assert PETRO_CONFIG.emoji == "🧪"


class TestPetroManualIndicators:
    def test_required_fields(self):
        for key, meta in PETRO_MANUAL_INDICATORS.items():
            assert "name" in meta, f"{key} missing name"
            assert "weight" in meta, f"{key} missing weight"
            assert "desc" in meta, f"{key} missing desc"
            assert "inverted" in meta, f"{key} missing inverted"

    def test_weights_sum_100(self):
        total = sum(m["weight"] for m in PETRO_MANUAL_INDICATORS.values())
        assert total == 100

    def test_has_inverted(self):
        inverted = [k for k, m in PETRO_MANUAL_INDICATORS.items() if m["inverted"]]
        assert len(inverted) >= 1  # china_capacity, trade_friction


class TestPetroPeakoutThresholds:
    def test_count(self):
        assert len(PETRO_PEAKOUT) == 6

    def test_required_fields(self):
        for key, thresh in PETRO_PEAKOUT.items():
            assert "warning" in thresh, f"{key} missing warning"
            assert "desc" in thresh, f"{key} missing desc"

    def test_direction_specified(self):
        for key, thresh in PETRO_PEAKOUT.items():
            assert "above" in thresh or "below" in thresh, f"{key} missing direction"


class TestPetroHistoricalPE:
    def test_required_fields(self):
        for key, pe in PETRO_HISTORICAL_PE.items():
            assert "avg" in pe, f"{key} missing avg"
            assert "min" in pe, f"{key} missing min"
            assert "max" in pe, f"{key} missing max"

    def test_range_valid(self):
        for key, pe in PETRO_HISTORICAL_PE.items():
            assert pe["min"] < pe["avg"] < pe["max"], f"{key}: invalid range"

    def test_major_companies(self):
        assert "lgchem" in PETRO_HISTORICAL_PE
        assert "lottechem" in PETRO_HISTORICAL_PE


class TestPetroDartTargets:
    def test_count(self):
        assert len(PETRO_DART_TARGETS) == 6

    def test_required_fields(self):
        for key, target in PETRO_DART_TARGETS.items():
            assert "code" in target, f"{key} missing code"
            assert "name" in target, f"{key} missing name"
            assert "focus" in target, f"{key} missing focus"


class TestPetroScenarios:
    def test_three_scenarios(self):
        assert set(PETRO_SCENARIOS.keys()) == {"bull", "base", "bear"}

    def test_required_fields(self):
        for key, tmpl in PETRO_SCENARIOS.items():
            assert "label" in tmpl
            assert "probability" in tmpl
            assert "score_delta" in tmpl
            assert "drivers" in tmpl
            assert len(tmpl["drivers"]) >= 1

    def test_base_delta_zero(self):
        assert PETRO_SCENARIOS["base"]["score_delta"] == 0

    def test_bull_positive(self):
        assert PETRO_SCENARIOS["bull"]["score_delta"] > 0

    def test_bear_negative(self):
        assert PETRO_SCENARIOS["bear"]["score_delta"] < 0


# ══════════════════════════════════════════════════════════════════
#  Market Pulse (석유화학)
# ══════════════════════════════════════════════════════════════════

class TestPetroMarketPulse:
    def _ind(self, overrides=None):
        d = overrides or {}
        return {k: {"zscore": d.get(k, 0.0), "close": 100, "name": PETRO_TIER1_INDICATORS[k]["name"]}
                for k in PETRO_MARKET_PULSE_WEIGHTS}

    def test_all_neutral_50(self):
        result = calculate_market_pulse_generic(self._ind(), PETRO_MARKET_PULSE_WEIGHTS)
        assert result["score"] == 50.0

    def test_all_strong_100(self):
        strong = {k: 2.0 for k in PETRO_MARKET_PULSE_WEIGHTS}
        assert calculate_market_pulse_generic(self._ind(strong), PETRO_MARKET_PULSE_WEIGHTS)["score"] == 100.0

    def test_all_weak_0(self):
        weak = {k: -2.0 for k in PETRO_MARKET_PULSE_WEIGHTS}
        assert calculate_market_pulse_generic(self._ind(weak), PETRO_MARKET_PULSE_WEIGHTS)["score"] == 0.0


# ══════════════════════════════════════════════════════════════════
#  Cycle Score (석유화학)
# ══════════════════════════════════════════════════════════════════

class TestPetroCycleScore:
    def test_with_financial_data(self):
        fin_trends = {
            "lgchem": {"name": "LG화학", "op_margin": 5.0, "roe": 8.0},
            "lottechem": {"name": "롯데케미칼", "op_margin": 3.0, "roe": 4.0},
        }
        val_ctx = {
            "lgchem": {"name": "LG화학", "pe_vs_avg_pct": 10.0},
        }
        manual = {"scores": {"china_capacity": 6, "green_transition": 5,
                              "feedstock_cost": 7, "demand_recovery": 6, "trade_friction": 4}}
        indicators = {
            "dow": {"zscore": 0.5}, "lyb": {"zscore": 0.3},
            "basf": {"zscore": -0.2}, "ce": {"zscore": 0.1},
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
            "lgchem": {"name": "LG화학", "op_margin": 8.0, "roe": 10.0},
        }
        result = calculate_cycle_score(fin_trends, {}, {"scores": {}}, {})
        assert result is not None
        assert result["axes_used"] == 1  # financial only


# ══════════════════════════════════════════════════════════════════
#  Analysis (석유화학)
# ══════════════════════════════════════════════════════════════════

class TestPetroAnalysis:
    def _financials(self):
        return {
            "companies": {
                "lgchem": {
                    "name": "LG화학",
                    "quarters": {
                        "2025Q3": {"revenue": 12_000_000, "operating_profit": 600_000,
                                   "net_income": 400_000, "total_equity": 20_000_000},
                        "2025Q4": {"revenue": 13_000_000, "operating_profit": 780_000,
                                   "net_income": 520_000, "total_equity": 21_000_000},
                    },
                },
                "lottechem": {
                    "name": "롯데케미칼",
                    "quarters": {
                        "2025Q3": {"revenue": 4_000_000, "operating_profit": 120_000,
                                   "net_income": 80_000, "total_equity": 8_000_000},
                        "2025Q4": {"revenue": 4_200_000, "operating_profit": 168_000,
                                   "net_income": 110_000, "total_equity": 8_200_000},
                    },
                },
            },
        }

    def test_financial_trends(self):
        ft = analyze_financial_trends(self._financials())
        assert "lgchem" in ft
        assert "lottechem" in ft
        assert ft["lgchem"]["revenue_qoq"] == pytest.approx(8.333333, rel=0.01)
        assert ft["lgchem"]["op_margin"] is not None

    def test_financial_trends_empty(self):
        assert analyze_financial_trends(None) == {}
        assert analyze_financial_trends({}) == {}

    def test_valuation_context(self):
        val = {
            "stocks": {
                "lgchem": {"name": "LG화학", "per": 20.0, "pbr": 1.0, "pe_vs_avg_pct": 33.3},
            },
        }
        result = analyze_valuation_context(val, None)
        assert "lgchem" in result
        assert result["lgchem"]["per"] == 20.0

    def test_spread_cycle_with_data(self):
        indicators = {
            "dow": {"zscore": 0.8, "close": 50.0},
            "lyb": {"zscore": 0.6, "close": 90.0},
            "basf": {"zscore": 0.3, "close": 40.0},
            "ce": {"zscore": 0.1, "close": 150.0},
        }
        fin_trends = {
            "lgchem": {"op_margin": 6.0},
            "lottechem": {"op_margin": 4.0},
        }
        result = analyze_spread_cycle(indicators, fin_trends)
        # (0.8+0.6+0.3+0.1)/4 = 0.45 → neutral (threshold is 0.5)
        assert result["spread_health"] == "neutral"
        assert result["kr_avg_margin"] == 5.0  # (6+4)/2
        assert result["ncc_margin_signal"] == "marginal"  # 5.0 is not > 5, so marginal

    def test_spread_cycle_no_data(self):
        result = analyze_spread_cycle(None, {})
        assert result["spread_health"] == "no_data"
        assert result["ncc_margin_signal"] == "no_data"

    def test_spread_cycle_distressed(self):
        indicators = {
            "dow": {"zscore": -1.0}, "lyb": {"zscore": -0.8},
            "basf": {"zscore": -0.7}, "ce": {"zscore": -0.9},
        }
        result = analyze_spread_cycle(indicators, {})
        assert result["spread_health"] == "distressed"

    def test_peakout_indicators(self):
        ft = analyze_financial_trends(self._financials())
        val_ctx = {"lgchem": {"pe_vs_avg_pct": 33.3}}
        peakout = compute_peakout_indicators(ft, val_ctx)
        assert len(peakout) == 6
        pe_item = next(p for p in peakout if p["key"] == "pe_vs_avg")
        assert pe_item["value"] == 33.3


# ══════════════════════════════════════════════════════════════════
#  리포트 빌드
# ══════════════════════════════════════════════════════════════════

class TestPetroReport:
    def test_report_build(self):
        data = {"indicators": {
            "wti": {"name": "WTI", "close": 75.0, "change_pct": 1.2, "zscore": 0.5, "category": "feedstock"},
        }}
        pulse = {"score": 55.0, "details": {}}
        cycle = {"score": 45.0, "axis_scores": {"financial": 50, "order": 40, "valuation": 45, "structural": 48}}
        combined = {"combined": 47.0, "market_pulse": 55.0, "cycle_score": 45.0, "note": "test"}
        fin_trends = {"lgchem": {"name": "LG화학", "latest_quarter": "2025Q4",
                                  "revenue_qoq": 8.3, "op_margin": 6.0, "roe": 2.5}}
        val_ctx = {"lgchem": {"name": "LG화학", "per": 20.0, "pbr": 1.0, "pe_vs_avg_pct": 33.3}}
        peakout = [{"key": "pe_vs_avg", "desc": "P/E vs 20Y평균 (%)", "value": 33.3, "status": "OK", "warning": 100.0}]
        spread_cycle = {"global_chem_zscore_avg": 0.45, "spread_health": "neutral",
                        "kr_avg_margin": 5.0, "ncc_margin_signal": "good"}
        manual = {"scores": {"china_capacity": 6}}

        report = build_petro_report(data, pulse, cycle, combined, fin_trends, val_ctx,
                                     peakout, spread_cycle, manual)

        assert "# 석유화학 사이클 분석 리포트" in report
        assert "종합 판정" in report
        assert "5축 분석" in report
        assert "기업별 실적" in report
        assert "스프레드 사이클" in report
        assert "LG화학" in report
        assert "EXPANSION" in report or "EARLY_RECOVERY" in report

    def test_report_no_cycle(self):
        data = {"indicators": {}}
        pulse = {"score": 50.0, "details": {}}
        combined = {"combined": None, "market_pulse": 50.0, "cycle_score": None, "note": "pulse only"}
        report = build_petro_report(data, pulse, None, combined, {}, {}, [], {}, {"scores": {}})
        assert "# 석유화학 사이클 분석 리포트" in report


# ══════════════════════════════════════════════════════════════════
#  Status
# ══════════════════════════════════════════════════════════════════

class TestPetroStatus:
    def test_status_no_data(self, capsys):
        """No data → prints help message without error."""
        with patch("pipeline.petrochemical_cycle_tracker.load_json_safe", return_value={}):
            with patch("pipeline.petrochemical_cycle_tracker.load_manual_indicators",
                       return_value={"scores": {}, "updated_at": None}):
                show_status()
        captured = capsys.readouterr()
        assert "수집 데이터 없음" in captured.out
