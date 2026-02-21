import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/experimental/project-radar.mjs";

describe("project-radar args", () => {
  it("parses root + json", () => {
    const args = parseArgs(["--root", "~/Documents/Code", "--json"]);
    expect(args.root).toBe("~/Documents/Code");
    expect(args.json).toBe(true);
  });
});
