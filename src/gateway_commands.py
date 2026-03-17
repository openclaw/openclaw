"""
Gateway Telegram command handlers.

Extracted from OpenClawGateway to keep main.py under 500 LOC.
Each handler receives `self` (OpenClawGateway instance) via binding in __init__.
"""

import asyncio
import base64

import aiohttp
import structlog
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
)

logger = structlog.get_logger("GatewayCommands")


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
        await callback.answer("Запускаю VRAM тест...")
        await cmd_test(gateway, callback.message)
    else:
        await callback.answer()


async def handle_unknown_command(gateway, message: Message):
    """Ignore or warn about unknown Telegram menu commands."""
    if message.from_user.id != gateway.admin_id:
        return
    await message.reply("⚠️ Неизвестная команда. Если это кнопка из меню, убедитесь, что она реализована.")


async def cmd_research(gateway, message: Message):
    """Deep Research: multi-step web search + memory synthesis."""
    if message.from_user.id != gateway.admin_id:
        return
    question = (message.text or "").replace("/research", "", 1).strip()
    if not question:
        await message.reply("Использование: `/research ваш вопрос`", parse_mode="Markdown")
        return

    status_msg = await message.reply("🔬 *Deep Research* запущен...", parse_mode="Markdown")

    async def update_status(role, model, text):
        try:
            escaped = gateway.archivist.escape_markdown(text)
            await status_msg.edit_text(f"🔬 *Deep Research*\n_{escaped}_", parse_mode="MarkdownV2")
        except Exception:
            pass

    try:
        from src.deep_research import DeepResearchPipeline
        router = gateway.config["system"]["model_router"]
        research_model = router.get("research", router.get("general", "Qwen/Qwen2.5-Coder-14B-Instruct-AWQ"))
        dr = DeepResearchPipeline(
            vllm_url=gateway.vllm_url,
            model=research_model,
            mcp_client=gateway.pipeline.openclaw_mcp,
        )
        result = await dr.research(question, status_callback=update_status)
        report = result["report"]
        sources_count = len(result.get("sources", []))
        iterations = result.get("iterations", 0)
        verified = result.get("verified_facts", [])
        refuted = result.get("refuted_facts", [])

        header = (
            f"🔬 *Deep Research* | Итерации: {iterations} | Источники: {sources_count}\n"
            f"✅ Подтверждено: {len(verified)} | ⚠️ Опровергнуто: {len(refuted)}\n\n"
        )
        try:
            await status_msg.edit_text(header + report, parse_mode="Markdown")
        except Exception:
            await status_msg.edit_text(
                f"🔬 Deep Research | Итерации: {iterations} | Источники: {sources_count}\n"
                f"✅ Подтверждено: {len(verified)} | ⚠️ Опровергнуто: {len(refuted)}\n\n{report}"
            )
    except Exception as e:
        logger.error("Deep Research failed", error=str(e))
        await status_msg.edit_text(f"❌ Deep Research ошибка: {e}")


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
        "/research — Глубокое исследование (web+memory)\n\n"
        "💬 *Текстовый запрос* — автоматически маршрутизируется\n"
        "в бригаду Dmarket или OpenClaw через Intent Classifier."
    )
    await message.reply(help_text, parse_mode="Markdown")


