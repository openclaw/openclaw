from __future__ import annotations

import asyncio
import argparse
import logging
import os
import re
import sqlite3
import sys
import threading
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Final

LOGGER: Final[logging.Logger] = logging.getLogger(__name__)
DEFAULT_DB_PATH: Final[Path] = Path.home() / ".openclaw" / "implicit_memory.db"
FTS_TABLE_NAME: Final[str] = "user_experiences_fts"
MAX_CONTEXT_RESULTS: Final[int] = 3
DB_PATH_ENV_VAR: Final[str] = "OPENCLAW_IMPLICIT_MEMORY_DB_PATH"


def resolve_default_db_path() -> Path:
    raw = os.environ.get(DB_PATH_ENV_VAR, "").strip()
    return Path(raw).expanduser() if raw else DEFAULT_DB_PATH


class MemoryManager:
    def __init__(self, db_path: Path | None = None, logger: logging.Logger | None = None) -> None:
        self._db_path = db_path or resolve_default_db_path()
        self._logger = logger or LOGGER
        self._init_lock = threading.Lock()
        self._initialized = False

    def init_db(self) -> None:
        if self._initialized:
            return

        with self._init_lock:
            if self._initialized:
                return

            self._db_path.parent.mkdir(parents=True, exist_ok=True)
            self._logger.debug("Initializing implicit memory database at %s", self._db_path)

            with closing(self._connect()) as conn:
                try:
                    conn.execute("PRAGMA journal_mode=WAL")
                    conn.execute("PRAGMA synchronous=NORMAL")
                    conn.execute(
                        """
                        CREATE TABLE IF NOT EXISTS user_experiences (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            trigger_intent TEXT NOT NULL,
                            implicit_rules TEXT NOT NULL,
                            created_at TEXT NOT NULL
                        )
                        """
                    )
                    conn.execute(
                        f"""
                        CREATE VIRTUAL TABLE IF NOT EXISTS {FTS_TABLE_NAME}
                        USING fts5(
                            trigger_intent,
                            implicit_rules,
                            content='user_experiences',
                            content_rowid='id'
                        )
                        """
                    )
                    conn.executescript(
                        f"""
                        CREATE TRIGGER IF NOT EXISTS user_experiences_ai
                        AFTER INSERT ON user_experiences
                        BEGIN
                            INSERT INTO {FTS_TABLE_NAME}(rowid, trigger_intent, implicit_rules)
                            VALUES (new.id, new.trigger_intent, new.implicit_rules);
                        END;

                        CREATE TRIGGER IF NOT EXISTS user_experiences_ad
                        AFTER DELETE ON user_experiences
                        BEGIN
                            INSERT INTO
                                {FTS_TABLE_NAME}({FTS_TABLE_NAME}, rowid, trigger_intent, implicit_rules)
                            VALUES('delete', old.id, old.trigger_intent, old.implicit_rules);
                        END;

                        CREATE TRIGGER IF NOT EXISTS user_experiences_au
                        AFTER UPDATE ON user_experiences
                        BEGIN
                            INSERT INTO
                                {FTS_TABLE_NAME}({FTS_TABLE_NAME}, rowid, trigger_intent, implicit_rules)
                            VALUES('delete', old.id, old.trigger_intent, old.implicit_rules);
                            INSERT INTO {FTS_TABLE_NAME}(rowid, trigger_intent, implicit_rules)
                            VALUES (new.id, new.trigger_intent, new.implicit_rules);
                        END;
                        """
                    )
                    conn.commit()
                except sqlite3.OperationalError:
                    self._logger.debug("FTS5 initialization failed for %s", self._db_path, exc_info=True)
                    raise

            self._initialized = True
            self._logger.debug("Implicit memory database initialized")

    async def save_experience(self, intent: str, rules: str) -> None:
        await asyncio.to_thread(self._save_experience_sync, intent, rules)

    async def retrieve_implicit_context(self, user_query: str) -> str | None:
        return await asyncio.to_thread(self._retrieve_implicit_context_sync, user_query)

    def _save_experience_sync(self, intent: str, rules: str) -> None:
        self.init_db()

        normalized_intent = intent.strip()
        normalized_rules = rules.strip()
        if not normalized_intent or not normalized_rules:
            raise ValueError("intent and rules must be non-empty strings")

        created_at = datetime.now(timezone.utc).isoformat()
        self._logger.debug(
            "Saving implicit experience for intent=%r created_at=%s",
            normalized_intent,
            created_at,
        )

        with closing(self._connect()) as conn:
            conn.execute(
                """
                INSERT INTO user_experiences (trigger_intent, implicit_rules, created_at)
                VALUES (?, ?, ?)
                """,
                (normalized_intent, normalized_rules, created_at),
            )
            conn.commit()

    def _retrieve_implicit_context_sync(self, user_query: str) -> str | None:
        self.init_db()

        normalized_query = user_query.strip()
        if not normalized_query:
            self._logger.debug("Skipping implicit context retrieval for empty query")
            return None

        match_query = self._build_match_query(normalized_query)
        if not match_query:
            self._logger.debug("No FTS tokens extracted from query=%r", normalized_query)
            return None

        self._logger.debug("Retrieving implicit context for query=%r", normalized_query)

        with closing(self._connect()) as conn:
            rows = conn.execute(
                f"""
                SELECT
                    ue.trigger_intent,
                    ue.implicit_rules,
                    ue.created_at,
                    bm25({FTS_TABLE_NAME}) AS score
                FROM {FTS_TABLE_NAME}
                JOIN user_experiences AS ue ON ue.id = {FTS_TABLE_NAME}.rowid
                WHERE {FTS_TABLE_NAME} MATCH ?
                ORDER BY score ASC, ue.created_at DESC
                LIMIT ?
                """,
                (match_query, MAX_CONTEXT_RESULTS),
            ).fetchall()

        if not rows:
            self._logger.debug("No implicit context match found for query=%r", normalized_query)
            return None

        context_lines = ["Relevant implicit context from prior user experience:"]
        for row in rows:
            context_lines.append(f"Intent: {row['trigger_intent']}")
            context_lines.append(f"Rule: {row['implicit_rules']}")
            context_lines.append(f"Captured at: {row['created_at']}")

        context = "\n".join(context_lines)
        self._logger.debug("Retrieved %d implicit context match(es)", len(rows))
        return context

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        return conn

    @staticmethod
    def _build_match_query(user_query: str) -> str:
        tokens = re.findall(r"[\w\u4e00-\u9fff]+", user_query.casefold())
        unique_tokens = list(dict.fromkeys(tokens))
        if not unique_tokens:
            return ""

        escaped_tokens = [f'"{token.replace(chr(34), chr(34) * 2)}"' for token in unique_tokens]
        return " OR ".join(escaped_tokens)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Implicit memory manager")
    subparsers = parser.add_subparsers(dest="command", required=True)

    save_parser = subparsers.add_parser("save", help="Persist an implicit memory experience")
    save_parser.add_argument("--intent", required=True)
    save_parser.add_argument("--rules", required=True)

    retrieve_parser = subparsers.add_parser("retrieve", help="Fetch matching implicit memory")
    retrieve_parser.add_argument("--query", required=True)

    return parser


async def _run_cli(argv: list[str]) -> int:
    args = _build_parser().parse_args(argv)
    manager = MemoryManager()

    if args.command == "save":
        await manager.save_experience(args.intent, args.rules)
        return 0

    if args.command == "retrieve":
        context = await manager.retrieve_implicit_context(args.query)
        if context:
            print(context)
        return 0

    raise ValueError(f"Unsupported command: {args.command}")


def main(argv: list[str] | None = None) -> int:
    try:
        return asyncio.run(_run_cli(argv or sys.argv[1:]))
    except Exception:
        LOGGER.debug("Implicit memory manager CLI failed", exc_info=True)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
