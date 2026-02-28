"""Tests for vault_flow_health.py — 볼트 v3 흐름 헬스체크."""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

import pipeline.vault_flow_health as vfh


# ── Helpers ────────────────────────────────────────────────────────

def _make_vault(tmp_path):
    """Create a mock vault structure under tmp_path and return the root."""
    vault = tmp_path / "knowledge"
    (vault / "100 캡처" / "110 수신함").mkdir(parents=True)
    (vault / "200 정리").mkdir(parents=True)
    (vault / "300 연결").mkdir(parents=True)
    (vault / "400 판단").mkdir(parents=True)
    (vault / "700 활동").mkdir(parents=True)
    (vault / "800 운영").mkdir(parents=True)
    (vault / "900 시스템").mkdir(parents=True)
    return vault


def _build_v3_map(vault):
    """Return a _V3_MAP dict pointing to tmp_path vault."""
    return {
        "캡처":   vault / "100 캡처" / "110 수신함",
        "정리":   vault / "200 정리",
        "연결":   vault / "300 연결",
        "판단":   vault / "400 판단",
        "활동":   vault / "700 활동",
        "운영":   vault / "800 운영",
        "시스템": vault / "900 시스템",
    }


def _create_md_files(directory, count):
    """Create N .md files in a directory."""
    directory.mkdir(parents=True, exist_ok=True)
    for i in range(count):
        (directory / f"note_{i}.md").write_text(f"# Note {i}")


# ── Tests: count_stage_notes ──────────────────────────────────────

class TestCountStageNotes:
    def test_basic_counts(self, tmp_path):
        vault = _make_vault(tmp_path)
        _create_md_files(vault / "100 캡처" / "110 수신함", 5)
        _create_md_files(vault / "200 정리", 10)
        _create_md_files(vault / "200 정리" / "210 원자노트", 3)
        _create_md_files(vault / "300 연결", 4)
        _create_md_files(vault / "400 판단", 15)
        _create_md_files(vault / "800 운영", 2)

        v3_map = _build_v3_map(vault)
        counts = vfh.count_stage_notes(v3_map=v3_map)

        assert counts["캡처"] == 5
        assert counts["정리"] == 13  # 10 + 3 in subdir
        assert counts["연결"] == 4
        assert counts["판단"] == 15
        assert counts["운영"] == 2
        assert counts["활동"] == 0
        assert counts["시스템"] == 0

    def test_excludes_archives_and_obsidian(self, tmp_path):
        vault = _make_vault(tmp_path)
        _create_md_files(vault / "200 정리", 5)
        _create_md_files(vault / "200 정리" / "archives", 10)
        _create_md_files(vault / "200 정리" / ".obsidian", 3)

        v3_map = _build_v3_map(vault)
        counts = vfh.count_stage_notes(v3_map=v3_map)
        assert counts["정리"] == 5

    def test_nonexistent_stage_dir(self, tmp_path):
        vault = tmp_path / "knowledge"
        v3_map = {"캡처": vault / "100 캡처" / "110 수신함"}
        counts = vfh.count_stage_notes(v3_map=v3_map)
        assert counts["캡처"] == 0


# ── Tests: detect_funnel_health ───────────────────────────────────

class TestFunnelHealth:
    def test_healthy(self):
        counts = {"정리": 200, "연결": 30, "판단": 20}
        is_healthy, msg = vfh.detect_funnel_health(counts)
        assert is_healthy is True
        assert msg == "정상"

    def test_equal_counts(self):
        counts = {"정리": 100, "연결": 100, "판단": 100}
        is_healthy, msg = vfh.detect_funnel_health(counts)
        assert is_healthy is True

    def test_inverted(self):
        counts = {"정리": 50, "연결": 20, "판단": 200}
        is_healthy, msg = vfh.detect_funnel_health(counts)
        assert is_healthy is False
        assert "역전" in msg
        assert "400 > 300" in msg

    def test_multiple_inversions(self):
        counts = {"정리": 10, "연결": 20, "판단": 100}
        is_healthy, msg = vfh.detect_funnel_health(counts)
        assert is_healthy is False
        assert "300 > 200" in msg
        assert "400 > 300" in msg


