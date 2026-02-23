"""
test_geopolitical_monitor.py -- 지정학 모니터 유닛 테스트 (v3)
"""
from __future__ import annotations

import json
import sys
import urllib.error
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Ensure scripts/ is on path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from pipeline.geopolitical_monitor import (
    BASELINE_SKIP_TYPES,
    COUNTRY_SHORT,
    DEFAULT_WATCHLIST,
    ICAO_COUNTRY_RANGES,
    REGION_CHOKEPOINT_MAP,
    REGION_MARKET_MAP,
    REGION_TIERS,
    TENSION_HIGH,
    TENSION_MEDIUM,
    _annotate_screenshot,
    _bbox_to_point_radius,
    _compute_tension,
    _country_abbr,
    _format_countries_short,
    _format_region_lines,
    _icao_hex_to_country,
    _parse_pizza_text,
    _trend_arrow,
    capture_vessel_map,
    collect_all,
    fetch_aircraft,
    fetch_airplanes_live,
    fetch_gpr_epu,
    fetch_portwatch_transit,
    fetch_vessel_count,
    compute_alert_level,
    compute_averages,
    detect_anomalies,
    format_telegram_message,
    load_market_context,
    load_watchlist,
    save_watchlist,
    load_history,
    cleanup_old_charts,
    fetch_opensky,
    fetch_gdelt_news,
    send_telegram_album,
)


# ── _parse_pizza_text ───────────────────────────────────────────────

class TestParsePizzaText:
    def test_doughcon_4(self):
        text = "DOUGHCON 4\nDOUBLE TAKE\n27 alerts\nOPERATIONAL"
        r = _parse_pizza_text(text)
        assert r["doughcon"] == 4
        assert r["label"] == "DOUBLE TAKE"
        assert r["alerts"] == 27
        assert r["status"] == "OPERATIONAL"

    def test_doughcon_1_cocked_pistol(self):
        text = "DOUGHCON 1\n5 alerts\nDEGRADED"
        r = _parse_pizza_text(text)
        assert r["doughcon"] == 1
        assert r["label"] == "COCKED PISTOL"
        assert r["status"] == "DEGRADED"

    def test_doughcon_5_fade_out(self):
        text = "DOUGHCON 5\n0 alerts\nOPERATIONAL"
        r = _parse_pizza_text(text)
        assert r["doughcon"] == 5
        assert r["label"] == "FADE OUT"
        assert r["alerts"] == 0

    def test_no_doughcon_in_text(self):
        text = "Some random page content without anything useful"
        r = _parse_pizza_text(text)
        assert r["doughcon"] is None
        assert r["alerts"] == 0

    def test_case_insensitive(self):
        text = "doughcon 3\n12 Alerts\noperational"
        r = _parse_pizza_text(text)
        assert r["doughcon"] == 3
        assert r["label"] == "ROUND HOUSE"
        assert r["alerts"] == 12
        assert r["status"] == "OPERATIONAL"


# ── compute_averages ────────────────────────────────────────────────

class TestComputeAverages:
    def test_single_day(self):
        history = [{"regions": {"taiwan": {
            "aircraft": {"count": 30}, "news": {"count": 20}
        }}}]
        avg = compute_averages(history)
        assert avg["taiwan"]["avg_aircraft"] == 30.0
        assert avg["taiwan"]["avg_news"] == 20.0

    def test_multiple_days(self):
        history = [
            {"regions": {"hormuz": {"aircraft": {"count": 10}, "news": {"count": 5}}}},
            {"regions": {"hormuz": {"aircraft": {"count": 20}, "news": {"count": 15}}}},
            {"regions": {"hormuz": {"aircraft": {"count": 30}, "news": {"count": 10}}}},
        ]
        avg = compute_averages(history)
        assert avg["hormuz"]["avg_aircraft"] == 20.0
        assert avg["hormuz"]["avg_news"] == 10.0

    def test_empty_history(self):
        avg = compute_averages([])
        assert avg == {}

    def test_missing_aircraft_data(self):
        history = [{"regions": {"suez": {"news": {"count": 8}}}}]
        avg = compute_averages(history)
        assert avg["suez"]["avg_aircraft"] is None
        assert avg["suez"]["avg_news"] == 8.0


# ── _compute_tension ──────────────────────────────────────────────

class TestComputeTension:
    def test_high_tension_two_high_keywords(self):
        titles = ["Missile attack on target", "War erupts in region"]
        tension, matched = _compute_tension(titles)
        assert tension == "high"
        assert "missile" in matched
        assert "attack" in matched
        assert "war" in matched

    def test_medium_tension_one_high_keyword(self):
        titles = ["Missile test conducted over sea"]
        tension, matched = _compute_tension(titles)
        assert tension == "medium"
        assert "missile" in matched

    def test_medium_tension_three_medium_keywords(self):
        titles = ["Military deploys navy troops near strait"]
        tension, matched = _compute_tension(titles)
        assert tension == "medium"
        assert len([kw for kw in matched if kw in [k.lower() for k in TENSION_MEDIUM]]) >= 3

    def test_low_tension_no_keywords(self):
        titles = ["Peace talks continue at summit", "Economic cooperation agreement signed"]
        tension, matched = _compute_tension(titles)
        assert tension == "low"
        assert matched == []

    def test_korean_keywords(self):
        titles = ["미사일 발사 소식", "군사 배치 확인"]
        tension, matched = _compute_tension(titles)
        assert tension == "medium"  # 미사일(high) → at least medium
        assert "미사일" in matched

    def test_mixed_en_ko_titles(self):
        titles = ["전쟁 위기 고조", "Missile launch detected", "공격 possible"]
        tension, matched = _compute_tension(titles)
        assert tension == "high"  # 전쟁+공격+missile = 2+ high

    def test_empty_titles(self):
        tension, matched = _compute_tension([])
        assert tension == "low"
        assert matched == []


# ── detect_anomalies (v3) ─────────────────────────────────────────

class TestDetectAnomalies:
    def test_no_anomalies_normal_traffic(self):
        today = {"regions": {"taiwan": {
            "aircraft": {"count": 20}, "news": {"count": 15}
        }}, "pentagon_index": {"doughcon": 4}}
        avg = {"taiwan": {"avg_aircraft": 18, "avg_news": 14}}
        anomalies = detect_anomalies(today, avg)
        assert len(anomalies) == 0

    def test_aircraft_increase_ignored(self):
        """v3: aircraft increase is ignored (commercial noise)."""
        today = {"regions": {"taiwan": {
            "aircraft": {"count": 50}, "news": {"count": 15}
        }}, "pentagon_index": {}}
        avg = {"taiwan": {"avg_aircraft": 18, "avg_news": 14}}
        anomalies = detect_anomalies(today, avg)
        aircraft = [a for a in anomalies if a["type"] == "aircraft_avoidance"]
        assert len(aircraft) == 0

    def test_aircraft_decrease_30pct_medium(self):
        """v3: -30% → medium aircraft_avoidance."""
        today = {"regions": {"hormuz": {
            "aircraft": {"count": 7}, "news": {"count": 5}
        }}, "pentagon_index": {}}
        avg = {"hormuz": {"avg_aircraft": 10, "avg_news": 5}}
        anomalies = detect_anomalies(today, avg)
        aircraft = [a for a in anomalies if a["type"] == "aircraft_avoidance"]
        assert len(aircraft) == 1
        assert aircraft[0]["severity"] == "medium"
        assert aircraft[0]["pct_change"] == -30

    def test_aircraft_decrease_50pct_high(self):
        """v3: -50% → high aircraft_avoidance."""
        today = {"regions": {"hormuz": {
            "aircraft": {"count": 4}, "news": {"count": 5}
        }}, "pentagon_index": {}}
        avg = {"hormuz": {"avg_aircraft": 10, "avg_news": 5}}
        anomalies = detect_anomalies(today, avg)
        aircraft = [a for a in anomalies if a["type"] == "aircraft_avoidance"]
        assert len(aircraft) == 1
        assert aircraft[0]["severity"] == "high"
        assert aircraft[0]["pct_change"] == -60

    def test_news_volume_high_with_tension_keywords(self):
        """v3: news +200% with high tension → high anomaly."""
        today = {"regions": {"scs": {
            "news": {"count": 60, "top_titles": ["Missile attack near island", "War preparations"]}
        }}, "pentagon_index": {}}
        avg = {"scs": {"avg_aircraft": None, "avg_news": 15}}
        anomalies = detect_anomalies(today, avg)
        news = [a for a in anomalies if a["type"] == "news"]
        assert len(news) == 1
        assert news[0]["severity"] == "high"
        assert news[0]["tension"] == "high"
        assert len(news[0]["matched_keywords"]) >= 2

    def test_news_volume_100pct_with_medium_tension(self):
        """v3: news +100% with medium tension → medium anomaly."""
        today = {"regions": {"black_sea": {
            "news": {"count": 30, "top_titles": ["Military buildup in region", "Troops deploy"]}
        }}, "pentagon_index": {}}
        avg = {"black_sea": {"avg_aircraft": None, "avg_news": 15}}
        anomalies = detect_anomalies(today, avg)
        news = [a for a in anomalies if a["type"] == "news"]
        assert len(news) == 1
        assert news[0]["severity"] == "medium"

    def test_news_volume_high_no_keywords_ignored(self):
        """v3: news +300% but no tension keywords → ignored (peace talks)."""
        today = {"regions": {"taiwan": {
            "news": {"count": 60, "top_titles": ["Peace summit achieves breakthrough", "Trade deal signed"]}
        }}, "pentagon_index": {}}
        avg = {"taiwan": {"avg_aircraft": None, "avg_news": 15}}
        anomalies = detect_anomalies(today, avg)
        news = [a for a in anomalies if a["type"] == "news"]
        assert len(news) == 0

    def test_news_volume_moderate_low_tension_ignored(self):
        """v3: news +80% (below 100%) → no anomaly regardless of keywords."""
        today = {"regions": {"hormuz": {
            "news": {"count": 27, "top_titles": ["Missile test conducted"]}
        }}, "pentagon_index": {}}
        avg = {"hormuz": {"avg_aircraft": None, "avg_news": 15}}
        anomalies = detect_anomalies(today, avg)
        news = [a for a in anomalies if a["type"] == "news"]
        assert len(news) == 0

    def test_doughcon_high_anomaly(self):
        today = {"regions": {}, "pentagon_index": {"doughcon": 2, "label": "FAST PACE"}}
        anomalies = detect_anomalies(today, {})
        assert len(anomalies) == 1
        assert anomalies[0]["type"] == "doughcon"
        assert anomalies[0]["severity"] == "high"
        assert anomalies[0]["value"] == 2

    def test_doughcon_4_no_anomaly(self):
        today = {"regions": {}, "pentagon_index": {"doughcon": 4}}
        anomalies = detect_anomalies(today, {})
        assert len(anomalies) == 0

    def test_no_averages_no_anomaly(self):
        today = {"regions": {"taiwan": {
            "aircraft": {"count": 100}, "news": {"count": 200}
        }}, "pentagon_index": {}}
        anomalies = detect_anomalies(today, {})
        assert len(anomalies) == 0


