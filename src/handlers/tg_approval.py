"""Telegram HITL Approval Handler — inline buttons for approve/reject/edit.

When the LLM Gateway detects a high-risk action (file deletion, system
commands, budget > threshold), it pauses the pipeline and sends an approval
request. This module handles the Telegram UI:

  [✅ Approve]  [❌ Reject]  [📝 Edit Plan]

The user taps a button → callback_query → resolve_approval() → pipeline resumes.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

import structlog
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup

if TYPE_CHECKING:
    from aiogram import Bot

from src.llm.gateway import ApprovalRequest, resolve_approval

logger = structlog.get_logger("HITL.TelegramApproval")

# Prefix for callback data to distinguish HITL buttons from other callbacks
_CB_PREFIX = "hitl:"


def build_approval_keyboard(request_id: str) -> InlineKeyboardMarkup:
    """Build the Approve / Reject / Edit inline keyboard."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="✅ Approve", callback_data=f"{_CB_PREFIX}approve:{request_id}"),
                InlineKeyboardButton(text="❌ Reject", callback_data=f"{_CB_PREFIX}reject:{request_id}"),
                InlineKeyboardButton(text="📝 Edit Plan", callback_data=f"{_CB_PREFIX}edit:{request_id}"),
            ]
        ]
    )


async def send_approval_request(
    bot: Bot,
    chat_id: int,
    approval: ApprovalRequest,
) -> None:
    """Send an approval request with inline buttons to a Telegram chat."""
    reasons_str = "\n".join(f"  • {r}" for r in approval.risk_reasons)
    text = (
        f"🛑 *HITL Approval Required*\n\n"
        f"**Request ID:** `{approval.request_id}`\n"
        f"**Risk reasons:**\n{reasons_str}\n\n"
        f"**Prompt preview:**\n```\n{approval.prompt_preview[:500]}\n```\n\n"
        f"⏱ Timeout: {300}s"
    )

    keyboard = build_approval_keyboard(approval.request_id)

    try:
        await bot.send_message(
            chat_id=chat_id,
            text=text,
            parse_mode="Markdown",
            reply_markup=keyboard,
        )
        logger.info("HITL approval sent to Telegram", request_id=approval.request_id, chat_id=chat_id)
    except Exception:
        # Fallback without markdown
        await bot.send_message(
            chat_id=chat_id,
            text=f"🛑 HITL Approval Required\n\nRequest: {approval.request_id}\nReasons: {reasons_str}\nPrompt: {approval.prompt_preview[:300]}",
            reply_markup=keyboard,
        )


async def handle_hitl_callback(gateway: Any, callback: CallbackQuery) -> None:
    """Handle HITL button presses (approve/reject/edit)."""
    data = callback.data or ""
    if not data.startswith(_CB_PREFIX):
        return

    parts = data[len(_CB_PREFIX):].split(":", 1)
    if len(parts) != 2:
        await callback.answer("⚠️ Invalid HITL action")
        return

    action, request_id = parts

    if action in ("approve", "reject"):
        success = resolve_approval(request_id, action)
        if success:
            emoji = "✅" if action == "approve" else "❌"
            await callback.answer(f"{emoji} {'Approved' if action == 'approve' else 'Rejected'}")
            try:
                await callback.message.edit_text(
                    f"{callback.message.text}\n\n→ **{action.upper()}** by {callback.from_user.first_name}",
                    parse_mode="Markdown",
                )
            except Exception:
                pass
            logger.info("HITL resolved", action=action, request_id=request_id)
        else:
            await callback.answer("⚠️ Request expired or already resolved")
    elif action == "edit":
        # For edit, we mark the request as pending edit and ask user to type
        await callback.answer("📝 Reply to this message with modified prompt")
        try:
            await callback.message.reply(
                f"📝 *Edit Plan*\n\nReply to this message with the modified prompt.\n"
                f"Request ID: `{request_id}`",
                parse_mode="Markdown",
            )
        except Exception:
            await callback.message.reply(
                f"📝 Edit Plan\nReply to this message with the modified prompt.\nRequest ID: {request_id}"
            )
        # Store pending edit info on gateway for reply handling
        if not hasattr(gateway, "_pending_hitl_edits"):
            gateway._pending_hitl_edits = {}
        gateway._pending_hitl_edits[callback.from_user.id] = request_id
    else:
        await callback.answer("⚠️ Unknown HITL action")


def create_approval_notifier(bot: "Bot", admin_chat_id: int):
    """Create an async callback for the LLM gateway to notify about approvals."""
    async def _notify(approval: ApprovalRequest) -> None:
        await send_approval_request(bot, admin_chat_id, approval)
    return _notify
