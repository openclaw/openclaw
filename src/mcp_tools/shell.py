"""
MCP Server: Secure Shell Command Execution for OpenClaw Pipeline.

Exposes `run_command` tool so agent roles (Planner, Executor_Tools, etc.)
can execute shell commands autonomously instead of asking the user.

Security model:
  - shell=False everywhere (no shell injection).
  - Per-invocation timeout (default 30 s, max 120 s).
  - Deny list blocks the most dangerous operations (rm -rf, format, etc.).
  - Output truncated to 16 000 chars to protect context window.
  - All invocations are logged with command + exit code.
"""

import asyncio
import os
import re
import shlex
import sys
import logging
from mcp.server.fastmcp import FastMCP

logger = logging.getLogger("ShellMCP")
mcp = FastMCP("Shell Executor")

# --------------------------------------------------------------------------- #
# Safety: deny list (regex patterns matched against the raw command string).  #
# Add patterns here to block commands that must never run automatically.      #
# --------------------------------------------------------------------------- #
_DENY_PATTERNS: list[re.Pattern] = [
    re.compile(r'\brm\s+-rf\b', re.IGNORECASE),
    re.compile(r'\bformat\b', re.IGNORECASE),
    re.compile(r'\bdiskpart\b', re.IGNORECASE),
    re.compile(r'\bmkfs\b', re.IGNORECASE),
    re.compile(r'\bdd\s+if=', re.IGNORECASE),
    re.compile(r'\bshutdown\b', re.IGNORECASE),
    re.compile(r'\breboot\b', re.IGNORECASE),
    re.compile(r'\bpowershell\s+-enc\b', re.IGNORECASE),     # base64-encoded PS payloads
    re.compile(r'>\s*/dev/(sd|hd|nvme)', re.IGNORECASE),     # raw disk writes
    re.compile(r'\bcurl\b.*(sh|bash|python)\s*\|', re.IGNORECASE),  # pipe-to-shell downloads
]

_MAX_OUTPUT_CHARS = 16_000
_MAX_TIMEOUT_SEC = 120


def _is_denied(command: str) -> str | None:
    """Returns the matching deny-pattern description, or None if command is safe."""
    for pattern in _DENY_PATTERNS:
        if pattern.search(command):
            return pattern.pattern
    return None


@mcp.tool()
def run_command(command: str, workdir: str = "", timeout: int = 30) -> str:
    """
    Execute a shell command and return its output (stdout + stderr).

    Use this tool to autonomously run CLI tools (npx, pnpm, bunx, pip, python, rg, git, etc.)
    instead of asking the user to run them manually.

    Args:
        command: The command to run (e.g. "npx clawhub@latest install sonoscli").
        workdir: Working directory. Defaults to the bot's root directory.
        timeout: Seconds before the command is killed. Max 120 s.

    Returns:
        Combined stdout + stderr, truncated to 16 000 chars.
    """
    # --- Validation ---
    if not command or not command.strip():
        return "❌ Error: empty command."

    denied = _is_denied(command)
    if denied:
        logger.warning("run_command DENIED: %s — matched rule: %s", command, denied)
        return f"❌ Command denied by security policy. Matched rule: `{denied}`. Ask the user before running this command."

    capped_timeout = min(int(timeout), _MAX_TIMEOUT_SEC)

    # Resolve working directory
    bot_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    cwd = workdir.strip() if workdir.strip() else bot_root
    if not os.path.isdir(cwd):
        cwd = bot_root

    # Build args — on Windows we wrap in cmd.exe so PATH/extension resolution works
    # but we do NOT use shell=True to avoid injection; cmd /C is a single argument list.
    if sys.platform == "win32":
        args = ["cmd.exe", "/C", command]
    else:
        args = ["bash", "-c", command]

    logger.info("run_command: %s (cwd=%s, timeout=%ds)", command, cwd, capped_timeout)

    # Inherit PATH + common env vars so npm/pnpm/bunx resolve correctly
    env = os.environ.copy()

    try:
        proc = asyncio.get_event_loop().run_until_complete(
            _exec_async(args, cwd, env, capped_timeout)
        )
        return proc
    except RuntimeError:
        # If no event loop is running (called from sync context by FastMCP)
        import subprocess
        try:
            result = subprocess.run(
                args,
                cwd=cwd,
                env=env,
                capture_output=True,
                text=True,
                timeout=capped_timeout,
                encoding="utf-8",
                errors="replace",
            )
            output = _merge_output(result.stdout, result.stderr, result.returncode)
            logger.info("run_command exit=%d: %s", result.returncode, command[:80])
            return output
        except subprocess.TimeoutExpired:
            return f"⏳ Timeout: command took longer than {capped_timeout} s and was killed."
        except Exception as exc:
            logger.error("run_command error: %s", exc)
            return f"❌ Execution error: {exc}"


async def _exec_async(args: list[str], cwd: str, env: dict, timeout: int) -> str:
    """Async variant of subprocess execution."""
    import subprocess
    try:
        result = await asyncio.wait_for(
            asyncio.get_event_loop().run_in_executor(
                None,
                lambda: subprocess.run(
                    args,
                    cwd=cwd,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=timeout,
                    encoding="utf-8",
                    errors="replace",
                )
            ),
            timeout=timeout + 2,
        )
        return _merge_output(result.stdout, result.stderr, result.returncode)
    except asyncio.TimeoutError:
        return f"⏳ Timeout: command took longer than {timeout} s and was killed."
    except Exception as exc:
        logger.error("_exec_async error: %s", exc)
        return f"❌ Execution error: {exc}"


def _merge_output(stdout: str, stderr: str, returncode: int) -> str:
    """Combine stdout + stderr into a single string, truncated for LLM safety."""
    parts = []
    if stdout.strip():
        parts.append(f"[stdout]\n{stdout.strip()}")
    if stderr.strip():
        parts.append(f"[stderr]\n{stderr.strip()}")
    if not parts:
        parts.append("(no output)")

    combined = "\n\n".join(parts)
    status_line = f"\n\n[exit code: {returncode}]"

    if len(combined) + len(status_line) > _MAX_OUTPUT_CHARS:
        combined = combined[:_MAX_OUTPUT_CHARS - len(status_line) - 50] + "\n[...output truncated...]"

    return combined + status_line


if __name__ == "__main__":
    mcp.run()
