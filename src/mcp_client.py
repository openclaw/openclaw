import asyncio
import sys
import os
import contextlib
from typing import Dict, Any, List, Optional
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

# Get the path to the virtual environment python assuming it exists locally or using global if needed
# A more robust enterprise approach is to provide explicit exact paths
PYTHON_BIN = sys.executable

class OpenClawMCPClient:
    """
    MCP Client integrated into OpenClaw Gateway.
    Responsible for initializing and managing connections to local MCP tools (Filesystem, SQLite)
    and exposing their tools in a format Ollama / DeepSeek understands.
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
        
        # Aggregated tools
        self.available_tools_for_ollama: List[Dict[str, Any]] = []
        self._tool_route_map: Dict[str, ClientSession] = {}

    async def initialize(self):
        """Starts local MCP servers and establishes Stdio connections via anyio"""
        if self.db_path:
            await self._start_sqlite_server()
        await self._start_filesystem_server()
        await self._start_parsers_server()

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
        """Converts MCP tool specification into Ollama-compatible payload"""
        # MCP tool_spec has attributes like name, description, inputSchema
        tool_name = tool_spec.name
        self._tool_route_map[tool_name] = session
        
        ollama_tool = {
            "type": "function",
            "function": {
                "name": tool_name,
                "description": tool_spec.description,
                "parameters": tool_spec.inputSchema
            }
        }
        self.available_tools_for_ollama.append(ollama_tool)

    async def call_tool(self, name: str, arguments: dict) -> str:
        """Execute a tool via the corresponding MCP server"""
        if name not in self._tool_route_map:
            return f"Error: Tool '{name}' is not recognized."
        
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
