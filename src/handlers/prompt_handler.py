"""Prompt handling logic extracted from OpenClawGateway.

Contains handle_prompt() and _handle_prompt_inner() — the core
user-message processing pipeline that routes through brigades.

v15.1: Multi-turn context bridge + bare URL auto-execution.
"""

import asyncio
import re
import time
from collections import deque
from typing import Deque, Dict, List, Tuple

import structlog
from aiogram.types import ForceReply, Message

from src.boot import PROMPT_COUNTER
from src.intent_classifier import classify_intent

logger = structlog.get_logger("PromptHandler")

# ---------------------------------------------------------------------------
# v15.1: Chat History Bridge — per-user multi-turn context
# ---------------------------------------------------------------------------
_MAX_HISTORY_TURNS = 5
_MAX_TURN_CHARS = 400  # truncate long messages in history to save context budget

# Type alias: each turn is (user_prompt, assistant_response)
ChatHistory = Deque[Tuple[str, str]]


def _get_chat_history(gateway, user_id: int) -> ChatHistory:
    """Return (lazily init) per-user chat history deque."""
    if not hasattr(gateway, "_chat_history"):
        gateway._chat_history: Dict[int, ChatHistory] = {}
    if user_id not in gateway._chat_history:
        gateway._chat_history[user_id] = deque(maxlen=_MAX_HISTORY_TURNS)
    return gateway._chat_history[user_id]


def _build_history_prefix(history: ChatHistory) -> str:
    """Format last N turns as a context prefix for the current prompt."""
    if not history:
        return ""
    lines: List[str] = ["[CHAT HISTORY — last conversation turns]:"]
    for user_msg, bot_resp in history:
        u = user_msg[:_MAX_TURN_CHARS] + ("…" if len(user_msg) > _MAX_TURN_CHARS else "")
        b = bot_resp[:_MAX_TURN_CHARS] + ("…" if len(bot_resp) > _MAX_TURN_CHARS else "")
        lines.append(f"User: {u}")
        lines.append(f"Assistant: {b}")
    lines.append("")
    lines.append("[CURRENT TASK]:")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# v15.1: Bare URL Auto-Execution — detect and inject action instructions
# ---------------------------------------------------------------------------
_YOUTUBE_RE = re.compile(r"(?:youtube\.com/watch|youtu\.be/|youtube\.com/shorts/)", re.I)
_URL_ONLY_RE = re.compile(
    r"^\s*(https?://\S+)\s*$",  # prompt is ONLY a URL (with optional whitespace)
    re.I,
)
_URL_DOMINANT_RE = re.compile(
    r"^\s*(https?://\S+)\s*(.{0,20})\s*$",  # URL + up to 20 chars (e.g. "вот" / "check this")
    re.I,
)

_YT_AUTO_INSTRUCTION = (
    "Проанализируй это видео. Используй инструмент youtube_parser для извлечения транскрипта, "
    "затем предоставь подробный анализ содержания на языке пользователя."
)
_WEB_AUTO_INSTRUCTION = (
    "Открой и проанализируй содержимое этой ссылки. Используй brave_web_search или fetch "
    "для получения данных со страницы, затем предоставь краткий анализ."
)


def _enrich_bare_url(prompt: str) -> str:
    """If prompt is a bare URL (or URL + trivial filler), inject an action directive.

    Returns enriched prompt or the original if no injection needed.
    """
    # Reject prompts with multiple URLs — likely a comparison/list, not a bare link
    if len(re.findall(r"https?://", prompt)) > 1:
        return prompt
    m = _URL_ONLY_RE.match(prompt) or _URL_DOMINANT_RE.match(prompt)
    if not m:
        return prompt
    url = m.group(1)
    if _YOUTUBE_RE.search(url):
        enriched = f"{_YT_AUTO_INSTRUCTION}\n\nURL: {url}"
    else:
        enriched = f"{_WEB_AUTO_INSTRUCTION}\n\nURL: {url}"
    logger.info(
        "v15.1 bare URL auto-execution injected",
        url=url[:120],
        is_youtube=bool(_YOUTUBE_RE.search(url)),
    )
    return enriched


