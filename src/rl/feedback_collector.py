"""Feedback Collector — user reaction capture for reward signal enrichment.

Stores user feedback (👍/👎, star ratings, explicit comments) for each
bot response. This data feeds into the RewardModel as `user_rating`
and will be used for RLHF-style training.

Integration points:
- Telegram: inline keyboard buttons under bot responses
- Discord: reaction emojis
- Web: star rating or like/dislike buttons

This module is transport-agnostic — it stores feedback records in SQLite.
Channel-specific handlers (aiogram callbacks, discord.py events) call
the `record()` method.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

import structlog

logger = structlog.get_logger("FeedbackCollector")


class FeedbackType(str, Enum):
    THUMBS_UP = "thumbs_up"
    THUMBS_DOWN = "thumbs_down"
    STAR_RATING = "star_rating"  # 1-5 stars
    TEXT_COMMENT = "text_comment"
    CORRECTION = "correction"  # user provided correct answer


@dataclass
class UserFeedback:
    """A single user feedback entry."""
    feedback_id: str = ""
    message_id: str = ""  # bot message that received feedback
    episode_id: str = ""  # pipeline episode (if available)
    user_id: str = ""
    channel: str = ""  # "telegram", "discord", "web"
    feedback_type: FeedbackType = FeedbackType.THUMBS_UP
    value: float = 1.0  # 1.0 for 👍, 0.0 for 👎, 0.2..1.0 for stars
    comment: str = ""  # optional text feedback
    correction: str = ""  # correct answer if type=CORRECTION
    timestamp: float = field(default_factory=time.time)
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def normalized_score(self) -> float:
        """Normalize any feedback type to [0.0, 1.0] for RewardModel."""
        if self.feedback_type == FeedbackType.THUMBS_UP:
            return 1.0
        elif self.feedback_type == FeedbackType.THUMBS_DOWN:
            return 0.0
        elif self.feedback_type == FeedbackType.STAR_RATING:
            return max(0.0, min(1.0, (self.value - 1.0) / 4.0))  # 1-5 → 0-1
        elif self.feedback_type == FeedbackType.CORRECTION:
            return 0.1  # correction implies original was wrong
        elif self.feedback_type == FeedbackType.TEXT_COMMENT:
            return self.value  # caller sets sentiment
        return 0.5


class FeedbackCollector:
    """Collects and aggregates user feedback for bot responses.

    Usage:
        fc = FeedbackCollector("data/rl/feedback.db")
        fc.record(UserFeedback(message_id="msg123", feedback_type=FeedbackType.THUMBS_UP))
        score = fc.get_aggregate_score("msg123")  # → 1.0
        stats = fc.get_stats()
    """

    def __init__(self, db_path: str = "data/rl/feedback.db") -> None:
        self._db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None
        self._initialized = False

    def initialize(self) -> None:
        os.makedirs(os.path.dirname(self._db_path), exist_ok=True)
        self._conn = sqlite3.connect(self._db_path)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS feedback (
                feedback_id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                episode_id TEXT DEFAULT '',
                user_id TEXT DEFAULT '',
                channel TEXT DEFAULT '',
                feedback_type TEXT NOT NULL,
                value REAL DEFAULT 1.0,
                comment TEXT DEFAULT '',
                correction TEXT DEFAULT '',
                timestamp REAL NOT NULL,
                metadata TEXT DEFAULT '{}'
            );
            CREATE INDEX IF NOT EXISTS idx_fb_message ON feedback(message_id);
            CREATE INDEX IF NOT EXISTS idx_fb_episode ON feedback(episode_id);
            CREATE INDEX IF NOT EXISTS idx_fb_user ON feedback(user_id);
            CREATE INDEX IF NOT EXISTS idx_fb_type ON feedback(feedback_type);
            CREATE INDEX IF NOT EXISTS idx_fb_time ON feedback(timestamp DESC);
        """)
        self._conn.commit()
        self._initialized = True
        logger.info("FeedbackCollector initialized", db=self._db_path)

    # ------------------------------------------------------------------
    # Record
    # ------------------------------------------------------------------

    def record(self, fb: UserFeedback) -> str:
        """Store a feedback entry. Returns feedback_id."""
        self._ensure_init()
        assert self._conn is not None

        if not fb.feedback_id:
            fb.feedback_id = f"fb_{int(fb.timestamp * 1000)}_{fb.message_id[:8]}"

        self._conn.execute("""
            INSERT OR REPLACE INTO feedback
            (feedback_id, message_id, episode_id, user_id, channel,
             feedback_type, value, comment, correction, timestamp, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            fb.feedback_id, fb.message_id, fb.episode_id, fb.user_id,
            fb.channel, fb.feedback_type.value, fb.value,
            fb.comment[:2000], fb.correction[:5000],
            fb.timestamp, json.dumps(fb.metadata),
        ))
        self._conn.commit()

        logger.info(
            "feedback_recorded",
            feedback_id=fb.feedback_id,
            message_id=fb.message_id,
            type=fb.feedback_type.value,
            score=fb.normalized_score,
        )
        return fb.feedback_id

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def get_aggregate_score(self, message_id: str) -> Optional[float]:
        """Get average normalized score for a message. None if no feedback."""
        self._ensure_init()
        assert self._conn is not None

        rows = self._conn.execute(
            "SELECT feedback_type, value FROM feedback WHERE message_id = ?",
            (message_id,),
        ).fetchall()

        if not rows:
            return None

        scores = []
        for ftype, val in rows:
            fb = UserFeedback(feedback_type=FeedbackType(ftype), value=val)
            scores.append(fb.normalized_score)
        return sum(scores) / len(scores)

    def get_episode_feedback(self, episode_id: str) -> List[UserFeedback]:
        """Get all feedback for a pipeline episode."""
        self._ensure_init()
        assert self._conn is not None

        rows = self._conn.execute(
            "SELECT * FROM feedback WHERE episode_id = ? ORDER BY timestamp",
            (episode_id,),
        ).fetchall()
        return [self._row_to_feedback(r) for r in rows]

    def get_corrections(self, limit: int = 100) -> List[UserFeedback]:
        """Get recent corrections — high-value negative training data."""
        self._ensure_init()
        assert self._conn is not None

        rows = self._conn.execute(
            "SELECT * FROM feedback WHERE feedback_type = ? AND correction != '' "
            "ORDER BY timestamp DESC LIMIT ?",
            (FeedbackType.CORRECTION.value, limit),
        ).fetchall()
        return [self._row_to_feedback(r) for r in rows]

    def get_stats(self) -> Dict[str, Any]:
        """Return feedback statistics."""
        self._ensure_init()
        assert self._conn is not None

        total = self._conn.execute("SELECT COUNT(*) FROM feedback").fetchone()[0]
        if total == 0:
            return {"total": 0, "by_type": {}, "avg_score": 0.0, "positive_rate": 0.0}

        by_type = {}
        for row in self._conn.execute(
            "SELECT feedback_type, COUNT(*) FROM feedback GROUP BY feedback_type"
        ).fetchall():
            by_type[row[0]] = row[1]

        positive = by_type.get(FeedbackType.THUMBS_UP.value, 0)
        negative = by_type.get(FeedbackType.THUMBS_DOWN.value, 0)
        pn_total = positive + negative

        return {
            "total": total,
            "by_type": by_type,
            "positive_rate": round(positive / pn_total, 4) if pn_total else 0.0,
            "corrections_count": by_type.get(FeedbackType.CORRECTION.value, 0),
        }

    # ------------------------------------------------------------------
    # Telegram helpers (keyboard markup generators)
    # ------------------------------------------------------------------

    @staticmethod
    def make_telegram_keyboard(message_id: str, episode_id: str = "") -> Dict[str, Any]:
        """Generate inline keyboard data for aiogram.

        Returns dict compatible with InlineKeyboardMarkup construction.
        Callback data format: "rl_fb:{message_id}:{episode_id}:{type}"
        """
        prefix = f"rl_fb:{message_id}:{episode_id}"
        return {
            "inline_keyboard": [
                [
                    {"text": "👍", "callback_data": f"{prefix}:thumbs_up"},
                    {"text": "👎", "callback_data": f"{prefix}:thumbs_down"},
                    {"text": "⭐", "callback_data": f"{prefix}:star_5"},
                ],
            ]
        }

    @staticmethod
    def parse_telegram_callback(data: str) -> Optional[Dict[str, str]]:
        """Parse callback_data from Telegram inline button.

        Returns dict with keys: message_id, episode_id, feedback_type, value
        or None if format is invalid.
        """
        parts = data.split(":")
        if len(parts) < 4 or parts[0] != "rl_fb":
            return None

        feedback_str = parts[3]
        if feedback_str.startswith("star_"):
            try:
                star_val = int(feedback_str.split("_")[1])
            except (IndexError, ValueError):
                star_val = 3
            return {
                "message_id": parts[1],
                "episode_id": parts[2],
                "feedback_type": "star_rating",
                "value": str(star_val),
            }

        return {
            "message_id": parts[1],
            "episode_id": parts[2],
            "feedback_type": feedback_str,
            "value": "1.0" if feedback_str == "thumbs_up" else "0.0",
        }

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _ensure_init(self) -> None:
        if not self._initialized:
            self.initialize()

    @staticmethod
    def _row_to_feedback(row: tuple) -> UserFeedback:
        return UserFeedback(
            feedback_id=row[0],
            message_id=row[1],
            episode_id=row[2],
            user_id=row[3],
            channel=row[4],
            feedback_type=FeedbackType(row[5]),
            value=row[6],
            comment=row[7],
            correction=row[8],
            timestamp=row[9],
            metadata=json.loads(row[10]) if row[10] else {},
        )
