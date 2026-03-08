import { describe, expect, it } from "vitest";
import { mapAllowlistResolutionInputs } from "./allowlist-resolution.js";

describe("mapAllowlistResolutionInputs", () => {
  it("maps inputs sequentially and preserves order", async () => {
    const visited: string[] = [];
    const result = await mapAllowlistResolutionInputs({
      inputs: ["one", "two", "three"],
      mapInput: async (input) => {
        visited.push(input);
        return input.toUpperCase();
      },
    });

    expect(visited).toEqual(["one", "two", "three"]);
    expect(result).toEqual(["ONE", "TWO", "THREE"]);
  });
});
