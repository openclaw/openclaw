"""MCP & LLM Gateway initialisation helpers (extracted from OpenClawGateway.run)."""

import asyncio
import os
import time

import structlog

logger = structlog.get_logger("MCPInit")


async def configure_llm_and_pipeline(gateway) -> None:
    """Wire up LLM gateway, pipeline, scheduler, dashboard, and background tasks.

    Performs the full initialisation sequence that was previously inlined
    inside ``OpenClawGateway.run()``.  Mutates *gateway* in-place (adds
    background tasks, scheduler, etc.).
    """
    # Live init logger (optional, set by OpenClawGateway.run)
    _tg_log = getattr(gateway, '_tg_init_log', None)

    # 1. Unified LLM Gateway (must run before pipeline.initialize)
    from src.llm_gateway import configure as configure_llm_gateway
    configure_llm_gateway(gateway.config)
    if _tg_log:
        await _tg_log.stage("🛠", "LLM Gateway", "Настроен. Модели подключены.")

    # 2. Pipeline (MCP + SuperMemory + RAG)
    await gateway.pipeline.initialize()
    if _tg_log:
        await _tg_log.stage("🧠", "Pipeline + MCP", "Инициализирован. SuperMemory + RAG готовы.")

    # 3. HITL Approval Gate
    if gateway.config.get("hitl", {}).get("enabled", False):
        from src.llm_gateway import set_approval_callback
        from src.handlers.tg_approval import create_approval_notifier, handle_hitl_callback

        notifier = create_approval_notifier(gateway.bot, gateway.admin_id)
        set_approval_callback(notifier)

        def _hitl_aw(fn):
            async def wrapper(callback):
                await fn(gateway, callback)
            return wrapper

        gateway.dp.callback_query.register(
            _hitl_aw(handle_hitl_callback),
            lambda c: (c.data or "").startswith("hitl:"),
        )
        logger.info("HITL Approval Gate enabled")
    if _tg_log:
        hitl_status = "Включен" if gateway.config.get("hitl", {}).get("enabled", False) else "Отключен"
        await _tg_log.stage("🛡", "HITL Approval", hitl_status)

    # 4. Mission Control Dashboard
    dashboard_cfg = gateway.config.get("dashboard", {})
    if dashboard_cfg.get("enabled", False):
        try:
            from src.web.api import init_dashboard, start_dashboard

            gateway._start_time = time.time()
            init_dashboard(gateway=gateway, pipeline=gateway.pipeline, config=gateway.config)
            dash_host = dashboard_cfg.get("host", "127.0.0.1")
            dash_port = dashboard_cfg.get("port", 8800)
            dash_task = asyncio.create_task(start_dashboard(host=dash_host, port=dash_port))
            gateway._bg_tasks.add(dash_task)
            dash_task.add_done_callback(gateway._bg_tasks.discard)
            logger.info("Mission Control Dashboard started", host=dash_host, port=dash_port)
        except Exception as e:
            logger.warning("Mission Control failed to start (non-fatal)", error=str(e))

    # 5. Background tasks (Memory GC, Polling)
    from src.boot._background import scheduled_memory_gc, poll_remote_tasks
    memory_task = asyncio.create_task(scheduled_memory_gc(gateway))
    poll_task = asyncio.create_task(poll_remote_tasks(gateway))
    gateway._bg_tasks.add(memory_task)
    gateway._bg_tasks.add(poll_task)
    memory_task.add_done_callback(gateway._bg_tasks.discard)
    poll_task.add_done_callback(gateway._bg_tasks.discard)

    # 6. ClawHub Marketplace sync
    if hasattr(gateway, "clawhub_client") and gateway.clawhub_client:
        async def _marketplace_sync():
            try:
                result = await gateway.clawhub_client.sync_skills_with_library(
                    getattr(gateway.pipeline, "skill_library", None)
                )
                logger.info("ClawHub Marketplace sync complete", **result)
            except Exception as exc:
                logger.warning("ClawHub Marketplace sync skipped", error=str(exc))

        sync_task = asyncio.create_task(_marketplace_sync())
        gateway._bg_tasks.add(sync_task)
        sync_task.add_done_callback(gateway._bg_tasks.discard)

    # 7. Scheduler (APScheduler cron jobs)
    from src.scheduler import OpenClawScheduler
    gateway._scheduler = OpenClawScheduler(gateway.config, gateway.pipeline, gateway.bot)
    await gateway._scheduler.start()

    # 8. Discord handler (optional)
    discord_cfg = gateway.config.get("discord", {})
    if discord_cfg.get("token") or os.getenv("DISCORD_BOT_TOKEN"):
        from src.discord_handler import DiscordHandler
        gateway._discord = DiscordHandler(gateway.config, gateway.pipeline)
        gateway._discord.run_in_background()
        logger.info("Discord handler started in background")

    # 9. Cloud-only vs vLLM startup
    or_cfg = gateway.config.get("system", {}).get("openrouter", {})
    force_cloud = (
        or_cfg.get("force_cloud", False)
        and or_cfg.get("enabled", False)
        and bool(or_cfg.get("api_key", ""))
        and not or_cfg.get("use_local_models", True)
    )

    if force_cloud:
        logger.info("Cloud-Only mode active: OpenRouter primary, vLLM/WSL/Ollama DISABLED")
        if _tg_log:
            await _tg_log.stage("☁️", "SmartModelRouter", "Cloud-Only mode. OpenRouter primary.")
    else:
        gateway.vllm_manager.start_health_monitor()
        default_model = (
            gateway.config.get("system", {})
            .get("model_router", {})
            .get("general", "meta-llama/llama-3.3-70b-instruct:free")
        )
        preload_task = asyncio.create_task(gateway._preload_model(default_model))
        gateway._bg_tasks.add(preload_task)
        preload_task.add_done_callback(gateway._bg_tasks.discard)

    # 10. Brigade REST API
    brigade_port = int(os.environ.get("BRIGADE_API_PORT", "8765"))
    try:
        from src.brigade_api import run_brigade_api
        brigade_task = asyncio.create_task(
            run_brigade_api(gateway.config, gateway.vllm_url, gateway.vllm_manager, port=brigade_port)
        )
        gateway._bg_tasks.add(brigade_task)
        brigade_task.add_done_callback(gateway._bg_tasks.discard)
        logger.info("Brigade API started", port=brigade_port)
    except Exception as e:
        logger.error("Brigade API failed to start", error=str(e))
    if _tg_log:
        await _tg_log.stage("🏰", "Brigade API", f"Порт {brigade_port}")
