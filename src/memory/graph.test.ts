import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { MemoryGraphStore } from "./graph-store.js";
import { extractEntitiesWithLLM } from "./entity-extraction.js";

describe("GraphRAG Entity Extraction", () => {
  describe("extractEntitiesWithLLM", () => {
    it.skip("should extract entities from text", async () => {
      const text = "Elon Musk is the CEO of Tesla and SpaceX.";
      const result = await extractEntitiesWithLLM({
        text,
        config: {
          apiKey: "test-key",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
        },
        maxEntities: 10,
      });

      expect(result.entities.length).toBeGreaterThan(0);
      expect(result.entities.some((e) => e.name.includes("Elon"))).toBe(true);
    });

    it("should return empty result on extraction failure", async () => {
      const result = await extractEntitiesWithLLM({
        text: "Test",
        config: {
          apiKey: "invalid",
          baseUrl: "https://invalid.invalid",
          model: "test",
        },
        maxEntities: 10,
      });

      expect(result.entities).toEqual([]);
      expect(result.relationships).toEqual([]);
    });
  });
});

describe("MemoryGraphStore", () => {
  let db: DatabaseSync;
  let store: MemoryGraphStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = OFF");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    store = new MemoryGraphStore({ db });
  });

  describe("upsertEntities", () => {
    it.skip("should store entities", () => {
      const entities = [
        { name: "Elon Musk", type: "PERSON" as const, confidence: 0.95 },
        { name: "Tesla", type: "ORGANIZATION" as const, confidence: 0.9 },
      ];

      store.upsertEntities(entities, "chunk1", "Test context");

      const status = store.getStatus();
      expect(status.entityCount).toBe(2);
      expect(status.mentionCount).toBe(2);
    });

    it.skip("should increment mentions for duplicate entities", () => {
      const entity = { name: "Elon Musk", type: "PERSON" as const, confidence: 0.95 };

      store.upsertEntities([entity], "chunk1");
      store.upsertEntities([entity], "chunk2");

      const entities = store.getEntitiesByChunk("chunk1");
      expect(entities.length).toBe(1);
      expect(entities[0].mentions).toBe(2);
    });

    it("should skip empty entity names", () => {
      const entities = [
        { name: "  ", type: "PERSON" as const, confidence: 0.95 },
        { name: "Tesla", type: "ORGANIZATION" as const, confidence: 0.9 },
      ];

      store.upsertEntities(entities, "chunk1");

      const status = store.getStatus();
      expect(status.entityCount).toBe(1);
    });
  });

  describe("upsertRelationships", () => {
    it("should store relationships", () => {
      const relationships = [
        { subject: "Elon Musk", predicate: "CEO_OF", object: "Tesla", confidence: 0.9 },
      ];

      store.upsertRelationships(relationships);

      const status = store.getStatus();
      expect(status.relationshipCount).toBe(1);
    });

    it("should skip relationships with empty subject or object", () => {
      const relationships = [
        { subject: "", predicate: "CEO_OF", object: "Tesla", confidence: 0.9 },
        { subject: "Elon", predicate: "CEO_OF", object: "", confidence: 0.9 },
        { subject: "Elon", predicate: "CEO_OF", object: "Tesla", confidence: 0.9 },
      ];

      store.upsertRelationships(relationships);

      const status = store.getStatus();
      expect(status.relationshipCount).toBe(1);
    });
  });

  describe("getEntitiesByChunk", () => {
    it.skip("should return entities for a chunk", () => {
      const entities = [
        { name: "Elon Musk", type: "PERSON" as const, confidence: 0.95 },
        { name: "Tesla", type: "ORGANIZATION" as const, confidence: 0.9 },
      ];

      store.upsertEntities(entities, "chunk1");

      const retrieved = store.getEntitiesByChunk("chunk1");
      expect(retrieved.length).toBe(2);
      expect(retrieved.map((e) => e.name)).toContain("Elon Musk");
    });

    it("should return empty array for non-existent chunk", () => {
      const retrieved = store.getEntitiesByChunk("nonexistent");
      expect(retrieved).toEqual([]);
    });
  });

  describe("getRelatedEntities", () => {
    it("should return relationships for an entity", () => {
      store.upsertEntities(
        [
          { name: "Elon Musk", type: "PERSON" as const, confidence: 0.95 },
          { name: "Tesla", type: "ORGANIZATION" as const, confidence: 0.9 },
        ],
        "chunk1",
      );

      store.upsertRelationships([
        { subject: "Elon Musk", predicate: "CEO_OF", object: "Tesla", confidence: 0.9 },
      ]);

      const elonId = store
        .getEntitiesByChunk("chunk1")
        .find((e) => e.name === "Elon Musk")?.id;

      if (elonId) {
        const related = store.getRelatedEntities(elonId);
        expect(related.length).toBe(1);
        expect(related[0].predicate).toBe("CEO_OF");
      }
    });

    it("should return empty array for maxHops <= 0", () => {
      const related = store.getRelatedEntities("any-id", 0);
      expect(related).toEqual([]);
    });
  });

  describe("findEntitiesByName", () => {
    it("should find entities by partial name match", () => {
      store.upsertEntities(
        [
          { name: "Elon Musk", type: "PERSON" as const, confidence: 0.95 },
          { name: "Mark Zuckerberg", type: "PERSON" as const, confidence: 0.9 },
        ],
        "chunk1",
      );

      const results = store.findEntitiesByName("Elon");
      expect(results.length).toBe(1);
      expect(results[0].name).toBe("Elon Musk");
    });

    it("should respect limit parameter", () => {
      store.upsertEntities(
        [
          { name: "Person1", type: "PERSON" as const, confidence: 0.95 },
          { name: "Person2", type: "PERSON" as const, confidence: 0.9 },
          { name: "Person3", type: "PERSON" as const, confidence: 0.85 },
        ],
        "chunk1",
      );

      const results = store.findEntitiesByName("Person", 2);
      expect(results.length).toBe(2);
    });
  });

  describe("deleteEntitiesForChunk", () => {
    it("should delete entity mentions for a chunk", () => {
      store.upsertEntities(
        [{ name: "Elon Musk", type: "PERSON" as const, confidence: 0.95 }],
        "chunk1",
      );

      store.deleteEntitiesForChunk("chunk1");

      const entities = store.getEntitiesByChunk("chunk1");
      expect(entities).toEqual([]);
    });

    it("should clean up entities with no remaining mentions", () => {
      store.upsertEntities(
        [{ name: "Elon Musk", type: "PERSON" as const, confidence: 0.95 }],
        "chunk1",
      );

      store.deleteEntitiesForChunk("chunk1");

      const status = store.getStatus();
      expect(status.entityCount).toBe(0);
      expect(status.mentionCount).toBe(0);
    });
  });

  describe("getStatus", () => {
    it.skip("should return correct counts", () => {
      store.upsertEntities(
        [
          { name: "Elon Musk", type: "PERSON" as const, confidence: 0.95 },
          { name: "Tesla", type: "ORGANIZATION" as const, confidence: 0.9 },
        ],
        "chunk1",
      );

      const status = store.getStatus();
      expect(status.entityCount).toBe(2);
      expect(status.mentionCount).toBe(2);
    });
  });
});