# ── Tests: detect_bottleneck ──────────────────────────────────────

class TestDetectBottleneck:
    def test_bottleneck_detected(self, tmp_path):
        vault = _make_vault(tmp_path)
        _create_md_files(vault / "400 판단" / "541 지식관리", 180)
        _create_md_files(vault / "400 판단" / "542 프레임워크", 63)

        v3_map = _build_v3_map(vault)
        counts = {"정리": 50, "판단": 243}
        result = vfh.detect_bottleneck(counts, v3_map=v3_map)

        assert result is not None
        assert "400 판단 비대" in result
        assert "541 지식관리" in result
        assert "180건" in result

    def test_no_bottleneck(self):
        counts = {"정리": 200, "판단": 50}
        result = vfh.detect_bottleneck(counts)
        assert result is None

    def test_equal_no_bottleneck(self):
        counts = {"정리": 100, "판단": 100}
        result = vfh.detect_bottleneck(counts)
        assert result is None


# ── Tests: count_inbox_stale ──────────────────────────────────────

class TestInboxStale:
    def test_stale_files(self, tmp_path):
        vault = _make_vault(tmp_path)
        inbox = vault / "100 캡처" / "110 수신함"
        old_time = time.time() - (8 * 86400)
        for i in range(3):
            f = inbox / f"old_{i}.md"
            f.write_text("old")
            os.utime(f, (old_time, old_time))
        for i in range(2):
            (inbox / f"new_{i}.md").write_text("new")

        stale = vfh.count_inbox_stale(days=7, inbox=inbox)
        assert stale == 3

    def test_empty_inbox(self, tmp_path):
        vault = _make_vault(tmp_path)
        inbox = vault / "100 캡처" / "110 수신함"
        stale = vfh.count_inbox_stale(days=7, inbox=inbox)
        assert stale == 0

    def test_nonexistent_inbox(self, tmp_path):
        fake = tmp_path / "nonexistent"
        stale = vfh.count_inbox_stale(days=7, inbox=fake)
        assert stale == 0


# ── Tests: format_report ──────────────────────────────────────────

class TestFormatReport:
    def test_basic_format(self):
        counts = {
            "캡처": 36, "정리": 209, "연결": 79,
            "판단": 250, "활동": 10, "운영": 15, "시스템": 5,
        }
        delta = {
            "캡처": 3, "정리": -1, "연결": 0,
            "판단": 1, "활동": 0, "운영": 0, "시스템": 0,
        }
        report = vfh.format_report(counts, delta, "정상", None, 5)

        assert "볼트 흐름 헬스체크" in report
        assert "100 캡처" in report
        assert "200 정리" in report
        assert "400 판단" in report
        assert "+3" in report
        assert "-1" in report
        assert "정상" in report
        assert "5건 미처리" in report

    def test_with_bottleneck(self):
        counts = {"캡처": 0, "정리": 50, "연결": 5,
                  "판단": 200, "활동": 0, "운영": 0, "시스템": 0}
        delta = {s: 0 for s in counts}
        report = vfh.format_report(
            counts, delta, "역전 (400 > 300)", "400 판단 비대 (541 지식관리 180건)", 0
        )
        assert "역전" in report
        assert "병목" in report
        assert "541 지식관리" in report

    def test_no_stale_no_bottleneck(self):
        counts = {s: 10 for s in vfh.COUNT_STAGES}
        delta = {s: 0 for s in counts}
        report = vfh.format_report(counts, delta, "정상", None, 0)
        assert "미처리" not in report
        assert "병목" not in report


# ── Tests: compute_delta ──────────────────────────────────────────

class TestStateDelta:
    def test_with_previous(self):
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        state = {yesterday: {"캡처": 30, "정리": 200, "연결": 30}}
        current = {"캡처": 36, "정리": 199, "연결": 32}
        delta = vfh.compute_delta(current, state)
        assert delta["캡처"] == 6
        assert delta["정리"] == -1
        assert delta["연결"] == 2

    def test_no_previous(self):
        current = {"캡처": 36, "정리": 200}
        delta = vfh.compute_delta(current, {})
        assert delta["캡처"] == 0
        assert delta["정리"] == 0


