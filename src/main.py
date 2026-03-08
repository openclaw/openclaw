import asyncio
import atexit
import base64
import json
import logging
import os
import re
import subprocess
import sys
from typing import Optional

import structlog
from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message, ForceReply
from prometheus_client import Counter, Gauge, start_http_server
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from src.archivist_telegram import TelegramArchivist
from src.memory_gc import MemoryGarbageCollector
from src.pipeline_executor import PipelineExecutor
from src.risk_manager import RiskManager

# Prometheus metrics
PROMPT_COUNTER = Counter("openclaw_prompts_total", "Total prompts received")
VRAM_GAUGE = Gauge("openclaw_vram_usage_mb", "Estimated VRAM usage")
MODEL_LOAD_GAUGE = Gauge("openclaw_model_loaded", "Is a model currently loaded")

# Structured Logging Setup
structlog.configure(
    processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.dict_tracebacks,
        structlog.processors.JSONRenderer(),
    ],
    logger_factory=structlog.PrintLoggerFactory(),
)
logger = structlog.get_logger("OpenClawGateway")


class ConfigReloader(FileSystemEventHandler):
    def __init__(self, callback):
        self.callback = callback

    def on_modified(self, event):
        if event.src_path.endswith("config/openclaw_config.json"):
            logger.info("Config changed, reloading...")
            self.callback()


LOCK_FILE = os.path.join(os.path.dirname(__file__), ".bot.lock")


def acquire_lock():
    """Prevent multiple bot instances from running."""
    if os.path.exists(LOCK_FILE):
        try:
            with open(LOCK_FILE, "r") as f:
                old_pid = int(f.read().strip())

            try:
                import psutil

                if psutil.pid_exists(old_pid):
                    print(f"❌ Bot is already running (PID {old_pid})! Exiting.")
                    sys.exit(1)
            except ImportError:
                # UNIX fallback
                try:
                    os.kill(old_pid, 0)
                    print(f"❌ Bot is already running (PID {old_pid})! Exiting.")
                    sys.exit(1)
                except OSError:
                    pass
            print(f"⚠️ Stale lock file found (PID {old_pid} dead). Removing...")
        except (ValueError, FileNotFoundError):
            pass

    with open(LOCK_FILE, "w") as f:
        f.write(str(os.getpid()))
    atexit.register(release_lock)


def release_lock():
    """Remove lock file on exit."""
    try:
        if os.path.exists(LOCK_FILE):
            os.remove(LOCK_FILE)
    except OSError:
        pass


# Removed old logging setup


