import { describe, expect, it } from "vitest";
import { SignalAccountSchemaBase } from "./zod-schema.providers-core.js";

describe("Signal ingest schema", () => {
  it("accepts ingest in signal groups", () => {
    const parsed = SignalAccountSchemaBase.parse({
      groupPolicy: "allowlist",
      groups: {
        "*": {
          ingest: true,
          requireMention: true,
        },
      },
    });
    expect(parsed.groups?.["*"]?.ingest).toBe(true);
  });
});
