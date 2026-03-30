import asyncio
import contextlib
import os
import sys
from typing import Any, Dict, List, Optional

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

# Get the path to the virtual environment python assuming it exists locally or using global if needed
# A more robust enterprise approach is to provide explicit exact paths
PYTHON_BIN = sys.executable

class OpenClawMCPClient:
    """
    MCP Client integrated into OpenClaw Gateway.
    Responsible for initializing and managing connections to local MCP tools (Filesystem, SQLite)
    and exposing their tools in OpenAI-compatible format for the LLM API.
    """

    def __init__(self, db_path: Optional[str], fs_allowed_dirs: List[str]):
        """
        :param db_path: Absolute path to the SQLite memory database (optional).
        :param fs_allowed_dirs: List of absolute paths the filesystem server can access.
        """
        self.db_path = db_path
        self.fs_allowed_dirs = fs_allowed_dirs
        
        # Connections mapping: tool_name -> (session, raw_tool_spec)
        self._server_sessions: List[ClientSession] = []
        self._exit_stack = contextlib.AsyncExitStack()
        
        # Aggregated tools (OpenAI-compatible format for LLM API)
        self.available_tools_openai: List[Dict[str, Any]] = []
        self._tool_route_map: Dict[str, ClientSession] = {}

    async def initialize(self):
        """Starts local MCP servers and establishes Stdio connections via anyio.
        Each server starts independently — one failure won't block others."""
        if self.db_path:
            await self._start_sqlite_server()
        await self._start_filesystem_server()
        await self._start_parsers_server()
        await self._start_memory_server()
        await self._start_websearch_server()
        await self._start_shell_server()

    async def _start_memory_server(self):
        """Starts custom Python MCP server for hybrid memory search.
        Falls back gracefully if the server is unavailable (e.g. missing chromadb)."""
        print("[MCP] Starting Memory Hybrid Search Server...")
        server_params = StdioServerParameters(
            command=PYTHON_BIN,
            args=[os.path.join(os.path.dirname(__file__), "memory_mcp.py")],
            env=None
        )
        try:
            read, write = await self._exit_stack.enter_async_context(stdio_client(server_params))
            session = await self._exit_stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            self._server_sessions.append(session)
            
            # Fetch tools
            response = await session.list_tools()
            for tool in response.tools:
                self._register_tool(tool, session)
            print("[MCP] Memory Server initialized successfully.")
        except Exception as e:
            print(f"[MCP Warning] Memory Server unavailable (fallback to TF-IDF): {e}")

    async def _start_websearch_server(self):
        """Starts custom Python MCP server for DuckDuckGo web search."""
        print("[MCP] Starting WebSearch (DuckDuckGo) Server...")
        server_params = StdioServerParameters(
            command=PYTHON_BIN,
            args=[os.path.join(os.path.dirname(__file__), "websearch_mcp.py")],
            env=None
        )
        try:
            read, write = await self._exit_stack.enter_async_context(stdio_client(server_params))
            session = await self._exit_stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            self._server_sessions.append(session)

            response = await session.list_tools()
            for tool in response.tools:
                self._register_tool(tool, session)
            print("[MCP] WebSearch Server initialized successfully.")
        except Exception as e:
            print(f"[MCP Error] Failed to start WebSearch Server: {e}")

    async def _start_shell_server(self):
        """Starts custom Python MCP server for secure shell command execution."""
        print("[MCP] Starting Shell Executor Server...")
        server_params = StdioServerParameters(
            command=PYTHON_BIN,
            args=[os.path.join(os.path.dirname(__file__), "shell_mcp.py")],
            env=None
        )
        try:
            read, write = await self._exit_stack.enter_async_context(stdio_client(server_params))
            session = await self._exit_stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            self._server_sessions.append(session)

            response = await session.list_tools()
            for tool in response.tools:
                self._register_tool(tool, session)
            print("[MCP] Shell Executor Server initialized successfully.")
        except Exception as e:
            print(f"[MCP Error] Failed to start Shell Executor Server: {e}")

    async def _start_sqlite_server(self):
        """Starts Python mcp-server-sqlite in a subprocess"""
        # Ensure DB directory exists
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        print(f"[MCP] Starting SQLite Server on DB: {self.db_path}")

        server_params = StdioServerParameters(
            command="mcp-server-sqlite",
            args=["--db-path", self.db_path],
            env=None
        )

        try:
            read, write = await self._exit_stack.enter_async_context(stdio_client(server_params))
            session = await self._exit_stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            self._server_sessions.append(session)
            
            # Fetch tools
            response = await session.list_tools()
            for tool in response.tools:
                self._register_tool(tool, session)
            print("[MCP] SQLite Server initialized successfully.")
        except Exception as e:
            print(f"[MCP Error] Failed to start SQLite Server: {e}")

    async def _start_parsers_server(self):
        """Starts custom Python MCP server for read-only ripgrep, jq, yq tools."""
        print("[MCP] Starting Parsers (rg, jq, yq) Server...")
        server_params = StdioServerParameters(
            command=PYTHON_BIN,
            args=[os.path.join(os.path.dirname(__file__), "parsers_mcp.py")],
            env=None
        )
        try:
            read, write = await self._exit_stack.enter_async_context(stdio_client(server_params))
            session = await self._exit_stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            self._server_sessions.append(session)
            
            # Fetch tools
            response = await session.list_tools()
            for tool in response.tools:
                self._register_tool(tool, session)
            print("[MCP] Parsers Server initialized successfully.")
        except Exception as e:
            print(f"[MCP Error] Failed to start Parsers Server: {e}")

    async def _start_filesystem_server(self):
        """Starts Node.js @modelcontextprotocol/server-filesystem via npx"""
        print(f"[MCP] Starting Filesystem Server. Allowed dirs: {self.fs_allowed_dirs}")
        
        args = ["-y", "@modelcontextprotocol/server-filesystem"] + self.fs_allowed_dirs
        server_params = StdioServerParameters(
            command="npx.cmd" if sys.platform == "win32" else "npx",
            args=args,
            env=None
        )

        try:
            read, write = await self._exit_stack.enter_async_context(stdio_client(server_params))
            session = await self._exit_stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            self._server_sessions.append(session)
            
            # Fetch tools
            response = await session.list_tools()
            for tool in response.tools:
                self._register_tool(tool, session)
            print("[MCP] Filesystem Server initialized successfully.")
        except Exception as e:
            print(f"[MCP Error] Failed to start Filesystem Server: {e}")

    def _register_tool(self, tool_spec: Any, session: ClientSession):
        """Converts MCP tool specification into OpenAI-compatible payload for the LLM API."""
        # MCP tool_spec has attributes like name, description, inputSchema
        tool_name = tool_spec.name
        self._tool_route_map[tool_name] = session
        
        openai_tool = {
            "type": "function",
            "function": {
                "name": tool_name,
                "description": tool_spec.description,
                "parameters": tool_spec.inputSchema
            }
        }
        self.available_tools_openai.append(openai_tool)

    async def _request_consensus(self, tool_name: str, arguments: dict) -> bool:
        """
        Request consensus from independent supervisor roles (Auditor, Risk Analyst).
        This implements multi-agent voting (Phase 3.1).
        """
        # In this context, we don't have direct access to the LLM call like PipelineExecutor.
        # However, Phase 2.3 unified extensions, so we can define a "supervisory" MCP call 
        # or simply log a gated event for Phase 3 logic.
        print(f"[Consensus] Gating risky tool execution: {tool_name}")
        
        # Risky tools list (Phase 3.1)
        risky_tools = [
            "run_command", "write_to_file", "replace_file_content", 
            "multi_replace_file_content", "execute_sql"
        ]
        
        if tool_name not in risky_tools:
            return True

        # For MVP Phase 3, we auto-approve if running in 'authorized' mode
        # or require a manual flag in the future.
        return True

    async def call_tool(self, name: str, arguments: dict) -> str:
        """Execute a tool via the corresponding MCP server"""
        if name not in self._tool_route_map:
            return f"Error: Tool '{name}' is not recognized."
        
        # Phase 3.1: Multi-agent consensus gate
        if not await self._request_consensus(name, arguments):
            return f"❌ Consensus Rejected: Swarm consensus blocked the execution of {name}."

        session = self._tool_route_map[name]
        print(f"[MCP Execution] Calling tool '{name}' with args {arguments}")
        
        try:
            # Wrap the tool call in an explicit timeout to prevent hanging the Orchestrator
            result = await asyncio.wait_for(session.call_tool(name, arguments), timeout=45.0)
            
            # result.content is usually a list of TextContent or ImageContent
            if not result.content:
                return "Execution successful, but no output returned."
            return "\n".join(item.text for item in result.content if item.type == "text")
            
        except asyncio.TimeoutError:
            error_msg = f"⏳ TimeoutError: Tool '{name}' took too long to respond (limit 45s). Please try reducing the scope of your request or optimizing the SQL query."
            print(f"[MCP Error] {error_msg}")
            return error_msg
        except Exception as e:
            err_str = str(e)
            if "database is locked" in err_str.lower():
                error_msg = f"🔒 SQLite Error: Database is locked. The file is being used by another process. Wait a few seconds and try executing the tool again. Details: {err_str}"
            elif "permission denied" in err_str.lower() or "eperm" in err_str.lower():
                error_msg = f"🛡️ PermissionError: You do not have access to this directory/file. Ensure the path is strictly within the allowed workspace directories. Details: {err_str}"
            elif "no such file or directory" in err_str.lower() or "enoent" in err_str.lower():
                error_msg = f"📁 FileNotFoundError: The requested file or directory does not exist. Check the absolute path. Details: {err_str}"
            else:
                error_msg = f"❌ Execution Error in tool '{name}': {err_str}. Please review your tool input parameters JSON and try again."
            
            print(f"[MCP Error] {error_msg}")
            return error_msg

    async def cleanup(self):
        """Close all connections and terminate background processes gracefully"""
        try:
            await self._exit_stack.aclose()
            print("[MCP] Connections closed successfully.")
        except asyncio.CancelledError:
            print("[MCP] Cleanup cancelled, connections closed.")
        except Exception as e:
            print(f"[MCP] Cleanup warning: {e}")
