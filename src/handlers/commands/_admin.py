"""Admin / system commands: start, help, status, models, history, perf, callbacks."""

import structlog
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
)

logger = structlog.get_logger("GatewayCommands.Admin")


async def handle_callback_query(gateway, callback: CallbackQuery):
    """Handle inline button presses."""
    if callback.from_user.id != gateway.admin_id:
        await callback.answer("⛔ Access Denied.")
        return

    action = callback.data
    if action == "cmd_status":
        await cmd_status(gateway, callback.message, from_callback=True)
        await callback.answer()
    elif action == "cmd_models":
        await cmd_models(gateway, callback.message, from_callback=True)
        await callback.answer()
    elif action == "cmd_test":
        await callback.answer("Запускаю тест моделей...")
        from src.handlers.commands._tools import cmd_test
        await cmd_test(gateway, callback.message)
    elif action == "cmd_history":
        await cmd_history(gateway, callback.message)
        await callback.answer()
    elif action == "cmd_perf":
        await cmd_perf(gateway, callback.message)
        await callback.answer()
    else:
        await callback.answer()


async def handle_unknown_command(gateway, message: Message):
    """Ignore or warn about unknown Telegram menu commands."""
    if message.from_user.id != gateway.admin_id:
        return
    await message.reply("⚠️ Неизвестная команда. Если это кнопка из меню, убедитесь, что она реализована.")


async def cmd_help(gateway, message: Message):
    if message.from_user.id != gateway.admin_id:
        await message.reply("⛔ Access Denied.")
        return
    help_text = (
        "🦞 *OpenClaw — Список команд:*\n\n"
        "/start — Главное меню с кнопками\n"
        "/help — Эта справка\n"
        "/status — Статус системы (API, бригады)\n"
        "/models — Список моделей по бригадам\n"
        "/test — Запустить тест моделей\n"
        "/test_all_models — Тест всех 20 ролей (10-20 мин)\n"
        "/research — Глубокое исследование (web+memory)\n"
        "/history — Последние задачи и результаты\n"
        "/perf — Метрики латенции и скорости\n\n"
        "💬 *Текстовый запрос* — автоматически маршрутизируется\n"
        "в бригаду Dmarket или OpenClaw через Intent Classifier.\n"
        "🎤 *Голосовое сообщение* — STT → текст → бригада\n"
        "📎 *Документ (PDF/TXT)* — извлечение текста → бригада"
    )
    await message.reply(help_text, parse_mode="Markdown")


async def cmd_start(gateway, message: Message):
    if message.from_user.id != gateway.admin_id:
        await message.reply("⛔ Access Denied. Locked to Admin.")
        return

    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📊 Статус Системы", callback_data="cmd_status")],
        [InlineKeyboardButton(text="🧠 Список Моделей", callback_data="cmd_models")],
        [InlineKeyboardButton(text="🔬 Тест Моделей", callback_data="cmd_test")],
        [InlineKeyboardButton(text="📜 История задач", callback_data="cmd_history")],
        [InlineKeyboardButton(text="⚡ Производительность", callback_data="cmd_perf")],
    ])

    unique_models = set()
    for brigade in gateway.config.get("brigades", {}).values():
        for role in brigade.get("roles", {}).values():
            m = role.get("openrouter_model", role.get("model", ""))
            if m:
                short = m.rsplit("/", 1)[-1]
                for suffix in (":free",):
                    short = short.replace(suffix, "")
                unique_models.add(short)
    models_str = " / ".join(sorted(unique_models)) or "N/A"

    await message.reply(
        "🦞 *OpenClaw v2026: Dual-Brigade Online*\n\n"
        f"🧠 Модели: {models_str}\n"
        f"📡 Inference: OpenRouter API (cloud)\n\n"
        "Выбери нужный раздел меню ниже или отправь задачу текстом для роутинга в бригаду.",
        parse_mode="Markdown",
        reply_markup=keyboard,
    )


async def cmd_status(gateway, message: Message, from_callback: bool = False):
    if message.from_user.id != gateway.admin_id:
        return

    total_roles = sum(len(brigade["roles"]) for brigade in gateway.config["brigades"].values())

    openrouter_cfg = gateway.config.get("system", {}).get("openrouter", {})
    has_api_key = bool(openrouter_cfg.get("api_key", ""))
    cloud_status = "✅ Online" if has_api_key else "⚠️ API key not set"

    status_msg = (
        f"🛠️ *System Status:*\n\n"
        f"📦 Framework: `{gateway.config['system']['framework']}` v{gateway.config['system']['version']}\n"
        f"☁️ Cloud API: {cloud_status}\n"
        f"🏴 Бригады: Dmarket + OpenClaw ({total_roles} ролей)\n"
        f"🧠 Inference: OpenRouter API (cloud-only)"
    )
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🔄 Обновить статус", callback_data="cmd_status")],
        [InlineKeyboardButton(text="⬅️ Назад", callback_data="cmd_models")],
    ])

    if from_callback:
        try:
            await message.edit_text(status_msg, parse_mode="Markdown", reply_markup=keyboard)
        except Exception:
            pass
    else:
        await message.reply(status_msg, parse_mode="Markdown", reply_markup=keyboard)


