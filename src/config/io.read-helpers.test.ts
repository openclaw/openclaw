import { describe, expect, it } from "vitest";
import { collectEnvRefPaths } from "./io.read-helpers.js";

describe("collectEnvRefPaths", () => {
  it("collects deeply nested references without consuming the call stack", () => {
    let value: unknown = "${DEEP_ENV}";
    for (let depth = 0; depth < 4000; depth += 1) {
      value = { x: value };
    }

    const output = new Map<string, string>();
    collectEnvRefPaths(value, "", output);

    expect(output).toEqual(new Map([[`${"x.".repeat(3999)}x`, "${DEEP_ENV}"]]));
  });

  it("preserves depth-first traversal order for arrays and objects", () => {
    const output = new Map<string, string>();
    collectEnvRefPaths(
      {
        first: "${FIRST}",
        nested: [{ second: "${SECOND}" }, "${THIRD}"],
      },
      "",
      output,
    );

    expect([...output.entries()]).toEqual([
      ["first", "${FIRST}"],
      ["nested[0].second", "${SECOND}"],
      ["nested[1]", "${THIRD}"],
    ]);
  });
});
