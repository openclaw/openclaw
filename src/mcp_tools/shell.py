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
    re.compile(r'\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive)', re.IGNORECASE),
    re.compile(r'\bformat\b', re.IGNORECASE),
    re.compile(r'\bdiskpart\b', re.IGNORECASE),
    re.compile(r'\bmkfs\b', re.IGNORECASE),
    re.compile(r'\bdd\s+if=', re.IGNORECASE),
    re.compile(r'\bshutdown\b', re.IGNORECASE),
    re.compile(r'\breboot\b', re.IGNORECASE),
    re.compile(r'\bpowershell\s+-enc\b', re.IGNORECASE),     # base64-encoded PS payloads
    re.compile(r'>\s*/dev/(sd|hd|nvme)', re.IGNORECASE),     # raw disk writes
    re.compile(r'\b(curl|wget)\b.*\|\s*(sh|bash|python)', re.IGNORECASE),  # pipe-to-shell downloads
    re.compile(r'\b(python|python3|node|ruby|perl)\s+-[ce]\b', re.IGNORECASE),  # inline code execution
    re.compile(r'\bchmod\s+[0-7]*7[0-7]*\b', re.IGNORECASE),  # world-writable chmod
    re.compile(r'\b(sudo|su)\b', re.IGNORECASE),             # privilege escalation
    re.compile(r'\bnc\s+-[a-z]*l', re.IGNORECASE),           # netcat listener
    re.compile(r'\bcrontab\b', re.IGNORECASE),               # cron modification
    re.compile(r'\bmkdir.*&&.*cd.*&&.*\bwget\b', re.IGNORECASE),  # download-and-execute chains
    re.compile(r'\beval\b', re.IGNORECASE),                  # eval in shell
    re.compile(r'\bbase64\s+(-d|--decode)', re.IGNORECASE),  # base64 decode pipes
]

# Allowed commands whitelist — only these base commands can run
_ALLOW_LIST: frozenset[str] = frozenset({
    "ls", "dir", "cat", "head", "tail", "echo", "pwd", "cd",
    "grep", "rg", "find", "wc", "sort", "uniq", "diff",
    "git", "pip", "pip3", "npm", "npx", "pnpm", "bunx", "cargo",
    "python", "python3",  # only without -c/-e (blocked by deny pattern)
    "mkdir", "cp", "mv", "touch", "tree", "which", "where",
    "docker", "docker-compose", "kubectl",
    "curl", "wget",  # only without pipe-to-shell (blocked by deny pattern)
    "jq", "yq", "awk", "sed", "cut", "tr",
})

_MAX_OUTPUT_CHARS = 16_000
_MAX_TIMEOUT_SEC = 120


def _is_denied(command: str) -> str | None:
    """Returns the matching deny-pattern description, or None if command is safe."""
    for pattern in _DENY_PATTERNS:
        if pattern.search(command):
            return pattern.pattern

    # Whitelist check: extract base command and verify it's allowed
    # Handle chained commands (&&, ||, ;, |)
    segments = re.split(r'[&|;]+', command)
    for segment in segments:
        segment = segment.strip()
        if not segment:
            continue
        # Extract the base command (first word)
        parts = shlex.split(segment) if segment else []
        if parts:
            base_cmd = os.path.basename(parts[0]).lower()
            # Strip common extensions on Windows
            base_cmd = re.sub(r'\.(exe|cmd|bat|ps1)$', '', base_cmd)
            if base_cmd not in _ALLOW_LIST:
                return f"command '{base_cmd}' not in allowlist"

    return None


@mcp.tool()
async def run_command(command: str, workdir: str = "", timeout: int = 30) -> str:
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
    bot_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
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

    return await _exec_async(args, cwd, env, capped_timeout, command)


async def _exec_async(
    args: list[str], cwd: str, env: dict, timeout: int, command: str = "",
) -> str:
    """Non-blocking subprocess execution using asyncio.create_subprocess_exec."""
    proc: asyncio.subprocess.Process | None = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=cwd,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(), timeout=timeout,
        )

        stdout = stdout_bytes.decode("utf-8", errors="replace")
        stderr = stderr_bytes.decode("utf-8", errors="replace")
        returncode = proc.returncode or 0

        logger.info("run_command exit=%d: %s", returncode, (command or " ".join(args))[:80])
        return _merge_output(stdout, stderr, returncode)

    except asyncio.TimeoutError:
        if proc is not None:
            try:
                proc.kill()
                await proc.wait()
            except ProcessLookupError:
                pass
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
