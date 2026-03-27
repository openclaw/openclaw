"""Bot command handlers — split from the monolithic gateway_commands.py."""

from src.bot_commands.status import cmd_start, cmd_status, cmd_models, cmd_help
from src.bot_commands.research import cmd_research
from src.bot_commands.media import handle_photo, handle_voice, handle_document, handle_video
from src.bot_commands.diagnostics import (
    cmd_tailscale,
    cmd_test,
    cmd_test_all_models,
    cmd_history,
    cmd_perf,
    cmd_openrouter_test,
    cmd_diag,
)
from src.bot_commands.agents_cmd import cmd_agents, cmd_agent
from src.bot_commands.callbacks import handle_callback_query, handle_unknown_command

__all__ = [
    "cmd_start",
    "cmd_status",
    "cmd_models",
    "cmd_help",
    "cmd_research",
    "handle_photo",
    "handle_voice",
    "handle_document",
    "handle_video",
    "cmd_tailscale",
    "cmd_test",
    "cmd_test_all_models",
    "cmd_history",
    "cmd_perf",
    "cmd_openrouter_test",
    "cmd_diag",
    "cmd_agents",
    "cmd_agent",
    "handle_callback_query",
    "handle_unknown_command",
]
