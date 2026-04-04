"""Deep Research command handler."""

import structlog
from aiogram.types import Message

logger = structlog.get_logger("BotCommands.Research")


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
        research_model = router.get("research", router.get("general", "meta-llama/llama-3.3-70b-instruct:free"))
        dr = DeepResearchPipeline(
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
