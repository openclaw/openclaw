"""Backward-compatible shim — real implementation in src/mcp_tools/client.py."""
from src.mcp_tools.client import *  # noqa: F401,F403
from src.mcp_tools.client import OpenClawMCPClient, _SERVER_INIT_TIMEOUT, PYTHON_BIN  # noqa: F401
