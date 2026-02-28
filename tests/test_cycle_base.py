"""test_cycle_base.py — 산업 사이클 공통 베이스 모듈 테스트."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from shared.cycle_base import (
    CycleConfig, CYCLE_PHASES,
    load_json_safe, save_json_atomic,
    compute_zscore_entry,
    zscore_to_ratio, zscore_to_1_10,
    calculate_market_pulse_generic, calculate_combined_score,
    determine_cycle_phase,
    append_score_history, append_peakout_history,
    load_score_history, load_peakout_history,
    load_manual_indicators, save_manual_indicators, update_manual,
    peakout_item, qoq_change, sorted_quarters,
)


# ── Helpers ──────────────────────────────────────────────────────

def _make_config(tmp_path: Path) -> CycleConfig:
    """테스트용 CycleConfig."""
    return CycleConfig(
        domain="test",
        output_dir=tmp_path / "test-indicators",
        report_dir=tmp_path / "test-indicators" / "reports",
        tier1_indicators={
            "a": {"ticker": "AAA", "name": "Alpha", "category": "demand"},
            "b": {"ticker": "BBB", "name": "Beta", "category": "supply"},
        },
        market_pulse_weights={"a": 60, "b": 40},
        cycle_score_weights={"demand": 20, "financial": 30, "order": 20, "valuation": 15, "structural": 15},
        manual_indicators={
            "x": {"name": "X Factor", "weight": 50, "desc": "test", "inverted": False},
            "y": {"name": "Y Factor", "weight": 50, "desc": "test inv", "inverted": True},
        },
        peakout_thresholds={
            "metric_a": {"warning": -5.0, "desc": "Metric A", "below": True},
            "metric_b": {"warning": 80.0, "desc": "Metric B", "above": True},
        },
        historical_pe_ranges={"co1": {"avg": 10.0, "min": 5.0, "max": 20.0}},
        dart_targets={"co1": {"code": "000001", "name": "Test Co"}},
        scenario_templates={
            "bull": {"label": "Bull", "probability": "30%", "score_delta": +10, "drivers": ["d1"]},
            "base": {"label": "Base", "probability": "50%", "score_delta": 0, "drivers": ["d2"]},
            "bear": {"label": "Bear", "probability": "20%", "score_delta": -10, "drivers": ["d3"]},
        },
        kr_tickers=set(),
        emoji="T",
        report_title="Test Cycle",
    )


# ── Z-Score 계산 ─────────────────────────────────────────────────

class TestComputeZscoreEntry:
    def test_basic(self):
        import pandas as pd
        dates = pd.date_range("2024-01-01", periods=30)
        series = pd.Series([100 + i for i in range(30)], index=dates)
        meta = {"ticker": "TEST", "name": "Test", "category": "demand"}
        result = compute_zscore_entry(series, meta)
        assert result is not None
        assert result["ticker"] == "TEST"
        assert result["close"] == 129.0
        assert result["data_points"] == 30
        assert "zscore" in result

    def test_too_few_points(self):
        import pandas as pd
        dates = pd.date_range("2024-01-01", periods=3)
        series = pd.Series([100, 101, 102], index=dates)
        meta = {"ticker": "TEST", "name": "Test", "category": "demand"}
        assert compute_zscore_entry(series, meta) is None

    def test_constant_series(self):
        import pandas as pd
        dates = pd.date_range("2024-01-01", periods=10)
        series = pd.Series([100.0] * 10, index=dates)
        meta = {"ticker": "TEST", "name": "Test", "category": "demand"}
        result = compute_zscore_entry(series, meta)
        assert result is not None
        assert result["zscore"] == 0.0  # std=0 → zscore=0

    def test_dataframe_input(self):
        import pandas as pd
        dates = pd.date_range("2024-01-01", periods=10)
        df = pd.DataFrame({"Close": [100 + i for i in range(10)]}, index=dates)
        meta = {"ticker": "TEST", "name": "Test", "category": "demand"}
        result = compute_zscore_entry(df, meta)
        assert result is not None


# ── Z-Score 변환 ─────────────────────────────────────────────────

class TestZscoreToRatio:
    def test_very_strong(self):
        assert zscore_to_ratio(2.0) == 1.0
        assert zscore_to_ratio(1.5) == 1.0

    def test_strong(self):
        assert zscore_to_ratio(1.0) == 0.75
        assert zscore_to_ratio(0.5) == 0.75

    def test_neutral(self):
        assert zscore_to_ratio(0.0) == 0.5
        assert zscore_to_ratio(-0.49) == 0.5

    def test_weak(self):
        assert zscore_to_ratio(-0.51) == 0.25
        assert zscore_to_ratio(-1.0) == 0.25

    def test_very_weak(self):
        assert zscore_to_ratio(-2.0) == 0.0
        assert zscore_to_ratio(-1.51) == 0.0

    def test_boundary_exact(self):
        assert zscore_to_ratio(1.5) == 1.0
        assert zscore_to_ratio(0.5) == 0.75
        assert zscore_to_ratio(-0.5) == 0.5
        assert zscore_to_ratio(-1.5) == 0.25


class TestZscoreTo1_10:
    def test_center(self):
        assert zscore_to_1_10(0.0) == 5.5

    def test_max(self):
        assert zscore_to_1_10(2.0) == 10.0
        assert zscore_to_1_10(5.0) == 10.0  # clamped

    def test_min(self):
        assert zscore_to_1_10(-2.0) == 1.0
        assert zscore_to_1_10(-5.0) == 1.0  # clamped


# ── Market Pulse ─────────────────────────────────────────────────

class TestMarketPulseGeneric:
    def test_all_neutral_50(self):
        indicators = {
            "a": {"zscore": 0.0, "close": 100, "name": "A"},
            "b": {"zscore": 0.0, "close": 100, "name": "B"},
        }
        weights = {"a": 60, "b": 40}
        result = calculate_market_pulse_generic(indicators, weights)
        assert result["score"] == 50.0
        assert result["indicators_used"] == 2

    def test_all_strong_100(self):
        indicators = {
            "a": {"zscore": 2.0, "close": 100, "name": "A"},
            "b": {"zscore": 2.0, "close": 100, "name": "B"},
        }
        weights = {"a": 60, "b": 40}
        assert calculate_market_pulse_generic(indicators, weights)["score"] == 100.0

    def test_all_weak_0(self):
        indicators = {
            "a": {"zscore": -2.0, "close": 100, "name": "A"},
            "b": {"zscore": -2.0, "close": 100, "name": "B"},
        }
        weights = {"a": 60, "b": 40}
        assert calculate_market_pulse_generic(indicators, weights)["score"] == 0.0

    def test_empty_data(self):
        result = calculate_market_pulse_generic({}, {"a": 60, "b": 40})
        assert result["score"] == 0.0
        assert result["indicators_used"] == 0

    def test_partial_data(self):
        indicators = {"a": {"zscore": 1.0, "close": 100, "name": "A"}}
        weights = {"a": 60, "b": 40}
        result = calculate_market_pulse_generic(indicators, weights)
        assert result["indicators_used"] == 1
        assert result["score"] == 75.0  # single indicator zscore=1.0 → ratio=0.75

    def test_mixed_signals(self):
        indicators = {
            "a": {"zscore": 2.0, "close": 100, "name": "A"},
            "b": {"zscore": -2.0, "close": 100, "name": "B"},
        }
        weights = {"a": 60, "b": 40}
        result = calculate_market_pulse_generic(indicators, weights)
        assert 0 < result["score"] < 100


# ── Combined Score ───────────────────────────────────────────────

class TestCombinedScore:
    def test_basic(self):
        pulse = {"score": 60.0}
        cycle = {"score": 70.0}
        result = calculate_combined_score(pulse, cycle, 15, 85)
        expected = round(60.0 * 0.15 + 70.0 * 0.85, 1)
        assert result["combined"] == expected
        assert result["method"] == "combined"

    def test_no_cycle(self):
        pulse = {"score": 50.0}
        result = calculate_combined_score(pulse, None, 15, 85)
        assert result["combined"] is None
        assert result["method"] == "market_pulse_only"

    def test_custom_weights(self):
        pulse = {"score": 80.0}
        cycle = {"score": 40.0}
        result = calculate_combined_score(pulse, cycle, 50, 50)
        assert result["combined"] == round(80.0 * 0.50 + 40.0 * 0.50, 1)


# ── Phase 판정 ───────────────────────────────────────────────────

class TestDetermineCyclePhase:
    def test_trough(self):
        assert determine_cycle_phase(0)[0] == "TROUGH"
        assert determine_cycle_phase(25)[0] == "TROUGH"

    def test_early_recovery(self):
        assert determine_cycle_phase(26)[0] == "EARLY_RECOVERY"
        assert determine_cycle_phase(45)[0] == "EARLY_RECOVERY"

    def test_expansion(self):
        assert determine_cycle_phase(46)[0] == "EXPANSION"
        assert determine_cycle_phase(65)[0] == "EXPANSION"

    def test_peak(self):
        assert determine_cycle_phase(66)[0] == "PEAK"
        assert determine_cycle_phase(85)[0] == "PEAK"

    def test_overheating(self):
        assert determine_cycle_phase(86)[0] == "OVERHEATING"
        assert determine_cycle_phase(100)[0] == "OVERHEATING"

    def test_phases_cover_0_to_100(self):
        covered = set()
        for lo, hi, _, _ in CYCLE_PHASES:
            for i in range(lo, hi + 1):
                covered.add(i)
        assert covered == set(range(0, 101))


# ── 히스토리 ─────────────────────────────────────────────────────

class TestScoreHistory:
    def test_append_and_load(self, tmp_path):
        cfg = _make_config(tmp_path)
        combined = {"combined": 55.0, "cycle_score": 60.0}
        pulse = {"score": 50.0, "details": {}}

        append_score_history(cfg, 1, 2026, combined, pulse, None)
        history = load_score_history(cfg)
        assert len(history) == 1
        assert history[0]["combined"] == 55.0
        assert history[0]["week"] == 1

    def test_upsert_same_week(self, tmp_path):
        cfg = _make_config(tmp_path)
        combined1 = {"combined": 50.0, "cycle_score": 55.0}
        combined2 = {"combined": 60.0, "cycle_score": 65.0}
        pulse = {"score": 50.0, "details": {}}

        append_score_history(cfg, 1, 2026, combined1, pulse, None)
        append_score_history(cfg, 1, 2026, combined2, pulse, None)
        history = load_score_history(cfg)
        assert len(history) == 1
        assert history[0]["combined"] == 60.0

    def test_max_size(self, tmp_path):
        cfg = _make_config(tmp_path)
        cfg = CycleConfig(**{**cfg.__dict__, "score_history_max": 5})
        pulse = {"score": 50.0, "details": {}}
        for i in range(10):
            combined = {"combined": float(i), "cycle_score": float(i)}
            append_score_history(cfg, i + 1, 2026, combined, pulse, None)
        history = load_score_history(cfg)
        assert len(history) == 5
        assert history[-1]["combined"] == 9.0


class TestPeakoutHistory:
    def test_append_and_load(self, tmp_path):
        cfg = _make_config(tmp_path)
        peakout = [{"key": "m1", "desc": "Metric 1", "value": 5.0, "status": "OK"}]
        append_peakout_history(cfg, peakout)
        history = load_peakout_history(cfg)
        assert len(history) == 1
        assert history[0]["m1"] == 5.0


# ── JSON 유틸 ────────────────────────────────────────────────────

class TestJsonUtils:
    def test_load_missing_file(self, tmp_path):
        result = load_json_safe(tmp_path / "nonexistent.json")
        assert result == {}

    def test_load_with_default(self, tmp_path):
        result = load_json_safe(tmp_path / "nonexistent.json", [])
        assert result == []

    def test_load_invalid_json(self, tmp_path):
        bad_file = tmp_path / "bad.json"
        bad_file.write_text("{invalid json")
        result = load_json_safe(bad_file, {"fallback": True})
        assert result == {"fallback": True}

    def test_save_and_load(self, tmp_path):
        path = tmp_path / "test.json"
        data = {"key": "value", "number": 42}
        save_json_atomic(path, data)
        loaded = load_json_safe(path)
        assert loaded == data

    def test_save_atomic_creates_parents(self, tmp_path):
        path = tmp_path / "sub" / "dir" / "file.json"
        save_json_atomic(path, {"ok": True})
        assert load_json_safe(path) == {"ok": True}


# ── 수동 지표 ────────────────────────────────────────────────────

class TestManualIndicators:
    def test_load_empty(self, tmp_path):
        cfg = _make_config(tmp_path)
        result = load_manual_indicators(cfg)
        assert result == {"scores": {}, "updated_at": None}

    def test_update_manual(self, tmp_path):
        cfg = _make_config(tmp_path)
        update_manual(cfg, ["x=7", "y=3"])
        manual = load_manual_indicators(cfg)
        assert manual["scores"]["x"] == 7.0
        assert manual["scores"]["y"] == 3.0

    def test_update_invalid_key(self, tmp_path):
        cfg = _make_config(tmp_path)
        update_manual(cfg, ["invalid_key=5"])
        manual = load_manual_indicators(cfg)
        assert "invalid_key" not in manual.get("scores", {})

    def test_update_clamps(self, tmp_path):
        cfg = _make_config(tmp_path)
        update_manual(cfg, ["x=15", "y=0"])
        manual = load_manual_indicators(cfg)
        assert manual["scores"]["x"] == 10.0
        assert manual["scores"]["y"] == 1.0


# ── 피크아웃 아이템 ──────────────────────────────────────────────

class TestPeakoutItem:
    def test_warning_below(self):
        thresholds = {"m": {"warning": -5.0, "desc": "Test", "below": True}}
        result = peakout_item("m", -6.0, thresholds)
        assert result["status"] == "WARNING"

    def test_ok_below(self):
        thresholds = {"m": {"warning": -5.0, "desc": "Test", "below": True}}
        result = peakout_item("m", 0.0, thresholds)
        assert result["status"] == "OK"

    def test_warning_above(self):
        thresholds = {"m": {"warning": 80.0, "desc": "Test", "above": True}}
        result = peakout_item("m", 90.0, thresholds)
        assert result["status"] == "WARNING"

    def test_none_value(self):
        thresholds = {"m": {"warning": -5.0, "desc": "Test"}}
        result = peakout_item("m", None, thresholds)
        assert result["status"] == "N/A"


# ── QoQ / sorted_quarters ───────────────────────────────────────

class TestQoqChange:
    def test_basic(self):
        assert qoq_change(110, 100) == pytest.approx(10.0)

    def test_negative(self):
        assert qoq_change(90, 100) == pytest.approx(-10.0)

    def test_none_values(self):
        assert qoq_change(None, 100) is None
        assert qoq_change(100, None) is None

    def test_zero_previous(self):
        assert qoq_change(100, 0) is None


class TestSortedQuarters:
    def test_basic(self):
        qs = {"2024Q3": {"rev": 3}, "2024Q1": {"rev": 1}, "2024Q2": {"rev": 2}}
        result = sorted_quarters(qs)
        assert [k for k, v in result] == ["2024Q1", "2024Q2", "2024Q3"]
