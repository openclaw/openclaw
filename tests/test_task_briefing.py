"""Tests for pipeline/task_briefing.py — 통합 할일 관리 브리핑."""

import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Ensure workspace scripts are importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))


# ── Fixtures ──

@pytest.fixture
def todo_db(tmp_path):
    """Create a temp DB with ops_todos + bus_commands tables."""
    db_path = tmp_path / "ops_multiagent.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE ops_todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            detail TEXT,
            workflow_id TEXT,
            status TEXT DEFAULT 'todo'
                CHECK(status IN ('todo','doing','done','blocked','cancelled')),
            assigned_to TEXT,
            priority TEXT DEFAULT 'normal'
                CHECK(priority IN ('low','normal','high','urgent')),
            antfarm_run_id TEXT,
            source TEXT DEFAULT NULL,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            started_at TEXT,
            completed_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE bus_commands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            body TEXT,
            requested_by TEXT NOT NULL DEFAULT 'harry',
            target_agent TEXT NOT NULL DEFAULT 'all',
            status TEXT NOT NULL DEFAULT 'queued'
                CHECK(status IN ('queued','claimed','done','failed','cancelled')),
            priority TEXT NOT NULL DEFAULT 'normal',
            claimed_by TEXT,
            result_note TEXT,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            claimed_at TEXT,
            completed_at TEXT
        )
    """)
    conn.commit()
    conn.close()
    return db_path


@pytest.fixture
def briefing_module(todo_db):
    """Import task_briefing with patched OPS_DB."""
    with patch.dict("sys.modules", {}):
        import importlib
        import pipeline.task_briefing as tb
        importlib.reload(tb)
        tb.OPS_DB = todo_db
        # Disable _ensure_source_column since test DB already has it
        tb._ensure_source_column = lambda: None
        return tb


def _seed_todos(db_path, items):
    """Insert test todos."""
    conn = sqlite3.connect(str(db_path))
    for item in items:
        conn.execute(
            """INSERT INTO ops_todos(title, status, priority, source, created_at, completed_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                item.get("title", "test"),
                item.get("status", "todo"),
                item.get("priority", "normal"),
                item.get("source"),
                item.get("created_at", datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
                item.get("completed_at"),
            ),
        )
    conn.commit()
    conn.close()


