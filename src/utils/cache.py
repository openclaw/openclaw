"""Generic TTL cache with LRU eviction.

Thread-safe for single-threaded asyncio usage. Uses ``OrderedDict``
for O(1) move-to-end on access and O(1) pop of the oldest entry.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Generic, Optional, TypeVar

V = TypeVar("V")


class TTLCache(Generic[V]):
    """In-memory cache with per-entry TTL and LRU eviction.

    Parameters
    ----------
    maxsize:
        Maximum number of entries before the oldest is evicted.
    ttl:
        Time-to-live in seconds. Entries older than *ttl* are
        treated as expired on access and silently removed.
    """

    def __init__(self, maxsize: int = 256, ttl: float = 300.0) -> None:
        self._maxsize = maxsize
        self._ttl = ttl
        # value -> (timestamp, payload)
        self._data: OrderedDict[str, tuple[float, V]] = OrderedDict()

    # -- public API --

    def get(self, key: str) -> Optional[V]:
        """Return cached value or ``None`` if missing / expired."""
        entry = self._data.get(key)
        if entry is None:
            return None
        ts, value = entry
        if time.monotonic() - ts > self._ttl:
            self._data.pop(key, None)
            return None
        # Mark as recently used
        self._data.move_to_end(key)
        return value

    def put(self, key: str, value: V) -> None:
        """Store *value* under *key*, evicting the oldest entry if full."""
        if key in self._data:
            self._data.move_to_end(key)
        self._data[key] = (time.monotonic(), value)
        while len(self._data) > self._maxsize:
            self._data.popitem(last=False)

    def __contains__(self, key: str) -> bool:
        entry = self._data.get(key)
        if entry is None:
            return False
        if time.monotonic() - entry[0] > self._ttl:
            self._data.pop(key, None)
            return False
        return True

    def __len__(self) -> int:
        return len(self._data)

    def clear(self) -> None:
        self._data.clear()
