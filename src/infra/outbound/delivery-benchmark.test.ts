import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// This is a real filesystem test, not mocked
describe("delivery queue benchmark", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oag-bench-"));
    const queueDir = path.join(tmpDir, "delivery-queue");
    fs.mkdirSync(queueDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMockDelivery(id: string, channel: string, accountId: string) {
    return {
      id,
      channel,
      accountId,
      to: `${channel}:user-${id}`,
      payloads: [{ text: `Message ${id}` }],
      enqueuedAt: Date.now(),
      retryCount: 0,
      lanePriority: "user-visible",
    };
  }

  function writeDeliveries(count: number, channels: string[] = ["telegram", "discord", "slack"]) {
    const queueDir = path.join(tmpDir, "delivery-queue");
    for (let i = 0; i < count; i++) {
      const channel = channels[i % channels.length];
      const entry = createMockDelivery(`d-${i}`, channel, "default");
      fs.writeFileSync(path.join(queueDir, `${entry.id}.json`), JSON.stringify(entry), "utf-8");
    }
  }

  function scanFullDirectory(filter?: { channel?: string }) {
    const queueDir = path.join(tmpDir, "delivery-queue");
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".json") && f !== "index.json");
    const entries = [];
    for (const file of files) {
      const raw = fs.readFileSync(path.join(queueDir, file), "utf-8");
      const entry = JSON.parse(raw);
      if (filter?.channel && entry.channel !== filter.channel) {
        continue;
      }
      entries.push(entry);
    }
    return entries;
  }

  function buildAndQueryIndex(filter?: { channel?: string }) {
    const queueDir = path.join(tmpDir, "delivery-queue");
    // Build index
    const indexEntries: Record<
      string,
      { id: string; channel: string; accountId: string; enqueuedAt: number }
    > = {};
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".json") && f !== "index.json");
    for (const file of files) {
      const raw = fs.readFileSync(path.join(queueDir, file), "utf-8");
      const entry = JSON.parse(raw);
      indexEntries[entry.id] = {
        id: entry.id,
        channel: entry.channel,
        accountId: entry.accountId,
        enqueuedAt: entry.enqueuedAt,
      };
    }
    fs.writeFileSync(
      path.join(queueDir, "index.json"),
      JSON.stringify({ version: 1, entries: indexEntries }),
    );

    // Query from index
    const index = JSON.parse(fs.readFileSync(path.join(queueDir, "index.json"), "utf-8"));
    let results = Object.values(index.entries);
    if (filter?.channel) {
      results = results.filter((e) => e.channel === filter.channel);
    }
    return results;
  }

  it("benchmarks 100 deliveries — full scan vs index query", () => {
    writeDeliveries(100);

    const scanStart = performance.now();
    const scanResults = scanFullDirectory({ channel: "telegram" });
    const scanMs = performance.now() - scanStart;

    const indexStart = performance.now();
    const indexResults = buildAndQueryIndex({ channel: "telegram" });
    const indexMs = performance.now() - indexStart;

    // Index build includes initial scan, so compare query-only time
    // For this test, just verify correctness
    expect(scanResults.length).toBe(34); // 100/3 ≈ 33-34
    expect(indexResults.length).toBe(scanResults.length);

    console.log(
      `[100 deliveries] Full scan: ${scanMs.toFixed(1)}ms | Index build+query: ${indexMs.toFixed(1)}ms`,
    );
  });

  it("benchmarks 1000 deliveries — full scan vs index query", () => {
    writeDeliveries(1000);

    const scanStart = performance.now();
    const scanResults = scanFullDirectory({ channel: "telegram" });
    const scanMs = performance.now() - scanStart;

    const indexStart = performance.now();
    buildAndQueryIndex({ channel: "telegram" }); // build once
    const indexBuildMs = performance.now() - indexStart;

    // Now query from existing index (the real benefit)
    const queueDir = path.join(tmpDir, "delivery-queue");
    const queryStart = performance.now();
    const index = JSON.parse(fs.readFileSync(path.join(queueDir, "index.json"), "utf-8"));
    const queryResults = Object.values(index.entries).filter((e) => e.channel === "telegram");
    const queryMs = performance.now() - queryStart;

    expect(scanResults.length).toBe(334); // 1000/3 ≈ 333-334
    expect(queryResults.length).toBe(scanResults.length);

    console.log(
      `[1000 deliveries] Full scan: ${scanMs.toFixed(1)}ms | Index build: ${indexBuildMs.toFixed(1)}ms | Index query: ${queryMs.toFixed(1)}ms`,
    );
  });
});
