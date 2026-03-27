"""Status, start, models, and help command handlers."""

import aiohttp
import structlog
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
)

logger = structlog.get_logger("BotCommands.Status")


async def cmd_help(gateway, message: Message):
    if message.from_user.id != gateway.admin_id:
        await message.reply("⛔ Access Denied.")
        return
    help_text = (
        "🦞 *OpenClaw — Список команд:*\n\n"
        "/start — Главное меню с кнопками\n"
        "/help — Эта справка\n"
        "/status — Статус системы (vLLM, GPU, бригады)\n"
        "/models — Список моделей по бригадам\n"
        "/test — Запустить VRAM-тест\n"
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
        [InlineKeyboardButton(text="🔬 VRAM Тест", callback_data="cmd_test")],
        [InlineKeyboardButton(text="📜 История задач", callback_data="cmd_history")],
        [InlineKeyboardButton(text="⚡ Производительность", callback_data="cmd_perf")],
    ])

    openrouter_cfg = gateway.config.get("system", {}).get("openrouter", {})
    openrouter_on = openrouter_cfg.get("enabled", False) and openrouter_cfg.get("api_key", "")
    unique_models = set()
    for brigade in gateway.config.get("brigades", {}).values():
        for role in brigade.get("roles", {}).values():
            m = role.get("openrouter_model", role.get("model", "")) if openrouter_on else role.get("model", "")
            if m:
                short = m.rsplit("/", 1)[-1]
                for suffix in ("-AWQ", "-GGUF", "-GPTQ", ":free"):
                    short = short.replace(suffix, "")
                unique_models.add(short)
    models_str = " / ".join(sorted(unique_models)) or "N/A"

    await message.reply(
        "🦞 *OpenClaw v2026: Dual-Brigade Online*\n\n"
        f"🛠️ GPU: {gateway.config['system']['hardware']['target_gpu']}\n"
        f"🧠 Модели: {models_str}\n"
        f"📡 vLLM: `{gateway.vllm_url}`\n\n"
        "Выбери нужный раздел меню ниже или отправь задачу текстом для роутинга в бригаду.",
        parse_mode="Markdown",
        reply_markup=keyboard
    )


async def cmd_status(gateway, message: Message, from_callback: bool = False):
    if message.from_user.id != gateway.admin_id:
        return

    vllm_status = "❌ Недоступен"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{gateway.vllm_url}/models", timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    model_count = len(data.get("data", []))
                    vllm_status = f"✅ Online ({model_count} моделей)"
                else:
                    vllm_status = f"⚠️ HTTP {resp.status}"
    except Exception as e:
        logger.debug("vLLM status check failed", error=str(e))

    brigade_names = list(gateway.config.get("brigades", {}).keys())
    total_roles = sum(len(brigade["roles"]) for brigade in gateway.config["brigades"].values())

    openrouter_cfg = gateway.config.get("system", {}).get("openrouter", {})
    openrouter_on = openrouter_cfg.get("enabled", False) and openrouter_cfg.get("api_key", "")
    inference_label = "OpenRouter API (vLLM fallback)" if openrouter_on else gateway.config['system']['hardware']['inference_engine']
    brigades_display = " + ".join(brigade_names) if brigade_names else "N/A"

    status_msg = (
        f"🛠️ *System Status:*\n\n"
        f"📦 Framework: `{gateway.config['system']['framework']}` v{gateway.config['system']['version']}\n"
        f"🎮 GPU: `{gateway.config['system']['hardware']['target_gpu']}`\n"
        f"💾 VRAM: {gateway.config['system']['hardware']['vram_limit_gb']}GB\n"
        f"📡 vLLM: `{gateway.vllm_url}` — {vllm_status}\n"
        f"🏴 Бригады: {brigades_display} ({total_roles} ролей)\n"
        f"🧠 Inference: {inference_label}"
    )
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🔄 Обновить статус", callback_data="cmd_status")],
        [InlineKeyboardButton(text="⬅️ Назад", callback_data="cmd_models")]
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
    openrouter_on = openrouter_cfg.get("enabled", False) and openrouter_cfg.get("api_key", "")

    models_msg = "🧠 *Модели по бригадам:*\n\n"
    for brigade_name, brigade_info in gateway.config["brigades"].items():
        models_msg += f"🏴 *{brigade_name}:*\n"
        for role, data in brigade_info["roles"].items():
            display_model = data.get("openrouter_model", data["model"]) if openrouter_on else data["model"]
            models_msg += f"  • `{role}` → `{display_model}`\n"
        models_msg += "\n"

    all_models = set()
    for brigade_info in gateway.config["brigades"].values():
        for data in brigade_info["roles"].values():
            m = data.get("openrouter_model", data["model"]) if openrouter_on else data["model"]
            all_models.add(m)
    models_msg += f"📊 *Уникальных моделей:* {len(all_models)}"

    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📋 Статус системы", callback_data="cmd_status")]
    ])

    if from_callback:
        try:
            await message.edit_text(models_msg, parse_mode="Markdown", reply_markup=keyboard)
        except Exception:
            pass
    else:
        await message.reply(models_msg, parse_mode="Markdown", reply_markup=keyboard)
