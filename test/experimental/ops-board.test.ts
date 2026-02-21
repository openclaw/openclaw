import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/experimental/ops-board.mjs";

describe("ops-board args", () => {
  it("parses --json", () => {
    const args = parseArgs(["--json"]);
    expect(args.json).toBe(true);
  });
});
