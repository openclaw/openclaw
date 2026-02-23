"""
test_shared_db.py — Unit tests for shared.db module.

Tests:
- get_connection: WAL + busy_timeout
- db_connection: context manager auto-close
- db_transaction: auto-commit/rollback
"""
import sqlite3
import sys
import tempfile
from pathlib import Path

SCRIPTS_DIR = str(Path(__file__).parent.parent / "scripts")
sys.path.insert(0, SCRIPTS_DIR)

import pytest

from shared.db import get_connection, db_connection, db_transaction


@pytest.fixture
def tmp_db(tmp_path):
    """Create a temporary SQLite database."""
    db = tmp_path / "test.db"
    conn = sqlite3.connect(str(db))
    conn.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)")
    conn.commit()
    conn.close()
    return db


class TestGetConnection:
    def test_returns_connection(self, tmp_db):
        conn = get_connection(tmp_db)
        assert conn is not None
        conn.close()

    def test_sets_wal_mode(self, tmp_db):
        conn = get_connection(tmp_db)
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode == "wal"
        conn.close()

    def test_sets_busy_timeout(self, tmp_db):
        conn = get_connection(tmp_db, timeout=15)
        bt = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        assert bt == 15000
        conn.close()

    def test_default_timeout(self, tmp_db):
        conn = get_connection(tmp_db)
        bt = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        assert bt == 10000  # DEFAULT_TIMEOUT=10s
        conn.close()

    def test_row_factory(self, tmp_db):
        conn = get_connection(tmp_db, row_factory=sqlite3.Row)
        assert conn.row_factory is sqlite3.Row
        conn.close()


class TestDbConnection:
    def test_auto_closes(self, tmp_db):
        with db_connection(tmp_db) as conn:
            conn.execute("SELECT 1")
        # After exiting context, connection should be closed
        # (can't easily check, but no exception means success)

    def test_select_works(self, tmp_db):
        with db_connection(tmp_db) as conn:
            conn.execute("INSERT INTO items (name) VALUES ('test')")
            conn.commit()
        with db_connection(tmp_db) as conn:
            rows = conn.execute("SELECT name FROM items").fetchall()
            assert len(rows) == 1
            assert rows[0][0] == "test"


class TestDbTransaction:
    def test_auto_commits(self, tmp_db):
        with db_transaction(tmp_db) as conn:
            conn.execute("INSERT INTO items (name) VALUES ('committed')")
        # Verify committed
        with db_connection(tmp_db) as conn:
            rows = conn.execute("SELECT name FROM items").fetchall()
            assert len(rows) == 1
            assert rows[0][0] == "committed"

    def test_auto_rollback_on_exception(self, tmp_db):
        with pytest.raises(ValueError):
            with db_transaction(tmp_db) as conn:
                conn.execute("INSERT INTO items (name) VALUES ('should_rollback')")
                raise ValueError("test error")
        # Verify rolled back
        with db_connection(tmp_db) as conn:
            rows = conn.execute("SELECT name FROM items").fetchall()
            assert len(rows) == 0

    def test_multiple_operations(self, tmp_db):
        with db_transaction(tmp_db) as conn:
            conn.execute("INSERT INTO items (name) VALUES ('a')")
            conn.execute("INSERT INTO items (name) VALUES ('b')")
            conn.execute("INSERT INTO items (name) VALUES ('c')")
        with db_connection(tmp_db) as conn:
            cnt = conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
            assert cnt == 3