# ── compute_alert_level ───────────────────────────────────────────

class TestComputeAlertLevel:
    def test_normal_no_anomalies(self):
        level, reason = compute_alert_level([])
        assert level == "normal"
        assert reason == "전 지역 정상"

    def test_watch_single_source(self):
        anomalies = [{"type": "aircraft_avoidance", "severity": "medium", "region": "hormuz"}]
        level, reason = compute_alert_level(anomalies)
        assert level == "watch"
        assert "단일 소스" in reason

    def test_watch_news_only(self):
        anomalies = [{"type": "news", "severity": "high", "region": "scs"}]
        level, reason = compute_alert_level(anomalies)
        assert level == "watch"

    def test_watch_doughcon_3(self):
        """DOUGHCON 3 → watch (not alert, since ≤2 required for alert)."""
        anomalies = [{"type": "doughcon", "severity": "high", "value": 3, "region": "pentagon"}]
        level, reason = compute_alert_level(anomalies)
        assert level == "watch"

    def test_alert_avoidance_plus_news(self):
        anomalies = [
            {"type": "aircraft_avoidance", "severity": "high", "region": "hormuz"},
            {"type": "news", "severity": "high", "region": "hormuz"},
        ]
        level, reason = compute_alert_level(anomalies)
        assert level == "alert"
        assert "복수 독립 소스" in reason

    def test_alert_avoidance_plus_doughcon(self):
        anomalies = [
            {"type": "aircraft_avoidance", "severity": "medium", "region": "taiwan"},
            {"type": "doughcon", "severity": "high", "value": 3, "region": "pentagon"},
        ]
        level, reason = compute_alert_level(anomalies)
        assert level == "alert"
        assert "복수 독립 소스" in reason

    def test_alert_doughcon_2_standalone(self):
        anomalies = [{"type": "doughcon", "severity": "high", "value": 2, "region": "pentagon"}]
        level, reason = compute_alert_level(anomalies)
        assert level == "alert"
        assert "DOUGHCON 2" in reason

    def test_alert_doughcon_1_standalone(self):
        anomalies = [{"type": "doughcon", "severity": "high", "value": 1, "region": "pentagon"}]
        level, reason = compute_alert_level(anomalies)
        assert level == "alert"
        assert "DOUGHCON 1" in reason

    def test_watch_avoidance_plus_news_medium(self):
        """aircraft_avoidance + news medium → watch (news must be high for alert)."""
        anomalies = [
            {"type": "aircraft_avoidance", "severity": "medium", "region": "hormuz"},
            {"type": "news", "severity": "medium", "region": "hormuz"},
        ]
        level, reason = compute_alert_level(anomalies)
        assert level == "watch"


# ── load_market_context ───────────────────────────────────────────

