import { describe, expect, it } from "vitest";
import {
  buildOptionalSecretInputSchema,
  buildSecretInputArraySchema,
  normalizeSecretInputString,
} from "./secret-input.js";

describe("plugin-sdk secret input helpers", () => {
  it.each([
    {
      name: "accepts undefined for optional secret input",
      run: () => buildOptionalSecretInputSchema().safeParse(undefined).success,
      expected: true,
    },
    {
      name: "accepts arrays of secret inputs",
      run: () =>
        buildSecretInputArraySchema().safeParse([
          "sk-plain",
          { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        ]).success,
      expected: true,
    },
    {
      name: "normalizes plaintext secret strings",
      run: () => normalizeSecretInputString("  sk-test  "),
      expected: "sk-test",
    },
  ])("$name", ({ run, expected }) => {
    expect(run()).toEqual(expected);
  });
});
