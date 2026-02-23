"""
conftest.py — Shared pytest fixtures for OpenClaw test suite.

Fixtures:
- tmp_db: temporary SQLite DB with ops_multiagent schema
- mock_gateway: patches urllib to mock Gateway HTTP responses
- tmp_workspace: temporary workspace directory tree
- mock_telegram: patches urllib to mock Telegram API responses
"""
import json
import sqlite3
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# sys.path: make scripts/ importable for all tests
# ---------------------------------------------------------------------------
WORKSPACE_DIR = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = str(WORKSPACE_DIR / "scripts")
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)


# ---------------------------------------------------------------------------
# tmp_db — temporary SQLite DB with ops_multiagent schema
# ---------------------------------------------------------------------------
_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS bus_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT,
    requested_by TEXT NOT NULL DEFAULT 'harry',
    target_agent TEXT NOT NULL DEFAULT 'all',
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued','claimed','done','failed','cancelled')),
    priority TEXT NOT NULL DEFAULT 'normal'
        CHECK(priority IN ('low','normal','high','urgent')),
    claimed_by TEXT,
    result_note TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    claimed_at TEXT,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bus_commands_status
    ON bus_commands(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_bus_commands_target
    ON bus_commands(target_agent, status, updated_at);

CREATE TABLE IF NOT EXISTS bus_commands_archive (
    id INTEGER PRIMARY KEY,
    title TEXT, body TEXT,
    requested_by TEXT, target_agent TEXT,
    status TEXT, priority TEXT,
    claimed_by TEXT, result_note TEXT,
    created_at TEXT, updated_at TEXT,
    claimed_at TEXT, completed_at TEXT,
    archived_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_archive_archived_at
    ON bus_commands_archive(archived_at);
CREATE INDEX IF NOT EXISTS idx_archive_status_target
    ON bus_commands_archive(status, target_agent);

CREATE TABLE IF NOT EXISTS ops_agent_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    memory_type TEXT NOT NULL
        CHECK(memory_type IN ('insight','pattern','strategy','preference','lesson')),
    content TEXT NOT NULL,
    confidence REAL DEFAULT 0.60 CHECK(confidence >= 0.55),
    source_event_id INTEGER,
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_memory_agent ON ops_agent_memory(agent);
CREATE INDEX IF NOT EXISTS idx_memory_type_created
    ON ops_agent_memory(memory_type, created_at);

CREATE TABLE IF NOT EXISTS ops_todos (
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
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    started_at TEXT,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_kpi_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    agent TEXT NOT NULL,
    autonomy INTEGER DEFAULT 0,
    value_creation INTEGER DEFAULT 0,
    organic_connection INTEGER DEFAULT 0,
    expanded_thinking INTEGER DEFAULT 0,
    minimal_intervention INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    delta INTEGER DEFAULT 0,
    raw_data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(date, agent)
);
"""


@pytest.fixture
def tmp_db(tmp_path):
    """Temporary SQLite DB with full ops_multiagent schema.

    Returns the path (str) to the database file.
    The DB is created in WAL mode with a 5-second busy timeout.
    """
    db_path = str(tmp_path / "test_ops.db")
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.executescript(_SCHEMA_SQL)
    conn.commit()
    conn.close()
    return db_path


# ---------------------------------------------------------------------------
# mock_gateway — mock Gateway HTTP responses
# ---------------------------------------------------------------------------
class _MockHTTPResponse:
    """Minimal HTTPResponse-like object for mocking urllib."""

    def __init__(self, data, status=200):
        self._data = json.dumps(data).encode() if isinstance(data, (dict, list)) else data
        self.status = status
        self.code = status

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


@pytest.fixture
def mock_gateway():
    """Patch urllib.request.urlopen to return controlled Gateway responses.

    Usage:
        def test_something(mock_gateway):
            mock_gateway.set_response({"reply": "hello"})
            # code that calls urllib.request.urlopen(...)
            mock_gateway.set_response({"error": "fail"}, status=500)
    """

    class GatewayMock:
        def __init__(self):
            self._response = _MockHTTPResponse({"reply": "default"})
            self._calls = []

        def set_response(self, data, status=200):
            self._response = _MockHTTPResponse(data, status)

        def _urlopen(self, req, *args, **kwargs):
            url = req if isinstance(req, str) else req.full_url
            self._calls.append(url)
            return self._response

        @property
        def call_count(self):
            return len(self._calls)

        @property
        def last_url(self):
            return self._calls[-1] if self._calls else None

    gw = GatewayMock()
    with patch("urllib.request.urlopen", side_effect=gw._urlopen):
        yield gw


# ---------------------------------------------------------------------------
# tmp_workspace — temporary workspace directory tree
# ---------------------------------------------------------------------------
@pytest.fixture
def tmp_workspace(tmp_path):
    """Temporary workspace directory with scripts/, logs/, memory/ subdirs.

    Returns the tmp_path (Path) with the directory structure created.
    """
    for d in ["scripts", "logs", "memory", "bus"]:
        (tmp_path / d).mkdir()
    return tmp_path


# ---------------------------------------------------------------------------
# mock_telegram — mock Telegram Bot API responses
# ---------------------------------------------------------------------------
@pytest.fixture
def mock_telegram():
    """Patch urllib.request.urlopen for Telegram sendMessage calls.

    Usage:
        def test_send(mock_telegram):
            mock_telegram.set_response({"ok": True, "result": {}})
            # code that sends Telegram message
            assert mock_telegram.call_count == 1
    """

    class TelegramMock:
        def __init__(self):
            self._response = _MockHTTPResponse({"ok": True, "result": {}})
            self._calls = []

        def set_response(self, data, status=200):
            self._response = _MockHTTPResponse(data, status)

        def _urlopen(self, req, *args, **kwargs):
            url = req if isinstance(req, str) else req.full_url
            self._calls.append(url)
            return self._response

        @property
        def call_count(self):
            return len(self._calls)

        @property
        def last_url(self):
            return self._calls[-1] if self._calls else None

    tg = TelegramMock()
    with patch("urllib.request.urlopen", side_effect=tg._urlopen):
        yield tg