# ── Tests: state management ───────────────────────────────────────

class TestStateManagement:
    def test_load_empty(self, tmp_path):
        state_file = tmp_path / "state.json"
        state = vfh.load_state(state_file=state_file)
        assert state == {}

    def test_load_existing(self, tmp_path):
        state_file = tmp_path / "state.json"
        data = {"2026-02-25": {"캡처": 30}}
        state_file.write_text(json.dumps(data))
        state = vfh.load_state(state_file=state_file)
        assert state == data

    def test_load_corrupt(self, tmp_path):
        state_file = tmp_path / "state.json"
        state_file.write_text("not json")
        state = vfh.load_state(state_file=state_file)
        assert state == {}

    def test_save(self, tmp_path):
        state_dir = tmp_path / "vault-flow-health"
        state_file = state_dir / "state.json"
        state = {}
        vfh.save_state(state, {"캡처": 36, "정리": 200},
                       state_dir=state_dir, state_file=state_file)

        assert state_file.exists()
        saved = json.loads(state_file.read_text())
        today = datetime.now().strftime("%Y-%m-%d")
        assert today in saved
        assert saved[today]["캡처"] == 36

    def test_pruning(self, tmp_path):
        """30일 초과 항목이 정리되는지 확인."""
        state_dir = tmp_path / "vault-flow-health"
        state_file = state_dir / "state.json"
        old_date = (datetime.now() - timedelta(days=40)).strftime("%Y-%m-%d")
        recent_date = (datetime.now() - timedelta(days=5)).strftime("%Y-%m-%d")
        state = {old_date: {"캡처": 10}, recent_date: {"캡처": 30}}
        vfh.save_state(state, {"캡처": 36},
                       state_dir=state_dir, state_file=state_file)

        saved = json.loads(state_file.read_text())
        assert old_date not in saved
        assert recent_date in saved
        today = datetime.now().strftime("%Y-%m-%d")
        assert today in saved


# ── Tests: CLI modes ──────────────────────────────────────────────

# ── Tests: _parse_wikilinks ──────────────────────────────────────

class TestParseWikilinks:
    def test_simple_link(self):
        links = vfh._parse_wikilinks("See [[My Note]] for details")
        assert "My Note" in links

    def test_aliased_link(self):
        links = vfh._parse_wikilinks("See [[My Note|alias text]] for details")
        assert "My Note" in links
        assert "alias text" not in links

    def test_multiple_links(self):
        links = vfh._parse_wikilinks("[[A]] and [[B|b]] and [[C]]")
        assert links == {"A", "B", "C"}

    def test_no_links(self):
        links = vfh._parse_wikilinks("No wikilinks here")
        assert links == set()

    def test_strips_whitespace(self):
        links = vfh._parse_wikilinks("[[ spaced ]]")
        assert "spaced" in links


# ── Tests: detect_orphan_notes ──────────────────────────────────

