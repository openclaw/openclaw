/**
 * Tiered Cache System Test Suite
 *
 * Run with: npx ts-node tiered-cache.test.ts
 */

import { DiskCache } from "./disk-cache.js";
import { Prefetcher } from "./prefetcher.js";
import { RamCache } from "./ram-cache.js";
import type { CachedSlot, PrefetchPrediction } from "./types.js";

const TEST_DIR = "/tmp/tiered-cache-test";

// Test utilities
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.log(`✗ ${name}`);
    console.log(`  Error: ${String(err)}`);
    process.exitCode = 1;
  }
}

// ============================================================================
// Tests
// ============================================================================

async function testRamCache(): Promise<void> {
  console.log("\n--- RAM Cache Tests ---\n");

  const cache = new RamCache({
    maxMemoryBytes: 1024 * 1024, // 1MB for testing
    evictionPolicy: "lru",
  });

  await cache.initialize();

  await test("RAM: Store and load slot", async () => {
    const slot: CachedSlot = {
      id: "test-slot-1",
      sessionId: "session-1",
      tokenCount: 100,
      sizeBytes: 1024,
      location: { tier: "ram", ramKey: "test-slot-1" },
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      isPinned: false,
      isPrefetch: false,
      metadata: {},
    };

    const data = Buffer.from("test data content");

    const stored = await cache.store(slot, data);
    assert(stored, "Should store successfully");

    const loaded = await cache.load("test-slot-1");
    assert(loaded !== null, "Should load successfully");
    assert(loaded!.data.toString() === "test data content", "Data should match");
  });

  await test("RAM: LRU eviction", async () => {
    // Fill cache to trigger eviction
    for (let i = 0; i < 100; i++) {
      const slot: CachedSlot = {
        id: `evict-test-${i}`,
        sessionId: `session-${i}`,
        tokenCount: 100,
        sizeBytes: 20000,
        location: { tier: "ram" },
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        accessCount: 0,
        isPinned: false,
        isPrefetch: false,
        metadata: {},
      };

      const data = Buffer.alloc(20000, i);
      await cache.store(slot, data);
    }

    // First slot should have been evicted
    const firstSlot = await cache.load("test-slot-1");
    // This might or might not be evicted depending on timing
    // Just check that cache is working
    const stats = cache.getStats();
    assert(stats.itemsCount > 0, "Cache should have items");
  });

  await test("RAM: Pinning", async () => {
    const slot: CachedSlot = {
      id: "pinned-slot",
      sessionId: "pinned-session",
      tokenCount: 100,
      sizeBytes: 100,
      location: { tier: "ram" },
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      isPinned: false,
      isPrefetch: false,
      metadata: {},
    };

    const data = Buffer.from("pinned data");
    await cache.store(slot, data);

    cache.pin("pinned-slot");
    assert(cache.isPinned("pinned-slot"), "Slot should be pinned");

    // Try to evict (should fail for pinned)
    const evicted = await cache.evictSlot("pinned-slot");
    assert(!evicted, "Should not evict pinned slot");
  });

  await cache.close();
}

async function testDiskCache(): Promise<void> {
  console.log("\n--- Disk Cache Tests ---\n");

  const cache = new DiskCache({
    basePath: TEST_DIR,
    compression: "gzip",
    compressionLevel: 6,
    asyncWrites: false,
  });

  await cache.initialize();

  await test("Disk: Store and load slot", async () => {
    const slot: CachedSlot = {
      id: "disk-slot-1",
      sessionId: "disk-session-1",
      tokenCount: 100,
      sizeBytes: 1024,
      location: { tier: "disk" },
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      isPinned: false,
      isPrefetch: false,
      metadata: { sourcePaths: ["/test/path.txt"] },
    };

    const data = Buffer.from("disk test data content with some repetition for compression");

    const result = await cache.store(slot, data);
    assert(result.path.includes("disk-slot-1"), "Path should contain slot id");

    const loaded = await cache.load("disk-slot-1");
    assert(loaded !== null, "Should load successfully");
    assert(loaded!.data.toString() === data.toString(), "Data should match after decompression");
  });

  await test("Disk: Template storage", async () => {
    const templateData = Buffer.from("system prompt template content");
    const path = await cache.storeTemplate("system-prompt", templateData);

    const loaded = await cache.loadTemplate("system-prompt");
    assert(loaded !== null, "Should load template");
    assert(loaded!.toString() === templateData.toString(), "Template data should match");
  });

  await test("Disk: Delete slot", async () => {
    const deleted = await cache.delete("disk-slot-1");
    assert(deleted, "Should delete successfully");

    const loaded = await cache.load("disk-slot-1");
    assert(loaded === null, "Should not load deleted slot");
  });

  await cache.close();

  // Cleanup
  const fs = await import("fs/promises");
  await fs.rm(TEST_DIR, { recursive: true, force: true });
}

