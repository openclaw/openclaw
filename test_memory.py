#!/usr/bin/env python3
"""
Test script for O.R.I.O.N. Memory and Dream systems.
Demonstrates preference learning and recall capabilities.
"""

import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(__file__))

from core.memory import Memory, remember_preference, recall_preferences
from modules.dream import DreamState


def test_memory_system():
    """Test the memory system with preference storage and recall."""

    print("=" * 70)
    print("🧠 O.R.I.O.N. MEMORY TEST - Preference Learning")
    print("=" * 70)

    # Initialize memory
    mem = Memory()

    # Phase 1: Process conversation logs to learn preferences
    print("\n📖 PHASE 1: Learning from conversation logs...\n")

    dreamer = DreamState()

    # Process the conversation log (extracts preferences automatically)
    log_file = "conversation.log"
    if os.path.exists(log_file):
        result = dreamer.process_logs(log_file)
        print(f"\n✅ Dream cycle result: {result['status']}")
        print(f"   Preferences learned: {result.get('preferences_stored', 0)}")
    else:
        print(f"⚠️ Log file not found: {log_file}")
        print("   Manually adding test preferences...")

        # Fallback: manually add some preferences
        remember_preference("I prefer efficiency to keep my API bills low", "workflow")
        remember_preference("I like the kernel vs plugin architecture for safety", "architecture")
        remember_preference("Never update core/ files - they are immutable", "security")
        remember_preference("I prefer comprehensive docstrings in Google style", "coding_style")
        remember_preference("Always add type hints to function signatures", "coding_style")

    # Phase 2: Query the memory to demonstrate recall
    print("\n" + "=" * 70)
    print("🔍 PHASE 2: Testing Memory Recall")
    print("=" * 70)

    # Test 1: Recall coding style preferences
    print("\n📝 Question: What are my coding style preferences?")
    coding_prefs = recall_preferences("coding style preferences", n=3)

    if coding_prefs:
        print(f"\n💭 O.R.I.O.N. remembers {len(coding_prefs)} thing(s) about your coding style:\n")
        for i, pref in enumerate(coding_prefs, 1):
            relevance = (1 - pref['distance']) * 100
            print(f"   {i}. {pref['text']}")
            print(f"      Category: {pref['metadata'].get('category', 'N/A')}")
            print(f"      Relevance: {relevance:.1f}%\n")
    else:
        print("   ⚠️ No preferences found in memory")

    # Test 2: Recall architecture preferences
    print("\n🏗️ Question: What do I prefer about architecture?")
    arch_prefs = recall_preferences("architecture safety immutability", n=2)

    if arch_prefs:
        print(f"\n💭 O.R.I.O.N. remembers:\n")
        for i, pref in enumerate(arch_prefs, 1):
            print(f"   {i}. {pref['text']}\n")
    else:
        print("   ⚠️ No architecture preferences found")

    # Test 3: General memory stats
    print("\n" + "=" * 70)
    print("📊 Memory Statistics")
    print("=" * 70)

    stats = mem.get_stats()
    print(f"\n   Total memories stored: {stats['total_memories']}")
    print(f"   Collection: {stats['collection_name']}")
    print(f"   Database: ./brain_data/\n")

    print("=" * 70)
    print("✅ MEMORY TEST COMPLETE")
    print("=" * 70 + "\n")


if __name__ == "__main__":
    test_memory_system()
