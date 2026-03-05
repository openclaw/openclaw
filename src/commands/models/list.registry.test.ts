import { describe, expect, it } from "vitest";
import { toModelRow } from "./list.registry.js";

describe("toModelRow", () => {
  it("falls back to text input when model.input is missing", () => {
    const row = toModelRow({
      model: {
        id: "custom/missing-input",
        name: "Missing Input",
        provider: "custom",
        baseUrl: "https://example.com/v1",
      } as unknown as Parameters<typeof toModelRow>[0]["model"],
      key: "custom/missing-input",
      tags: [],
    });

    expect(row.input).toBe("text");
  });
});