class TestDetectOrphanNotes:
    def test_no_orphans(self, tmp_path):
        """모든 노트가 다른 노트에서 링크되면 고아 없음."""
        vault = _make_vault(tmp_path)
        (vault / "200 정리" / "alpha.md").write_text("# Alpha\n[[beta]]")
        (vault / "200 정리" / "beta.md").write_text("# Beta\n[[alpha]]")

        count, total, names = vfh.detect_orphan_notes(vault_root=vault)
        assert count == 0
        assert total == 2
        assert names == []

    def test_orphan_detected(self, tmp_path):
        """링크되지 않은 노트는 고아로 감지."""
        vault = _make_vault(tmp_path)
        (vault / "200 정리" / "alpha.md").write_text("# Alpha\n[[beta]]")
        (vault / "200 정리" / "beta.md").write_text("# Beta")
        (vault / "200 정리" / "orphan.md").write_text("# Orphan note")

        count, total, names = vfh.detect_orphan_notes(vault_root=vault)
        assert count == 2  # beta and orphan not linked from anyone
        assert total == 3
        assert "orphan" in names

    def test_excludes_index_files(self, tmp_path):
        """INDEX 파일은 고아 감지 대상에서 제외."""
        vault = _make_vault(tmp_path)
        (vault / "200 정리" / "real.md").write_text("# Real")
        (vault / "200 정리" / "200 INDEX.md").write_text("# Index")

        count, total, names = vfh.detect_orphan_notes(vault_root=vault)
        # INDEX excluded from total count, real is orphan
        assert total == 1
        assert count == 1
        assert "200 INDEX" not in names

    def test_excludes_moc_files(self, tmp_path):
        """MOC 파일은 고아 감지 대상에서 제외."""
        vault = _make_vault(tmp_path)
        (vault / "300 연결" / "MOC-test.md").write_text("# MOC\n[[note]]")
        (vault / "300 연결" / "MOC something.md").write_text("# MOC 2")
        (vault / "200 정리" / "note.md").write_text("# Note")

        count, total, names = vfh.detect_orphan_notes(vault_root=vault)
        # MOC files excluded from orphan checking
        assert "MOC-test" not in names
        assert "MOC something" not in names

    def test_excludes_system_dir(self, tmp_path):
        """900 시스템/ 내 파일은 고아 감지 대상에서 제외."""
        vault = _make_vault(tmp_path)
        (vault / "900 시스템" / "config.md").write_text("# Config")
        (vault / "200 정리" / "note.md").write_text("# Note")

        count, total, names = vfh.detect_orphan_notes(vault_root=vault)
        assert "config" not in names
        # total should only count non-excluded files
        assert total == 1

    def test_excludes_archives(self, tmp_path):
        """archives/ 내 파일은 고아 감지에 포함되지 않음."""
        vault = _make_vault(tmp_path)
        (vault / "200 정리" / "archives").mkdir(parents=True)
        (vault / "200 정리" / "archives" / "old.md").write_text("# Old")
        (vault / "200 정리" / "note.md").write_text("# Note\n[[old]]")

        count, total, names = vfh.detect_orphan_notes(vault_root=vault)
        assert "old" not in names

    def test_top10_sorted(self, tmp_path):
        """고아 목록은 이름순 정렬, 최대 10개 반환."""
        vault = _make_vault(tmp_path)
        for i in range(15):
            (vault / "200 정리" / f"orphan_{i:02d}.md").write_text(f"# {i}")

        count, total, names = vfh.detect_orphan_notes(vault_root=vault)
        assert count == 15
        assert len(names) == 10
        assert names == sorted(names)

    def test_nonexistent_vault(self, tmp_path):
        """존재하지 않는 볼트 루트에서는 (0, 0, []) 반환."""
        fake = tmp_path / "nonexistent"
        count, total, names = vfh.detect_orphan_notes(vault_root=fake)
        assert count == 0
        assert total == 0
        assert names == []

    def test_wikilink_with_alias_counts(self, tmp_path):
        """별칭 있는 wikilink도 타겟으로 정확히 인식."""
        vault = _make_vault(tmp_path)
        (vault / "200 정리" / "linker.md").write_text("[[target|display text]]")
        (vault / "200 정리" / "target.md").write_text("# Target")

        count, total, names = vfh.detect_orphan_notes(vault_root=vault)
        assert "target" not in names  # target is linked


# ── Tests: check_moc_freshness ──────────────────────────────────

