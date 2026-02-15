// @ts-nocheck - Test script with simplified types for comparison testing
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { LanceDBMemoryStore } from "./lancedb-store.js";
import { SQLiteMemoryStore } from "./sqlite-store.js";
import { StoredChunk, SearchParams } from "./types.js";

async function run() {
  console.log("Starting Comparison Test: SQLite vs LanceDB");

  // Setup temporary paths
  const tmpDir = "/tmp/openclaw_compare_" + Date.now();
  await fs.mkdir(tmpDir, { recursive: true });
  const sqlitePath = path.join(tmpDir, "memory.db");
  const lancedbPath = path.join(tmpDir, "lancedb");

  console.log(`Temp Dir: ${tmpDir}`);

  // Initialize Stores
  console.log("Initializing stores...");
  const sqliteStore = new SQLiteMemoryStore({ dbPath: sqlitePath });
  const lanceStore = new LanceDBMemoryStore({ dbPath: lancedbPath });

  await sqliteStore.init();
  await lanceStore.init();

  // Mock Data
  // Dimensions: 3.
  // Axis 1: Fruit-ness, Axis 2: Tech-ness, Axis 3: Space-ness
  const chunks: StoredChunk[] = [
    {
      id: randomUUID(),
      text: "Apple is a sweet red fruit.",
      vector: [0.9, 0.1, 0.0],
      source: "fruits.txt",
      startIndex: 0,
      endIndex: 20,
      metadata: { category: "food" },
    },
    {
      id: randomUUID(),
      text: "Bananas are yellow and rich in potassium.",
      vector: [0.85, 0.2, 0.0],
      source: "fruits.txt",
      startIndex: 21,
      endIndex: 50,
      metadata: { category: "food" },
    },
    {
      id: randomUUID(),
      text: "Python is a popular programming language for data science.",
      vector: [0.1, 0.9, 0.0],
      source: "tech.txt",
      startIndex: 0,
      endIndex: 50,
      metadata: { category: "tech" },
    },
    {
      id: randomUUID(),
      text: "Rust offers memory safety without garbage collection.",
      vector: [0.1, 0.85, 0.1],
      source: "tech.txt",
      startIndex: 51,
      endIndex: 100,
      metadata: { category: "tech" },
    },
    {
      id: randomUUID(),
      text: "SpaceX launches rockets to Mars.",
      vector: [0.0, 0.2, 0.9],
      source: "space.txt",
      startIndex: 0,
      endIndex: 30,
      metadata: { category: "space" },
    },
  ];

  console.log(`Inserting ${chunks.length} chunks...`);
  await sqliteStore.insertChunks(chunks);
  await lanceStore.insertChunks(chunks);

  // Test Cases
  const testCases: { name: string; params: SearchParams }[] = [
    {
      name: "Semantic Search: Fruit (Query Vector approx [1,0,0])",
      params: {
        queryVec: [0.95, 0.05, 0.0],
        limit: 2,
        useVector: true,
      },
    },
    {
      name: "Semantic Search: Tech (Query Vector approx [0,1,0])",
      params: {
        queryVec: [0.05, 0.95, 0.0],
        limit: 2,
        useVector: true,
      },
    },
    {
      name: "Hybrid Search: 'Python' (Keyword + Vector)",
      params: {
        query: "Python",
        queryVec: [0.1, 0.9, 0.0],
        limit: 2,
        useVector: true,
        useFts: true, // Note: LanceDB impl might ignore this if not fully supported
      },
    },
    {
      name: "Metadata Filter (if supported by LanceDB basic impl)",
      params: {
        queryVec: [0.5, 0.5, 0.5], // Neutral vector
        limit: 5,
        filter: "category = 'food'", // Standard SQL-like filter
      },
    },
  ];

  for (const test of testCases) {
    console.log(`\n--- Test Case: ${test.name} ---`);

    try {
      console.log("SQLite Results:");
      const sqliteResults = await sqliteStore.search(test.params);
      sqliteResults.forEach((r, i) =>
        console.log(`  ${i + 1}. [${r.score.toFixed(4)}] ${r.text.substring(0, 50)}...`),
      );
    } catch (e: any) {
      console.log(`  SQLite Error: ${e.message}`);
    }

    try {
      console.log("LanceDB Results:");
      const lanceResults = await lanceStore.search(test.params);
      lanceResults.forEach((r, i) =>
        console.log(`  ${i + 1}. [${r.score.toFixed(4)}] ${r.text.substring(0, 50)}...`),
      );
    } catch (e: any) {
      console.log(`  LanceDB Error: ${e.message}`);
    }
  }

  // Clean up
  // await fs.rm(tmpDir, { recursive: true, force: true });
  console.log(`\nDone. Temp dir left at: ${tmpDir}`);
}

run();
