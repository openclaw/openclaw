"""Pydantic validation schemas for Telegram input layer.

Validates incoming requests before they reach the pipeline.
Ensures admin_id gating, prompt sanity, and media constraints.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field, field_validator


class TelegramPromptInput(BaseModel):
    """Validated prompt from a Telegram text message."""
    user_id: int
    chat_id: int
    text: str = Field(..., min_length=1, max_length=32_000)
    is_reply: bool = False
    reply_to_bot: bool = False

    @field_validator("text")
    @classmethod
    def strip_whitespace(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Prompt cannot be empty or whitespace-only")
        return v


class TelegramMediaInput(BaseModel):
    """Validated media attachment from Telegram."""
    user_id: int
    chat_id: int
    media_type: str = Field(..., pattern=r"^(photo|voice|document)$")
    file_id: str = Field(..., min_length=1)
    caption: Optional[str] = Field(default=None, max_length=4096)
    file_size: Optional[int] = Field(default=None, le=50_000_000)  # 50MB max

    @field_validator("caption")
    @classmethod
    def strip_caption(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            v = v.strip()
            return v if v else None
        return v


class TelegramCallbackInput(BaseModel):
    """Validated callback query from inline buttons."""
    user_id: int
    chat_id: int
    callback_data: str = Field(..., min_length=1, max_length=256)
    message_id: Optional[int] = None


class TelegramConfig(BaseModel):
    """Validated Telegram section from openclaw_config.json."""
    bot_token: str = Field(..., min_length=10)
    admin_chat_id: str = Field(..., min_length=1)
    use_webhook: bool = False
    webhook_url: str = ""
    webhook_port: int = Field(default=8080, ge=1024, le=65535)

    @field_validator("bot_token")
    @classmethod
    def clean_token(cls, v: str) -> str:
        """Strip ${} wrapper if present (legacy config format)."""
        v = v.strip()
        if v.startswith("${") and v.endswith("}"):
            v = v[2:-1]
        if ":" not in v:
            raise ValueError("Invalid bot token format (expected id:hash)")
        return v

    @field_validator("admin_chat_id")
    @classmethod
    def clean_admin_id(cls, v: str) -> str:
        """Strip ${} wrapper and validate numeric."""
        v = v.strip()
        if v.startswith("${") and v.endswith("}"):
            v = v[2:-1]
        if not v.lstrip("-").isdigit():
            raise ValueError("admin_chat_id must be numeric")
        return v
