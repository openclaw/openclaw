import { describe, expect, it } from "vitest";
import { MemorySearchSchema } from "./zod-schema.memory-search.js";

describe("memory search query instruction schema", () => {
  it.each(["search_query: ", "Instruct: Retrieve notes\nQuery: ", ""])(
    "preserves the literal instruction %j",
    (queryInstruction) => {
      expect(MemorySearchSchema.parse({ queryInstruction })).toEqual({ queryInstruction });
    },
  );
});

describe("memory search input format schema", () => {
  it.each([
    { query: "query: ", document: "passage: " },
    { query: "Instruct: Retrieve notes\nQuery: ", document: "" },
    { query: "", document: "" },
  ])("preserves literal prefixes %j", (inputFormat) => {
    expect(MemorySearchSchema.parse({ inputFormat })).toEqual({ inputFormat });
  });

  it.each([{}, { query: "query: " }, { document: "passage: " }])(
    "requires both prefixes in %j",
    (inputFormat) => {
      expect(MemorySearchSchema.safeParse({ inputFormat }).success).toBe(false);
    },
  );
});
