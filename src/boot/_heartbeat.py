"""Telegram Heartbeat & Live Init Logger.

Provides:
  - send_heartbeat(): first-signal test before any heavy init
  - TelegramInitLogger: streams init stages to admin chat
  - crash_reporter(): writes crash_report.log + sends error to Telegram
"""

from __future__ import annotations

import datetime
import traceback
from pathlib import Path

import aiohttp
import structlog

logger = structlog.get_logger("Heartbeat")

_TELEGRAM_API = "https://api.telegram.org/bot{token}/sendMessage"
_CRASH_LOG = Path("crash_report.log")


async def _send_telegram(token: str, chat_id: int | str, text: str) -> bool:
    """Low-level Telegram send — no aiogram dependency (works before Bot init)."""
    url = _TELEGRAM_API.format(token=token)
    payload = {"chat_id": str(chat_id), "text": text, "parse_mode": "HTML"}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status == 200:
                    return True
                body = await resp.text()
                logger.error("Telegram heartbeat failed", status=resp.status, body=body[:300])
                return False
    except Exception as exc:
        logger.error("Telegram heartbeat network error", error=str(exc))
        return False


async def send_heartbeat(token: str, admin_id: int | str) -> bool:
    """Send first-signal message. Returns True if delivered, False otherwise."""
    text = "🚀 <b>OpenClaw: Канал связи установлен.</b>\nНачинаю загрузку модулей..."
    ok = await _send_telegram(token, admin_id, text)
    if ok:
        logger.info("Heartbeat delivered to Telegram")
    else:
        logger.error("HEARTBEAT FAILED — Telegram unreachable. Aborting startup.")
    return ok


class TelegramInitLogger:
    """Streams initialisation stage messages to the admin Telegram chat."""

    def __init__(self, token: str, admin_id: int | str) -> None:
        self._token = token
        self._admin_id = admin_id

    async def stage(self, emoji: str, module: str, detail: str = "") -> None:
        """Report one init stage."""
        msg = f"[INIT] {emoji} <b>{module}</b>"
        if detail:
            msg += f": {detail}"
        await _send_telegram(self._token, self._admin_id, msg)
        logger.info("init_stage", module=module, detail=detail)


async def crash_reporter(
    token: str,
    admin_id: int | str,
    exc: BaseException,
    context: str = "startup",
) -> None:
    """Write crash_report.log and send error summary to Telegram."""
    tb = traceback.format_exception(type(exc), exc, exc.__traceback__)
    tb_text = "".join(tb)
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()

    # Append to crash log file
    entry = f"\n{'='*60}\n[{timestamp}] Context: {context}\n{tb_text}\n"
    try:
        with open(_CRASH_LOG, "a", encoding="utf-8") as f:
            f.write(entry)
        logger.info("Crash report saved", path=str(_CRASH_LOG))
    except Exception as io_err:
        logger.error("Failed to write crash_report.log", error=str(io_err))

    # Send to Telegram (truncate to 3500 chars for safety)
    short_tb = tb_text[-3500:] if len(tb_text) > 3500 else tb_text
    tg_msg = (
        f"❌ <b>FAILURE</b> [{context}]\n\n"
        f"<pre>{_escape_html(short_tb)}</pre>"
    )
    await _send_telegram(token, admin_id, tg_msg)


def _escape_html(text: str) -> str:
    """Escape HTML special chars for Telegram HTML parse mode."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


async def send_api_error_debug(
    token: str,
    admin_id: int | str,
    error_info: dict,
) -> None:
    """Send structured API error debug info to Telegram on 401/402/429.

    error_info keys: status, model, endpoint, body, role, attempt
    """
    status = error_info.get("status", "?")
    model = error_info.get("model", "unknown")
    endpoint = error_info.get("endpoint", "unknown")
    body = error_info.get("body", "")[:2000]
    role = error_info.get("role", "")
    attempt = error_info.get("attempt", "?")

    msg = (
        f"⚠️ <b>[DEBUG] API Error</b>\n\n"
        f"<b>Status:</b> {status}\n"
        f"<b>Model:</b> <code>{_escape_html(model)}</code>\n"
        f"<b>Endpoint:</b> <code>{_escape_html(endpoint)}</code>\n"
    )
    if role:
        msg += f"<b>Role:</b> {_escape_html(role)}\n"
    msg += (
        f"<b>Attempt:</b> {attempt}\n\n"
        f"<b>Response body:</b>\n"
        f"<pre>{_escape_html(body[:1500])}</pre>"
    )
    await _send_telegram(token, admin_id, msg)
