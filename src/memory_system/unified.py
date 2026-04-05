"""Unified Memory — single entry point wrapping all memory subsystems.

Composes:
- TieredMemoryManager (MemGPT) — hot/warm/cold tiers
- MemoryGarbageCollector — anchored iterative compression
- EpisodicMemory (Memento) — TF-IDF episode retrieval

Usage:
    mem = UnifiedMemory(config)
    mem.add("fact_key", "some content", importance=0.8)
    results = mem.recall("what happened?", top_k=5)
    await mem.compress_if_needed(history)
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import structlog

from src.memory_system.tiered import (
    EpisodicMemory,
    EpisodeRecord,
    MemoryItem,
    MemoryStats,
    TieredMemoryManager,
)
from src.memory_system.gc import MemoryGarbageCollector

logger = structlog.get_logger(__name__)


class UnifiedMemory:
    """Single facade over tiered memory, GC compression, and episodic retrieval."""

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        config = config or {}
        mem_cfg = config.get("memory", {})
        self._tiered = TieredMemoryManager(
            memory_bank_dir=mem_cfg.get("memory_bank_dir", ".memory-bank"),
            max_hot_tokens=mem_cfg.get("max_hot_tokens", 2000),
            max_warm_items=mem_cfg.get("max_warm_items", 100),
        )
        self._gc = MemoryGarbageCollector(config)
        self._episodic = EpisodicMemory(
            storage_dir=mem_cfg.get("training_data_dir", "training_data"),
        )
        logger.info("UnifiedMemory initialized")

    # -- Core API --

    def add(self, key: str, content: str, importance: float = 0.5) -> None:
        """Store a fact in hot memory."""
        self._tiered.add_to_hot(key, content, importance)

    def recall(self, query: str, top_k: int = 5) -> List[Dict[str, Any]]:
        """Retrieve relevant items from tiered + episodic memory."""
        # Page-in from warm/cold
        paged = self._tiered.page_in(query, k=min(top_k, 3))

        # Hot memory context
        hot_items = sorted(
            self._tiered._hot.values(),
            key=lambda it: it.importance,
            reverse=True,
        )[:top_k]

        results: List[Dict[str, Any]] = []
        for item in hot_items:
            results.append({
                "key": item.key,
                "content": item.content,
                "source": f"tiered:{item.tier}",
                "score": item.importance,
            })

        # Episodic memory
        episodes = self._episodic.retrieve_similar(query, k=min(top_k, 2))
        for ep in episodes:
            results.append({
                "key": ep.episode_id,
                "content": ep.compressed_summary or ep.task,
                "source": "episodic",
                "score": ep.reward,
            })

        return results[:top_k]

    async def compress_if_needed(self, history: List[Dict[str, str]]) -> List[Dict[str, str]]:
        """Delegate to GC for context compression."""
        return await self._gc.compress_if_needed(history)

    def record_episode(
        self, task: str, steps: List[Dict[str, str]], reward: float, success: bool = True
    ) -> None:
        """Record a completed task trajectory."""
        import uuid
        episode = EpisodeRecord(
            episode_id=str(uuid.uuid4())[:8],
            task=task,
            steps=steps,
            reward=reward,
            success=success,
        )
        self._episodic.store_episode(episode)

    def get_context_window(self, max_tokens: int = 2000) -> str:
        """Get formatted context from hot memory for LLM prompt."""
        return self._tiered.get_context_window(max_tokens)

    def get_stats(self) -> MemoryStats:
        return self._tiered.get_stats()

    def decay(self, factor: float = 0.95) -> None:
        self._tiered.decay(factor)

    def update_reward(self, key: str, reward: float) -> None:
        self._tiered.update_reward(key, reward)

    # -- Persistence --

    def save_state(self, path: str) -> None:
        self._tiered.save_state(path)

    def restore_state(self, path: str) -> None:
        self._tiered.restore_state(path)