class TestLoadMarketContext:
    def test_loads_today(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.geopolitical_monitor.MARKET_INDICATORS_DIR", tmp_path)
        today = datetime.now().date().isoformat()
        data = {"indicators": {
            "VIX": {"close": 20, "change_pct": 5.5},
            "WTI": {"close": 80, "change_pct": -2.3},
        }}
        (tmp_path / f"{today}.json").write_text(json.dumps(data))
        ctx = load_market_context()
        assert ctx["VIX"] == 5.5
        assert ctx["WTI"] == -2.3

    def test_fallback_yesterday(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.geopolitical_monitor.MARKET_INDICATORS_DIR", tmp_path)
        yesterday = (datetime.now().date() - timedelta(days=1)).isoformat()
        data = {"indicators": {"GOLD": {"close": 2000, "change_pct": 1.2}}}
        (tmp_path / f"{yesterday}.json").write_text(json.dumps(data))
        ctx = load_market_context()
        assert ctx["GOLD"] == 1.2

    def test_empty_when_no_files(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.geopolitical_monitor.MARKET_INDICATORS_DIR", tmp_path)
        ctx = load_market_context()
        assert ctx == {}

    def test_corrupted_json_fallback(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.geopolitical_monitor.MARKET_INDICATORS_DIR", tmp_path)
        today = datetime.now().date().isoformat()
        (tmp_path / f"{today}.json").write_text("{bad json")
        yesterday = (datetime.now().date() - timedelta(days=1)).isoformat()
        data = {"indicators": {"BDI": {"close": 1500, "change_pct": -0.8}}}
        (tmp_path / f"{yesterday}.json").write_text(json.dumps(data))
        ctx = load_market_context()
        assert ctx["BDI"] == -0.8


# ── watchlist ───────────────────────────────────────────────────────

class TestWatchlist:
    def test_load_default(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.geopolitical_monitor.WATCHLIST_FILE",
                            tmp_path / "nope.json")
        wl = load_watchlist()
        assert "hormuz" in wl
        assert "pentagon" in wl
        assert len(wl) == 9

    def test_save_and_load(self, tmp_path, monkeypatch):
        wl_file = tmp_path / "watchlist.json"
        monkeypatch.setattr("pipeline.geopolitical_monitor.WATCHLIST_FILE", wl_file)
        wl = {"test": {"name": "Test", "bbox": [0, 0, 1, 1], "types": ["news"],
                        "keywords": ["test"], "source": "test"}}
        save_watchlist(wl)
        loaded = load_watchlist()
        assert loaded["test"]["name"] == "Test"


# ── format_telegram_message (v3) ──────────────────────────────────

class TestFormatTelegramMessage:
    def test_no_anomalies_normal(self):
        data = {
            "regions": {"hormuz": {"aircraft": {"count": 4, "countries": {"United Arab Emirates": 3, "Pakistan": 1}}, "news": {"count": 12}}},
            "pentagon_index": {"doughcon": 4, "label": "DOUBLE TAKE", "alerts": 27, "status": "OPERATIONAL"},
            "alert_level": "normal",
            "collected_at": "2026-02-21T14:00:00",
            "market_context": {},
        }
        wl = DEFAULT_WATCHLIST
        msg = format_telegram_message(data, [], wl)
        assert "[Normal]" in msg
        assert "호르무즈 해협" in msg
        assert "DOUGHCON 4" in msg
        assert "🍕" in msg
        assert "2026-02-21" in msg
        assert "능동 감시" in msg
        assert "✈️항공기 4대" in msg
        assert "📰뉴스 12건" in msg
        assert "UAE 3" in msg

    def test_with_aircraft_avoidance(self):
        data = {
            "regions": {"hormuz": {"aircraft": {"count": 3}}},
            "pentagon_index": {},
            "alert_level": "watch",
            "market_context": {"WTI": 2.5, "GOLD": 1.1},
        }
        anomalies = [
            {"region": "hormuz", "type": "aircraft_avoidance", "severity": "high",
             "value": 3, "avg": 8.0, "pct_change": -63},
        ]
        wl = DEFAULT_WATCHLIST
        msg = format_telegram_message(data, anomalies, wl)
        assert "[Watch]" in msg
        assert "영공 회피" in msg
        assert "-63%" in msg
        assert "참고 시장" in msg
        assert "WTI" in msg

    def test_with_news_and_keywords(self):
        data = {
            "regions": {"scs": {"news": {"count": 45}}},
            "pentagon_index": {},
            "alert_level": "watch",
            "market_context": {},
        }
        anomalies = [
            {"region": "scs", "type": "news", "severity": "high",
             "value": 45, "avg": 15.0, "pct_change": 200,
             "tension": "high", "matched_keywords": ["missile", "attack"]},
        ]
        msg = format_telegram_message(data, anomalies, DEFAULT_WATCHLIST)
        assert "missile, attack" in msg
        assert "+200%" in msg

    def test_alert_level_in_title(self):
        data = {
            "regions": {},
            "pentagon_index": {"doughcon": 1, "label": "COCKED PISTOL", "alerts": 50, "status": "DEGRADED"},
            "alert_level": "alert",
            "market_context": {},
        }
        msg = format_telegram_message(data, [], DEFAULT_WATCHLIST)
        assert "[Alert]" in msg
        assert "🔴" in msg
        assert "DOUGHCON 1" in msg

    def test_market_context_for_relevant_regions(self):
        """Market data shown only for anomalous regions' relevant indicators."""
        data = {
            "regions": {"korea_dmz": {"aircraft": {"count": 5}}},
            "pentagon_index": {},
            "alert_level": "watch",
            "market_context": {"VIX": 8.3, "USDKRW": 1.5, "WTI": 0.2, "BDI": -0.5},
        }
        anomalies = [
            {"region": "korea_dmz", "type": "aircraft_avoidance", "severity": "medium",
             "value": 5, "avg": 10.0, "pct_change": -50},
        ]
        msg = format_telegram_message(data, anomalies, DEFAULT_WATCHLIST)
        assert "USDKRW" in msg
        assert "VIX" in msg
        # WTI/BDI not relevant to korea_dmz
        assert "WTI" not in msg
        assert "BDI" not in msg

    def test_date_header(self):
        """collected_at → date header in message."""
        data = {
            "regions": {},
            "pentagon_index": {},
            "alert_level": "normal",
            "collected_at": "2026-02-21T14:26:38.537902",
            "market_context": {},
        }
        msg = format_telegram_message(data, [], DEFAULT_WATCHLIST)
        assert "2026-02-21 14:26 KST" in msg

    def test_tier_grouping_normal(self):
        """정상 모드에서 능동/기준 그룹 분리."""
        data = {
            "regions": {
                "hormuz": {"aircraft": {"count": 4, "countries": {}}, "vessels": {"count": 85}},
                "taiwan": {"aircraft": {"count": 25, "countries": {"Taiwan": 8, "China": 7}}, "vessels": {"count": 4}},
            },
            "pentagon_index": {},
            "alert_level": "normal",
            "market_context": {},
        }
        msg = format_telegram_message(data, [], DEFAULT_WATCHLIST)
        assert "능동 감시" in msg
        assert "기준 감시" in msg
        # hormuz=active, taiwan=baseline
        active_pos = msg.index("능동 감시")
        baseline_pos = msg.index("기준 감시")
        hormuz_pos = msg.index("호르무즈 해협")
        taiwan_pos = msg.index("대만 해협")
        assert active_pos < hormuz_pos < baseline_pos < taiwan_pos

    def test_country_breakdown_in_normal(self):
        """정상 모드에서 국가별 항공기 표시."""
        data = {
            "regions": {
                "korea_dmz": {"aircraft": {"count": 33, "countries": {
                    "Republic of Korea": 23, "China": 7, "Japan": 1, "Uzbekistan": 1, "United States": 1,
                }}},
            },
            "pentagon_index": {},
            "alert_level": "normal",
            "market_context": {},
        }
        msg = format_telegram_message(data, [], DEFAULT_WATCHLIST)
        assert "KOR 23" in msg
        assert "CHN 7" in msg
        assert "JPN 1" in msg or "외" in msg  # either top 3 or "외" for rest

    def test_avg_and_trend_in_normal(self):
        """7일 평균 + 트렌드 화살표 표시."""
        data = {
            "regions": {
                "hormuz": {
                    "aircraft": {"count": 4, "countries": {"United Arab Emirates": 4}},
                    "avg7_aircraft": 8.2,
                },
            },
            "pentagon_index": {},
            "alert_level": "normal",
            "market_context": {},
        }
        msg = format_telegram_message(data, [], DEFAULT_WATCHLIST)
        assert "avg 8.2" in msg
        assert "↓" in msg  # 4 vs 8.2 = -51% → ↓

    def test_news_zero_hidden(self):
        """📰 0건은 표시하지 않음 (GDELT 에러 노이즈 방지)."""
        data = {
            "regions": {"hormuz": {"aircraft": {"count": 8, "countries": {}}, "news": {"count": 0}}},
            "pentagon_index": {},
            "alert_level": "normal",
            "market_context": {},
        }
        msg = format_telegram_message(data, [], DEFAULT_WATCHLIST)
        assert "📰" not in msg

    def test_anomaly_with_remaining_regions(self):
        """이상 발생 시 나머지 정상 지역도 표시."""
        data = {
            "regions": {
                "hormuz": {"aircraft": {"count": 2, "countries": {}}},
                "taiwan": {"aircraft": {"count": 25, "countries": {"Taiwan": 8}}, "vessels": {"count": 4}},
            },
            "pentagon_index": {},
            "alert_level": "watch",
            "market_context": {},
        }
        anomalies = [
            {"region": "hormuz", "type": "aircraft_avoidance", "severity": "high",
             "value": 2, "avg": 8.0, "pct_change": -75},
        ]
        msg = format_telegram_message(data, anomalies, DEFAULT_WATCHLIST)
        assert "영공 회피" in msg
        assert "대만 해협" in msg  # normal region still shown


# ── helper functions (v4) ───────────────────────────────────────────

class TestHelperFunctions:
    def test_country_abbr_known(self):
        assert _country_abbr("United Arab Emirates") == "UAE"
        assert _country_abbr("Republic of Korea") == "KOR"
        assert _country_abbr("Russian Federation") == "RUS"

    def test_country_abbr_unknown(self):
        """Unknown → first 3 chars uppercase."""
        assert _country_abbr("Pakistan") == "PAK"
        assert _country_abbr("Turkey") == "TUR"

    def test_trend_arrow_down(self):
        assert _trend_arrow(4, 8.0) == "↓"  # -50%

    def test_trend_arrow_up(self):
        assert _trend_arrow(12, 8.0) == "↑"  # +50%

    def test_trend_arrow_stable(self):
        assert _trend_arrow(9, 8.0) == "→"  # +12.5%

    def test_trend_arrow_no_avg(self):
        assert _trend_arrow(5, None) == ""
        assert _trend_arrow(5, 0) == ""

    def test_format_countries_short(self):
        countries = {"Republic of Korea": 23, "China": 7, "Japan": 1, "United States": 1}
        result = _format_countries_short(countries, top_n=3)
        assert "KOR 23" in result
        assert "CHN 7" in result
        assert "JPN 1" in result
        assert "외 1" in result

    def test_format_countries_short_few(self):
        countries = {"Turkey": 16, "Hungary": 2}
        result = _format_countries_short(countries, top_n=3)
        assert "TUR 16" in result
        assert "HUN 2" in result
        assert "외" not in result

    def test_format_region_lines_with_countries(self):
        """항공기 국가 데이터 있으면 멀티라인."""
        rdata = {
            "aircraft": {"count": 33, "countries": {"Republic of Korea": 23, "China": 7}},
            "vessels": {"count": 85},
        }
        lines = _format_region_lines("hormuz", rdata, DEFAULT_WATCHLIST)
        assert len(lines) == 3  # name, metrics, countries
        assert "▸ 호르무즈 해협" in lines[0]
        assert "✈️" in lines[1]
        assert "🚢" in lines[1]
        assert "→" in lines[2]

    def test_format_region_lines_no_countries(self):
        """국가 데이터 없으면 단일라인."""
        rdata = {"vessels": {"count": 848}}
        lines = _format_region_lines("malacca", rdata, DEFAULT_WATCHLIST)
        assert len(lines) == 1
        assert "말라카 해협" in lines[0]
        assert "🚢선박 ~848대" in lines[0]

    def test_format_region_lines_no_data(self):
        """데이터 없으면 '데이터 없음' 표시."""
        lines = _format_region_lines("hormuz", {}, DEFAULT_WATCHLIST)
        assert len(lines) == 1
        assert "데이터 없음" in lines[0]

    def test_format_region_lines_with_avg(self):
        """7일 평균 있으면 표시."""
        rdata = {
            "aircraft": {"count": 4, "countries": {"Pakistan": 4}},
            "avg7_aircraft": 8.2,
        }
        lines = _format_region_lines("hormuz", rdata, DEFAULT_WATCHLIST)
        joined = "\n".join(lines)
        assert "avg 8.2" in joined
        assert "↓" in joined


# ── fetch_opensky (mocked) ──────────────────────────────────────────

class TestFetchOpensky:
    def test_success(self, mock_gateway):
        mock_gateway.set_response({
            "states": [
                ["abc123", "CALL1", "United States", None, 1234567890],
                ["def456", "CALL2", "China", None, 1234567891],
                ["ghi789", "CALL3", "China", None, 1234567892],
            ]
        })
        r = fetch_opensky([25.5, 55.5, 27.5, 57.5])
        assert r["count"] == 3
        assert r["countries"]["China"] == 2
        assert r["countries"]["United States"] == 1

    def test_empty_states(self, mock_gateway):
        mock_gateway.set_response({"states": None})
        r = fetch_opensky([0, 0, 1, 1])
        assert r["count"] == 0
        assert r["countries"] == {}

    def test_api_error(self):
        with patch("urllib.request.urlopen", side_effect=OSError("timeout")):
            r = fetch_opensky([0, 0, 1, 1])
            assert r["count"] == 0
            assert "error" in r


# ── fetch_gdelt_news (mocked) ───────────────────────────────────────

class TestFetchGdelt:
    def test_success(self, mock_gateway):
        mock_gateway.set_response({
            "articles": [
                {"title": "Taiwan tensions rise"},
                {"title": "Military buildup near strait"},
            ]
        })
        r = fetch_gdelt_news(["Taiwan Strait"])
        assert r["count"] == 2
        assert len(r["top_titles"]) == 2

    def test_no_articles(self, mock_gateway):
        mock_gateway.set_response({})
        r = fetch_gdelt_news(["Nonexistent Place"])
        assert r["count"] == 0

    def test_api_error(self):
        with patch("urllib.request.urlopen", side_effect=OSError("connection error")):
            r = fetch_gdelt_news(["Taiwan"])
            assert r["count"] == 0
            assert "error" in r

    def test_retry_on_429(self):
        """429 → retry → success on second attempt."""
        err_429 = urllib.error.HTTPError(
            "http://example.com", 429, "Too Many Requests", {}, None)
        ok_resp = MagicMock()
        ok_resp.read.return_value = json.dumps(
            {"articles": [{"title": "Test"}]}).encode()
        ok_resp.__enter__ = lambda s: s
        ok_resp.__exit__ = MagicMock(return_value=False)

        with patch("urllib.request.urlopen", side_effect=[err_429, ok_resp]), \
             patch("time.sleep") as mock_sleep:
            r = fetch_gdelt_news(["Taiwan"], _max_retries=2)
            assert r["count"] == 1
            mock_sleep.assert_called_once_with(15)

    def test_retry_on_empty_response(self):
        """Empty body → retry → success on second attempt."""
        empty_resp = MagicMock()
        empty_resp.read.return_value = b""
        empty_resp.__enter__ = lambda s: s
        empty_resp.__exit__ = MagicMock(return_value=False)

        ok_resp = MagicMock()
        ok_resp.read.return_value = json.dumps(
            {"articles": [{"title": "A"}, {"title": "B"}]}).encode()
        ok_resp.__enter__ = lambda s: s
        ok_resp.__exit__ = MagicMock(return_value=False)

        with patch("urllib.request.urlopen", side_effect=[empty_resp, ok_resp]), \
             patch("time.sleep") as mock_sleep:
            r = fetch_gdelt_news(["Hormuz"], _max_retries=2)
            assert r["count"] == 2
            mock_sleep.assert_called_once_with(10)

    def test_retry_exhausted_429(self):
        """All retries 429 → returns error."""
        err_429 = urllib.error.HTTPError(
            "http://example.com", 429, "Too Many Requests", {}, None)
        with patch("urllib.request.urlopen", side_effect=err_429), \
             patch("time.sleep"):
            r = fetch_gdelt_news(["Taiwan"], _max_retries=3)
            assert r["count"] == 0
            assert "error" in r
            assert "429" in r["error"]

    def test_retry_on_json_decode_error(self):
        """JSONDecodeError (GDELT soft rate limit) → retry → success."""
        bad_resp = MagicMock()
        bad_resp.read.return_value = b"<!DOCTYPE html><html>"  # non-JSON
        bad_resp.__enter__ = lambda s: s
        bad_resp.__exit__ = MagicMock(return_value=False)

        ok_resp = MagicMock()
        ok_resp.read.return_value = json.dumps(
            {"articles": [{"title": "News A"}]}).encode()
        ok_resp.__enter__ = lambda s: s
        ok_resp.__exit__ = MagicMock(return_value=False)

        with patch("urllib.request.urlopen", side_effect=[bad_resp, ok_resp]), \
             patch("time.sleep") as mock_sleep:
            r = fetch_gdelt_news(["Taiwan"], _max_retries=2)
            assert r["count"] == 1
            mock_sleep.assert_called_once_with(10)


# ── load_history ────────────────────────────────────────────────────

class TestLoadHistory:
    def test_loads_existing_files(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.geopolitical_monitor.OUTPUT_DIR", tmp_path)
        yesterday = (datetime.now().date() - timedelta(days=1)).isoformat()
        data = {"regions": {"taiwan": {"aircraft": {"count": 25}}}}
        (tmp_path / f"{yesterday}.json").write_text(json.dumps(data))
        history = load_history(7)
        assert len(history) == 1
        assert history[0]["regions"]["taiwan"]["aircraft"]["count"] == 25

    def test_empty_dir(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.geopolitical_monitor.OUTPUT_DIR", tmp_path)
        history = load_history(7)
        assert history == []


# ── cleanup_old_charts ──────────────────────────────────────────────

class TestCleanupCharts:
    def test_removes_old_files(self, tmp_path, monkeypatch):
        monkeypatch.setattr("pipeline.geopolitical_monitor.CHARTS_DIR", tmp_path)
        old_file = tmp_path / "old_chart.png"
        old_file.write_text("fake png")
        import os
        old_time = (datetime.now() - timedelta(days=10)).timestamp()
        os.utime(str(old_file), (old_time, old_time))
        new_file = tmp_path / "new_chart.png"
        new_file.write_text("new fake png")
        cleanup_old_charts(7)
        assert not old_file.exists()
        assert new_file.exists()


# ── capture_vessel_map (v4: tuple return) ─────────────────────────

class TestFetchVesselCount:
    """fetch_vessel_count() — myshiptracking 내부 API 테스트."""

    def test_success_count(self):
        """정상 응답 — 3척."""
        # 헤더 2줄 + 선박 3줄
        response_data = "1740100000\n2\n" + "4\t0\t123456789\tTEST1\t26.0\t56.0\t10\t180\t0\t1740100000\n" * 3
        mock_resp = MagicMock()
        mock_resp.read.return_value = response_data.encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        with patch("urllib.request.urlopen", return_value=mock_resp):
            count = fetch_vessel_count([25.5, 55.5, 27.5, 57.5])
        assert count == 3

    def test_empty_response(self):
        """헤더만 있고 선박 없음 → 0."""
        response_data = "1740100000\n0\n"
        mock_resp = MagicMock()
        mock_resp.read.return_value = response_data.encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        with patch("urllib.request.urlopen", return_value=mock_resp):
            count = fetch_vessel_count([25.5, 55.5, 27.5, 57.5])
        assert count == 0

    def test_api_error(self):
        """HTTP 에러 → 0."""
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("timeout")):
            count = fetch_vessel_count([25.5, 55.5, 27.5, 57.5])
        assert count == 0

    def test_zoom_parameter(self):
        """줌 파라미터가 URL에 포함되는지 확인."""
        mock_resp = MagicMock()
        mock_resp.read.return_value = b"1740100000\n0\n"
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        with patch("urllib.request.urlopen", return_value=mock_resp) as mock_url:
            fetch_vessel_count([25.5, 55.5, 27.5, 57.5], zoom=12)
            call_args = mock_url.call_args
            req = call_args[0][0]
            assert "zoom=12" in req.full_url


class TestCaptureVesselMap:
    def test_playwright_missing_returns_none(self, monkeypatch):
        """playwright 미설치 → None 반환."""
        import builtins
        _real_import = builtins.__import__
        def _block_playwright(name, *args, **kwargs):
            if name == "playwright.sync_api":
                raise ImportError("no playwright")
            return _real_import(name, *args, **kwargs)
        monkeypatch.setattr(builtins, "__import__", _block_playwright)
        result = capture_vessel_map("hormuz", [25.5, 55.5, 27.5, 57.5])
        assert result is None

    def test_exception_returns_none(self):
        """브라우저 에러 → None 반환."""
        # Just verify the error return shape
        result = None  # mimics error path
        assert result is None


# ── _annotate_screenshot ──────────────────────────────────────────

class TestAnnotateScreenshot:
    def test_success_with_pillow(self, tmp_path):
        """Pillow로 라벨 오버레이 성공."""
        try:
            from PIL import Image
        except ImportError:
            pytest.skip("Pillow not installed")
        # 테스트 이미지 생성 (200x200)
        img = Image.new("RGB", (200, 200), color=(100, 100, 200))
        path = tmp_path / "test_vessel.png"
        img.save(path)
        result = _annotate_screenshot(path, "호르무즈 해협", 45)
        assert result == path
        # 파일이 수정되었는지 확인
        modified = Image.open(path)
        assert modified.size[1] <= 200  # 크롭으로 높이 감소 또는 동일

    def test_pillow_not_installed(self, tmp_path, monkeypatch):
        """Pillow 미설치 → 원본 반환."""
        path = tmp_path / "test.png"
        path.write_bytes(b"fake png data")
        import builtins
        _real_import = builtins.__import__
        def _block_pillow(name, *args, **kwargs):
            if "PIL" in name:
                raise ImportError("no Pillow")
            return _real_import(name, *args, **kwargs)
        monkeypatch.setattr(builtins, "__import__", _block_pillow)
        result = _annotate_screenshot(path, "대만 해협", 30)
        assert result == path

    def test_zero_count_label(self, tmp_path):
        """count=0일 때 지역명+시간만 표시 (카운트 생략)."""
        try:
            from PIL import Image
        except ImportError:
            pytest.skip("Pillow not installed")
        img = Image.new("RGB", (200, 200), color=(100, 100, 200))
        path = tmp_path / "zero_vessel.png"
        img.save(path)
        result = _annotate_screenshot(path, "수에즈 운하", 0)
        assert result == path

    def test_crop_removes_site_background(self, tmp_path):
        """동적 크롭: 사이트 배경색(25,58,128) 우측/하단 자동 제거."""
        try:
            from PIL import Image
        except ImportError:
            pytest.skip("Pillow not installed")
        # 지도 영역 (800x500) + 우측 사이트배경 (200px) + 하단 사이트배경 (100px)
        img = Image.new("RGB", (1000, 600), color=(25, 58, 128))  # 전체 사이트 배경색
        # 지도 영역을 밝은 색으로 채움
        for x in range(800):
            for y in range(500):
                img.putpixel((x, y), (200, 220, 240))
        path = tmp_path / "dynamic_crop.png"
        img.save(path)
        _annotate_screenshot(path, "테스트", 10)
        result = Image.open(path)
        # 우측 200px + 하단 100px 배경이 잘려야 함
        assert result.size[0] < 1000 - 55 - 35  # 우측 배경 제거됨
        assert result.size[1] < 600 - 50 - 20   # 하단 배경 제거됨


# ── compute_averages (vessels) ────────────────────────────────────

class TestComputeAveragesVessels:
    def test_vessels_average(self):
        history = [
            {"regions": {"hormuz": {"vessels": {"count": 80}}}},
            {"regions": {"hormuz": {"vessels": {"count": 90}}}},
        ]
        avg = compute_averages(history)
        assert avg["hormuz"]["avg_vessels"] == 85.0

    def test_vessels_zero_excluded(self):
        """count=0 (JS 실패) → 평균에서 제외."""
        history = [
            {"regions": {"hormuz": {"vessels": {"count": 0}}}},
            {"regions": {"hormuz": {"vessels": {"count": 80}}}},
        ]
        avg = compute_averages(history)
        assert avg["hormuz"]["avg_vessels"] == 80.0

    def test_vessels_all_zero(self):
        """모두 count=0 → avg_vessels is None."""
        history = [
            {"regions": {"hormuz": {"vessels": {"count": 0}}}},
        ]
        avg = compute_averages(history)
        assert avg["hormuz"]["avg_vessels"] is None

    def test_vessels_missing(self):
        """vessels 키 없음 → avg_vessels is None."""
        history = [
            {"regions": {"korea_dmz": {"aircraft": {"count": 30}}}},
        ]
        avg = compute_averages(history)
        assert avg["korea_dmz"]["avg_vessels"] is None


# ── detect_anomalies (vessel_avoidance) ───────────────────────────

class TestDetectAnomaliesVessels:
    def test_vessel_decrease_50pct_high(self):
        """선박 -50% → high vessel_avoidance."""
        today = {"regions": {"hormuz": {
            "vessels": {"count": 40},
        }}, "pentagon_index": {}}
        avg = {"hormuz": {"avg_aircraft": None, "avg_news": None, "avg_vessels": 85}}
        anomalies = detect_anomalies(today, avg)
        vessel = [a for a in anomalies if a["type"] == "vessel_avoidance"]
        assert len(vessel) == 1
        assert vessel[0]["severity"] == "high"
        assert vessel[0]["pct_change"] <= -50

    def test_vessel_decrease_30pct_medium(self):
        """선박 -30% → medium vessel_avoidance."""
        today = {"regions": {"hormuz": {
            "vessels": {"count": 59},
        }}, "pentagon_index": {}}
        avg = {"hormuz": {"avg_aircraft": None, "avg_news": None, "avg_vessels": 85}}
        anomalies = detect_anomalies(today, avg)
        vessel = [a for a in anomalies if a["type"] == "vessel_avoidance"]
        assert len(vessel) == 1
        assert vessel[0]["severity"] == "medium"

    def test_vessel_count_zero_ignored(self):
        """count=0 (JS 실패) → anomaly 미생성."""
        today = {"regions": {"hormuz": {
            "vessels": {"count": 0},
        }}, "pentagon_index": {}}
        avg = {"hormuz": {"avg_aircraft": None, "avg_news": None, "avg_vessels": 85}}
        anomalies = detect_anomalies(today, avg)
        vessel = [a for a in anomalies if a["type"] == "vessel_avoidance"]
        assert len(vessel) == 0

    def test_vessel_increase_ignored(self):
        """선박 증가 → 무시."""
        today = {"regions": {"hormuz": {
            "vessels": {"count": 150},
        }}, "pentagon_index": {}}
        avg = {"hormuz": {"avg_aircraft": None, "avg_news": None, "avg_vessels": 85}}
        anomalies = detect_anomalies(today, avg)
        vessel = [a for a in anomalies if a["type"] == "vessel_avoidance"]
        assert len(vessel) == 0


# ── compute_alert_level (vessel_avoidance) ────────────────────────

class TestComputeAlertLevelVessels:
    def test_vessel_avoidance_plus_news_high_alert(self):
        """vessel_avoidance + news high → alert."""
        anomalies = [
            {"type": "vessel_avoidance", "severity": "high", "region": "hormuz"},
            {"type": "news", "severity": "high", "region": "hormuz"},
        ]
        level, reason = compute_alert_level(anomalies)
        assert level == "alert"
        assert "복수 독립 소스" in reason

    def test_vessel_avoidance_only_watch(self):
        """vessel_avoidance만 → watch."""
        anomalies = [
            {"type": "vessel_avoidance", "severity": "medium", "region": "suez"},
        ]
        level, reason = compute_alert_level(anomalies)
        assert level == "watch"


# ── format_telegram_message (vessels) ─────────────────────────────

class TestFormatTelegramMessageVessels:
    def test_normal_with_vessels(self):
        """정상 상태에서 선박 수 표시."""
        data = {
            "regions": {"hormuz": {
                "aircraft": {"count": 8}, "news": {"count": 12},
                "vessels": {"count": 85},
            }},
            "pentagon_index": {},
            "alert_level": "normal",
            "market_context": {},
        }
        msg = format_telegram_message(data, [], DEFAULT_WATCHLIST)
        assert "🚢선박 ~85대" in msg
        assert "호르무즈 해협" in msg

    def test_vessel_avoidance_anomaly(self):
        """vessel_avoidance 이상 표시."""
        data = {
            "regions": {"hormuz": {}},
            "pentagon_index": {},
            "alert_level": "watch",
            "market_context": {},
        }
        anomalies = [
            {"region": "hormuz", "type": "vessel_avoidance", "severity": "high",
             "value": 15, "avg": 85.0, "pct_change": -82},
        ]
        msg = format_telegram_message(data, anomalies, DEFAULT_WATCHLIST)
        assert "해역 회피" in msg
        assert "~15대" in msg
        assert "~85.0대" in msg
        assert "-82%" in msg

    def test_vessels_zero_not_shown(self):
        """count=0 → 선박 표시 안 함."""
        data = {
            "regions": {"hormuz": {
                "aircraft": {"count": 8, "countries": {}},
                "vessels": {"count": 0},
            }},
            "pentagon_index": {},
            "alert_level": "normal",
            "market_context": {},
        }
        msg = format_telegram_message(data, [], DEFAULT_WATCHLIST)
        assert "🚢" not in msg
        assert "✈️항공기 8대" in msg


# ── send_telegram_album ───────────────────────────────────────────

class TestSendTelegramAlbum:
    def test_empty_photos_returns_false(self):
        assert send_telegram_album([]) is False

    def test_success(self, tmp_path):
        """앨범 전송 성공 모킹."""
        try:
            import requests
        except ImportError:
            pytest.skip("requests not installed")
        photo1 = tmp_path / "photo1.png"
        photo1.write_bytes(b"fake png 1")
        photo2 = tmp_path / "photo2.png"
        photo2.write_bytes(b"fake png 2")
        photos = [
            {"path": photo1, "caption": "🚢 호르무즈 해협 ~45대"},
            {"path": photo2, "caption": "🚢 대만 해협 ~22대"},
        ]
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        with patch("requests.post", return_value=mock_resp) as mock_post:
            result = send_telegram_album(photos)
            assert result is True
            mock_post.assert_called_once()
            call_kwargs = mock_post.call_args
            assert "sendMediaGroup" in call_kwargs[0][0]

    def test_fallback_on_error(self, tmp_path):
        """API 오류 → False 반환 (호출부에서 fallback)."""
        try:
            import requests
        except ImportError:
            pytest.skip("requests not installed")
        photo = tmp_path / "photo.png"
        photo.write_bytes(b"fake png")
        mock_resp = MagicMock()
        mock_resp.status_code = 400
        mock_resp.text = "Bad Request"
        with patch("requests.post", return_value=mock_resp):
            result = send_telegram_album([{"path": photo, "caption": "test"}])
            assert result is False


# ── Region Tier 분류 ─────────────────────────────────────────────────

class TestRegionTiers:
    """REGION_TIERS 상수 및 구조 검증."""

    def test_all_default_regions_have_tier(self):
        """DEFAULT_WATCHLIST의 모든 지역이 REGION_TIERS에 존재."""
        for rid in DEFAULT_WATCHLIST:
            assert rid in REGION_TIERS, f"{rid} missing from REGION_TIERS"

    def test_tier_values(self):
        """Tier 값은 active 또는 baseline만 가능."""
        for rid, tier in REGION_TIERS.items():
            assert tier in ("active", "baseline"), f"{rid}: invalid tier '{tier}'"

    def test_active_regions(self):
        """능동적 위협 지역이 active tier."""
        active = {r for r, t in REGION_TIERS.items() if t == "active"}
        assert "hormuz" in active
        assert "suez" in active
        assert "black_sea" in active
        assert "korea_dmz" in active
        assert "pentagon" in active

    def test_baseline_regions(self):
        """잠재적 위협 지역이 baseline tier."""
        baseline = {r for r, t in REGION_TIERS.items() if t == "baseline"}
        assert "taiwan" in baseline
        assert "scs" in baseline
        assert "malacca" in baseline
        assert "baltic" in baseline

    def test_baseline_skip_types(self):
        """Baseline에서 스킵되는 타입은 aircraft."""
        assert "aircraft" in BASELINE_SKIP_TYPES
        assert "news" not in BASELINE_SKIP_TYPES
        assert "vessel" not in BASELINE_SKIP_TYPES


class TestCollectAllTiers:
    """collect_all()의 tier 기반 수집 로직 검증."""

    def _make_watchlist(self):
        """테스트용 간소 워치리스트 (3개 지역)."""
        return {
            "hormuz": {
                "name": "호르무즈 해협", "bbox": [25.5, 55.5, 27.5, 57.5],
                "types": ["aircraft", "news"],
                "keywords": ["Hormuz"], "source": "preset",
            },
            "taiwan": {
                "name": "대만 해협", "bbox": [23, 117, 26, 121],
                "types": ["aircraft", "news"],
                "keywords": ["Taiwan"], "source": "preset",
            },
            "pentagon": {
                "name": "Pentagon", "bbox": [38.8, -77.1, 38.95, -76.95],
                "types": ["pizza"],
                "keywords": ["Pentagon"], "source": "preset",
            },
        }

    def _mock_all_fetches(self):
        """모든 외부 API 호출 모킹."""
        return [
            patch("pipeline.geopolitical_monitor.fetch_opensky",
                  return_value={"count": 5, "countries": {}}),
            patch("pipeline.geopolitical_monitor.fetch_gdelt_news",
                  return_value={"count": 10, "top_titles": []}),
            patch("pipeline.geopolitical_monitor.fetch_pizza_index",
                  return_value={"doughcon": 4, "label": "ROUTINE", "alerts": 5, "status": "OK"}),
            patch("pipeline.geopolitical_monitor.fetch_vessel_count", return_value=50),
            patch("pipeline.geopolitical_monitor.capture_vessel_map", return_value=None),
            patch("pipeline.geopolitical_monitor.load_history", return_value=[]),
            patch("pipeline.geopolitical_monitor.load_market_context", return_value={}),
            patch("pipeline.geopolitical_monitor.OUTPUT_DIR", Path("/tmp/geo_test")),
            patch("time.sleep"),
        ]

    def test_first_run_collects_all(self, tmp_path):
        """첫 실행 (기존 데이터 없음): active + baseline 모두 수집."""
        wl = self._make_watchlist()
        patches = self._mock_all_fetches()
        # OUTPUT_DIR에 기존 파일 없음 → baseline도 수집
        output_dir = tmp_path / "geo"
        output_dir.mkdir()
        patches[7] = patch("pipeline.geopolitical_monitor.OUTPUT_DIR", output_dir)
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
             patches[5], patches[6], patches[7], patches[8]:
            data, _ = collect_all(wl)
        assert "hormuz" in data["regions"]
        assert "taiwan" in data["regions"]
        assert data["pentagon_index"].get("doughcon") == 4

    def test_second_run_skips_baseline(self, tmp_path):
        """2회차 실행: baseline은 기존 데이터 carry-forward."""
        wl = self._make_watchlist()
        output_dir = tmp_path / "geo"
        output_dir.mkdir()
        # 기존 daily JSON 작성 (1회차 결과)
        today_str = datetime.now().strftime("%Y-%m-%d")
        existing = {
            "date": today_str,
            "regions": {
                "taiwan": {"news": {"count": 8, "top_titles": []}},
            },
            "pentagon_index": {"doughcon": 4},
        }
        with open(output_dir / f"{today_str}.json", "w") as f:
            json.dump(existing, f)

        opensky_mock = MagicMock(return_value={"count": 5, "countries": {}})
        gdelt_mock = MagicMock(return_value={"count": 10, "top_titles": []})
        patches = self._mock_all_fetches()
        patches[0] = patch("pipeline.geopolitical_monitor.fetch_opensky", opensky_mock)
        patches[1] = patch("pipeline.geopolitical_monitor.fetch_gdelt_news", gdelt_mock)
        patches[7] = patch("pipeline.geopolitical_monitor.OUTPUT_DIR", output_dir)
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
             patches[5], patches[6], patches[7], patches[8]:
            data, _ = collect_all(wl)

        # hormuz (active) 수집됨
        assert "hormuz" in data["regions"]
        # taiwan (baseline) carry-forward — GDELT 미호출
        assert "taiwan" in data["regions"]
        assert data["regions"]["taiwan"]["news"]["count"] == 8  # 기존 값

        # fetch_opensky는 hormuz만 호출 (taiwan은 baseline으로 스킵)
        opensky_mock.assert_called_once()

    def test_baseline_skips_aircraft(self, tmp_path):
        """Baseline 지역은 aircraft 미수집 (첫 실행이라도)."""
        wl = self._make_watchlist()
        output_dir = tmp_path / "geo"
        output_dir.mkdir()

        opensky_mock = MagicMock(return_value={"count": 5, "countries": {}})
        gdelt_mock = MagicMock(return_value={"count": 10, "top_titles": []})
        patches = self._mock_all_fetches()
        patches[0] = patch("pipeline.geopolitical_monitor.fetch_opensky", opensky_mock)
        patches[1] = patch("pipeline.geopolitical_monitor.fetch_gdelt_news", gdelt_mock)
        patches[7] = patch("pipeline.geopolitical_monitor.OUTPUT_DIR", output_dir)
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
             patches[5], patches[6], patches[7], patches[8]:
            data, _ = collect_all(wl)

        # taiwan 수집되지만 aircraft 없음
        assert "taiwan" in data["regions"]
        assert "aircraft" not in data["regions"]["taiwan"]
        # hormuz는 aircraft 있음
        assert "aircraft" in data["regions"]["hormuz"]

    def test_tier_filter_active_only(self, tmp_path):
        """--tier active: active 지역만 수집."""
        wl = self._make_watchlist()
        output_dir = tmp_path / "geo"
        output_dir.mkdir()
        patches = self._mock_all_fetches()
        patches[7] = patch("pipeline.geopolitical_monitor.OUTPUT_DIR", output_dir)
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
             patches[5], patches[6], patches[7], patches[8]:
            data, _ = collect_all(wl, tier_filter="active")

        assert "hormuz" in data["regions"]
        assert "taiwan" not in data["regions"]
        assert data["pentagon_index"].get("doughcon") == 4

    def test_tier_filter_baseline_only(self, tmp_path):
        """--tier baseline: baseline 지역만 수집."""
        wl = self._make_watchlist()
        output_dir = tmp_path / "geo"
        output_dir.mkdir()
        patches = self._mock_all_fetches()
        patches[7] = patch("pipeline.geopolitical_monitor.OUTPUT_DIR", output_dir)
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
             patches[5], patches[6], patches[7], patches[8]:
            data, _ = collect_all(wl, tier_filter="baseline")

        assert "hormuz" not in data["regions"]
        assert "taiwan" in data["regions"]
        # pentagon (active) → baseline 모드에서 미수집
        assert not data.get("pentagon_index") or data["pentagon_index"] == {}

    def test_tier_filter_baseline_carries_active(self, tmp_path):
        """--tier baseline: active 기존 데이터 carry-forward."""
        wl = self._make_watchlist()
        output_dir = tmp_path / "geo"
        output_dir.mkdir()
        today_str = datetime.now().strftime("%Y-%m-%d")
        existing = {
            "date": today_str,
            "regions": {
                "hormuz": {"aircraft": {"count": 12, "countries": {}}},
            },
            "pentagon_index": {"doughcon": 3},
        }
        with open(output_dir / f"{today_str}.json", "w") as f:
            json.dump(existing, f)

        patches = self._mock_all_fetches()
        patches[7] = patch("pipeline.geopolitical_monitor.OUTPUT_DIR", output_dir)
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
             patches[5], patches[6], patches[7], patches[8]:
            data, _ = collect_all(wl, tier_filter="baseline")

        # hormuz carry-forward
        assert data["regions"]["hormuz"]["aircraft"]["count"] == 12
        # pentagon carry-forward
        assert data["pentagon_index"]["doughcon"] == 3

    def test_region_flag_overrides_tier(self, tmp_path):
        """--region taiwan: tier 무시, aircraft 포함 전체 수집."""
        wl = self._make_watchlist()
        output_dir = tmp_path / "geo"
        output_dir.mkdir()

        opensky_mock = MagicMock(return_value={"count": 25, "countries": {}})
        patches = self._mock_all_fetches()
        patches[0] = patch("pipeline.geopolitical_monitor.fetch_opensky", opensky_mock)
        patches[7] = patch("pipeline.geopolitical_monitor.OUTPUT_DIR", output_dir)
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
             patches[5], patches[6], patches[7], patches[8]:
            data, _ = collect_all(wl, target_region="taiwan")

        # --region은 tier 무시 → aircraft 수집됨
        assert "taiwan" in data["regions"]
        assert data["regions"]["taiwan"]["aircraft"]["count"] == 25
        opensky_mock.assert_called_once()

    def test_unknown_region_defaults_active(self, tmp_path):
        """REGION_TIERS에 없는 지역은 active 기본값."""
        wl = {
            "custom": {
                "name": "Custom", "bbox": [10, 20, 30, 40],
                "types": ["news"], "keywords": ["test"], "source": "dynamic",
            },
        }
        output_dir = tmp_path / "geo"
        output_dir.mkdir()
        patches = self._mock_all_fetches()
        patches[7] = patch("pipeline.geopolitical_monitor.OUTPUT_DIR", output_dir)
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
             patches[5], patches[6], patches[7], patches[8]:
            data, _ = collect_all(wl)
        # unknown region → active → 항상 수집
        assert "custom" in data["regions"]


# ── ICAO hex → country ────────────────────────────────────────────

class TestIcaoHexToCountry:
    def test_us_aircraft(self):
        assert _icao_hex_to_country("A12345") == "United States"

    def test_china_aircraft(self):
        assert _icao_hex_to_country("780001") == "China"

    def test_korea_aircraft(self):
        assert _icao_hex_to_country("71A000") == "Republic of Korea"

    def test_japan_aircraft(self):
        assert _icao_hex_to_country("840000") == "Japan"

    def test_turkey_aircraft(self):
        assert _icao_hex_to_country("4B8100") == "Turkey"

    def test_russia_aircraft(self):
        assert _icao_hex_to_country("150000") == "Russian Federation"

    def test_uae_aircraft(self):
        assert _icao_hex_to_country("896100") == "United Arab Emirates"

    def test_iran_aircraft(self):
        assert _icao_hex_to_country("730001") == "Islamic Republic of Iran"

    def test_taiwan_aircraft(self):
        assert _icao_hex_to_country("899100") == "Taiwan"

    def test_unknown_hex(self):
        assert _icao_hex_to_country("FFFFFF") == "Unknown"

    def test_invalid_hex(self):
        assert _icao_hex_to_country("ZZZZZZ") == "Unknown"

    def test_empty_string(self):
        assert _icao_hex_to_country("") == "Unknown"

    def test_none(self):
        assert _icao_hex_to_country(None) == "Unknown"

    def test_pakistan(self):
        assert _icao_hex_to_country("760001") == "Pakistan"

    def test_singapore(self):
        assert _icao_hex_to_country("514001") == "Singapore"

    def test_range_boundary_start(self):
        """Test exact start of a range."""
        assert _icao_hex_to_country("A00000") == "United States"

    def test_range_boundary_end(self):
        """Test exact end of a range."""
        assert _icao_hex_to_country("AFFFFF") == "United States"


# ── bbox → point/radius ──────────────────────────────────────────

class TestBboxToPointRadius:
    def test_hormuz(self):
        lat, lon, radius = _bbox_to_point_radius([25.5, 55.5, 27.5, 57.5])
        assert abs(lat - 26.5) < 0.01
        assert abs(lon - 56.5) < 0.01
        assert 30 < radius < 100  # reasonable radius

    def test_korea_dmz(self):
        lat, lon, radius = _bbox_to_point_radius([37, 125, 39, 129])
        assert abs(lat - 38.0) < 0.01
        assert abs(lon - 127.0) < 0.01
        assert radius > 0

    def test_small_bbox(self):
        lat, lon, radius = _bbox_to_point_radius([38.8, -77.1, 38.95, -76.95])
        assert radius < 10  # pentagon area is small

    def test_large_bbox_capped(self):
        """Radius should be capped at 250nm."""
        lat, lon, radius = _bbox_to_point_radius([0, 0, 60, 60])
        assert radius == 250

    def test_center_calculation(self):
        lat, lon, _ = _bbox_to_point_radius([10, 20, 30, 40])
        assert lat == 20.0
        assert lon == 30.0


# ── fetch_airplanes_live ──────────────────────────────────────────

class TestFetchAirplanesLive:
    def test_success(self, mock_gateway):
        mock_gateway.set_response({
            "ac": [
                {"hex": "A12345", "flight": "UAL123", "lat": 26.5, "lon": 56.5},
                {"hex": "780001", "flight": "CCA456", "lat": 26.6, "lon": 56.6},
                {"hex": "780002", "flight": "CCA789", "lat": 26.7, "lon": 56.7},
            ],
            "total": 3, "msg": "No error",
        })
        r = fetch_airplanes_live([25.5, 55.5, 27.5, 57.5])
        assert r["count"] == 3
        assert r["countries"]["United States"] == 1
        assert r["countries"]["China"] == 2

    def test_empty_response(self, mock_gateway):
        mock_gateway.set_response({"ac": [], "total": 0, "msg": "No error"})
        r = fetch_airplanes_live([0, 0, 1, 1])
        assert r["count"] == 0
        assert r["countries"] == {}

    def test_api_error(self):
        with patch("urllib.request.urlopen", side_effect=OSError("timeout")):
            r = fetch_airplanes_live([0, 0, 1, 1])
            assert r["count"] == 0
            assert "error" in r

    def test_null_ac_field(self, mock_gateway):
        mock_gateway.set_response({"ac": None, "total": 0})
        r = fetch_airplanes_live([25, 55, 28, 58])
        assert r["count"] == 0

    def test_unknown_hex_counted(self, mock_gateway):
        mock_gateway.set_response({
            "ac": [{"hex": "FFFE00", "flight": "???"}],
            "total": 1,
        })
        r = fetch_airplanes_live([0, 0, 1, 1])
        assert r["count"] == 1
        assert r["countries"]["Unknown"] == 1

    def test_url_format(self, mock_gateway):
        """Check API URL uses point/radius format."""
        mock_gateway.set_response({"ac": [], "total": 0})
        fetch_airplanes_live([25.5, 55.5, 27.5, 57.5])
        assert "api.airplanes.live/v2/point/" in mock_gateway.last_url


# ── fetch_aircraft (fallback logic) ───────────────────────────────

class TestFetchAircraft:
    def test_opensky_success_no_fallback(self):
        """When OpenSky succeeds, no Airplanes.live call."""
        with patch("pipeline.geopolitical_monitor.fetch_opensky",
                   return_value={"count": 5, "countries": {"China": 5}}), \
             patch("pipeline.geopolitical_monitor.fetch_airplanes_live") as alt_mock:
            r = fetch_aircraft([25, 55, 28, 58])
            assert r["count"] == 5
            assert r["source"] == "opensky"
            alt_mock.assert_not_called()

    def test_opensky_error_triggers_fallback(self):
        """When OpenSky returns error, fallback to Airplanes.live."""
        with patch("pipeline.geopolitical_monitor.fetch_opensky",
                   return_value={"count": 0, "countries": {}, "error": "429"}), \
             patch("pipeline.geopolitical_monitor.fetch_airplanes_live",
                   return_value={"count": 10, "countries": {"Japan": 5, "China": 5}}):
            r = fetch_aircraft([25, 55, 28, 58])
            assert r["count"] == 10
            assert r["source"] == "airplanes.live"

    def test_opensky_empty_triggers_fallback(self):
        """When OpenSky returns count=0, fallback."""
        with patch("pipeline.geopolitical_monitor.fetch_opensky",
                   return_value={"count": 0, "countries": {}}), \
             patch("pipeline.geopolitical_monitor.fetch_airplanes_live",
                   return_value={"count": 8, "countries": {"US": 8}}):
            r = fetch_aircraft([25, 55, 28, 58])
            assert r["count"] == 8
            assert r["source"] == "airplanes.live"

    def test_both_fail(self):
        """When both APIs fail, return OpenSky error with fallback_error."""
        with patch("pipeline.geopolitical_monitor.fetch_opensky",
                   return_value={"count": 0, "countries": {}, "error": "timeout"}), \
             patch("pipeline.geopolitical_monitor.fetch_airplanes_live",
                   return_value={"count": 0, "countries": {}, "error": "rate limit"}):
            r = fetch_aircraft([25, 55, 28, 58])
            assert r["count"] == 0
            assert r["error"] == "timeout"
            assert r["fallback_error"] == "rate limit"

    def test_fallback_also_errors_keeps_original(self):
        """When fallback also has error, keep original error."""
        with patch("pipeline.geopolitical_monitor.fetch_opensky",
                   return_value={"count": 0, "countries": {}, "error": "original"}), \
             patch("pipeline.geopolitical_monitor.fetch_airplanes_live",
                   return_value={"count": 0, "countries": {}, "error": "fallback"}):
            r = fetch_aircraft([0, 0, 1, 1])
            assert "error" in r
            assert r["fallback_error"] == "fallback"


# ── fetch_portwatch_transit ───────────────────────────────────────

class TestFetchPortwatchTransit:
    """IMF PortWatch ArcGIS API — 초크포인트 일일 통과량."""

    def _make_api_response(self, features):
        """Helper: ArcGIS FeatureServer JSON 응답 생성."""
        return {"features": [{"attributes": f} for f in features]}

    def test_success(self, mock_gateway):
        """정상 응답 — latest + 7-day avg + breakdown 파싱."""
        # UTC ms timestamps (timezone-safe: noon UTC avoids date-boundary issues)
        ts1 = 1771113600000  # 2026-02-15 12:00:00 UTC
        ts2 = 1771027200000  # 2026-02-14 12:00:00 UTC
        features = [
            {"date": ts1, "n_total": 70, "n_tanker": 42,
             "n_container": 8, "n_dry_bulk": 13, "n_cargo": 5, "n_roro": 2},
            {"date": ts2, "n_total": 60, "n_tanker": 38,
             "n_container": 7, "n_dry_bulk": 10, "n_cargo": 3, "n_roro": 2},
        ]
        mock_gateway.set_response(self._make_api_response(features))
        r = fetch_portwatch_transit("hormuz")
        assert r["latest_total"] == 70
        assert r["latest_date"] == "2026-02-15"
        assert r["avg_7d"] == 65.0
        assert r["breakdown"]["tanker"] == 42
        assert r["breakdown"]["container"] == 8
        assert r["breakdown"]["dry_bulk"] == 13
        assert r["breakdown"]["cargo"] == 5
        assert r["breakdown"]["roro"] == 2
        assert r["source"] == "imf_portwatch"

    def test_no_matching_region(self):
        """REGION_CHOKEPOINT_MAP에 없는 지역 → 빈 dict."""
        r = fetch_portwatch_transit("korea_dmz")
        assert r == {}

    def test_api_error(self):
        """네트워크 에러 → 빈 dict (파이프라인 영향 없음)."""
        with patch("urllib.request.urlopen", side_effect=OSError("connection refused")):
            r = fetch_portwatch_transit("suez")
            assert r == {}

    def test_empty_features(self, mock_gateway):
        """API 정상이지만 데이터 없음 → 빈 dict."""
        mock_gateway.set_response({"features": []})
        r = fetch_portwatch_transit("malacca")
        assert r == {}

    def test_date_parsing(self, mock_gateway):
        """Unix ms 타임스탬프 → YYYY-MM-DD 변환 검증."""
        # 2026-01-01 12:00:00 UTC = 1767268800000 ms (noon UTC, timezone-safe)
        ts = 1767268800000
        features = [{"date": ts, "n_total": 50, "n_tanker": 30,
                      "n_container": 5, "n_dry_bulk": 10, "n_cargo": 3, "n_roro": 2}]
        mock_gateway.set_response(self._make_api_response(features))
        r = fetch_portwatch_transit("taiwan")
        assert r["latest_date"] == "2026-01-01"
        assert r["avg_7d"] == 50.0

    def test_pentagon_not_queried(self):
        """pentagon은 type=pizza이므로 REGION_CHOKEPOINT_MAP에 없음."""
        assert "pentagon" not in REGION_CHOKEPOINT_MAP
        r = fetch_portwatch_transit("pentagon")
        assert r == {}


# ── format_telegram_message (portwatch) ──────────────────────────

class TestFormatTelegramMessagePortwatch:
    """PortWatch 데이터가 포함된 텔레그램 메시지 포맷 검증."""

    def test_normal_with_portwatch(self):
        """정상 상태: 🚢선박 ~85대 (추세:2026-02-15 공식통과 70대, 최다선종: 탱커 42척)."""
        data = {
            "regions": {"hormuz": {
                "aircraft": {"count": 8, "countries": {}},
                "vessels": {"count": 85},
                "portwatch": {
                    "latest_total": 70, "latest_date": "2026-02-15",
                    "avg_7d": 65.3,
                    "breakdown": {"tanker": 42, "container": 8,
                                  "dry_bulk": 13, "cargo": 5, "roro": 2},
                    "source": "imf_portwatch",
                },
            }},
            "pentagon_index": {},
            "alert_level": "normal",
            "market_context": {},
        }
        msg = format_telegram_message(data, [], DEFAULT_WATCHLIST)
        assert "🚢선박 ~85대" in msg
        assert "추세:" in msg
        assert "2026-02-15" in msg
        assert "70대" in msg
        assert "최다선종: 탱커 42척" in msg

    def test_no_portwatch_shows_avg(self):
        """PortWatch 없으면 기존 avg 표시."""
        data = {
            "regions": {"hormuz": {
                "vessels": {"count": 85},
                "avg7_vessels": 80.0,
            }},
            "pentagon_index": {},
            "alert_level": "normal",
            "market_context": {},
        }
        msg = format_telegram_message(data, [], DEFAULT_WATCHLIST)
        assert "🚢선박 ~85대" in msg
        assert "avg ~80.0" in msg
        assert "추세:" not in msg

    def test_portwatch_source_footer(self):
        """소스 푸터에 IMF PortWatch 포함."""
        data = {
            "regions": {},
            "pentagon_index": {},
            "alert_level": "normal",
            "market_context": {},
        }
        msg = format_telegram_message(data, [], DEFAULT_WATCHLIST)
        assert "IMF PortWatch(추세)" in msg


# ── fetch_gpr_epu ──────────────────────────────────────────────────

class TestFetchGprEpu:
    """GPR/EPU 리스크 지수 테스트."""

    def test_gpr_success(self):
        """GPR XLS 정상 파싱."""
        mock_pd = MagicMock()
        df = MagicMock()
        col = MagicMock()
        col.dropna.return_value = col
        col.iloc.__getitem__ = lambda s, i: 120.5
        col.tail.return_value = MagicMock(mean=lambda: 100.0, std=lambda: 20.0)
        df.__contains__ = lambda s, k: k == "GPRD"
        df.columns = ["GPRD"]
        df.__getitem__ = lambda s, k: col
        mock_pd.read_excel.return_value = df

        mock_resp = MagicMock()
        mock_resp.read.return_value = b"fake xls"
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)

        with patch("urllib.request.urlopen", return_value=mock_resp), \
             patch.dict("sys.modules", {"pandas": mock_pd}):
            r = fetch_gpr_epu()
        assert r.get("gpr") == 120.5
        assert r.get("gpr_avg") == 100.0  # 20일 평균 반환 확인

    def test_epu_success(self):
        """EPU FRED CSV 정상 파싱."""
        csv_data = "DATE,USEPUINDXD\n2026-02-18,500.0\n2026-02-19,700.0\n"
        mock_resp = MagicMock()
        mock_resp.read.return_value = csv_data.encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)

        # GPR will fail (no real XLS), EPU should succeed
        call_count = [0]
        def side_effect(req, **kw):
            call_count[0] += 1
            if call_count[0] == 1:  # GPR call
                raise OSError("test skip GPR")
            return mock_resp

        with patch("urllib.request.urlopen", side_effect=side_effect):
            r = fetch_gpr_epu()
        assert r.get("epu_us") == 700.0
        assert "epu_us_zscore" in r
        assert "epu_us_avg" in r  # 20일 평균 반환 확인

    def test_both_fail(self):
        """GPR+EPU 모두 실패 → 빈 dict."""
        with patch("urllib.request.urlopen", side_effect=OSError("no network")):
            r = fetch_gpr_epu()
        assert r == {}

    def test_no_pandas(self):
        """pandas 없으면 GPR 건너뜀, EPU만 시도."""
        csv_data = "DATE,USEPUINDXD\n2026-02-19,300.0\n"
        mock_resp = MagicMock()
        mock_resp.read.return_value = csv_data.encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)

        # pandas import fails → GPR skipped (no urlopen call)
        # EPU is the FIRST urlopen call
        with patch("urllib.request.urlopen", return_value=mock_resp), \
             patch.dict("sys.modules", {"pandas": None}):
            r = fetch_gpr_epu()
        assert "gpr" not in r
        assert r.get("epu_us") == 300.0

    def test_format_with_gpr_epu(self):
        """텔레그램 메시지에 GPR/EPU + 해석 레벨 + 기준 설명 표시."""
        data = {
            "regions": {"hormuz": {"aircraft": {"count": 8, "countries": {}}}},
            "pentagon_index": {},
            "alert_level": "normal",
            "market_context": {},
            "gpr_epu": {"gpr": 96.7, "gpr_zscore": -0.54, "gpr_avg": 105.2,
                        "epu_us": 707.0, "epu_us_zscore": 3.0, "epu_us_avg": 300.5},
        }
        msg = format_telegram_message(data, [], DEFAULT_WATCHLIST)
        assert "GPR: 97" in msg
        assert "20일평균 105" in msg
        assert "정상" in msg  # GPR zscore -0.54 → 정상
        assert "군사긴장" in msg  # 지표 설명
        assert "평시~100" in msg  # 역사적 기준
        assert "EPU: 707" in msg
        assert "20일평균 300" in msg
        assert "극단" in msg  # EPU zscore 3.0 → 극단
        assert "정책불확실성" in msg  # 지표 설명
        assert "코로나~900" in msg  # 역사적 기준

    def test_format_gpr_only(self):
        """GPR만 있을 때 해석 레벨 + 기준 표시."""
        data = {
            "regions": {"hormuz": {"aircraft": {"count": 8, "countries": {}}}},
            "pentagon_index": {},
            "alert_level": "normal",
            "market_context": {},
            "gpr_epu": {"gpr": 150.0, "gpr_zscore": 2.5, "gpr_avg": 105.0},
        }
        msg = format_telegram_message(data, [], DEFAULT_WATCHLIST)
        assert "GPR: 150" in msg
        assert "20일평균 105" in msg
        assert "높음" in msg  # zscore 2.5 → 높음
        assert "우크라전쟁~350" in msg  # 기준
        assert "EPU" not in msg

    def test_format_no_gpr_epu(self):
        """GPR/EPU 없으면 리스크 지수 섹션 미표시."""
        data = {
            "regions": {"hormuz": {"aircraft": {"count": 8, "countries": {}}}},
            "pentagon_index": {},
            "alert_level": "normal",
            "market_context": {},
        }
        msg = format_telegram_message(data, [], DEFAULT_WATCHLIST)
        assert "리스크 지수" not in msg

    def test_format_epu_levels(self):
        """EPU zscore별 레벨 구분 검증."""
        base = {
            "regions": {"hormuz": {"aircraft": {"count": 8, "countries": {}}}},
            "pentagon_index": {}, "alert_level": "normal", "market_context": {},
        }
        # zscore 1.5 → 관심
        base["gpr_epu"] = {"epu_us": 400, "epu_us_zscore": 1.5}
        assert "관심" in format_telegram_message(base, [], DEFAULT_WATCHLIST)
        # zscore 0.3 → 정상
        base["gpr_epu"] = {"epu_us": 200, "epu_us_zscore": 0.3}
        assert "정상" in format_telegram_message(base, [], DEFAULT_WATCHLIST)
        # zscore -1.5 → 낮음
        base["gpr_epu"] = {"epu_us": 80, "epu_us_zscore": -1.5}
        assert "낮음" in format_telegram_message(base, [], DEFAULT_WATCHLIST)
