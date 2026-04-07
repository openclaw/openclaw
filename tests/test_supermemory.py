"""Unit tests for SuperMemory system."""
import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.memory_system.legacy import SuperMemory, MemoryRecord


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _make_supermemory(tmp_dir: str) -> SuperMemory:
    """Create SuperMemory with temp directory (no ChromaDB dependency)."""
    sm = SuperMemory(persist_dir=tmp_dir)
    # Initialize SQLite only (skip ChromaDB for unit tests)
    sm.initialize()
    return sm


def _close_supermemory(sm: SuperMemory) -> None:
    """Close SQLite connection so temp dir can be cleaned on Windows."""
    if hasattr(sm, '_conn') and sm._conn is not None:
        sm._conn.close()
        sm._conn = None


# ---------------------------------------------------------------------------
# Store & Recall
# ---------------------------------------------------------------------------
def test_store_and_recall():
    with tempfile.TemporaryDirectory() as tmp:
        sm = _make_supermemory(tmp)
        sm.store(
            key="test-fact-1",
            content="Python 3.12 supports faster comprehensions.",
            importance=0.8,
            source="test",
            tier="hot",
        )
        results = sm.recall("Python comprehensions", top_k=5)
        # Should find the stored fact via keyword match
        found = any("Python" in r.content for r in results)
        _close_supermemory(sm)
        assert found, f"Expected to find stored fact, got: {results}"
        print("[PASS] store and recall")


def test_store_multiple_tiers():
    with tempfile.TemporaryDirectory() as tmp:
        sm = _make_supermemory(tmp)
        sm.store("hot-fact", "Hot memory content", 0.9, "test", "hot")
        sm.store("warm-fact", "Warm memory content", 0.5, "test", "warm")
        sm.store("cold-fact", "Cold memory content", 0.2, "test", "cold")

        stats = sm.get_stats()
        _close_supermemory(sm)
        assert stats["hot_items"] + stats["warm_items"] + stats["cold_items"] >= 3
        print("[PASS] store multiple tiers")


# ---------------------------------------------------------------------------
# MemoryRecord dataclass
# ---------------------------------------------------------------------------
def test_memory_record():
    rec = MemoryRecord(
        key="rec-1",
        content="Test content",
        tier="hot",
        importance=0.7,
        source="test",
    )
    assert rec.key == "rec-1"
    assert rec.tier == "hot"
    assert rec.importance == 0.7
    print("[PASS] MemoryRecord dataclass")


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------
def test_get_stats_empty():
    with tempfile.TemporaryDirectory() as tmp:
        sm = _make_supermemory(tmp)
        stats = sm.get_stats()
        _close_supermemory(sm)
        assert "hot_items" in stats
        assert stats["hot_items"] == 0
        print("[PASS] get_stats empty")


# ---------------------------------------------------------------------------
# Garbage Collection
# ---------------------------------------------------------------------------
def test_gc_no_crash():
    """GC should not crash on empty database."""
    with tempfile.TemporaryDirectory() as tmp:
        sm = _make_supermemory(tmp)
        sm.gc()
        _close_supermemory(sm)
        print("[PASS] gc no crash on empty db")


# ---------------------------------------------------------------------------
# Run all
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    test_memory_record()
    test_get_stats_empty()
    test_gc_no_crash()
    test_store_and_recall()
    test_store_multiple_tiers()
    print("\n✅ All SuperMemory tests passed!")
