"""
vLLM Model Manager — Dynamic single-GPU multi-model serving via WSL.

Manages a vLLM server running in WSL2 Ubuntu for the MAS (Multi-Agent System).
Since 16GB VRAM can hold only one model at a time, this manager:
  1. Tracks which model is currently loaded
  2. Swaps models by stopping/restarting the vLLM server in WSL
  3. Exposes health checks and a ready-state signal
  4. Integrates with the existing task_queue which batches by model
  5. Supports LoRA adapter hot-swap for fine-tuned models

The OpenAI-compatible API is served at http://localhost:{port}/v1
Models are stored at /mnt/d/vllm_models (HF_HOME).
vLLM venv is at /mnt/d/vllm_env.
LoRA adapters are stored at /mnt/d/lora_adapters.
"""

import asyncio
import os
import time
from typing import Optional

import aiohttp
import structlog
from src.inference_optimizer import (
    ChunkedPrefillConfig,
    PrefixCachingConfig,
    SpeculativeDecodingConfig,
    build_optimized_vllm_args,
)

logger = structlog.get_logger("VLLMManager")

# WSL paths
WSL_DISTRO = "Ubuntu"
WSL_VENV_PYTHON = "/mnt/d/vllm_env/bin/python3"
WSL_HF_HOME = "/mnt/d/vllm_models"
WSL_LORA_DIR = "/mnt/d/lora_adapters"


