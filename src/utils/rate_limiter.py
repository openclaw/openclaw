"""Async rate limiter for MCP endpoints and external API calls."""

from __future__ import annotations

import asyncio
import time


class AsyncRateLimiter:
    """Token-bucket rate limiter for async contexts.

    Parameters
    ----------
    rate:
        Maximum requests per second.
    burst:
        Maximum burst size (bucket capacity). Defaults to *rate*.
    """

    def __init__(self, rate: float, burst: int = 0) -> None:
        self._rate = rate
        self._burst = burst or max(1, int(rate))
        self._tokens = float(self._burst)
        self._last_refill = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        """Wait until a token is available."""
        while True:
            async with self._lock:
                self._refill()
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return
                # Calculate wait time before releasing the lock
                wait = (1.0 - self._tokens) / self._rate
            # Sleep OUTSIDE the lock so other coroutines can proceed
            await asyncio.sleep(wait)

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_refill
        self._tokens = min(float(self._burst), self._tokens + elapsed * self._rate)
        self._last_refill = now
