import logging
import time
import os

logger = logging.getLogger("VRAMGuard")
logger.setLevel(logging.INFO)

class VRAMGuard:
    """
    Singleton hardware sensor using NVML to prevent OOM errors 
    during heavy inference or matrix relaxation tasks.
    """
    _instance = None
    _pynvml_initialized = False

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(VRAMGuard, cls).__new__(cls)
            cls._instance._init_nvml()
        return cls._instance

    def _init_nvml(self):
        try:
            import pynvml
            pynvml.nvmlInit()
            self._pynvml_initialized = True
            self.handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            logger.info("VRAMGuard NVML sensor initialized on GPU 0.")
        except Exception as e:
            logger.warning(f"VRAMGuard failed to initialize pynvml. Running blindly. Error: {e}")

    def get_free_vram_mb(self) -> float:
        """Returns free VRAM in MBs. Returns 999999 if NVML is unavailable."""
        if not self._pynvml_initialized:
            return 999999.0
            
        import pynvml
        info = pynvml.nvmlDeviceGetMemoryInfo(self.handle)
        return info.free / (1024 * 1024)

    def get_usage_percent(self) -> float:
        """Returns VRAM usage percentage."""
        if not self._pynvml_initialized:
            return 0.0
        import pynvml
        info = pynvml.nvmlDeviceGetMemoryInfo(self.handle)
        return (info.used / info.total) * 100

    def suggest_swapping(self, model_size_gb: float) -> bool:
        """
        Suggests whether a model should be swapped (keep_alive=0) 
        based on current VRAM pressure.
        """
        free_gb = self.get_free_vram_mb() / 1024
        # If model won't fit comfortably or usage is > 85%, suggest swapping
        return (model_size_gb > free_gb * 0.8) or (self.get_usage_percent() > 85)

    def yield_if_critical(self, threshold_mb: float = 500.0, sleep_sec: float = 1.0):
        """
        Blocks the current thread until VRAM is above the threshold.
        Prevents LLM/Scanner collisions. Publishes critical alerts to Telegram.

        WARNING: This is a blocking call — run in asyncio.to_thread() from async code.
        """
        alert_sent = False
        max_iterations = 60  # Prevent infinite blocking — max 60 iterations
        for _ in range(max_iterations):
            free_mgr = self.get_free_vram_mb()
            if free_mgr >= threshold_mb:
                break

            logger.warning(f"[WARNING] VRAM LIMIT ({free_mgr:.1f}MB free < {threshold_mb}MB). YIELDING FOR SPFA MATRICES.")

            if not alert_sent:
                try:
                    import redis
                    redis_host = "redis_state" if os.environ.get("RUNNING_IN_DOCKER") else "127.0.0.1"
                    redis_password = os.environ.get("REDIS_PASSWORD", "")
                    redis_url = f"redis://:{redis_password}@{redis_host}:6379/0" if redis_password else f"redis://{redis_host}:6379/0"
                    r = redis.Redis.from_url(redis_url)
                    try:
                        r.publish("alerts:VRAM_CRITICAL", f"🚨 VRAM CRITICAL - HALTING NON-CORE AI. Free: {free_mgr:.1f}MB")
                    finally:
                        r.close()
                    alert_sent = True
                except Exception as e:
                    logger.error(f"Failed to publish VRAM alert to Redis: {e}")

            time.sleep(sleep_sec)
        else:
            logger.error(f"VRAM yield_if_critical exhausted {max_iterations} iterations — proceeding anyway")
                
vram_guard = VRAMGuard()
