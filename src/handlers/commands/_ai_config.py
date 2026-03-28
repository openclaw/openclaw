"""AI / agent configuration commands: agents, agent, openrouter_test."""

import structlog
from aiogram.types import Message

logger = structlog.get_logger("GatewayCommands.AIConfig")


def _escape_md2(text: str) -> str:
    """Escape special characters for Telegram MarkdownV2."""
    special = r"_*[]()~`>#+-=|{}.!"
    return "".join(f"\\{c}" if c in special else c for c in text)


async def cmd_agents(gateway, message: Message):
    """List all available agent personas."""
    if message.from_user.id != gateway.admin_id:
        return

    from src.agent_personas import AgentPersonaManager

    mgr = AgentPersonaManager()
    personas = mgr.list_all()

    if not personas:
        await message.reply("🤖 Персоны агентов не найдены. Проверьте директорию agents/.")
        return

    categories: dict = {}
    for p in personas:
        categories.setdefault(p.category, []).append(p)

    lines = ["🤖 *Доступные персоны агентов:*\n"]
    for cat, items in sorted(categories.items()):
        lines.append(f"\n📁 *{cat}*")
        for p in items:
            lines.append(f"  • `{p.slug}` — {p.name} ({p.role})")

    lines.append(f"\n📊 Всего: {len(personas)} персон")
    lines.append("Используйте: /agent <slug> для подробностей")

    try:
        await message.reply("\n".join(lines), parse_mode="Markdown")
    except Exception:
        plain = "\n".join(lines).replace("*", "").replace("`", "")
        await message.reply(plain)


async def cmd_agent(gateway, message: Message):
    """Show details of a specific agent persona."""
    if message.from_user.id != gateway.admin_id:
        return

    slug = (message.text or "").replace("/agent", "", 1).strip()
    if not slug:
        await message.reply("Использование: `/agent <slug>`\nСписок: /agents", parse_mode="Markdown")
        return

    from src.agent_personas import AgentPersonaManager

    mgr = AgentPersonaManager()
    persona = mgr.get(slug)

    if not persona:
        await message.reply(f"❌ Персона '{slug}' не найдена. Список: /agents")
        return

    msg = (
        f"🤖 *{persona.name}*\n"
        f"📋 Роль: {persona.role}\n"
        f"📁 Категория: {persona.category}\n"
        f"📝 {persona.description}\n"
    )
    if persona.tags:
        msg += f"🏷 Теги: {', '.join(persona.tags)}\n"
    msg += f"\n💬 Промпт-аддендум:\n```\n{persona.system_prompt_addendum[:500]}\n```"

    try:
        await message.reply(msg, parse_mode="Markdown")
    except Exception:
        await message.reply(msg.replace("*", "").replace("`", ""))


async def cmd_openrouter_test(gateway, message: Message):
    """Quick OpenRouter connectivity test."""
    if message.from_user.id != gateway.admin_id:
        return

    or_cfg = gateway.config.get("system", {}).get("openrouter", {})
    if not or_cfg.get("enabled"):
        await message.reply("⚠️ OpenRouter не включён в конфиге.")
        return

    status_msg = await message.reply("🔄 Тестирую OpenRouter...")

    from src.openrouter_client import check_openrouter

    result = await check_openrouter(or_cfg.get("api_key", ""))

    if result["status"] == "ok":
        await status_msg.edit_text(
            f"✅ OpenRouter OK!\n"
            f"Модель: `{result['model']}`\n"
            f"Ответ: {result['response']}",
            parse_mode="Markdown",
        )
    else:
        await status_msg.edit_text(f"❌ OpenRouter ошибка: {result.get('error', 'unknown')}")
