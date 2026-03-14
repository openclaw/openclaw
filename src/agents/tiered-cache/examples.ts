/**
 * Tiered Cache Integration Example
 *
 * Shows how to integrate the tiered cache with OpenClaw
 */

import { createTieredCacheManager, TieredCacheManager } from "./index.js";
import type { CacheEvent, CacheStats, PrefetchPrediction } from "./types.js";

// ============================================================================
// Example: Basic Usage
// ============================================================================

async function basicUsageExample(): Promise<void> {
  console.log("=== Basic Usage Example ===\n");

  // Create the cache manager
  const cache = await createTieredCacheManager({
    llamaServerUrl: "http://127.0.0.1:18790",
    gpu: {
      enabled: true,
      maxSlots: 4,
      slotContextSize: 65536,
    },
    ram: {
      enabled: true,
      maxMemoryBytes: 40 * 1024 * 1024 * 1024, // 40GB
      evictionPolicy: "lru",
    },
    disk: {
      enabled: true,
      basePath: "~/.openclaw/kv-cache",
      compression: "zstd",
    },
    prefetcher: {
      enabled: true,
      learningEnabled: true,
    },
  });

  // Listen for events
  cache.onEvent((event: CacheEvent) => {
    switch (event.type) {
      case "slot_promoted":
        console.log(`Promoted ${event.slot.id} from ${event.from} to ${event.to}`);
        break;
      case "slot_evicted":
        console.log(`Evicted ${event.slot.id} from ${event.tier}`);
        break;
      case "stats_updated":
        console.log(`Cache hit rate: ${(event.stats.overallHitRate * 100).toFixed(1)}%`);
        break;
    }
  });

  // Store a slot
  const sessionId = "example-session-123";
  const contextData = Buffer.from("Example conversation context...");

  const result = await cache.store(sessionId, sessionId, contextData, {
    tokenCount: 100,
    sourcePaths: ["/path/to/source.md"],
  });

  console.log(`Stored at tier: ${result.storedAt}`);

  // Later, lookup the slot
  const lookup = await cache.lookup(sessionId);
  if (lookup.found) {
    console.log(`Found at tier: ${lookup.tier}`);
  }

  // Get predictions
  const predictions = cache.getPrefetchPredictions();
  console.log(`Predictions: ${predictions.length}`);

  // Get stats
  const stats = cache.getStats();
  console.log(`Overall hit rate: ${(stats.overallHitRate * 100).toFixed(1)}%`);

  // Clean up
  await cache.close();
}

// ============================================================================
// Example: With Agent Integration
// ============================================================================

async function agentIntegrationExample(): Promise<void> {
  console.log("\n=== Agent Integration Example ===\n");

  // In a real agent, you'd integrate like this:

  class MyAgent {
    private cache: TieredCacheManager;

    async initialize(): Promise<void> {
      this.cache = await createTieredCacheManager({
        llamaServerUrl: process.env.LLAMA_SERVER_URL || "http://127.0.0.1:18790",
      });

      // Preload common contexts
      await this.preloadCommonContexts();
    }

    private async preloadCommonContexts(): Promise<void> {
      // Preload system prompt
      const systemPrompt = "You are a helpful assistant...";
      await this.cache.store("system-prompt", "system", Buffer.from(systemPrompt), {
        tokenCount: 50,
      });

      // Preload tool definitions
      const tools = this.getToolDefinitions();
      await this.cache.store("tool-definitions", "tools", Buffer.from(tools), {
        tokenCount: 200,
      });
    }

    private getToolDefinitions(): string {
      return "[Tool definitions JSON...]";
    }

    async processMessage(sessionId: string, message: string): Promise<string> {
      // 1. Check cache for session context
      const cached = await this.cache.lookup(sessionId);

      if (cached.found) {
        console.log(`Cache hit at ${cached.tier}`);
      } else {
        console.log("Cache miss, building context...");

        // Build context and store
        const context = await this.buildContext(sessionId);
        await this.cache.store(sessionId, sessionId, Buffer.from(context), {
          tokenCount: this.estimateTokens(context),
        });
      }

      // 2. Get predictions for next likely sessions
      const predictions = this.cache.getPrefetchPredictions();
      await this.prefetchPredictions(predictions);

      // 3. Process with LLM
      const response = await this.callLLM(sessionId, message);

      // 4. Record access for learning
      // (This would be done internally by the cache manager)

      return response;
    }

    private async buildContext(sessionId: string): Promise<string> {
      return "Context for " + sessionId;
    }

    private estimateTokens(text: string): number {
      return Math.ceil(text.length / 4);
    }

    private async callLLM(sessionId: string, message: string): Promise<string> {
      // Would call the actual LLM here
      return "Response to: " + message;
    }

    private async prefetchPredictions(predictions: PrefetchPrediction[]): Promise<void> {
      // Prefetch high-confidence predictions
      for (const pred of predictions.slice(0, 2)) {
        if (pred.confidence > 0.7) {
          console.log(`Would prefetch ${pred.slotId} (${pred.confidence.toFixed(2)} confidence)`);
        }
      }
    }

    async close(): Promise<void> {
      await this.cache.close();
    }
  }

  // Usage
  const agent = new MyAgent();
  await agent.initialize();

  const response = await agent.processMessage("user-123", "Hello!");
  console.log(`Agent response: ${response}`);

  await agent.close();
}

// ============================================================================
// Example: Monitoring Dashboard
// ============================================================================

async function monitoringExample(): Promise<void> {
  console.log("\n=== Monitoring Example ===\n");

  const cache = await createTieredCacheManager();

  // Set up periodic stats logging
  const statsInterval = setInterval(() => {
    const stats = cache.getStats();

    console.log("\n--- Cache Stats ---");
    console.log(`GPU: ${stats.gpu.itemsCount} slots, ${formatBytes(stats.gpu.bytesUsed)}`);
    console.log(`RAM: ${stats.ram.itemsCount} slots, ${formatBytes(stats.ram.bytesUsed)}`);
    console.log(`Disk: ${stats.disk.itemsCount} slots, ${formatBytes(stats.disk.bytesUsed)}`);
    console.log(`Hit Rate: ${(stats.overallHitRate * 100).toFixed(1)}%`);
    console.log(`Avg Latency: ${stats.overallLatencyMs.toFixed(1)}ms`);

    // Alert on high memory pressure
    const ramPressure = stats.ram.bytesUsed / stats.ram.bytesAvailable;
    if (ramPressure > 0.9) {
      console.warn("⚠️  RAM cache pressure high!");
    }
  }, 10000);

  // Listen for important events
  cache.onEvent((event) => {
    if (event.type === "tier_full") {
      console.warn(`⚠️  Tier ${event.tier} is full!`);
    }
  });

  // Run for a bit
  await new Promise((r) => setTimeout(r, 30000));

  clearInterval(statsInterval);
  await cache.close();
}

// ============================================================================
// Helper
// ============================================================================

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let value = bytes;

  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }

  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ============================================================================
// Run Examples
// ============================================================================

async function main(): Promise<void> {
  try {
    await basicUsageExample();
    // await agentIntegrationExample();
    // await monitoringExample();
  } catch (err) {
    console.error("Example failed:", String(err));
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { basicUsageExample, agentIntegrationExample, monitoringExample };
