import { describe, expect, it } from "vitest";
import type { SearchSchema } from "./contract.js";
import { postgresSearchSql } from "./postgres-search-schema.js";

// Dimensions can come from stored schema metadata, not only from admitPostgresSearch.
const vectorSchema = (dimensions: unknown): SearchSchema => ({
  vector: {
    notes: {
      table: "vectors",
      alias: "v",
      rowShape: { id: "string" },
      postgres: { source: "notes", key: "id", embedding: "embedding", dimensions } as never,
    },
  },
});

describe("postgresSearchSql vector dimensions", () => {
  it("renders supported integer dimensions", () => {
    const sql = postgresSearchSql(vectorSchema(1536), "memory", {}, 1, 2);
    expect(sql).toContain('embedding "public".vector(1536) NOT NULL');
    expect(sql).toContain("embedding_bits bit(1536)");
  });

  it.each([
    ["SQL text", "3) NOT NULL); DROP TABLE notes; --"],
    ["a numeric string", "3"],
    ["a fraction", 3.5],
    ["zero", 0],
    ["more than 16000", 16_001],
    ["NaN", Number.NaN],
  ])("refuses %s before rendering DDL", (_label, dimensions) => {
    expect(() => postgresSearchSql(vectorSchema(dimensions), "memory")).toThrow(
      /dimensions must be 1/,
    );
  });
});