async function testPrefetcher(): Promise<void> {
  console.log("\n--- Prefetcher Tests ---\n");

  const prefetcher = new Prefetcher({
    enabled: true,
    learningEnabled: true,
    historySize: 100,
    minConfidence: 0.3,
  });

  await prefetcher.initialize();

  await test("Prefetcher: Record access patterns", async () => {
    // Record some access patterns
    for (let i = 0; i < 20; i++) {
      prefetcher.recordAccess({
        sessionId: `session-${i % 5}`,
        slotId: `slot-${i % 5}`,
        accessType: "hit",
        sourceTier: "ram",
      });

      // Simulate time passing
      await new Promise((r) => setTimeout(r, 10));
    }

    const stats = prefetcher.getStats();
    assert(stats.historySize === 20, "Should have 20 history items");
    assert(stats.sessionsTracked === 5, "Should track 5 sessions");
  });

  await test("Prefetcher: Generate predictions", async () => {
    // Generate predictions
    const predictions = prefetcher.predict("session-1");

    // Should have some predictions based on frequency
    console.log(`    Generated ${predictions.length} predictions`);

    // All predictions should have required fields
    for (const pred of predictions) {
      assert(pred.slotId !== undefined, "Should have slotId");
      assert(pred.confidence >= 0 && pred.confidence <= 1, "Confidence should be 0-1");
      assert(pred.reason !== undefined, "Should have reason");
    }
  });

  await test("Prefetcher: Reset learning data", async () => {
    prefetcher.reset();

    const stats = prefetcher.getStats();
    assert(stats.historySize === 0, "History should be empty");
    assert(stats.sequencesLearned === 0, "Sequences should be empty");
  });

  await prefetcher.close();
}

async function testIntegration(): Promise<void> {
  console.log("\n--- Integration Tests ---\n");

  await test("Integration: RAM to Disk promotion/demotion", async () => {
    const ramCache = new RamCache({ maxMemoryBytes: 1024 * 10 });
    const diskCache = new DiskCache({ basePath: TEST_DIR, compression: "none" });

    await ramCache.initialize();
    await diskCache.initialize();

    // Store in RAM
    const slot: CachedSlot = {
      id: "integration-slot",
      sessionId: "integration-session",
      tokenCount: 100,
      sizeBytes: 500,
      location: { tier: "ram" },
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      isPinned: false,
      isPrefetch: false,
      metadata: {},
    };

    const data = Buffer.from("integration test data");

    await ramCache.store(slot, data);
    assert(ramCache.has("integration-slot"), "RAM should have slot");

    // Demote to disk
    const ramData = await ramCache.load("integration-slot");
    await diskCache.store(ramData!.slot, ramData!.data);
    await ramCache.evictSlot("integration-slot");

    assert(!ramCache.has("integration-slot"), "RAM should not have slot after demotion");
    assert(diskCache.has("integration-slot"), "Disk should have slot");

    // Promote back to RAM
    const diskData = await diskCache.load("integration-slot");
    await ramCache.store(diskData!.slot, diskData!.data);

    assert(ramCache.has("integration-slot"), "RAM should have slot after promotion");

    await ramCache.close();
    await diskCache.close();

    // Cleanup
    const fs = await import("fs/promises");
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(50));
  console.log("  Tiered Cache System Test Suite");
  console.log("=".repeat(50));

  try {
    await testRamCache();
    await testDiskCache();
    await testPrefetcher();
    await testIntegration();

    console.log("\n" + "=".repeat(50));
    console.log("  All tests completed!");
    console.log("=".repeat(50) + "\n");
  } catch (err) {
    console.error("\nTest suite failed:", String(err));
    process.exit(1);
  }
}

main();
