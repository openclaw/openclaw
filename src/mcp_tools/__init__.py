"""MCP tool servers and client — consolidated from top-level src/*.

Submodules:
  - client          : OpenClawMCPClient  (manages stdio connections)
  - shell           : safe shell execution MCP server
  - code_analysis   : AST analysis + complexity metrics MCP server
  - websearch       : DuckDuckGo + Jina Reader MCP server
  - parsers         : ripgrep, jq, yq JSON/file MCP server
  - memory_search   : hybrid semantic/tiered memory MCP server
"""

from src.mcp_tools.client import OpenClawMCPClient

__all__ = ["OpenClawMCPClient"]
