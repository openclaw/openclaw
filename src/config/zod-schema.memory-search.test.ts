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