def _seed_bus_commands(db_path, items):
    """Insert test bus commands."""
    conn = sqlite3.connect(str(db_path))
    for item in items:
        conn.execute(
            """INSERT INTO bus_commands(title, target_agent, status, created_at)
               VALUES (?, ?, ?, ?)""",
            (
                item.get("title", "cmd"),
                item.get("target_agent", "ron"),
                item.get("status", "done"),
                item.get("created_at", datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
            ),
        )
    conn.commit()
    conn.close()


# ══════════════════════════════════════════════
# P0: Core fetch + briefing format + DM
# ══════════════════════════════════════════════

class TestFetchPendingTodos:
    def test_returns_pending_sorted_by_priority(self, briefing_module, todo_db):
        _seed_todos(todo_db, [
            {"title": "낮은 우선순위", "priority": "low"},
            {"title": "급한 일", "priority": "urgent"},
            {"title": "보통 일", "priority": "normal"},
        ])
        result = briefing_module.fetch_pending_todos()
        assert len(result) == 3
        assert result[0]["title"] == "급한 일"
        assert result[1]["title"] == "보통 일"
        assert result[2]["title"] == "낮은 우선순위"

    def test_excludes_done_and_cancelled(self, briefing_module, todo_db):
        _seed_todos(todo_db, [
            {"title": "대기중", "status": "todo"},
            {"title": "완료됨", "status": "done"},
            {"title": "취소됨", "status": "cancelled"},
            {"title": "진행중", "status": "doing"},
        ])
        result = briefing_module.fetch_pending_todos()
        titles = [r["title"] for r in result]
        assert "대기중" in titles
        assert "진행중" in titles
        assert "완료됨" not in titles
        assert "취소됨" not in titles

    def test_empty_db(self, briefing_module, todo_db):
        result = briefing_module.fetch_pending_todos()
        assert result == []


class TestFetchCompletedToday:
    def test_returns_today_completed(self, briefing_module, todo_db):
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")
        _seed_todos(todo_db, [
            {"title": "오늘 완료", "status": "done", "completed_at": now},
            {"title": "어제 완료", "status": "done", "completed_at": yesterday},
            {"title": "미완료", "status": "todo"},
        ])
        result = briefing_module.fetch_completed_today()
        assert len(result) == 1
        assert result[0]["title"] == "오늘 완료"

    def test_includes_cancelled_today(self, briefing_module, todo_db):
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        _seed_todos(todo_db, [
            {"title": "취소됨", "status": "cancelled", "completed_at": now},
        ])
        result = briefing_module.fetch_completed_today()
        assert len(result) == 1


class TestFetchAgentActivity:
    def test_groups_by_agent_and_status(self, briefing_module, todo_db):
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        _seed_bus_commands(todo_db, [
            {"target_agent": "ron", "status": "done", "created_at": now},
            {"target_agent": "ron", "status": "done", "created_at": now},
            {"target_agent": "codex", "status": "failed", "created_at": now},
        ])
        result = briefing_module.fetch_agent_activity_summary(hours=24)
        assert len(result) == 2
        ron_done = [r for r in result if r["agent"] == "ron" and r["status"] == "done"]
        assert ron_done[0]["cnt"] == 2


class TestBriefingFormat:
    def test_morning_briefing_with_todos(self, briefing_module, todo_db):
        _seed_todos(todo_db, [
            {"title": "테스트 할일", "priority": "high", "source": "telegram"},
        ])
        text = briefing_module.build_morning_briefing()
        assert "아침 브리핑" in text
        assert "테스트 할일" in text
        assert "[telegram]" in text

    def test_morning_briefing_empty(self, briefing_module, todo_db):
        text = briefing_module.build_morning_briefing()
        assert "미완료 할일 없음" in text

    def test_evening_briefing_with_completed(self, briefing_module, todo_db):
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        _seed_todos(todo_db, [
            {"title": "완료한 작업", "status": "done", "completed_at": now},
        ])
        text = briefing_module.build_evening_briefing()
        assert "저녁 브리핑" in text
        assert "완료한 작업" in text

    def test_on_demand_briefing(self, briefing_module, todo_db):
        _seed_todos(todo_db, [
            {"title": "대기 작업", "priority": "urgent"},
        ])
        text = briefing_module.build_on_demand_briefing()
        assert "할일 현황" in text
        assert "대기 작업" in text


class TestSendDM:
    def test_dry_run_skips_send(self, briefing_module):
        result = briefing_module.send_dm("test", dry_run=True)
        assert result is True

    @patch("pipeline.task_briefing.urllib.request.urlopen")
    def test_send_success(self, mock_urlopen, briefing_module):
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp
        result = briefing_module.send_dm("test")
        assert result is True

    @patch("pipeline.task_briefing.urllib.request.urlopen")
    def test_send_falls_back_to_plain(self, mock_urlopen, briefing_module):
        # First call fails (HTML), second succeeds (plain)
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.side_effect = [Exception("HTML parse error"), mock_resp]
        result = briefing_module.send_dm("<b>test</b>")
        assert result is True


# ══════════════════════════════════════════════
# P1: Ron handler CRUD + keyword tests
# ══════════════════════════════════════════════

class TestAddTodo:
    def test_add_returns_id(self, briefing_module, todo_db):
        new_id = briefing_module.add_todo("테스트 할일", priority="high", source="telegram")
        assert isinstance(new_id, int)
        assert new_id >= 1
        # Verify in DB
        conn = sqlite3.connect(str(todo_db))
        row = conn.execute("SELECT * FROM ops_todos WHERE id=?", (new_id,)).fetchone()
        conn.close()
        assert row is not None

    def test_add_with_source(self, briefing_module, todo_db):
        new_id = briefing_module.add_todo("소스 테스트", source="claude")
        conn = sqlite3.connect(str(todo_db))
        conn.row_factory = sqlite3.Row
        row = dict(conn.execute("SELECT * FROM ops_todos WHERE id=?", (new_id,)).fetchone())
        conn.close()
        assert row["source"] == "claude"


class TestCompleteTodo:
    def test_complete_success(self, briefing_module, todo_db):
        _seed_todos(todo_db, [{"title": "완료할 일"}])
        ok = briefing_module.complete_todo(1)
        assert ok is True
        conn = sqlite3.connect(str(todo_db))
        conn.row_factory = sqlite3.Row
        row = dict(conn.execute("SELECT * FROM ops_todos WHERE id=1").fetchone())
        conn.close()
        assert row["status"] == "done"
        assert row["completed_at"] is not None

    def test_complete_already_done(self, briefing_module, todo_db):
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        _seed_todos(todo_db, [{"title": "이미 완료", "status": "done", "completed_at": now}])
        ok = briefing_module.complete_todo(1)
        assert ok is False

    def test_complete_nonexistent(self, briefing_module, todo_db):
        ok = briefing_module.complete_todo(999)
        assert ok is False


class TestCancelTodo:
    def test_cancel_success(self, briefing_module, todo_db):
        _seed_todos(todo_db, [{"title": "취소할 일"}])
        ok = briefing_module.cancel_todo(1)
        assert ok is True
        conn = sqlite3.connect(str(todo_db))
        conn.row_factory = sqlite3.Row
        row = dict(conn.execute("SELECT * FROM ops_todos WHERE id=1").fetchone())
        conn.close()
        assert row["status"] == "cancelled"


class TestKeywordNoConflict:
    """할일 키워드가 기존 Ron 키워드와 충돌하지 않음을 확인."""
    def test_no_overlap_with_existing(self):
        todo_keywords = ["할일 추가", "할일 등록", "할일 확인", "할일 목록",
                         "할일 브리핑", "할일 완료", "할일 삭제", "할일 취소"]
        existing_keywords = [
            "구조 인지", "전체 구조", "structure brief", "아키텍처 브리프",
            "run-cycle", "지식 순환", "헬스", "health check",
            "obsidian", "vault 동기화", "진화 메트릭",
            "인사이트", "가설", "오늘의 인사이트", "인사이트 품질",
            "연구", "research", "크론", "cron", "스케줄",
        ]
        for tk in todo_keywords:
            for ek in existing_keywords:
                assert tk not in ek and ek not in tk, f"Keyword conflict: '{tk}' vs '{ek}'"


class TestPriorityParsing:
    """우선순위 태그 파싱 엣지케이스."""
    def test_urgent_tag(self, briefing_module, todo_db):
        new_id = briefing_module.add_todo("긴급 작업", priority="urgent")
        conn = sqlite3.connect(str(todo_db))
        conn.row_factory = sqlite3.Row
        row = dict(conn.execute("SELECT * FROM ops_todos WHERE id=?", (new_id,)).fetchone())
        conn.close()
        assert row["priority"] == "urgent"

    def test_default_priority(self, briefing_module, todo_db):
        new_id = briefing_module.add_todo("보통 작업")
        conn = sqlite3.connect(str(todo_db))
        conn.row_factory = sqlite3.Row
        row = dict(conn.execute("SELECT * FROM ops_todos WHERE id=?", (new_id,)).fetchone())
        conn.close()
        assert row["priority"] == "normal"


# ══════════════════════════════════════════════
# P2: Edge cases
# ══════════════════════════════════════════════

class TestEmptyListHandling:
    def test_morning_empty_produces_valid_output(self, briefing_module, todo_db):
        text = briefing_module.build_morning_briefing()
        assert len(text) > 0
        assert "아침 브리핑" in text

    def test_evening_empty_produces_valid_output(self, briefing_module, todo_db):
        text = briefing_module.build_evening_briefing()
        assert len(text) > 0


class TestSchemaIdempotency:
    def test_ensure_source_column_idempotent(self, todo_db):
        """ALTER TABLE twice does not crash."""
        import pipeline.task_briefing as tb
        tb.OPS_DB = todo_db
        # Call twice — should not raise
        tb._ensure_source_column()
        tb._ensure_source_column()


class TestAgentActivityEmpty:
    def test_no_commands(self, briefing_module, todo_db):
        result = briefing_module.fetch_agent_activity_summary(hours=24)
        assert result == []

    def test_old_commands_excluded(self, briefing_module, todo_db):
        old_time = (datetime.now() - timedelta(hours=48)).strftime("%Y-%m-%d %H:%M:%S")
        _seed_bus_commands(todo_db, [
            {"target_agent": "ron", "status": "done", "created_at": old_time},
        ])
        result = briefing_module.fetch_agent_activity_summary(hours=24)
        assert result == []
