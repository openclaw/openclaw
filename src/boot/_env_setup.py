"""Environment setup: structured logging, Prometheus metrics, config reloading, PID lock."""

import atexit
import os
import sys

import structlog
from prometheus_client import Counter, Gauge
from watchdog.events import FileSystemEventHandler

# ---------------------------------------------------------------------------
# Prometheus metrics
# ---------------------------------------------------------------------------
PROMPT_COUNTER = Counter("openclaw_prompts_total", "Total prompts received")
VRAM_GAUGE = Gauge("openclaw_vram_usage_mb", "Estimated VRAM usage")
MODEL_LOAD_GAUGE = Gauge("openclaw_model_loaded", "Is a model currently loaded")

# ---------------------------------------------------------------------------
# Structured Logging
# ---------------------------------------------------------------------------

def setup_structlog() -> None:
    """Configure structlog with JSON renderer (call once at startup)."""
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.dict_tracebacks,
            structlog.processors.JSONRenderer(),
        ],
        logger_factory=structlog.PrintLoggerFactory(),
    )


# ---------------------------------------------------------------------------
# Config hot-reload watcher
# ---------------------------------------------------------------------------

class ConfigReloader(FileSystemEventHandler):
    def __init__(self, callback, loop=None):
        self.callback = callback
        self._loop = loop  # Store reference to the main event loop

    def set_loop(self, loop):
        """Set the event loop reference (call from async context at startup)."""
        self._loop = loop

    def on_modified(self, event):
        normalized = os.path.normpath(event.src_path)
        if normalized.endswith(os.path.normpath("config/openclaw_config.json")):
            structlog.get_logger("ConfigReloader").info("Config changed, reloading...")
            import asyncio
            import inspect
            if inspect.iscoroutinefunction(self.callback):
                loop = self._loop
                if loop is None or loop.is_closed():
                    return  # No usable loop — skip
                asyncio.run_coroutine_threadsafe(self.callback(), loop)
            else:
                self.callback()


# ---------------------------------------------------------------------------
# PID-based lock file
# ---------------------------------------------------------------------------
LOCK_FILE = os.path.join(os.environ.get("TEMP", os.environ.get("TMP", "/tmp")), "openclaw_bot.lock")


def acquire_lock() -> None:
    """Prevent multiple bot instances from running."""
    if os.path.exists(LOCK_FILE):
        try:
            with open(LOCK_FILE, "r") as f:
                old_pid = int(f.read().strip())

            try:
                import psutil
                if psutil.pid_exists(old_pid):
                    print(f"❌ Bot is already running (PID {old_pid})! Exiting.")
                    sys.exit(1)
            except ImportError:
                try:
                    os.kill(old_pid, 0)
                    print(f"❌ Bot is already running (PID {old_pid})! Exiting.")
                    sys.exit(1)
                except OSError:
                    pass
            print(f"⚠️ Stale lock file found (PID {old_pid} dead). Removing...")
        except (ValueError, FileNotFoundError):
            pass

    with open(LOCK_FILE, "w") as f:
        f.write(str(os.getpid()))
    atexit.register(release_lock)


def release_lock() -> None:
    """Remove lock file on exit."""
    try:
        if os.path.exists(LOCK_FILE):
            os.remove(LOCK_FILE)
    except OSError:
        pass