class TestCheckMocFreshness:
    def test_fresh_moc(self, tmp_path):
        """MOC가 링크된 파일보다 최신이면 stale 아님."""
        vault = _make_vault(tmp_path)
        note = vault / "200 정리" / "note.md"
        note.write_text("# Note")
        # Set note to 10 days ago
        old_time = time.time() - (10 * 86400)
        os.utime(note, (old_time, old_time))

        moc = vault / "300 연결" / "MOC-test.md"
        moc.write_text("# MOC\n[[note]]")
        # MOC is current (default)

        stale = vfh.check_moc_freshness(vault_root=vault, days=7)
        assert stale == []

    def test_stale_moc(self, tmp_path):
        """MOC가 링크된 파일보다 7일+ 오래되면 stale."""
        vault = _make_vault(tmp_path)
        note = vault / "200 정리" / "note.md"
        note.write_text("# Note")
        # Note is current (default)

        moc = vault / "300 연결" / "MOC-test.md"
        moc.write_text("# MOC\n[[note]]")
        # Set MOC to 10 days ago
        old_time = time.time() - (10 * 86400)
        os.utime(moc, (old_time, old_time))

        stale = vfh.check_moc_freshness(vault_root=vault, days=7)
        assert "MOC-test" in stale

    def test_moc_no_links(self, tmp_path):
        """링크 없는 MOC는 stale로 판별하지 않음."""
        vault = _make_vault(tmp_path)
        moc = vault / "300 연결" / "MOC-empty.md"
        moc.write_text("# Empty MOC\nNo links here")
        old_time = time.time() - (30 * 86400)
        os.utime(moc, (old_time, old_time))

        stale = vfh.check_moc_freshness(vault_root=vault, days=7)
        assert stale == []

    def test_zk_type_structure(self, tmp_path):
        """zk_type: structure인 파일도 MOC로 인식."""
        vault = _make_vault(tmp_path)
        note = vault / "200 정리" / "topic.md"
        note.write_text("# Topic")

        structure_note = vault / "300 연결" / "structure_note.md"
        structure_note.write_text('---\nzk_type: "structure"\n---\n# Structure\n[[topic]]')
        old_time = time.time() - (10 * 86400)
        os.utime(structure_note, (old_time, old_time))

        stale = vfh.check_moc_freshness(vault_root=vault, days=7)
        assert "structure_note" in stale

    def test_nonexistent_connect_dir(self, tmp_path):
        """300 연결/ 디렉토리 없으면 빈 리스트 반환."""
        vault = tmp_path / "empty_vault"
        vault.mkdir()
        stale = vfh.check_moc_freshness(vault_root=vault, days=7)
        assert stale == []

    def test_custom_days(self, tmp_path):
        """days 파라미터 조정 테스트."""
        vault = _make_vault(tmp_path)
        note = vault / "200 정리" / "note.md"
        note.write_text("# Note")

        moc = vault / "300 연결" / "MOC-test.md"
        moc.write_text("# MOC\n[[note]]")
        # Set MOC to 3 days ago
        old_time = time.time() - (3 * 86400)
        os.utime(moc, (old_time, old_time))

        # days=7: not stale (3 days < 7 days threshold)
        stale7 = vfh.check_moc_freshness(vault_root=vault, days=7)
        assert stale7 == []

        # days=2: stale (3 days > 2 days threshold)
        stale2 = vfh.check_moc_freshness(vault_root=vault, days=2)
        assert "MOC-test" in stale2

    def test_sorted_output(self, tmp_path):
        """결과 리스트는 이름순 정렬."""
        vault = _make_vault(tmp_path)
        note = vault / "200 정리" / "note.md"
        note.write_text("# Note")

        old_time = time.time() - (10 * 86400)
        for name in ["MOC-zebra", "MOC-alpha", "MOC-mid"]:
            moc = vault / "300 연결" / f"{name}.md"
            moc.write_text("# MOC\n[[note]]")
            os.utime(moc, (old_time, old_time))

        stale = vfh.check_moc_freshness(vault_root=vault, days=7)
        assert stale == sorted(stale)


# ── Tests: format_report with orphan/MOC ────────────────────────