async def cmd_models(gateway, message: Message, from_callback: bool = False):
    if message.from_user.id != gateway.admin_id and not from_callback:
        return

    openrouter_cfg = gateway.config.get("system", {}).get("openrouter", {})

    models_msg = "🧠 *Модели по бригадам:*\n\n"
    for brigade_name, brigade_info in gateway.config["brigades"].items():
        models_msg += f"🏴 *{brigade_name}:*\n"
        for role, data in brigade_info["roles"].items():
            display_model = data.get("openrouter_model", data["model"])
            models_msg += f"  • `{role}` → `{display_model}`\n"
        models_msg += "\n"

    all_models = set()
    for brigade_info in gateway.config["brigades"].values():
        for data in brigade_info["roles"].values():
            m = data.get("openrouter_model", data["model"])
            all_models.add(m)
    models_msg += f"📊 *Уникальных моделей:* {len(all_models)}"

    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📋 Статус системы", callback_data="cmd_status")],
    ])

    if from_callback:
        try:
            await message.edit_text(models_msg, parse_mode="Markdown", reply_markup=keyboard)
        except Exception:
            pass
    else:
        await message.reply(models_msg, parse_mode="Markdown", reply_markup=keyboard)


async def cmd_history(gateway, message: Message):
    """Show recent pipeline execution history."""
    if message.from_user.id != gateway.admin_id:
        return

    history = getattr(gateway, '_pipeline_history', [])
    if not history:
        await message.reply("📜 История пуста — ещё не было выполненных задач.")
        return

    msg = "📜 *Последние задачи:*\n\n"
    for i, entry in enumerate(history[-10:], 1):
        ts = entry.get("timestamp", "?")
        brigade = entry.get("brigade", "?")
        prompt_short = entry.get("prompt", "?")[:60]
        chain = entry.get("chain", "?")
        duration = entry.get("duration_sec", 0)
        status = entry.get("status", "?")
        icon = "✅" if status == "completed" else "❌"

        msg += (
            f"{icon} *{i}.* `{ts}`\n"
            f"   📋 {prompt_short}...\n"
            f"   🏴 {brigade} | ⛓ {chain} | ⏱ {duration:.1f}s\n\n"
        )

    try:
        await message.reply(msg, parse_mode="Markdown")
    except Exception:
        await message.reply(msg.replace("*", "").replace("`", ""))


async def cmd_perf(gateway, message: Message):
    """Show inference performance metrics."""
    if message.from_user.id != gateway.admin_id:
        return

    metrics = getattr(gateway, '_perf_metrics', [])
    if not metrics:
        await message.reply("⚡ Метрики пусты — ещё не было inference вызовов.")
        return

    total_calls = len(metrics)
    total_tokens = sum(m.get("tokens", 0) for m in metrics)
    total_time = sum(m.get("duration_sec", 0) for m in metrics)
    avg_toks = total_tokens / total_time if total_time > 0 else 0
    avg_latency = total_time / total_calls if total_calls > 0 else 0

    role_stats = {}
    for m in metrics:
        role = m.get("role", "unknown")
        if role not in role_stats:
            role_stats[role] = {"calls": 0, "tokens": 0, "time": 0}
        role_stats[role]["calls"] += 1
        role_stats[role]["tokens"] += m.get("tokens", 0)
        role_stats[role]["time"] += m.get("duration_sec", 0)

    msg = (
        "⚡ *Метрики производительности:*\n\n"
        f"📊 Вызовов: {total_calls}\n"
        f"🔢 Токенов: {total_tokens:,}\n"
        f"⏱ Общее время: {total_time:.1f}s\n"
        f"🚀 Средняя скорость: *{avg_toks:.1f} tok/s*\n"
        f"⏳ Средняя латенция: {avg_latency:.2f}s\n\n"
        "📋 *По ролям:*\n"
    )

    for role, stats in sorted(role_stats.items(), key=lambda x: x[1]["time"], reverse=True)[:10]:
        role_toks = stats["tokens"] / stats["time"] if stats["time"] > 0 else 0
        msg += f"  • `{role}`: {stats['calls']} calls, {role_toks:.1f} tok/s\n"

    try:
        await message.reply(msg, parse_mode="Markdown")
    except Exception:
        await message.reply(msg.replace("*", "").replace("`", ""))