class OpenClawGateway:
    def __init__(self, config_path: str = "config/openclaw_config.json"):
        self.config_path = config_path
        with open(config_path, "r", encoding="utf-8") as f:
            self.config = json.load(f)

        self.bot_token = self.config["system"]["telegram"]["bot_token"]
        self.admin_id = int(self.config["system"]["telegram"]["admin_chat_id"])
        self.ollama_url = self.config["system"].get("ollama_url", "http://192.168.0.212:11434")

        self.bot = Bot(token=self.bot_token)
        self.dp = Dispatcher()
        self.archivist = TelegramArchivist(self.bot_token, str(self.admin_id))
        self.pipeline = PipelineExecutor(self.config, self.ollama_url)
        self.memory_gc = MemoryGarbageCollector(self.ollama_url)
        self._intent_cache: dict = {}  # Simple cache for intent classification

        # Watchdog for Config
        self._observer = Observer()
        self._observer.schedule(
            ConfigReloader(self.reload_config),
            os.path.dirname(self.config_path) or ".",
            recursive=False,
        )
        self._observer.start()

        # Start Prometheus metrics server on port 8000
        try:
            start_http_server(8000)
            logger.info("Prometheus metrics server started on port 8000")
        except Exception as e:
            logger.error(f"Failed to start Prometheus server: {e}")

        # Register Handlers
        self.dp.message.register(self.cmd_start, Command("start"))
        self.dp.message.register(self.cmd_status, Command("status"))
        self.dp.message.register(self.cmd_models, Command("models"))
        self.dp.message.register(self.cmd_test, Command("test"))
        self.dp.message.register(self.cmd_test_all_models, Command("test_all_models"))
        self.dp.message.register(self.handle_photo, F.photo)
        
        # Заглушка для неизвестных команд
        self.dp.message.register(self.handle_unknown_command, F.text.startswith('/'))
        
        # Перехват только текста, который НЕ является командой
        self.dp.message.register(self.handle_prompt, F.text & ~F.text.startswith('/'))
        
        # Callback query handler for inline buttons
        self.dp.callback_query.register(self.handle_callback_query)

    async def handle_callback_query(self, callback: CallbackQuery):
        """Handle inline button presses."""
        if callback.from_user.id != self.admin_id:
            await callback.answer("⛔ Access Denied.")
            return
            
        action = callback.data
        if action == "cmd_status":
            await self.cmd_status(callback.message, from_callback=True)
            await callback.answer()
        elif action == "cmd_models":
            await self.cmd_models(callback.message, from_callback=True)
            await callback.answer()
        elif action == "cmd_test":
            await callback.answer("Запускаю VRAM тест...")
            await self.cmd_test(callback.message)
        else:
            await callback.answer()

    async def handle_unknown_command(self, message: Message):
        """Ignore or warn about unknown Telegram menu commands."""
        if message.from_user.id != self.admin_id:
            return
        await message.reply("⚠️ Неизвестная команда. Если это кнопка из меню, убедитесь, что она реализована.")

    async def cmd_start(self, message: Message):
        if message.from_user.id != self.admin_id:
            await message.reply("⛔ Access Denied. Locked to Admin.")
            return
            
        keyboard = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="📊 Статус Системы", callback_data="cmd_status")],
            [InlineKeyboardButton(text="🧠 Список Моделей", callback_data="cmd_models")],
            [InlineKeyboardButton(text="🔬 VRAM Тест", callback_data="cmd_test")]
        ])
            
        await message.reply(
            "🦞 *OpenClaw v2026: Dual-Brigade Online*\n\n"
            f"🛠️ GPU: {self.config['system']['hardware']['target_gpu']}\n"
            f"🧠 Триада: deepseek-r1:14b / qwen2.5-coder:14b / gemma3:12b\n"
            f"📡 Ollama: `{self.ollama_url}`\n\n"
            "Выбери нужный раздел меню ниже или отправь задачу текстом для роутинга в бригаду.",
            parse_mode="Markdown",
            reply_markup=keyboard
        )

    async def cmd_status(self, message: Message, from_callback: bool = False):
        if message.from_user.id != self.admin_id:
            return

        # Check Ollama connectivity
        import aiohttp

        ollama_status = "❌ Недоступен"
        model_count = 0
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{self.ollama_url}/api/tags", timeout=aiohttp.ClientTimeout(total=5)
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        model_count = len(data.get("models", []))
                        ollama_status = f"✅ Online ({model_count} моделей)"
        except Exception:
            pass

        # Count roles
        total_roles = sum(len(brigade["roles"]) for brigade in self.config["brigades"].values())

        status_msg = (
            f"🛠️ *System Status:*\n\n"
            f"📦 Framework: `{self.config['system']['framework']}` v{self.config['system']['version']}\n"
            f"🎮 GPU: `{self.config['system']['hardware']['target_gpu']}`\n"
            f"💾 VRAM: {self.config['system']['hardware']['vram_limit_gb']}GB (max 1 модель)\n"
            f"📡 Ollama: `{self.ollama_url}` — {ollama_status}\n"
            f"🏴 Бригады: Dmarket + OpenClaw ({total_roles} ролей)\n"
            f"🧠 Inference: {self.config['system']['hardware']['inference_engine']}"
        )
        keyboard = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="🔄 Обновить статус", callback_data="cmd_status")],
            [InlineKeyboardButton(text="⬅️ Назад", callback_data="cmd_models")] 
        ])

        if from_callback:
            try:
                await message.edit_text(status_msg, parse_mode="Markdown", reply_markup=keyboard)
            except Exception:
                pass # Message is not modified
        else:
            await message.reply(status_msg, parse_mode="Markdown", reply_markup=keyboard)

    async def reload_config(self):
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                self.config = json.load(f)
            self.pipeline.config = self.config
            logger.info("Configuration successfully hot-reloaded.")
        except Exception as e:
            logger.error(f"Failed to reload config: {e}")

    def get_ollama_models(self) -> list:
        # This method was not fully provided in the diff, assuming it's meant to be empty or placeholder.
        # If it was intended to have content, it needs to be provided.
        return []

    async def cmd_models(self, message: Message, from_callback: bool = False):
        if message.from_user.id != self.admin_id and not from_callback:
            return

        models_msg = "🧠 *Модели по бригадам:*\n\n"
        for brigade_name, brigade_info in self.config["brigades"].items():
            models_msg += f"🏴 *{brigade_name}:*\n"
            for role, data in brigade_info["roles"].items():
                models_msg += f"  • `{role}` → `{data['model']}`\n"
            models_msg += "\n"

        # Count unique models
        all_models = set()
        for brigade_info in self.config["brigades"].values():
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

    async def cmd_test(self, message: Message):
        if message.from_user.id != self.admin_id:
            return

        await message.reply(
            "🔬 Запускаю VRAM-тестирование всех моделей...\nЭто может занять 10-20 минут.",
            parse_mode="Markdown",
        )

        # Launch pull_and_test.py as subprocess
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

    async def cmd_test_all_models(self, message: Message):
        if message.from_user.id != self.admin_id:
            return

        status_msg = await message.reply(
            "🚀 *Начинаю тестирование 20 моделей!*\n\nКаждая из ролей сейчас пройдет проверку отклика, чтобы подтвердить свои эмоции и характер. Ожидайте...",
            parse_mode="Markdown",
        )

        import aiohttp

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
                "keep_alive": 0,
            }
            try:
                # Set a moderate timeout in case a model isn't pulled or is failing
                timeout = aiohttp.ClientTimeout(total=45)
                async with session.post(
                    f"{self.ollama_url}/api/chat", json=payload, timeout=timeout
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        return data["message"]["content"].strip().replace("\n", " ")
                    else:
                        return f"⚠️ Ошибка API ({resp.status})"
            except Exception as e:
                return f"❌ Timeout/Error: Модель не загружена"

        async with aiohttp.ClientSession() as session:
            for brigade_name, brigade_info in self.config["brigades"].items():
                final_report += f"🏴 *Бригада: {brigade_name}*\n"

                # Check models sequence (simulate Task Queue to avoid VRAM Thrashing)
                for role, data in brigade_info["roles"].items():
                    sys_prompt = data.get("system_prompt", "Обычный ассистент")
                    model_name = data.get("model")

                    # Update status slightly
                    await self.archivist.send_status(role, model_name, "Пингую Ollama API...")

                    response_text = await fetch_hello(session, role, model_name, sys_prompt)
                    final_report += f"• `{role}`: {response_text}\n"

                final_report += "\n"

        # Send final long report using archivist to split correctly
        await self.archivist.send_summary("Результаты тестирования всех ролей", final_report)
        await status_msg.edit_text(
            "✅ *Тестирование завершено!*\nВсе данные отправлены.", parse_mode="Markdown"
        )

    async def handle_photo(self, message: Message):
        """Handle image inputs via LLaVA model."""
        if message.from_user.id != self.admin_id:
            return

        PROMPT_COUNTER.inc()
        status_msg = await message.reply("🖼️ Анализирую изображение через LLaVA...")

        try:
            photo = message.photo[-1]
            file_info = await self.bot.get_file(photo.file_id)
            file_bytes = await self.bot.download_file(file_info.file_path)
            base64_img = base64.b64encode(file_bytes.read()).decode("utf-8")

            prompt = message.caption or "Опиши это изображение"

            import aiohttp

            payload = {
                "model": "llava",
                "prompt": prompt,
                "images": [base64_img],
                "stream": False,
                "keep_alive": 0,
            }

            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.ollama_url}/api/generate", json=payload, timeout=60
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        await status_msg.edit_text(
                            f"🖼️ *Анализ LLaVA:*\n\n{data.get('response', '')}",
                            parse_mode="Markdown",
                        )
                    else:
                        await status_msg.edit_text(f"⚠️ Ошибка LLaVA API ({resp.status})")
        except Exception as e:
            await status_msg.edit_text(f"❌ Ошибка обработки фото: {e}")

    async def classify_intent(self, prompt: str) -> str:
        """
        LLM-based intent classification.
        Uses gemma3:12b for fast and accurate routing.
        Falls back to keyword matching if Ollama is unavailable.
        """
        # Check cache first
        cache_key = prompt.lower().strip()[:100]
        if cache_key in self._intent_cache:
            return self._intent_cache[cache_key]

        # Keyword fallback (always available)
        dmarket_keywords = [
            "buy",
            "sell",
            "dmarket",
            "trade",
            "price",
            "hft",
            "arbitrage",
            "купить",
            "продать",
            "торговля",
            "цена",
            "арбитраж",
            "дмаркет",
            "скин",
            "инвентарь",
            "skin",
            "inventory",
            "target",
            "spread",
        ]
        keyword_result = (
            "Dmarket" if any(kw in prompt.lower() for kw in dmarket_keywords) else "OpenClaw"
        )

        # Try LLM-based classification
        import aiohttp

        try:
            brigades = list(self.config.get("brigades", {}).keys())
            classify_prompt = (
                f"Classify this user request into ONE of these brigades: {', '.join(brigades)}.\n"
                f"Dmarket = trading, buying, selling items, prices, market, skins, inventory.\n"
                f"OpenClaw = system administration, framework, configuration, models, bots.\n\n"
                f"Request: {prompt}\n\n"
                f"Reply with ONLY the brigade name, nothing else."
            )
            payload = {
                "model": "gemma3:12b",
                "prompt": classify_prompt,
                "stream": False,
                "keep_alive": 0,
                "options": {"num_ctx": 1024, "temperature": 0.1},
            }
            async with aiohttp.ClientSession() as session:
                timeout = aiohttp.ClientTimeout(total=10)
                async with session.post(
                    f"{self.ollama_url}/api/generate", json=payload, timeout=timeout
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        result = data.get("response", "").strip()
                        # Validate response is a known brigade
                        for b in brigades:
                            if b.lower() in result.lower():
                                self._intent_cache[cache_key] = b
                                logger.info(
                                    "Intent classified by LLM", brigade=b, raw_response=result
                                )
                                return b
        except Exception as e:
            logger.warning("LLM intent classification failed, using keyword fallback", error=str(e))

        # Fallback to keyword result
        self._intent_cache[cache_key] = keyword_result
        return keyword_result

    async def handle_prompt(self, message: Message):
        if message.from_user.id != self.admin_id:
            return

        PROMPT_COUNTER.inc()
        prompt = message.text
        logger.info("received_prompt", prompt=prompt)

        # Check if it's a reply to ask_user
        is_reply = False
        if message.reply_to_message and getattr(message.reply_to_message.from_user, "id", None) == message.bot.id:
            if hasattr(self, 'pending_ask_user') and message.from_user.id in self.pending_ask_user:
                is_reply = True
                context = self.pending_ask_user.pop(message.from_user.id)
                brigade = context["brigade"]
                original_prompt = context["original_prompt"]
                prompt = f"Ранее я просил: {original_prompt}\nТвой вопрос ко мне. Вот мой ответ/уточнение: {prompt}\nПродолжай задачу с учетом этих новых данных."
                logger.info("Resuming pipeline with user clarification", brigade=brigade)

        # Session Management: Context Auto-Reset
        if not hasattr(self, '_session_msg_count'):
            self._session_msg_count = 0
        self._session_msg_count += 1
        
        reset_limit = self.config.get("system", {}).get("session_management", {}).get("auto_reset_context_messages", 15)
        if self._session_msg_count >= reset_limit:
            self._session_msg_count = 0
            if hasattr(self, 'memory_gc'):
                self.memory_gc._persistent_summary = ""
                self.memory_gc._compression_count = 0
            logger.info("Session context auto-reset triggered (reached max msgs)", limit=reset_limit)
            await message.reply(f"🔄 **Внимание:** Достигнут лимит сессии ({reset_limit} сообщений). Окно контекста и память очищены для экономии VRAM.", parse_mode="Markdown")

        # 1. Intent Classification (LLM-based with keyword fallback)
        if not is_reply:
            brigade = await self.classify_intent(prompt)

        status_msg = await message.reply(
            f"🤖 *Pipeline ({brigade})* запущен...\n_Маршрутизация задачи в бригаду..._",
            parse_mode="Markdown",
        )

        await self.archivist.send_status(
            f"Router ({brigade})", "Intent Classification", f"Задача направлена в бригаду {brigade}"
        )

        # 2. Execute Pipeline (Chain-of-Agents)
        async def update_status(role, model, text):
            try:
                await status_msg.edit_text(
                    f"🏴 *{brigade}* | ⚙️ `{role}` (`{model}`)\n_{text}_", parse_mode="Markdown"
                )
            except Exception:
                pass  # Telegram rate limit on edits

        result = await self.pipeline.execute(
            prompt=prompt,
            brigade=brigade,
            status_callback=update_status,
        )

        if result.get("status") == "ask_user":
            question = result.get("question", "Оркестратору нужно уточнение.")
            if not hasattr(self, 'pending_ask_user'):
                self.pending_ask_user = {}
                
            self.pending_ask_user[message.from_user.id] = {
                "original_prompt": prompt,
                "brigade": brigade
            }
            
            markup = ForceReply(selective=True)
            try:
                await status_msg.edit_text(
                    f"❓ *Вопрос от Оркестратора:*\n\n{question}",
                    parse_mode="Markdown"
                )
                await message.reply("Ответьте на это сообщение для продолжения (Reply):", reply_markup=markup)
            except Exception:
                await message.reply(
                    f"❓ *Вопрос от Оркестратора:*\n\n{question}",
                    parse_mode="Markdown",
                    reply_markup=markup
                )
                
            await self.archivist.send_status(
                f"Router ({brigade})", "Clarification Loop", "Пайплайн приостановлен. Ожидается ответ пользователя."
            )
            return

        llm_response = result["final_response"]
        chain_str = " → ".join(result["chain_executed"])

        # 3. Send final response to User
        try:
            await status_msg.edit_text(
                f"🏴 *Бригада:* {brigade} | *Pipeline:* `{chain_str}`\n\n{llm_response}",
                parse_mode="Markdown",
            )
        except Exception:
            # Markdown parse error fallback
            await status_msg.edit_text(
                f"🏴 Бригада: {brigade} | Pipeline: {chain_str}\n\n{llm_response}"
            )

        # 4. Final Report (для логов Архивариуса)
        roles = list(self.config["brigades"][brigade]["roles"].keys())
        await self.archivist.send_summary(
            f"Pipeline завершён ({brigade})",
            f"Промпт: {prompt}\n\n"
            f"*Pipeline:* {chain_str}\n"
            f"*Ответ:* {llm_response[:300]}...\n\n"
            f"*Бригада:* {brigade} (Ролей: {len(roles)})\n"
            f"*GC Stats:* {self.memory_gc.get_stats()}",
        )

    async def run(self):
        logger.info("Starting OpenClaw Gateway...")
        logger.info("Ollama URL", ollama_url=self.ollama_url)
        logger.info("Admin ID", admin_id=self.admin_id)

        # Support ENV vars from start_wsl.sh
        use_webhook_env = os.environ.get("USE_WEBHOOK")
        if use_webhook_env == "1":
            use_webhook = True
            self.webhook_url = os.environ.get("WEBHOOK_URL", "")
        else:
            use_webhook = self.config["system"]["telegram"].get("use_webhook", False)
            self.webhook_url = self.config["system"]["telegram"].get("webhook_url", "")

        try:
            if use_webhook and self.webhook_url:
                from aiogram.webhook.aiohttp_server import SimpleRequestHandler, setup_application
                from aiohttp import web

                logger.info("starting_webhook", url=self.webhook_url)
                await self.bot.set_webhook(self.webhook_url, drop_pending_updates=True)

                app = web.Application()
                webhook_requests_handler = SimpleRequestHandler(dispatcher=self.dp, bot=self.bot)
                webhook_requests_handler.register(app, path="/webhook")
                setup_application(app, self.dp, bot=self.bot)

                runner = web.AppRunner(app)
                await runner.setup()
                port = self.config["system"]["telegram"].get("webhook_port", 8080)
                site = web.TCPSite(runner, "0.0.0.0", port)
                await site.start()
                logger.info("Webhook server listening", port=port)

                # Keep process alive
                await asyncio.Event().wait()
            else:
                logger.info("starting_polling")
                await self.bot.delete_webhook(drop_pending_updates=True)
                await self.dp.start_polling(self.bot)
        except Exception as e:
            logger.error("startup_failed", error=str(e))
        finally:
            self._observer.stop()
            self._observer.join()
            await self.bot.session.close()


if __name__ == "__main__":
    acquire_lock()
    print("-" * 30)
    print("🚀 OpenClaw Gateway Starting...")
    print(f"🚀 Running on Python {sys.version}")
    print("-" * 30)
    try:
        gateway = OpenClawGateway()
        asyncio.run(gateway.run())
    except KeyboardInterrupt:
        print("\n🛑 OpenClaw Gateway stopped by user (Graceful Shutdown).")
    finally:
        release_lock()