class TestFormatReportOrphanMoc:
    def _base_args(self):
        counts = {s: 10 for s in vfh.COUNT_STAGES}
        delta = {s: 0 for s in counts}
        return counts, delta, "정상", None, 0

    def test_orphan_in_report(self):
        counts, delta, funnel, bn, stale = self._base_args()
        report = vfh.format_report(
            counts, delta, funnel, bn, stale,
            orphan_count=50, orphan_total=500,
        )
        assert "고아 노트: 50개 / 500 (10%)" in report
        # 10% < 20%, no warning
        assert "\u26a0\ufe0f" not in report.split("고아")[0] + report.split("고아")[1]

    def test_orphan_warning_above_20pct(self):
        counts, delta, funnel, bn, stale = self._base_args()
        report = vfh.format_report(
            counts, delta, funnel, bn, stale,
            orphan_count=250, orphan_total=500,
        )
        assert "고아 노트: 250개 / 500 (50%)" in report
        # Should have warning icon before orphan line
        for line in report.split("\n"):
            if "고아 노트" in line:
                assert line.startswith("\u26a0\ufe0f")

    def test_orphan_zero_total(self):
        counts, delta, funnel, bn, stale = self._base_args()
        report = vfh.format_report(
            counts, delta, funnel, bn, stale,
            orphan_count=0, orphan_total=0,
        )
        assert "고아 노트" not in report

    def test_stale_mocs_in_report(self):
        counts, delta, funnel, bn, stale = self._base_args()
        report = vfh.format_report(
            counts, delta, funnel, bn, stale,
            stale_mocs=["MOC-alpha", "MOC-beta"],
        )
        assert "MOC 갱신 필요: 2개" in report
        assert "MOC-alpha" in report
        assert "MOC-beta" in report

    def test_stale_mocs_truncated(self):
        counts, delta, funnel, bn, stale = self._base_args()
        mocs = [f"MOC-{i}" for i in range(8)]
        report = vfh.format_report(
            counts, delta, funnel, bn, stale,
            stale_mocs=mocs,
        )
        assert "MOC 갱신 필요: 8개" in report
        assert "외 3개" in report

    def test_no_stale_mocs(self):
        counts, delta, funnel, bn, stale = self._base_args()
        report = vfh.format_report(
            counts, delta, funnel, bn, stale,
            stale_mocs=[],
        )
        assert "MOC 갱신" not in report


# ── Tests: CLI modes ──────────────────────────────────────────────

class TestDryRun:
    def test_no_send(self, tmp_path, capsys):
        vault = _make_vault(tmp_path)
        _create_md_files(vault / "200 정리", 10)
        v3_map = _build_v3_map(vault)
        inbox = vault / "100 캡처" / "110 수신함"
        state_dir = tmp_path / "state"
        state_file = state_dir / "state.json"

        with patch.object(vfh, "DEFAULT_V3_MAP", v3_map), \
             patch.object(vfh, "DEFAULT_INBOX", inbox), \
             patch.object(vfh, "STATE_DIR", state_dir), \
             patch.object(vfh, "STATE_FILE", state_file), \
             patch.object(vfh, "VAULT", vault), \
             patch("sys.argv", ["vault_flow_health.py", "--dry-run"]), \
             patch.object(vfh, "_send_telegram_text") as mock_send:
            vfh.main()

        mock_send.assert_not_called()
        captured = capsys.readouterr()
        assert "볼트 흐름 헬스체크" in captured.out


class TestJsonOutput:
    def test_json(self, tmp_path, capsys):
        vault = _make_vault(tmp_path)
        _create_md_files(vault / "200 정리", 10)
        _create_md_files(vault / "300 연결", 5)
        v3_map = _build_v3_map(vault)
        inbox = vault / "100 캡처" / "110 수신함"
        state_dir = tmp_path / "state"
        state_file = state_dir / "state.json"

        with patch.object(vfh, "DEFAULT_V3_MAP", v3_map), \
             patch.object(vfh, "DEFAULT_INBOX", inbox), \
             patch.object(vfh, "STATE_DIR", state_dir), \
             patch.object(vfh, "STATE_FILE", state_file), \
             patch.object(vfh, "VAULT", vault), \
             patch("sys.argv", ["vault_flow_health.py", "--json"]):
            vfh.main()

        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert "counts" in data
        assert "delta" in data
        assert "funnel_healthy" in data
        assert "bottleneck" in data
        assert "inbox_stale" in data
        assert data["counts"]["정리"] == 10
        assert data["counts"]["연결"] == 5
        # New fields
        assert "orphan_count" in data
        assert "orphan_total" in data
        assert "orphan_ratio" in data
        assert "orphan_top10" in data
        assert "stale_mocs" in data
        assert isinstance(data["orphan_top10"], list)
        assert isinstance(data["stale_mocs"], list)
