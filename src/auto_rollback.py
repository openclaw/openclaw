"""
AutoRollback — защита от самомодификации (Phase 13: V2 HMAC-hardened).

Перед тем как Orchestrator правит файлы, этот модуль:
1. Создает git-чекпоинт (auto-commit).
2. HMAC-подписывает SHA чекпоинта (V2 fix: защита от git-index poisoning).
3. Проверяет синтаксис измененных .py-файлов через compile().
4. Откатывает (git reset --hard) при ошибках, верифицируя HMAC перед reset.
5. Отключает git hooks в subprocess для защиты от post-commit injection.
"""

import os
import hmac
import hashlib
import subprocess
import py_compile
import structlog
from typing import List, Optional

logger = structlog.get_logger(__name__)

# HMAC secret — in production, load from OS keyring or env var.
# For now, derived from a machine-specific path hash.
_HMAC_SECRET = hashlib.sha256(
    os.path.abspath(__file__).encode()
).digest()


class CheckpointTamperingError(Exception):
    """Raised when HMAC verification of a checkpoint SHA fails."""
    pass


class AutoRollback:
    """
    Git-backed safety net for autonomous code modifications.

    Phase 13 hardening:
    - Checkpoint SHAs are HMAC-signed to prevent git-index poisoning.
    - Git hooks are disabled in all subprocess calls.
    """

    def __init__(self, repo_path: str, signing_secret: bytes = _HMAC_SECRET):
        self.repo_path = repo_path
        self._secret = signing_secret
        self._checkpoint_sha: Optional[str] = None
        self._checkpoint_mac: Optional[str] = None

    # ───────── public API ─────────

    def create_checkpoint(self, message: str = "auto-checkpoint") -> str:
        """
        Stage everything and commit; return the HMAC-signed SHA.

        The SHA is stored alongside its HMAC tag. Any attempt to
        modify _checkpoint_sha without updating the MAC will be
        detected during rollback().
        """
        self._git("add", "-A")
        self._git("commit", "--allow-empty", "-m", f"[AutoRollback] {message}")
        sha = self._git("rev-parse", "HEAD").strip()

        # HMAC-sign the checkpoint
        self._checkpoint_sha = sha
        self._checkpoint_mac = hmac.new(
            self._secret, sha.encode(), hashlib.sha256
        ).hexdigest()

        logger.info(
            "[AutoRollback] HMAC-signed checkpoint created",
            sha=sha[:8],
            mac=self._checkpoint_mac[:8],
        )
        return sha

    def validate_files(self, file_paths: Optional[List[str]] = None) -> List[str]:
        """
        Compile-check a list of .py files (or all staged .py files).
        Returns a list of error descriptions; empty == all OK.
        """
        if file_paths is None:
            raw = self._git("diff", "--name-only", "--cached")
            file_paths = [
                os.path.join(self.repo_path, f)
                for f in raw.strip().splitlines()
                if f.endswith(".py")
            ]

        errors: List[str] = []
        for fp in file_paths:
            if not fp.endswith(".py") or not os.path.isfile(fp):
                continue
            try:
                py_compile.compile(fp, doraise=True)
            except py_compile.PyCompileError as exc:
                errors.append(f"{fp}: {exc}")
                logger.error("[AutoRollback] Compile error", file=fp, error=str(exc))
        return errors

    def rollback(self) -> bool:
        """
        Hard-reset to the last checkpoint SHA after HMAC verification.

        Raises CheckpointTamperingError if the stored SHA has been
        modified without updating the HMAC (V2: git-index poisoning defense).
        """
        if not self._checkpoint_sha or not self._checkpoint_mac:
            logger.warning("[AutoRollback] No checkpoint to rollback to!")
            return False

        # V2 Fix: Verify HMAC before trusting the SHA
        expected_mac = hmac.new(
            self._secret, self._checkpoint_sha.encode(), hashlib.sha256
        ).hexdigest()

        if not hmac.compare_digest(expected_mac, self._checkpoint_mac):
            raise CheckpointTamperingError(
                f"[AutoRollback] HMAC mismatch! Checkpoint SHA may have been "
                f"tampered with. Expected MAC {expected_mac[:8]}..., "
                f"got {self._checkpoint_mac[:8]}... Rollback BLOCKED."
            )

        logger.warning("[AutoRollback] HMAC verified. Rolling back!",
                       target=self._checkpoint_sha[:8])
        self._git("reset", "--hard", self._checkpoint_sha)
        return True

    def finalize(self, message: str = "auto-finalized"):
        """Commit the successful state so the next checkpoint is clean."""
        self._git("add", "-A")
        self._git("commit", "--allow-empty", "-m", f"[AutoRollback] ✅ {message}")
        logger.info("[AutoRollback] Finalized successfully")

    # ───────── helpers ─────────

    def _git(self, *args: str) -> str:
        """
        Execute a git command with hooks disabled (V2 defense).

        Setting core.hooksPath to /dev/null prevents malicious
        post-commit hooks from amending checkpoint commits.
        """
        env = os.environ.copy()
        env["GIT_HOOKS_PATH"] = "/dev/null"

        result = subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", *args],
            cwd=self.repo_path,
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )
        if result.returncode != 0 and args[0] not in ("diff",):
            logger.debug("[AutoRollback] git warning",
                         args=args, stderr=result.stderr.strip())
        return result.stdout
