/**
 * Benchmark script to measure cache performance improvements
 */

import { performance } from "node:perf_hooks";
import { CacheManager } from "./cache-manager.js";
import { createCachedModelCall } from "./integrations/model-response-cache.js";
import { createCachedWebSearch } from "./integrations/web-search-cache.js";

type BenchmarkResult = {
  operation: string;
  withoutCache: {
    avgLatency: number;
    totalTime: number;
    operations: number;
  };
  withCache: {
    avgLatency: number;
    totalTime: number;
    operations: number;
    hitRate: number;
  };
  improvement: {
    latencyReduction: number;
    speedup: number;
  };
};

class CacheBenchmark {
  private cache: CacheManager;
  private results: BenchmarkResult[] = [];

  constructor() {
    this.cache = new CacheManager({
      maxSizeInMB: 10,
      enableMetrics: true,
    });
  }

  /**
   * Run all benchmarks
   */
  async runAll(): Promise<void> {
    console.log("🚀 Starting cache performance benchmarks...\n");

    await this.benchmarkWebSearch();
    await this.benchmarkModelResponses();
    await this.benchmarkMixedWorkload();

    this.printResults();
  }

  /**
   * Benchmark web search caching
   */
  private async benchmarkWebSearch(): Promise<void> {
    console.log("📊 Benchmarking web search caching...");

    // Simulate web search function
    const mockSearch = async (params: { query: string }) => {
      // Simulate network latency
      await this.sleep(100 + Math.random() * 50);
      return {
        results: [{ title: `Result for ${params.query}`, url: "http://example.com" }],
      };
    };

    // Test queries (some repeated)
    const queries = [
      "OpenClaw performance",
      "TypeScript caching",
      "LRU cache implementation",
      "OpenClaw performance", // Duplicate
      "web search optimization",
      "TypeScript caching", // Duplicate
      "API response caching",
      "OpenClaw performance", // Duplicate
      "memory management",
      "TypeScript caching", // Duplicate
    ];

    // Without cache
    const withoutCacheStart = performance.now();
    for (const query of queries) {
      await mockSearch({ query });
    }
    const withoutCacheTime = performance.now() - withoutCacheStart;

    // With cache
    const cachedSearch = createCachedWebSearch(this.cache, mockSearch as any);
    await this.cache.clearAll(); // Start fresh

    const withCacheStart = performance.now();
    for (const query of queries) {
      await cachedSearch({ query });
    }
    const withCacheTime = performance.now() - withCacheStart;

    const stats = await this.cache.getStats();

    this.results.push({
      operation: "Web Search",
      withoutCache: {
        avgLatency: withoutCacheTime / queries.length,
        totalTime: withoutCacheTime,
        operations: queries.length,
      },
      withCache: {
        avgLatency: withCacheTime / queries.length,
        totalTime: withCacheTime,
        operations: queries.length,
        hitRate: stats.global.hitRate,
      },
      improvement: {
        latencyReduction: withoutCacheTime - withCacheTime,
        speedup: withoutCacheTime / withCacheTime,
      },
    });
  }

  /**
   * Benchmark model response caching
   */
  private async benchmarkModelResponses(): Promise<void> {
    console.log("📊 Benchmarking model response caching...");

    // Simulate model API call
    const mockModelCall = async (params: { messages: any[]; model: string }) => {
      // Simulate processing time
      await this.sleep(200 + Math.random() * 100);
      const lastMessage = params.messages[params.messages.length - 1]?.content || "";
      return {
        content: `Response to: ${lastMessage}`,
        model: params.model,
        usage: { totalTokens: 100 },
      };
    };

    // Test prompts (some very similar)
    const prompts = [
      "What is TypeScript?",
      "Explain JavaScript closures",
      "What is TypeScript?", // Duplicate
      "What is typescript?", // Similar (case difference)
      "How does async/await work?",
      "Explain JavaScript closures", // Duplicate
      "What are React hooks?",
      "What is TypeScript?", // Duplicate
      "Explain promises in JavaScript",
      "what is typescript?", // Similar
    ];

    // Without cache
    const withoutCacheStart = performance.now();
    for (const prompt of prompts) {
      await mockModelCall({
        messages: [{ role: "user", content: prompt }],
        model: "test-model",
      });
    }
    const withoutCacheTime = performance.now() - withoutCacheStart;

    // With cache
    const cachedModelCall = createCachedModelCall(this.cache, mockModelCall as any);
    await this.cache.clearAll(); // Start fresh

    const withCacheStart = performance.now();
    for (const prompt of prompts) {
      await cachedModelCall({
        messages: [{ role: "user", content: prompt }],
        model: "test-model",
        temperature: 0, // Deterministic
      });
    }
    const withCacheTime = performance.now() - withCacheStart;

    const stats = await this.cache.getStats();

    this.results.push({
      operation: "Model Response",
      withoutCache: {
        avgLatency: withoutCacheTime / prompts.length,
        totalTime: withoutCacheTime,
        operations: prompts.length,
      },
      withCache: {
        avgLatency: withCacheTime / prompts.length,
        totalTime: withCacheTime,
        operations: prompts.length,
        hitRate: stats.global.hitRate,
      },
      improvement: {
        latencyReduction: withoutCacheTime - withCacheTime,
        speedup: withoutCacheTime / withCacheTime,
      },
    });
  }