async def handle_prompt(gateway, message: Message):
    """Top-level prompt handler registered on the Dispatcher."""
    if message.from_user.id != gateway.admin_id:
        return

    # --- Phase 8: HITL edit reply interception ---
    _hitl_edits = getattr(gateway, "_pending_hitl_edits", {})
    user_id = message.from_user.id
    if user_id in _hitl_edits:
        from src.llm_gateway import resolve_approval
        req_id = _hitl_edits.pop(user_id)
        resolve_approval(req_id, "edited", edited_prompt=message.text)
        await message.reply("✏️ Промпт обновлён. Запрос продолжает выполнение.")
        return

    PROMPT_COUNTER.inc()
    prompt = message.text
    logger.info("received_prompt", prompt=prompt)
    try:
        await message.bot.send_chat_action(chat_id=message.chat.id, action="typing")
    except Exception:
        pass
    try:
        await _handle_prompt_inner(gateway, message, prompt)
    except Exception as exc:
        logger.error("handle_prompt unhandled error", error=str(exc), exc_info=True)
        try:
            await message.reply(f"❌ Внутренняя ошибка бота: {exc}")
        except Exception:
            pass


async def _handle_prompt_inner(gateway, message: Message, prompt: str):
    """Full pipeline execution: injection check → intent → brigade → response."""

    # Safety: Prompt Injection Detection
    injection_result = gateway.injection_defender.analyze(prompt)
    if injection_result.is_injection:
        logger.warning("Prompt injection detected", severity=injection_result.severity,
                       patterns=injection_result.patterns_matched)
        if injection_result.severity in ("high", "critical"):
            await message.reply(
                f"🛡️ *Заблокировано*: обнаружена попытка prompt injection "
                f"(severity: {injection_result.severity})",
                parse_mode="Markdown",
            )
            return
        await message.reply(
            f"⚠️ Предупреждение: подозрительный паттерн в запросе "
            f"(confidence: {injection_result.confidence:.0%}). Обрабатываю с осторожностью.",
        )

    # Check if it's a reply to ask_user
    is_reply = False
    if message.reply_to_message and getattr(message.reply_to_message.from_user, "id", None) == message.bot.id:
        if hasattr(gateway, 'pending_ask_user') and message.from_user.id in gateway.pending_ask_user:
            is_reply = True
            context = gateway.pending_ask_user.pop(message.from_user.id)
            brigade = context["brigade"]
            original_prompt = context["original_prompt"]
            prompt = (
                f"Ранее я просил: {original_prompt}\n"
                f"Твой вопрос ко мне. Вот мой ответ/уточнение: {prompt}\n"
                f"Продолжай задачу с учетом этих новых данных."
            )
            logger.info("Resuming pipeline with user clarification", brigade=brigade)

    # Session Management: Context Auto-Reset
    if not hasattr(gateway, '_session_msg_count'):
        gateway._session_msg_count = 0
    gateway._session_msg_count += 1

    reset_limit = gateway.config.get("system", {}).get(
        "session_management", {}
    ).get("auto_reset_context_messages", 15)
    if gateway._session_msg_count >= reset_limit:
        gateway._session_msg_count = 0
        if hasattr(gateway, 'memory_gc'):
            gateway.memory_gc._persistent_summary = ""
            gateway.memory_gc._compression_count = 0
        # v15.1: also clear chat history on session reset
        if hasattr(gateway, '_chat_history'):
            gateway._chat_history.clear()
        logger.info("Session context auto-reset triggered", limit=reset_limit)
        await message.reply(
            f"🔄 **Внимание:** Достигнут лимит сессии ({reset_limit} сообщений). "
            f"Окно контекста и память очищены для экономии VRAM.",
            parse_mode="Markdown",
        )

    # 1. Intent Classification
    if not is_reply:
        brigade = await classify_intent(gateway, prompt)

    # -------------------------------------------------------------------
    # v15.1: Bare URL auto-execution — inject action directive BEFORE
    # intent routing so the enriched prompt flows through the full pipeline.
    # Must happen after intent classification (brigade already selected).
    # -------------------------------------------------------------------
    prompt = _enrich_bare_url(prompt)

    # -------------------------------------------------------------------
    # v15.1: Multi-turn context bridge — prepend chat history so the LLM
    # sees previous conversation turns. Skipped for ask_user replies
    # (they already carry context from the original prompt).
    # -------------------------------------------------------------------
    user_id = message.from_user.id
    if not is_reply:
        history = _get_chat_history(gateway, user_id)
        history_prefix = _build_history_prefix(history)
        if history_prefix:
            prompt = history_prefix + prompt
            logger.info(
                "v15.1 chat history injected",
                user_id=user_id,
                turns=len(history),
                prefix_len=len(history_prefix),
            )

    # 2. Execute Pipeline (Chain-of-Agents) or Fast Path
    is_fast_path = (brigade == "General")
    actual_brigade = "OpenClaw-Core" if is_fast_path else brigade

    route_label = f"{actual_brigade} ⚡" if is_fast_path else actual_brigade
    _b = gateway.archivist.escape_markdown(route_label)
    status_msg = await message.reply(
        f"🤖 *Pipeline \\({_b}\\)* запущен\\.\\.\\.\n"
        f"_Маршрутизация задачи в бригаду\\.\\.\\._",
        parse_mode="MarkdownV2",
    )

    await gateway.archivist.send_status(
        f"Router ({actual_brigade})", "Intent Classification",
        f"Задача направлена в бригаду {actual_brigade}"
        + (" (fast path)" if is_fast_path else ""),
    )

    async def update_status(role, model, text):
        try:
            b = gateway.archivist.escape_markdown(actual_brigade)
            r = gateway.archivist.escape_markdown(role)
            m = gateway.archivist.escape_markdown(model)
            t = gateway.archivist.escape_markdown(text)
            await status_msg.edit_text(
                f"🏴 *{b}* \\| ⚙️ `{r}` \\(`{m}`\\)\n_{t}_",
                parse_mode="MarkdownV2",
            )
        except Exception:
            pass

    # Periodic typing indicator
    typing_stop = asyncio.Event()

    async def _keep_typing():
        while not typing_stop.is_set():
            try:
                await message.bot.send_chat_action(chat_id=message.chat.id, action="typing")
            except Exception:
                pass
            try:
                await asyncio.wait_for(typing_stop.wait(), timeout=4)
                break
            except asyncio.TimeoutError:
                pass

    typing_task = asyncio.create_task(_keep_typing())

    _pipeline_start = time.time()
    try:
        result = await gateway.pipeline.execute_stream(
            prompt=prompt,
            brigade=actual_brigade,
            status_callback=update_status,
            task_type="general" if is_fast_path else None,
        )
    finally:
        typing_stop.set()
        typing_task.cancel()

    # Self-Healing Logic (one-time retry on failure)
    if result.get("status") == "error":
        logger.warning("Pipeline failed. Attempting self-healing retry...", brigade=actual_brigade)
        typing_stop.clear()
        typing_task = asyncio.create_task(_keep_typing())
        try:
            result = await gateway.pipeline.execute_stream(
                prompt=prompt,
                brigade=actual_brigade,
                status_callback=update_status,
                task_type="general" if is_fast_path else None,
            )
        finally:
            typing_stop.set()
            typing_task.cancel()

    # --- Send API error debug to Telegram if captured ---
    try:
        from src.llm_gateway import get_last_api_error
        api_err = get_last_api_error()
        if api_err and api_err.get("status") in (401, 402, 429, 500, 503):
            from src.boot._heartbeat import send_api_error_debug
            tg_config = gateway.config.get("telegram", {})
            await send_api_error_debug(
                token=tg_config.get("token", ""),
                admin_id=gateway.admin_id,
                error_info=api_err,
            )
    except Exception as debug_err:
        logger.warning("Failed to send API error debug", error=str(debug_err))

    # ask_user flow
    if result.get("status") == "ask_user":
        question = result.get("question", "Оркестратору нужно уточнение.")
        if not hasattr(gateway, 'pending_ask_user'):
            gateway.pending_ask_user = {}
        gateway.pending_ask_user[message.from_user.id] = {
            "original_prompt": prompt,
            "brigade": actual_brigade,
        }
        markup = ForceReply(selective=True)
        try:
            await status_msg.edit_text(
                f"❓ *Вопрос от Оркестратора:*\n\n{question}",
                parse_mode="Markdown",
            )
            await message.reply("Ответьте на это сообщение для продолжения (Reply):", reply_markup=markup)
        except Exception:
            await message.reply(
                f"❓ *Вопрос от Оркестратора:*\n\n{question}",
                parse_mode="Markdown",
                reply_markup=markup,
            )
        await gateway.archivist.send_status(
            f"Router ({actual_brigade})", "Clarification Loop",
            "Пайплайн приостановлен. Ожидается ответ пользователя.",
        )
        return

    llm_response = result["final_response"]
    chain_str = " → ".join(result["chain_executed"])
    display_brigade = f"{actual_brigade} ⚡" if is_fast_path else actual_brigade
    _pipeline_elapsed = time.time() - _pipeline_start

    # Safety: Hallucination Detection on output
    hall_result = gateway.hallucination_detector.detect(llm_response, prompt)
    if hall_result.overall_risk == "high":
        llm_response += "\n\n⚠️ _Внимание: обнаружен высокий риск галлюцинации. Проверьте факты._"
        logger.warning("Hallucination risk HIGH", flags=hall_result.flags,
                       suspicious=hall_result.suspicious_claims[:3])

    # -------------------------------------------------------------------
    # v15.1: Record turn in chat history for multi-turn context bridge.
    # Store the ORIGINAL user message (before history prefix injection)
    # paired with the final LLM response.
    # -------------------------------------------------------------------
    _original_user_msg = message.text or ""
    _hist = _get_chat_history(gateway, message.from_user.id)
    _hist.append((_original_user_msg, llm_response[:_MAX_TURN_CHARS]))

    # Record pipeline history
    gateway._pipeline_history.append({
        "timestamp": time.strftime("%H:%M:%S"),
        "brigade": actual_brigade,
        "prompt": prompt[:80],
        "chain": chain_str,
        "duration_sec": _pipeline_elapsed,
        "status": result.get("status", "completed"),
        "hallucination_risk": hall_result.overall_risk,
    })
    if len(gateway._pipeline_history) > 50:
        gateway._pipeline_history = gateway._pipeline_history[-50:]

    # Record perf metrics
    for step in result.get("steps", []):
        resp_len = len(step.get("response", ""))
        est_tokens = resp_len // 4
        gateway._perf_metrics.append({
            "role": step.get("role", "?"),
            "model": step.get("model", "?"),
            "tokens": est_tokens,
            "duration_sec": step.get("duration_sec",
                                     _pipeline_elapsed / max(len(result.get("steps", [{}])), 1)),
        })
    if len(gateway._perf_metrics) > 500:
        gateway._perf_metrics = gateway._perf_metrics[-500:]

    # Build metadata footer (spoiler in Telegram)
    _dur = f"{_pipeline_elapsed:.1f}s"
    _steps_count = len(result.get("steps", []))
    _hall_risk = hall_result.overall_risk
    _total_est_tokens = sum(len(s.get("response", "")) // 4 for s in result.get("steps", []))
    meta_footer = (
        f"\n\n<tg-spoiler>📊 {display_brigade} | {chain_str} | "
        f"⏱ {_dur} | 🔗 {_steps_count} steps | "
        f"~{_total_est_tokens} tok | hall: {_hall_risk}</tg-spoiler>"
    )

    # 3. Send final response
    await _send_response(gateway, message, status_msg, result, llm_response,
                         chain_str, display_brigade, actual_brigade, prompt,
                         meta_footer)


def smart_split(text: str, limit: int = 4000) -> list[str]:
    """Split text respecting newlines, sentence boundaries, and code blocks.

    Avoids breaking code fences or tables in the middle.
    """
    if len(text) <= limit:
        return [text]

    parts: list[str] = []
    while text:
        if len(text) <= limit:
            parts.append(text)
            break

        # Try splitting at a code-fence boundary first
        chunk = text[:limit]
        fence_pos = chunk.rfind("\n```\n")
        if fence_pos > limit // 3:
            split_at = fence_pos + 4  # after ```\n
        else:
            # Try double-newline (paragraph)
            split_at = chunk.rfind("\n\n")
            if split_at < limit // 3:
                # Try single newline
                split_at = chunk.rfind("\n")
            if split_at < limit // 4:
                # Try sentence boundary
                for sep in (". ", "! ", "? "):
                    pos = chunk.rfind(sep)
                    if pos > split_at:
                        split_at = pos + 1
            if split_at < 1:
                split_at = limit  # hard split

        parts.append(text[:split_at].rstrip())
        text = text[split_at:].lstrip()

    return parts


async def _send_response(gateway, message, status_msg, result, llm_response,
                         chain_str, display_brigade, actual_brigade, prompt,
                         meta_footer=""):
    """Send the final pipeline response with optional streaming edits.

    Output format: Answer text + spoiler metadata footer.
    Long messages are automatically split into chunks to avoid
    Telegram's MESSAGE_TOO_LONG (4096 char limit).
    """
    stream = result.get("stream")
    if stream:
        accumulated = ""
        last_edit_time = 0
        try:
            async for chunk in stream:
                accumulated += chunk
                now = time.time()
                if now - last_edit_time >= 1.0:
                    preview = accumulated[-3800:] + "▌" if len(accumulated) > 3800 else accumulated + "▌"
                    try:
                        await status_msg.edit_text(preview, parse_mode="HTML")
                    except Exception:
                        try:
                            await status_msg.edit_text(preview)
                        except Exception:
                            pass
                    last_edit_time = now
        except Exception as e:
            logger.warning("Stream interrupted", error=str(e))

        final_text = accumulated + meta_footer
    else:
        final_text = llm_response + meta_footer

    # --- Chunked delivery ---
    chunks = smart_split(final_text)
    if len(chunks) == 1:
        try:
            await status_msg.edit_text(chunks[0], parse_mode="HTML")
        except Exception:
            await status_msg.edit_text(chunks[0])
    else:
        # First chunk replaces the status message
        first = f"{chunks[0]}\n\n⏬ _(1/{len(chunks)})_"
        try:
            await status_msg.edit_text(first, parse_mode="HTML")
        except Exception:
            await status_msg.edit_text(first)
        # Remaining chunks sent as new messages
        for i, chunk in enumerate(chunks[1:], start=2):
            label = f"\n\n⏬ _({i}/{len(chunks)})_" if i < len(chunks) else ""
            try:
                await message.reply(chunk + label, parse_mode="HTML")
            except Exception:
                await message.reply(chunk + label)
            await asyncio.sleep(0.5)  # rate-limit safety

    # Archivist log — metadata only (response already shown above)
    roles = list(gateway.config["brigades"][actual_brigade]["roles"].keys())
    await gateway.archivist.send_summary(
        f"📊 Pipeline ({actual_brigade})",
        f"Промпт: {prompt[:120]}{'…' if len(prompt) > 120 else ''}\n"
        f"Pipeline: {chain_str}\n"
        f"Бригада: {actual_brigade} ({len(roles)} ролей)\n"
        f"GC: {gateway.memory_gc.get_stats()}",
    )
