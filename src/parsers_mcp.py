"""Backward-compatible shim — real implementation in src/mcp_tools/parsers.py."""
from src.mcp_tools.parsers import *  # noqa: F401,F403
from src.mcp_tools.parsers import _truncate, _MAX_OUTPUT_CHARS  # noqa: F401
