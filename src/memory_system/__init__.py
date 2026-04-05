"""Python memory subsystem — tiered memory, GC compression, unified facade.

Submodules:
  - tiered  : TieredMemoryManager, MemoryImportanceScorer, EpisodicMemory (MemGPT/Mem-α/Memento)
  - gc      : MemoryGarbageCollector (anchored iterative compression)
  - unified : UnifiedMemory facade (composes tiered + GC + episodic)
  - legacy  : SuperMemory (deprecated SQLite + RAG — migrate to unified)
"""

from src.memory_system.tiered import (
    EpisodicMemory,
    EpisodeRecord,
    MemoryImportanceScorer,
    MemoryItem,
    MemoryStats,
    TieredMemoryManager,
)
from src.memory_system.gc import MemoryGarbageCollector
from src.memory_system.unified import UnifiedMemory

__all__ = [
    "EpisodicMemory",
    "EpisodeRecord",
    "MemoryGarbageCollector",
    "MemoryImportanceScorer",
    "MemoryItem",
    "MemoryStats",
    "TieredMemoryManager",
    "UnifiedMemory",
]
