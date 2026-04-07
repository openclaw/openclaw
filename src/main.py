import asyncio
import json
import os
import re
import sys

from dotenv import load_dotenv
load_dotenv()

import structlog
from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command
from aiogram.types import BotCommand
from prometheus_client import start_http_server
from watchdog.observers import Observer

from src.integrations.archivist_telegram import TelegramArchivist
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
    cmd_train, cmd_rl_status,
    handle_callback_query, handle_document, handle_photo,
    handle_unknown_command, handle_video, handle_voice,
)
from src.handlers.prompt_handler import handle_prompt
from src.handlers.tg_schemas import TelegramConfig
from src.memory_system.gc import MemoryGarbageCollector
from src.pipeline._core import PipelineExecutor
from src.safety import HallucinationDetector, OutputSafetyFilter, PromptInjectionDefender
from src.integrations.tailscale_monitor import TailscaleMonitor

setup_structlog()
logger = structlog.get_logger("OpenClawGateway")


class OpenClawGateway:
    def __init__(self, config_path: str = "config/openclaw_config.json"):
        self.config_path = config_path
        with open(config_path, "r", encoding="utf-8") as f:
            raw = os.path.expandvars(f.read())

        # Warn about unresolved ${...} env vars (mask values to prevent secret leakage)
        unresolved = re.findall(r'\$\{([^}]+)\}', raw)
        if unresolved:
            masked = [v[:3] + "***" if len(v) > 3 else "***" for v in unresolved]
            logger.warning("Unresolved env vars in config", count=len(masked), hints=masked)

        self.config = json.loads(raw)

        # Pydantic-validated Telegram config (strips ${} wrappers, validates format)
        _tg_raw = self.config.get("system", {}).get("telegram", {})
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
        self.output_filter = OutputSafetyFilter()

        # Pipeline history & performance metrics storage
        self._pipeline_history: list = []
        self._perf_metrics: list = []

        # Watchdog for Config
        self._observer = Observer()
        self._config_reloader = ConfigReloader(self.reload_config)
        self._observer.schedule(
            self._config_reloader,
            os.path.dirname(self.config_path) or ".",
            recursive=False,
        )
        self._observer.start()

        # Start Prometheus metrics server on port 9090
        try:
            start_http_server(9090)
            logger.info("Prometheus metrics server started", port=9090)
        except Exception as e:
            logger.error("Failed to start Prometheus server", error=str(e))

        # Register Handlers (async wrappers inject `self` as first arg)
        self._register_handlers()

        # Background logic
        self._bg_tasks = set()
        self._reload_lock = asyncio.Lock()

    def _make_handler(self, fn):
        """Wrap a command handler so `self` (gateway) is injected as first arg."""
        async def wrapper(event):
            await fn(self, event)
        return wrapper

    def _register_handlers(self):
        """Register all aiogram message/callback handlers."""
        _h = self._make_handler

        # Command handlers
        _commands = [
            (cmd_start, "start"),
            (cmd_help, "help"),
            (cmd_status, "status"),
            (cmd_models, "models"),
            (cmd_test, "test"),
            (cmd_test_all_models, "test_all_models"),
            (cmd_research, "research"),
            (cmd_tailscale, "tailscale"),
            (cmd_history, "history"),
            (cmd_perf, "perf"),
            (cmd_agents, "agents"),
            (cmd_agent, "agent"),
            (cmd_openrouter_test, "openrouter_test"),
            (cmd_diag, "diag"),
            (cmd_train, "train"),
            (cmd_rl_status, "rl_status"),
        ]
        for fn, name in _commands:
            self.dp.message.register(_h(fn), Command(name))

        # Media handlers
        self.dp.message.register(_h(handle_photo), F.photo)
        self.dp.message.register(_h(handle_voice), F.voice)
        self.dp.message.register(_h(handle_document), F.document)
        self.dp.message.register(_h(handle_video), F.video)
        self.dp.message.register(_h(handle_video), F.video_note)

        # Unknown commands catch-all
        self.dp.message.register(_h(handle_unknown_command), F.text.startswith('/'))

        # Text messages that are NOT commands -> prompt handler
        async def _prompt_handler(msg):
            await handle_prompt(self, msg)
        self.dp.message.register(_prompt_handler, F.text & ~F.text.startswith('/'))

        # Callback query handler for inline buttons (exclude hitl: prefix for HITL handler)
        self.dp.callback_query.register(
            _h(handle_callback_query),
            ~F.data.startswith('hitl:'),
        )

    async def reload_config(self):
        async with self._reload_lock:
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
                # B4-fix: update derived values that were cached at init
                try:
                    _tg_new = new_config.get("system", {}).get("telegram", {})
                    if _tg_new.get("admin_chat_id"):
                        self.admin_id = int(_tg_new["admin_chat_id"])
                except (ValueError, KeyError):
                    pass
                if hasattr(self, 'tailscale') and self.tailscale:
                    try:
                        self.tailscale._config = new_config
                        _ts_cfg = new_config.get("system", {}).get("tailscale", {})
                        self.tailscale.enabled = _ts_cfg.get("enabled", True)
                        self.tailscale.health_interval = _ts_cfg.get("health_interval_sec", 60)
                    except Exception:
                        pass
                logger.info("Configuration successfully hot-reloaded.")
                try:
                    rollback.finalize("config-reload-success")
                except Exception:
                    pass
            except Exception as e:
                logger.error("Failed to reload config", error=str(e))

    async def _graceful_shutdown(self):
        """Clean up all background subsystems before exit."""
        logger.info("graceful_shutdown_initiated")
        # Stop file-watcher observer
        try:
            self._observer.stop()
            self._observer.join(timeout=3)
        except Exception:
            pass
        # Stop scheduler
        if hasattr(self, '_scheduler') and self._scheduler:
            try:
                await self._scheduler.shutdown()
            except Exception:
                pass
        # Cancel background tasks
        for task in list(self._bg_tasks):
            task.cancel()
        if self._bg_tasks:
            await asyncio.gather(*self._bg_tasks, return_exceptions=True)
        # Stop MAS orchestrator
        if hasattr(self.pipeline, 'mas_orchestrator'):
            try:
                self.pipeline.mas_orchestrator.stop_autonomous()
            except Exception:
                pass
        # Stop dashboard server
        try:
            from src.web.api import stop_dashboard
            await stop_dashboard()
        except Exception:
            pass
        # Clean up MCP subprocess servers
        if hasattr(self, 'pipeline') and hasattr(self.pipeline, 'mcp_client') and self.pipeline.mcp_client:
            try:
                await self.pipeline.mcp_client.cleanup()
            except Exception as e:
                logger.warning("MCP cleanup error during shutdown", error=str(e))
        # Close shared aiohttp sessions (connection pooling)
        try:
            from src.llm.gateway import close_shared_session
            await close_shared_session()
        except Exception:
            pass
        try:
            from src.llm.openrouter import close_or_session
            await close_or_session()
        except Exception:
            pass
        # Close bot session
        try:
            await self.bot.session.close()
        except Exception:
            pass
        logger.info("graceful_shutdown_complete")

    async def run(self):
        logger.info("Starting OpenClaw Gateway...")
        logger.info("Admin ID", admin_id=self.admin_id)

        # Pass the running event loop to the ConfigReloader (fixes watchdog thread callback)
        import asyncio
        self._config_reloader.set_loop(asyncio.get_running_loop())

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
            await self._graceful_shutdown()


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
