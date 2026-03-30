import asyncio
import json
import os
import sys

from dotenv import load_dotenv
load_dotenv()

import structlog
from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command
from aiogram.types import BotCommand
from prometheus_client import start_http_server
from watchdog.observers import Observer

from src.archivist_telegram import TelegramArchivist
from src.boot import (
    ConfigReloader,
    acquire_lock,
    configure_llm_and_pipeline,
    release_lock,
    setup_structlog,
)
from src.bot_commands import (
    cmd_agent, cmd_agents, cmd_diag, cmd_help, cmd_history, cmd_models,
    cmd_openrouter_test, cmd_perf, cmd_research, cmd_start,
    cmd_status, cmd_tailscale, cmd_test, cmd_test_all_models,
    handle_callback_query, handle_document, handle_photo,
    handle_unknown_command, handle_video, handle_voice,
)
from src.handlers.prompt_handler import handle_prompt
from src.memory_gc import MemoryGarbageCollector
from src.pipeline_executor import PipelineExecutor
from src.safety_guardrails import HallucinationDetector, PromptInjectionDefender
from src.tailscale_monitor import TailscaleMonitor

setup_structlog()
logger = structlog.get_logger("OpenClawGateway")


class OpenClawGateway:
    def __init__(self, config_path: str = "config/openclaw_config.json"):
        self.config_path = config_path
        with open(config_path, "r", encoding="utf-8") as f:
            self.config = json.loads(os.path.expandvars(f.read()))

        # Pydantic-validated Telegram config (strips ${} wrappers, validates format)
        from src.handlers.tg_schemas import TelegramConfig
        _tg_raw = self.config["system"]["telegram"]
        _tg = TelegramConfig(**_tg_raw)
        self.bot_token = _tg.bot_token
        self.admin_id = int(_tg.admin_chat_id)
        # Initialize Tailscale monitor
        self.tailscale = TailscaleMonitor(self.config)

        self.bot = Bot(token=self.bot_token)
        self.dp = Dispatcher()
        self.archivist = TelegramArchivist(self.bot_token, str(self.admin_id))
        self.pipeline = PipelineExecutor(self.config)
        self.memory_gc = MemoryGarbageCollector(self.config)
        self._intent_cache: dict = {}  # Simple cache for intent classification
        self.processed_task_hashes = set()

        # Safety Guardrails (zero-VRAM heuristic checks)
        self.injection_defender = PromptInjectionDefender(strictness="medium")
        self.hallucination_detector = HallucinationDetector()

        # Pipeline history & performance metrics storage
        self._pipeline_history: list = []
        self._perf_metrics: list = []

        # Watchdog for Config
        self._observer = Observer()
        self._observer.schedule(
            ConfigReloader(self.reload_config),
            os.path.dirname(self.config_path) or ".",
            recursive=False,
        )
        self._observer.start()

        # Start Prometheus metrics server on port 9090
        try:
            start_http_server(9090)
            logger.info("Prometheus metrics server started on port 9090")
        except Exception as e:
            logger.error(f"Failed to start Prometheus server: {e}")

        # Register Handlers (delegating to gateway_commands module)
        # NOTE: async wrappers required — plain lambdas returning coroutines are NOT awaited by aiogram
        def _aw(fn):
            async def wrapper(event):
                await fn(self, event)
            return wrapper

        self.dp.message.register(_aw(cmd_start), Command("start"))
        self.dp.message.register(_aw(cmd_help), Command("help"))
        self.dp.message.register(_aw(cmd_status), Command("status"))
        self.dp.message.register(_aw(cmd_models), Command("models"))
        self.dp.message.register(_aw(cmd_test), Command("test"))
        self.dp.message.register(_aw(cmd_test_all_models), Command("test_all_models"))
        self.dp.message.register(_aw(cmd_research), Command("research"))
        self.dp.message.register(_aw(cmd_tailscale), Command("tailscale"))
        self.dp.message.register(_aw(handle_photo), F.photo)
        self.dp.message.register(_aw(handle_voice), F.voice)
        self.dp.message.register(_aw(handle_document), F.document)
        self.dp.message.register(_aw(handle_video), F.video)
        self.dp.message.register(_aw(handle_video), F.video_note)
        self.dp.message.register(_aw(cmd_history), Command("history"))
        self.dp.message.register(_aw(cmd_perf), Command("perf"))
        self.dp.message.register(_aw(cmd_agents), Command("agents"))
        self.dp.message.register(_aw(cmd_agent), Command("agent"))
        self.dp.message.register(_aw(cmd_openrouter_test), Command("openrouter_test"))
        self.dp.message.register(_aw(cmd_diag), Command("diag"))
        
        # Заглушка для неизвестных команд
        self.dp.message.register(_aw(handle_unknown_command), F.text.startswith('/'))
        
        # Перехват только текста, который НЕ является командой
        async def _prompt_handler(msg):
            await handle_prompt(self, msg)
        self.dp.message.register(_prompt_handler, F.text & ~F.text.startswith('/'))
        
        # Callback query handler for inline buttons
        self.dp.callback_query.register(_aw(handle_callback_query))

        # Background logic
        self._bg_tasks = set()

    async def reload_config(self):
        try:
            from src.auto_rollback import AutoRollback
            rollback = AutoRollback(os.path.dirname(os.path.abspath(self.config_path)))
            try:
                rollback.create_checkpoint("pre-config-reload")
            except Exception:
                pass
            with open(self.config_path, "r", encoding="utf-8") as f:
                new_config = json.loads(os.path.expandvars(f.read()))
            self.config = new_config
            self.pipeline.config = new_config
            logger.info("Configuration successfully hot-reloaded.")
            try:
                rollback.finalize("config-reload-success")
            except Exception:
                pass
        except Exception as e:
            logger.error(f"Failed to reload config: {e}")

    async def run(self):
        logger.info("Starting OpenClaw Gateway...")
        logger.info("Admin ID", admin_id=self.admin_id)

        # --- Heartbeat: first-signal test ---
        from src.boot._heartbeat import send_heartbeat, TelegramInitLogger, crash_reporter
        heartbeat_ok = await send_heartbeat(self.bot_token, self.admin_id)
        if not heartbeat_ok:
            logger.critical("Heartbeat failed — Telegram unreachable. Aborting.")
            return

        self._tg_init_log = TelegramInitLogger(self.bot_token, self.admin_id)
        self._crash_reporter = crash_reporter

        # Delegate heavy init to boot module (with live-logging)
        try:
            await configure_llm_and_pipeline(self)
        except Exception as exc:
            await crash_reporter(self.bot_token, self.admin_id, exc, context="configure_llm_and_pipeline")
            raise

        # Support ENV vars from start_wsl.sh
        use_webhook_env = os.environ.get("USE_WEBHOOK")
        if use_webhook_env == "1":
            use_webhook = True
            self.webhook_url = os.environ.get("WEBHOOK_URL", "")
        else:
            use_webhook = self.config["system"]["telegram"].get("use_webhook", False)
            self.webhook_url = self.config["system"]["telegram"].get("webhook_url", "")

        # Notify admin that init is complete
        if hasattr(self, '_tg_init_log'):
            await self._tg_init_log.stage("✅", "OpenClaw Gateway", "Все модули загружены. Бот готов.")

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
                # Register bot commands in Telegram menu ("Меню" button)
                await self.bot.set_my_commands([
                    BotCommand(command="start", description="Главное меню"),
                    BotCommand(command="help", description="Список всех команд"),
                    BotCommand(command="status", description="Статус системы"),
                    BotCommand(command="models", description="Список моделей"),
                    BotCommand(command="test", description="Тест системы"),
                    BotCommand(command="test_all_models", description="Тест всех 20 ролей"),
                ])
                logger.info("Bot commands registered in Telegram menu")
                await self.dp.start_polling(self.bot)
        except Exception as e:
            logger.error("startup_failed", error=str(e))
            if hasattr(self, '_crash_reporter'):
                await self._crash_reporter(self.bot_token, self.admin_id, e, context="polling/webhook")
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