class VLLMModelManager:
    """
    Manages a local vLLM OpenAI-compatible server process.
    Supports automatic model swapping on a single GPU.
    Supports LoRA adapter loading for fine-tuned models.
    Accepts optional inference optimisation configs (speculative, chunked_prefill,
    prefix_caching) which are merged into vllm_extra_args via build_optimized_vllm_args.
    """

    def __init__(
        self,
        port: int = 8000,
        gpu_memory_utilization: float = 0.90,
        max_model_len: int = 8192,
        quantization: Optional[str] = None,
        vllm_extra_args: Optional[list] = None,
        speculative: Optional[SpeculativeDecodingConfig] = None,
        chunked_prefill: Optional[ChunkedPrefillConfig] = None,
        prefix_caching: Optional[PrefixCachingConfig] = None,
    ):
        self.port = port
        self.gpu_memory_utilization = gpu_memory_utilization
        self.max_model_len = max_model_len
        self.quantization = quantization  # e.g. "awq", "gptq", None (auto)
        opt_args = build_optimized_vllm_args(speculative, chunked_prefill, prefix_caching)
        self.vllm_extra_args = opt_args + (vllm_extra_args or [])
        self.base_url = f"http://localhost:{port}/v1"

        self.current_model: Optional[str] = None
        self.current_lora_adapter: Optional[str] = None  # Path to loaded LoRA adapter
        self._process: Optional[asyncio.subprocess.Process] = None
        self._lock = asyncio.Lock()
        self._startup_timeout = 600  # seconds to wait for vLLM to start (14B AWQ needs ~5 min)
        self._healthy = False
        self._health_task: Optional[asyncio.Task] = None

    @property
    def is_running(self) -> bool:
        return self._process is not None and self._process.returncode is None

    def start_health_monitor(self) -> None:
        """Start background health monitoring loop. Call once after event loop is running."""
        if self._health_task is None or self._health_task.done():
            self._health_task = asyncio.create_task(self._health_monitor_loop())
            logger.info("Health monitor started")

    async def _health_monitor_loop(self) -> None:
        """Periodically check server health with HTTP + inference liveness probe."""
        inference_check_counter = 0
        while True:
            try:
                await asyncio.sleep(30)
                if not self.is_running or not self._healthy:
                    continue  # nothing to monitor when no model is loaded

                status = await self.health_check()
                if not status["healthy"]:
                    logger.warning(
                        "Health check failed, marking unhealthy",
                        model=self.current_model,
                        detail=status,
                    )
                    self._healthy = False
                    continue

                # Every 5th tick (~2.5 min), run a micro-inference liveness probe
                inference_check_counter += 1
                if inference_check_counter >= 5:
                    inference_check_counter = 0
                    probe_ok = await self._inference_liveness_probe()
                    if not probe_ok:
                        logger.warning(
                            "Inference liveness probe failed, marking unhealthy",
                            model=self.current_model,
                        )
                        self._healthy = False
            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.debug("Health monitor tick error", error=str(e))

    async def _inference_liveness_probe(self) -> bool:
        """Send a minimal 1-token inference to verify the model is actually responding."""
        if not self.current_model:
            return False
        try:
            async with aiohttp.ClientSession() as session:
                payload = {
                    "model": self.current_model,
                    "messages": [{"role": "user", "content": "ping"}],
                    "max_tokens": 1,
                    "stream": False,
                }
                async with session.post(
                    f"{self.base_url}/chat/completions",
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        if data.get("choices"):
                            logger.debug("Inference liveness probe OK", model=self.current_model)
                            return True
                    logger.warning("Inference probe bad status", status=resp.status)
                    return False
        except Exception as e:
            logger.warning("Inference liveness probe error", error=str(e))
            return False

    async def ensure_model_loaded(self, model_name: str) -> None:
        """
        Ensure the specified model is loaded and ready for inference.
        If a different model is running, swaps to the new one.
        """
        async with self._lock:
            if self.current_model == model_name and self.is_running and self._healthy:
                return  # Already loaded and healthy

            if self.current_model != model_name or not self.is_running:
                logger.info(
                    "Model swap requested",
                    current=self.current_model,
                    target=model_name,
                )
                await self._stop_server()
                await self._start_server(model_name)
                self.current_model = model_name

    async def _start_server(self, model_name: str) -> None:
        """Start vLLM server in WSL with the specified model."""
        vllm_args = [
            WSL_VENV_PYTHON,
            "-m", "vllm.entrypoints.openai.api_server",
            "--model", model_name,
            "--host", "0.0.0.0",
            "--port", str(self.port),
            "--max-model-len", str(self.max_model_len),
            "--gpu-memory-utilization", str(self.gpu_memory_utilization),
            "--dtype", "auto",
            "--trust-remote-code",
        ]

        if self.quantization:
            vllm_args.extend(["--quantization", self.quantization])

        vllm_args.extend(self.vllm_extra_args)

        # Build the bash command to run inside WSL
        # Redirect stdout/stderr to log file to prevent pipe buffer deadlock
        # (vLLM produces megabytes of output during torch.compile / CUDA graph capture)
        args_str = " ".join(vllm_args)
        log_path = f"{WSL_HF_HOME}/vllm_server.log"
        bash_cmd = f"export HF_HOME={WSL_HF_HOME} && {args_str} > {log_path} 2>&1"

        logger.info("Starting vLLM server in WSL", model=model_name, port=self.port, log=log_path)
        self._healthy = False

        self._process = await asyncio.create_subprocess_exec(
            "wsl", "-d", WSL_DISTRO, "--", "bash", "-c", bash_cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )

        # Wait for the server to become healthy
        await self._wait_for_ready(model_name)
        logger.info("vLLM server ready", model=model_name, pid=self._process.pid)

    async def _stop_server(self) -> None:
        """Gracefully stop the current vLLM server running in WSL."""
        if self._process is None:
            return

        if self._process.returncode is not None:
            self._process = None
            self.current_model = None
            self._healthy = False
            return

        logger.info("Stopping vLLM server", model=self.current_model, pid=self._process.pid)

        try:
            # Kill vLLM processes inside WSL
            kill_proc = await asyncio.create_subprocess_exec(
                "wsl", "-d", WSL_DISTRO, "--", "bash", "-c",
                "pkill -f 'vllm.entrypoints' 2>/dev/null; sleep 1; pkill -9 -f 'vllm.entrypoints' 2>/dev/null",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(kill_proc.wait(), timeout=10)

            # Also terminate the WSL wrapper process
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=10)
            except asyncio.TimeoutError:
                self._process.kill()
                await self._process.wait()
        except (ProcessLookupError, Exception) as e:
            logger.warning("Error stopping vLLM", error=str(e) or type(e).__name__)

        self._process = None
        self.current_model = None
        self._healthy = False

        # Brief pause to let the GPU release VRAM
        await asyncio.sleep(2)

    async def _wait_for_ready(self, model_name: str) -> None:
        """Poll the /v1/models endpoint until the server is ready."""
        start = time.monotonic()
        last_error = ""

        while time.monotonic() - start < self._startup_timeout:
            # Check if process crashed
            if self._process and self._process.returncode is not None:
                # Read last lines from vLLM log file for diagnostics
                log_tail = ""
                try:
                    tail_proc = await asyncio.create_subprocess_exec(
                        "wsl", "-d", WSL_DISTRO, "--", "tail", "-n", "20",
                        f"{WSL_HF_HOME}/vllm_server.log",
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.DEVNULL,
                    )
                    tail_out, _ = await asyncio.wait_for(tail_proc.communicate(), timeout=5)
                    log_tail = tail_out.decode(errors="replace")[:500]
                except Exception:
                    pass
                raise RuntimeError(
                    f"vLLM process exited with code {self._process.returncode}. "
                    f"Log tail: {log_tail}"
                )

            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        f"{self.base_url}/models",
                        timeout=aiohttp.ClientTimeout(total=3),
                    ) as resp:
                        if resp.status == 200:
                            # content_type=None: vLLM may return text/plain during startup
                            try:
                                data = await resp.json(content_type=None)
                            except (ValueError, Exception):
                                # Response isn't valid JSON yet (e.g. Prometheus metrics)
                                last_error = f"non-JSON response: {resp.content_type}"
                                continue
                            models = [m.get("id", "") for m in data.get("data", [])]
                            if any(model_name in m for m in models):
                                self._healthy = True
                                return
            except Exception as e:
                last_error = str(e)

            await asyncio.sleep(2)

        raise RuntimeError(
            f"vLLM server did not become ready within {self._startup_timeout}s. "
            f"Model: {model_name}. Last error: {last_error}"
        )

    async def health_check(self) -> dict:
        """Returns current server health status."""
        if not self.is_running:
            return {"healthy": False, "model": None, "reason": "Server not running"}

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{self.base_url}/models",
                    timeout=aiohttp.ClientTimeout(total=3),
                ) as resp:
                    if resp.status == 200:
                        return {"healthy": True, "model": self.current_model}
                    return {"healthy": False, "model": self.current_model, "status": resp.status}
        except Exception as e:
            return {"healthy": False, "model": self.current_model, "error": str(e)}

    async def shutdown(self) -> None:
        """Clean shutdown — call on application exit."""
        if self._health_task and not self._health_task.done():
            self._health_task.cancel()
            try:
                await self._health_task
            except asyncio.CancelledError:
                pass
        await self._stop_server()
        logger.info("VLLMModelManager shut down")

    # --- LoRA Adapter Support (arXiv:2503.16219, Unsloth) ---

    async def ensure_model_with_lora(
        self, model_name: str, lora_adapter_path: Optional[str] = None
    ) -> None:
        """
        Ensure model is loaded, optionally with a LoRA adapter.

        If a LoRA adapter path is provided, the server is started with
        --enable-lora and --lora-modules flags.

        Args:
            model_name: Base model name (e.g., Qwen/Qwen2.5-Coder-7B-Instruct-AWQ)
            lora_adapter_path: WSL path to LoRA adapter directory (e.g., /mnt/d/lora_adapters/qwen-coder-7b/)
        """
        async with self._lock:
            needs_restart = (
                self.current_model != model_name
                or self.current_lora_adapter != lora_adapter_path
                or not self.is_running
                or not self._healthy
            )

            if not needs_restart:
                return

            logger.info(
                "Model+LoRA swap requested",
                current_model=self.current_model,
                current_lora=self.current_lora_adapter,
                target_model=model_name,
                target_lora=lora_adapter_path,
            )
            await self._stop_server()
            await self._start_server_with_lora(model_name, lora_adapter_path)
            self.current_model = model_name
            self.current_lora_adapter = lora_adapter_path

    async def _start_server_with_lora(
        self, model_name: str, lora_adapter_path: Optional[str] = None
    ) -> None:
        """Start vLLM server with optional LoRA adapter support."""
        vllm_args = [
            WSL_VENV_PYTHON,
            "-m", "vllm.entrypoints.openai.api_server",
            "--model", model_name,
            "--host", "0.0.0.0",
            "--port", str(self.port),
            "--max-model-len", str(self.max_model_len),
            "--gpu-memory-utilization", str(self.gpu_memory_utilization),
            "--dtype", "auto",
            "--trust-remote-code",
        ]

        if self.quantization:
            vllm_args.extend(["--quantization", self.quantization])

        # LoRA adapter support
        if lora_adapter_path:
            adapter_name = os.path.basename(lora_adapter_path.rstrip("/"))
            vllm_args.extend([
                "--enable-lora",
                "--lora-modules", f"{adapter_name}={lora_adapter_path}",
                "--max-lora-rank", "64",  # Support up to rank 64
            ])
            logger.info(
                "LoRA adapter configured",
                adapter_name=adapter_name,
                adapter_path=lora_adapter_path,
            )

        vllm_args.extend(self.vllm_extra_args)

        args_str = " ".join(vllm_args)
        log_path = f"{WSL_HF_HOME}/vllm_server.log"
        bash_cmd = f"export HF_HOME={WSL_HF_HOME} && {args_str} > {log_path} 2>&1"

        logger.info(
            "Starting vLLM server with LoRA",
            model=model_name,
            lora=lora_adapter_path,
            port=self.port,
        )
        self._healthy = False

        self._process = await asyncio.create_subprocess_exec(
            "wsl", "-d", WSL_DISTRO, "--", "bash", "-c", bash_cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )

        await self._wait_for_ready(model_name)
        logger.info(
            "vLLM server ready with LoRA",
            model=model_name,
            lora=lora_adapter_path,
            pid=self._process.pid,
        )

    def list_available_lora_adapters(self) -> list:
        """
        List LoRA adapters available in the adapters directory.

        Returns list of adapter directory names.
        """
        adapters = []
        lora_dir = WSL_LORA_DIR
        # In WSL, we check via the local filesystem equivalent
        local_lora_dir = lora_dir.replace("/mnt/d/", "D:/").replace("/mnt/c/", "C:/")

        for candidate in [lora_dir, local_lora_dir]:
            if os.path.isdir(candidate):
                for entry in os.listdir(candidate):
                    full_path = os.path.join(candidate, entry)
                    # A valid adapter has adapter_config.json
                    if os.path.isdir(full_path) and os.path.exists(
                        os.path.join(full_path, "adapter_config.json")
                    ):
                        adapters.append({
                            "name": entry,
                            "path": os.path.join(lora_dir, entry),
                            "local_path": full_path,
                        })
                break  # Use first found path

        return adapters
