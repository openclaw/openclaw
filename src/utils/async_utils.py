"""Structured concurrency helpers — Python 3.11+ asyncio.TaskGroup wrapper.

Provides ``taskgroup_gather`` — a drop-in replacement for ``asyncio.gather``
that uses TaskGroup for proper structured concurrency with automatic cleanup,
while preserving the ``return_exceptions=True`` error-handling pattern.
"""

from __future__ import annotations

import asyncio
from typing import Any, Coroutine, List


async def taskgroup_gather(
    *coros: Coroutine[Any, Any, Any],
    return_exceptions: bool = False,
) -> List[Any]:
    """Run coroutines concurrently via TaskGroup (structured concurrency).

    Drop-in replacement for ``asyncio.gather(*coros, return_exceptions=...)``:
    - ``return_exceptions=True``: exceptions are returned as values (like gather).
    - ``return_exceptions=False``: first exception cancels all siblings and propagates.
    """
    results: List[Any] = [None] * len(coros)

    async def _wrap(idx: int, coro: Coroutine[Any, Any, Any]) -> None:
        try:
            results[idx] = await coro
        except Exception as exc:
            if return_exceptions:
                results[idx] = exc
            else:
                raise

    async with asyncio.TaskGroup() as tg:
        for i, c in enumerate(coros):
            tg.create_task(_wrap(i, c))

    return results
