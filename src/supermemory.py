"""Backward-compatible shim — real implementation in src/memory_system/legacy.py.

SuperMemory is deprecated — prefer UnifiedMemory from src.memory_system.
"""
from src.memory_system.legacy import *  # noqa: F401,F403
from src.memory_system.legacy import SuperMemory, MemoryRecord  # noqa: F401