async def cmd_start(gateway, message: Message):
    if message.from_user.id != gateway.admin_id:
        await message.reply("⛔ Access Denied. Locked to Admin.")
        return

    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📊 Статус Системы", callback_data="cmd_status")],
        [InlineKeyboardButton(text="🧠 Список Моделей", callback_data="cmd_models")],
        [InlineKeyboardButton(text="🔬 VRAM Тест", callback_data="cmd_test")]
    ])

    await message.reply(
        "🦞 *OpenClaw v2026: Dual-Brigade Online*\n\n"
        f"🛠️ GPU: {gateway.config['system']['hardware']['target_gpu']}\n"
        f"🧠 Модели: Llama-3.1-8B / DeepSeek-R1-8B / Gemma-3-12B / Qwen2.5-Coder-7B\n"
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
    except Exception:
        pass

    total_roles = sum(len(brigade["roles"]) for brigade in gateway.config["brigades"].values())

    status_msg = (
        f"🛠️ *System Status:*\n\n"
        f"📦 Framework: `{gateway.config['system']['framework']}` v{gateway.config['system']['version']}\n"
        f"🎮 GPU: `{gateway.config['system']['hardware']['target_gpu']}`\n"
        f"💾 VRAM: {gateway.config['system']['hardware']['vram_limit_gb']}GB\n"
        f"📡 vLLM: `{gateway.vllm_url}` — {vllm_status}\n"
        f"🏴 Бригады: Dmarket + OpenClaw ({total_roles} ролей)\n"
        f"🧠 Inference: {gateway.config['system']['hardware']['inference_engine']}"
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

    models_msg = "🧠 *Модели по бригадам:*\n\n"
    for brigade_name, brigade_info in gateway.config["brigades"].items():
        models_msg += f"🏴 *{brigade_name}:*\n"
        for role, data in brigade_info["roles"].items():
            models_msg += f"  • `{role}` → `{data['model']}`\n"
        models_msg += "\n"

    all_models = set()
    for brigade_info in gateway.config["brigades"].values():
        for data in brigade_info["roles"].values():
            all_models.add(data["model"])
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


async def cmd_test(gateway, message: Message):
    if message.from_user.id != gateway.admin_id:
        return

    await message.reply(
        "🔬 Запускаю VRAM-тестирование всех моделей...\nЭто может занять 10-20 минут.",
        parse_mode="Markdown",
    )

    try:
        process = await asyncio.create_subprocess_exec(
            "python",
            "pull_and_test.py",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=".",
        )
        stdout, stderr = await process.communicate()

        if process.returncode == 0:
            await message.reply(
                "✅ VRAM-тест завершён! Результаты отправлены в чат.", parse_mode="Markdown"
            )
        else:
            error = stderr.decode()[:500] if stderr else "Unknown error"
            await message.reply(
                f"❌ Ошибка тестирования:\n```\n{error}\n```", parse_mode="Markdown"
            )
    except Exception as e:
        await message.reply(f"❌ Не удалось запустить тест: `{e}`", parse_mode="Markdown")


async def cmd_test_all_models(gateway, message: Message):
    if message.from_user.id != gateway.admin_id:
        return

    status_msg = await message.reply(
        "🚀 *Начинаю тестирование 20 моделей!*\n\nКаждая из ролей сейчас пройдет проверку отклика, чтобы подтвердить свои эмоции и характер. Ожидайте...",
        parse_mode="Markdown",
    )

    final_report = "📊 *Отчет: Парад Планет (20 Ролей)*\n\n"

    async def fetch_hello(session, role_name, model_name, sys_prompt):
        payload = {
            "model": model_name,
            "messages": [
                {
                    "role": "system",
                    "content": f"{sys_prompt}. Представься одним коротким предложением (максимум 5-7 слов), используя свои эмодзи.",
                },
                {"role": "user", "content": "Привет, проверка связи!"},
            ],
            "stream": False,
            "max_tokens": 128,
        }
        try:
            timeout = aiohttp.ClientTimeout(total=30)
            async with session.post(
                f"{gateway.vllm_url}/chat/completions", json=payload, timeout=timeout
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data["choices"][0]["message"]["content"].strip().replace("\n", " ")
                else:
                    return f"⚠️ Ошибка vLLM ({resp.status})"
        except Exception as e:
            return f"❌ Error: {e}"

    async with aiohttp.ClientSession() as session:
        for brigade_name, brigade_info in gateway.config["brigades"].items():
            final_report += f"🏴 *Бригада: {brigade_name}*\n"

            for role, data in brigade_info["roles"].items():
                sys_prompt = data.get("system_prompt", "Обычный ассистент")
                model_name = data.get("model")

                await gateway.archivist.send_status(role, model_name, "Пингую vLLM...")

                response_text = await fetch_hello(session, role, model_name, sys_prompt)
                final_report += f"• `{role}`: {response_text}\n"

            final_report += "\n"

    await gateway.archivist.send_summary("Результаты тестирования всех ролей", final_report)
    await status_msg.edit_text(
        "✅ *Тестирование завершено!*\nВсе данные отправлены.", parse_mode="Markdown"
    )


async def handle_photo(gateway, message: Message):
    """Handle image inputs via vLLM vision model."""
    if message.from_user.id != gateway.admin_id:
        return

    from prometheus_client import Counter
    PROMPT_COUNTER = Counter("openclaw_prompts_photo", "Photo prompts received")
    PROMPT_COUNTER.inc()
    status_msg = await message.reply("🖼️ Анализирую изображение через vLLM Vision...")

    try:
        photo = message.photo[-1]
        file_info = await gateway.bot.get_file(photo.file_id)
        file_bytes = await gateway.bot.download_file(file_info.file_path)
        base64_img = base64.b64encode(file_bytes.read()).decode("utf-8")

        prompt = message.caption or "Опиши это изображение"

        vision_model = "meta-llama/Llama-3.2-11B-Vision-Instruct"

        if gateway.vllm_manager:
            await gateway.vllm_manager.ensure_model_loaded(vision_model)

        payload = {
            "model": vision_model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{base64_img}"}},
                    ],
                }
            ],
            "stream": False,
            "max_tokens": 1024,
        }

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{gateway.vllm_url}/chat/completions", json=payload, timeout=60
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    content = data["choices"][0]["message"]["content"].strip()
                    await status_msg.edit_text(
                        f"🖼️ *Анализ Vision:*\n\n{content}",
                        parse_mode="Markdown",
                    )
                else:
                    await status_msg.edit_text(f"⚠️ Ошибка vLLM Vision ({resp.status})")
    except Exception as e:
        await status_msg.edit_text(f"❌ Ошибка обработки фото: {e}")
