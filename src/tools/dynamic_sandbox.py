"""
Dynamic Sandbox — Isolated code execution + tool synthesis for OpenClaw.

Implements the AGI pattern "Self-Synthesized Tools":
1. Agent generates Python/Bash code to solve a novel task.
2. Code executes inside an isolated Docker container (or subprocess fallback).
3. stdout/stderr are captured and returned to the agent for Reflexion.
4. On success, the script is persisted as a reusable local skill.

Security model:
  - Docker isolation is preferred (network=none, read-only rootfs,
    memory/CPU limits, non-root user, 60 s hard timeout).
  - Subprocess fallback used when Docker is unavailable — restricted via
    tempfile sandbox + deny-list inherited from shell_mcp.py.
  - All generated scripts are validated against basic safety patterns
    before execution.

Reference:
  - Voyager (arXiv:2305.16291): skill library + code synthesis
  - Toolformer (arXiv:2302.04761): self-taught tool use
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import structlog

logger = structlog.get_logger("DynamicSandbox")

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
_DOCKER_IMAGE = "python:3.12-slim"
_DOCKER_TIMEOUT_SEC = 60
_DOCKER_MEM_LIMIT = "256m"
_DOCKER_CPU_QUOTA = 50_000  # 50% of one core
_MAX_OUTPUT_CHARS = 32_000
_SKILL_DIR_NAME = "local_skills"

# Safety: patterns that must never appear in generated code
_CODE_DENY_PATTERNS: list[re.Pattern] = [
    re.compile(r"\bos\.system\b"),
    re.compile(r"\bsubprocess\b"),               # no subprocess at all (Popen/run/call)
    re.compile(r"\beval\b\s*\("),
    re.compile(r"\bexec\b\s*\("),
    re.compile(r"\b__import__\b"),
    re.compile(r"\bimportlib\b"),                # no dynamic imports (bypass __import__)
    re.compile(r"\bos\.popen\b"),                # no os.popen
    re.compile(r"\bos\.exec\w*\b"),              # no os.execve/execvp/etc.
    re.compile(r"\bos\.spawn\w*\b"),             # no os.spawn*
    re.compile(r"\bshutil\.rmtree\s*\(\s*['\"/]", re.IGNORECASE),
    re.compile(r"\bopen\s*\([^)]*['\"]\/etc\/", re.IGNORECASE),
    re.compile(r"\bsocket\b"),                   # no raw network
    re.compile(r"\bctypes\b"),                   # no FFI
    re.compile(r"\bpickle\.loads?\b"),            # deserialization risk
    re.compile(r"\bwhile\s+True\b"),              # infinite loop
]


@dataclass
class SandboxResult:
    """Result of an isolated code execution."""
    success: bool
    exit_code: int
    stdout: str
    stderr: str
    elapsed_sec: float
    method: str          # "docker" | "subprocess"
    script_hash: str     # SHA-256 of the code (for dedup)


@dataclass
class LocalSkill:
    """A synthesized tool persisted for reuse."""
    skill_id: str
    name: str
    description: str
    language: str        # "python" | "bash"
    code: str
    script_hash: str
    created_at: float
    success_count: int = 0
    fail_count: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# Code Safety Validator
# ---------------------------------------------------------------------------

def validate_code(code: str) -> tuple[bool, str]:
    """Check generated code against deny-list patterns.

    Returns (is_safe, reason).
    """
    for pat in _CODE_DENY_PATTERNS:
        if pat.search(code):
            return False, f"Blocked pattern: {pat.pattern}"
    return True, ""


# ---------------------------------------------------------------------------
# Docker Availability Check
# ---------------------------------------------------------------------------

def _docker_available() -> bool:
    """Return True if docker CLI is reachable."""
    try:
        result = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            timeout=5,
        )
        return result.returncode == 0
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Execution Backends
# ---------------------------------------------------------------------------

async def _run_in_docker(
    code: str,
    language: str = "python",
    timeout: int = _DOCKER_TIMEOUT_SEC,
) -> SandboxResult:
    """Execute code inside a disposable Docker container.

    Container properties:
      - network=none (no internet)
      - read_only rootfs + tmpfs /tmp
      - memory limit 256 MB
      - CPU 50% of one core
      - non-root user (nobody)
      - auto-removed after exit
    """
    t0 = time.monotonic()
    script_hash = hashlib.sha256(code.encode()).hexdigest()

    with tempfile.TemporaryDirectory(prefix="openclaw_sandbox_") as tmpdir:
        ext = ".py" if language == "python" else ".sh"
        script_path = os.path.join(tmpdir, f"task{ext}")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(code)

        if language == "python":
            cmd_inside = ["python3", f"/sandbox/task{ext}"]
            image = _DOCKER_IMAGE
        else:
            cmd_inside = ["bash", f"/sandbox/task{ext}"]
            image = "bash:5"

        docker_cmd = [
            "docker", "run",
            "--rm",
            "--network", "none",
            "--read-only",
            "--tmpfs", "/tmp:rw,noexec,size=64m",
            "--memory", _DOCKER_MEM_LIMIT,
            f"--cpu-quota={_DOCKER_CPU_QUOTA}",
            "--user", "nobody",
            "-v", f"{tmpdir}:/sandbox:ro",
            image,
            *cmd_inside,
        ]

        try:
            proc = await asyncio.wait_for(
                asyncio.create_subprocess_exec(
                    *docker_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                ),
                timeout=5,
            )
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(),
                timeout=timeout,
            )
            elapsed = time.monotonic() - t0
            return SandboxResult(
                success=proc.returncode == 0,
                exit_code=proc.returncode or 0,
                stdout=stdout_b.decode("utf-8", errors="replace")[:_MAX_OUTPUT_CHARS],
                stderr=stderr_b.decode("utf-8", errors="replace")[:_MAX_OUTPUT_CHARS],
                elapsed_sec=round(elapsed, 2),
                method="docker",
                script_hash=script_hash,
            )
        except asyncio.TimeoutError:
            elapsed = time.monotonic() - t0
            # Kill the container if still running
            try:
                subprocess.run(
                    ["docker", "kill", f"sandbox_{script_hash[:12]}"],
                    capture_output=True,
                    timeout=5,
                )
            except Exception:
                pass
            return SandboxResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr=f"Timeout: execution exceeded {timeout}s",
                elapsed_sec=round(elapsed, 2),
                method="docker",
                script_hash=script_hash,
            )
        except Exception as e:
            elapsed = time.monotonic() - t0
            return SandboxResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr=f"Docker execution error: {e}",
                elapsed_sec=round(elapsed, 2),
                method="docker",
                script_hash=script_hash,
            )


async def _run_in_subprocess(
    code: str,
    language: str = "python",
    timeout: int = _DOCKER_TIMEOUT_SEC,
) -> SandboxResult:
    """Fallback: execute in a temporary directory via subprocess.

    Less isolated than Docker but functional when Docker is unavailable.
    """
    t0 = time.monotonic()
    script_hash = hashlib.sha256(code.encode()).hexdigest()

    with tempfile.TemporaryDirectory(prefix="openclaw_sandbox_") as tmpdir:
        ext = ".py" if language == "python" else ".sh"
        script_path = os.path.join(tmpdir, f"task{ext}")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(code)

        if language == "python":
            args = ["python3" if os.name != "nt" else "python", script_path]
        else:
            args = ["bash", script_path]

        # Restrict env — remove sensitive vars
        env = {
            k: v for k, v in os.environ.items()
            if not any(s in k.upper() for s in [
                "TOKEN", "SECRET", "KEY", "PASSWORD", "CREDENTIALS",
            ])
        }
        env["HOME"] = tmpdir
        env["TMPDIR"] = tmpdir

        try:
            proc = await asyncio.wait_for(
                asyncio.create_subprocess_exec(
                    *args,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=tmpdir,
                    env=env,
                ),
                timeout=5,
            )
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(),
                timeout=timeout,
            )
            elapsed = time.monotonic() - t0
            return SandboxResult(
                success=proc.returncode == 0,
                exit_code=proc.returncode or 0,
                stdout=stdout_b.decode("utf-8", errors="replace")[:_MAX_OUTPUT_CHARS],
                stderr=stderr_b.decode("utf-8", errors="replace")[:_MAX_OUTPUT_CHARS],
                elapsed_sec=round(elapsed, 2),
                method="subprocess",
                script_hash=script_hash,
            )
        except asyncio.TimeoutError:
            elapsed = time.monotonic() - t0
            return SandboxResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr=f"Timeout: execution exceeded {timeout}s",
                elapsed_sec=round(elapsed, 2),
                method="subprocess",
                script_hash=script_hash,
            )
        except Exception as e:
            elapsed = time.monotonic() - t0
            return SandboxResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr=f"Subprocess error: {e}",
                elapsed_sec=round(elapsed, 2),
                method="subprocess",
                script_hash=script_hash,
            )


# ---------------------------------------------------------------------------
# Skill Library (Persistence)
# ---------------------------------------------------------------------------

class SkillLibrary:
    """Manages locally-synthesized tools for reuse across sessions.

    Skills are stored as JSON metadata + script files in the data directory.
    """

    def __init__(self, base_dir: str | None = None) -> None:
        if base_dir is None:
            base_dir = os.path.join(
                os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")),
                "data",
                _SKILL_DIR_NAME,
            )
        self._dir = base_dir
        self._index_path = os.path.join(self._dir, "index.json")
        self._skills: Dict[str, LocalSkill] = {}
        self._ensure_dir()
        self._load_index()

    def _ensure_dir(self) -> None:
        os.makedirs(self._dir, exist_ok=True)

    def _load_index(self) -> None:
        if not os.path.exists(self._index_path):
            return
        try:
            with open(self._index_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            for entry in data:
                skill = LocalSkill(**entry)
                self._skills[skill.skill_id] = skill
            logger.info("Skill library loaded", count=len(self._skills))
        except Exception as e:
            logger.warning("Failed to load skill index", error=str(e))

    def _save_index(self) -> None:
        try:
            with open(self._index_path, "w", encoding="utf-8") as f:
                json.dump(
                    [s.to_dict() for s in self._skills.values()],
                    f,
                    ensure_ascii=False,
                    indent=2,
                )
        except Exception as e:
            logger.warning("Failed to save skill index", error=str(e))

    def save_skill(
        self,
        name: str,
        description: str,
        code: str,
        language: str = "python",
    ) -> LocalSkill:
        """Persist a successfully-tested script as a reusable skill."""
        script_hash = hashlib.sha256(code.encode()).hexdigest()
        skill_id = f"skill_{script_hash[:12]}"

        # Dedup: if same hash exists, increment success counter
        if skill_id in self._skills:
            self._skills[skill_id].success_count += 1
            self._save_index()
            logger.info("Skill already exists, incremented success", skill_id=skill_id)
            return self._skills[skill_id]

        ext = ".py" if language == "python" else ".sh"
        script_file = os.path.join(self._dir, f"{skill_id}{ext}")
        with open(script_file, "w", encoding="utf-8") as f:
            f.write(code)

        skill = LocalSkill(
            skill_id=skill_id,
            name=name,
            description=description,
            language=language,
            code=code,
            script_hash=script_hash,
            created_at=time.time(),
            success_count=1,
        )
        self._skills[skill_id] = skill
        self._save_index()
        logger.info("New skill saved", skill_id=skill_id, name=name)
        return skill

    def record_failure(self, skill_id: str) -> None:
        """Increment failure counter for an existing skill."""
        if skill_id in self._skills:
            self._skills[skill_id].fail_count += 1
            self._save_index()

    def find_skill(self, query: str) -> Optional[LocalSkill]:
        """Simple keyword search across skill names and descriptions."""
        query_lower = query.lower()
        best: Optional[LocalSkill] = None
        best_score = 0
        for skill in self._skills.values():
            text = f"{skill.name} {skill.description}".lower()
            score = sum(1 for word in query_lower.split() if word in text)
            if score > best_score:
                best_score = score
                best = skill
        return best if best_score > 0 else None

    def list_skills(self) -> List[Dict[str, Any]]:
        """Return summaries of all saved skills."""
        return [
            {
                "skill_id": s.skill_id,
                "name": s.name,
                "description": s.description[:120],
                "language": s.language,
                "success_count": s.success_count,
                "fail_count": s.fail_count,
            }
            for s in sorted(
                self._skills.values(),
                key=lambda s: s.success_count,
                reverse=True,
            )
        ]


# ---------------------------------------------------------------------------
# Main Public API
# ---------------------------------------------------------------------------

class DynamicSandbox:
    """Orchestrates code generation → validation → execution → storage.

    Usage:
        sandbox = DynamicSandbox()
        result = await sandbox.execute("print('hello')")
        if result.success:
            sandbox.save_as_skill("hello_printer", "Prints hello", result)
    """

    def __init__(self, base_dir: str | None = None) -> None:
        self._use_docker = _docker_available()
        self.skill_library = SkillLibrary(base_dir)
        logger.info(
            "DynamicSandbox initialized",
            docker_available=self._use_docker,
            saved_skills=len(self.skill_library.list_skills()),
        )

    async def execute(
        self,
        code: str,
        language: str = "python",
        timeout: int = _DOCKER_TIMEOUT_SEC,
    ) -> SandboxResult:
        """Validate and execute code in the safest available backend.

        Steps:
        1. Static safety validation
        2. Run in Docker (preferred) or subprocess (fallback)
        3. Return full result with stdout/stderr for agent Reflexion
        """
        # 1. Safety check
        is_safe, reason = validate_code(code)
        if not is_safe:
            script_hash = hashlib.sha256(code.encode()).hexdigest()
            logger.warning("Code rejected by safety validator", reason=reason)
            return SandboxResult(
                success=False,
                exit_code=-2,
                stdout="",
                stderr=f"Safety validation failed: {reason}",
                elapsed_sec=0.0,
                method="validation",
                script_hash=script_hash,
            )

        # 2. Execute
        if self._use_docker:
            result = await _run_in_docker(code, language, timeout)
        else:
            result = await _run_in_subprocess(code, language, timeout)

        logger.info(
            "Sandbox execution complete",
            success=result.success,
            method=result.method,
            elapsed_sec=result.elapsed_sec,
            exit_code=result.exit_code,
        )
        return result

    def save_as_skill(
        self,
        name: str,
        description: str,
        result: SandboxResult,
        code: str = "",
        language: str = "python",
    ) -> Optional[LocalSkill]:
        """Persist a successful execution as a reusable skill.

        Only saves if the execution was successful.
        """
        if not result.success:
            logger.warning("Cannot save failed execution as skill")
            return None
        return self.skill_library.save_skill(name, description, code, language)

    async def execute_skill(
        self,
        skill_id: str,
        timeout: int = _DOCKER_TIMEOUT_SEC,
    ) -> Optional[SandboxResult]:
        """Re-execute a previously saved skill by ID."""
        skill = self.skill_library._skills.get(skill_id)
        if not skill:
            logger.warning("Skill not found", skill_id=skill_id)
            return None
        result = await self.execute(skill.code, skill.language, timeout)
        if result.success:
            skill.success_count += 1
        else:
            skill.fail_count += 1
        self.skill_library._save_index()
        return result

    async def synthesize_and_run(
        self,
        task_description: str,
        generated_code: str,
        language: str = "python",
    ) -> tuple[SandboxResult, Optional[LocalSkill]]:
        """Full pipeline: execute code, and save as skill if successful.

        Used by Executor_Tools when it generates novel code.
        Returns (result, skill_or_None).
        """
        result = await self.execute(generated_code, language)
        skill = None
        if result.success:
            skill = self.save_as_skill(
                name=task_description[:80],
                description=task_description,
                result=result,
                code=generated_code,
                language=language,
            )
        return result, skill