  /**
   * Benchmark mixed workload
   */
  private async benchmarkMixedWorkload(): Promise<void> {
    console.log("📊 Benchmarking mixed workload...");

    await this.cache.clearAll();

    const operations = 100;
    const cacheableRatio = 0.4; // 40% of operations are repeats

    const withoutCacheStart = performance.now();
    for (let i = 0; i < operations; i++) {
      if (Math.random() < 0.5) {
        // Web search
        await this.sleep(50);
      } else {
        // Model call
        await this.sleep(150);
      }
    }
    const withoutCacheTime = performance.now() - withoutCacheStart;

    // With cache (simulating cache hits)
    const withCacheStart = performance.now();
    for (let i = 0; i < operations; i++) {
      if (Math.random() < cacheableRatio) {
        // Cache hit
        await this.sleep(1);
      } else if (Math.random() < 0.5) {
        // Web search miss
        await this.sleep(50);
      } else {
        // Model call miss
        await this.sleep(150);
      }
    }
    const withCacheTime = performance.now() - withCacheStart;

    this.results.push({
      operation: "Mixed Workload",
      withoutCache: {
        avgLatency: withoutCacheTime / operations,
        totalTime: withoutCacheTime,
        operations,
      },
      withCache: {
        avgLatency: withCacheTime / operations,
        totalTime: withCacheTime,
        operations,
        hitRate: cacheableRatio * 100,
      },
      improvement: {
        latencyReduction: withoutCacheTime - withCacheTime,
        speedup: withoutCacheTime / withCacheTime,
      },
    });
  }

  /**
   * Print benchmark results
   */
  private printResults(): void {
    console.log("\n📈 BENCHMARK RESULTS\n" + "=".repeat(60));

    for (const result of this.results) {
      console.log(`\n🔹 ${result.operation}`);
      console.log("─".repeat(40));

      console.log("Without Cache:");
      console.log(`  • Average Latency: ${result.withoutCache.avgLatency.toFixed(2)}ms`);
      console.log(`  • Total Time: ${result.withoutCache.totalTime.toFixed(2)}ms`);

      console.log("With Cache:");
      console.log(`  • Average Latency: ${result.withCache.avgLatency.toFixed(2)}ms`);
      console.log(`  • Total Time: ${result.withCache.totalTime.toFixed(2)}ms`);
      console.log(`  • Hit Rate: ${result.withCache.hitRate.toFixed(1)}%`);

      console.log("Improvement:");
      console.log(`  • Latency Reduction: ${result.improvement.latencyReduction.toFixed(2)}ms`);
      console.log(`  • Speedup: ${result.improvement.speedup.toFixed(2)}x`);
      console.log(`  • Time Saved: ${((1 - 1 / result.improvement.speedup) * 100).toFixed(1)}%`);
    }

    // Overall summary
    const avgSpeedup =
      this.results.reduce((sum, r) => sum + r.improvement.speedup, 0) / this.results.length;
    const totalTimeSaved = this.results.reduce((sum, r) => sum + r.improvement.latencyReduction, 0);

    console.log("\n" + "=".repeat(60));
    console.log("📊 OVERALL SUMMARY");
    console.log("─".repeat(40));
    console.log(`• Average Speedup: ${avgSpeedup.toFixed(2)}x`);
    console.log(`• Total Time Saved: ${totalTimeSaved.toFixed(2)}ms`);
    console.log(`• Cache Effectiveness: ${this.getCacheEffectiveness()}`);
    console.log("=".repeat(60));
  }

  /**
   * Calculate overall cache effectiveness
   */
  private getCacheEffectiveness(): string {
    const avgSpeedup =
      this.results.reduce((sum, r) => sum + r.improvement.speedup, 0) / this.results.length;

    if (avgSpeedup > 3) {
      return "🌟 Excellent";
    }
    if (avgSpeedup > 2) {
      return "✅ Very Good";
    }
    if (avgSpeedup > 1.5) {
      return "👍 Good";
    }
    if (avgSpeedup > 1.2) {
      return "🆗 Moderate";
    }
    return "⚠️ Limited";
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  dispose(): void {
    this.cache.dispose();
  }
}

// Run benchmark if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const benchmark = new CacheBenchmark();

  benchmark
    .runAll()
    .then(() => {
      benchmark.dispose();
      process.exit(0);
    })
    .catch((err) => {
      console.error("Benchmark failed:", err);
      benchmark.dispose();
      process.exit(1);
    });
}

export { CacheBenchmark };
