import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { formatCatalogInputError } from "./tool-search-recovery.js";

describe("tool search input recovery", () => {
  it("names every required key in the expected input when the shape overflows", () => {
    const parameters = Type.Object({
      attribution: Type.String(),
      items: Type.Array(
        Type.Object({
          text: Type.String(),
          ...Object.fromEntries(
            Array.from({ length: 12 }, (_, i) => [`detail_${i}`, Type.Optional(Type.String())]),
          ),
        }),
      ),
      requestId: Type.String(),
    });
    const entry = { id: "plugin:remember", tool: { name: "remember", parameters }, parameters };
    const error = {
      path: "",
      message: "must have required property 'items'",
      text: "<root>: must have required property 'items'",
    };

    expect(formatCatalogInputError(entry as never, [error], { attribution: "user" })).toMatch(
      /Expected input: \{ attribution: string; items: Array<\{ text: string; detail_0\?: string; .*; \.\.\. \}>; requestId: string; \.\.\. \}\.$/u,
    );
  });
});
