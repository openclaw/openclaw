import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LanceDBMemoryStore } from "./lancedb-store.js";

async function runTest() {
  console.log("Starting LanceDB Store Test...");

  // Setup temp dir
  const tmpDir = path.join(os.tmpdir(), "lancedb-test-" + Date.now());
  await fs.mkdir(tmpDir, { recursive: true });
  console.log("Using temp dir:", tmpDir);

  const store = new LanceDBMemoryStore({
    dbPath: tmpDir,
  });

  try {
    // 1. Init
    console.log("Initializing...");
    await store.init();

    // 2. Insert Metadata
    console.log("Testing Metadata...");
    await store.setMeta("test_key", { foo: "bar" });
    const meta = await store.getMeta("test_key");
    console.log("Meta retrieved:", meta);
    if (meta.foo !== "bar") throw new Error("Metadata mismatch");

    // 3. Insert File
    console.log("Testing File Tracking...");
    await store.setFile("file1.md", "memory", "hash123", Date.now(), 100);
    const hash = await store.getFileHash("file1.md", "memory");
    console.log("File hash:", hash);
    if (hash !== "hash123") throw new Error("File hash mismatch");

    // 4. Insert Chunks
    console.log("Testing Chunk Insertion...");
    const chunk = {
      id: "chunk1",
      path: "file1.md",
      source: "memory",
      startLine: 1,
      endLine: 5,
      hash: "chunkhash1",
      model: "test-model",
      text: "This is a test chunk for vector search.",
      embedding: [0.1, 0.2, 0.3], // 3 dimensions
      updatedAt: Date.now(),
    };
    await store.insertChunks([chunk]);

    // 5. Search
    console.log("Testing Vector Search...");
    const results = await store.search({
      queryVec: [0.1, 0.2, 0.3],
      limit: 1,
      sources: ["memory"],
      providerModel: "test-model",
      snippetMaxChars: 100,
    });
    console.log("Search Results:", results);

    if (results.length === 0) throw new Error("No results found");
    if (results[0].id !== "chunk1") throw new Error("Wrong chunk returned");

    // 6. Embedding Cache
    console.log("Testing Embedding Cache...");
    const cacheKey = { provider: "openai", model: "ada", hash: "text_hash" };
    await store.setCachedEmbedding(cacheKey, [0.9, 0.9]);
    const cached = await store.getCachedEmbedding(cacheKey);
    console.log("Cached embedding:", cached);

    if (!cached) throw new Error("Cache miss");
    const diff = Math.abs(cached[0] - 0.9);
    if (diff > 0.0001) throw new Error(`Cache mismatch: expected 0.9, got ${cached[0]}`);

    console.log("All tests passed successfully!");
  } catch (err) {
    console.error("Test failed:", err);
  } finally {
    await store.close();
    // Cleanup
    // await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

runTest();
