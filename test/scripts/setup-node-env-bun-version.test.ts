import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("setup-node-env action bun version", () => {
  it("uses a bun release tag that GitHub serves", () => {
    const actionPath = resolve(process.cwd(), ".github/actions/setup-node-env/action.yml");
    const action = readFileSync(actionPath, "utf8");
    const match = action.match(/bun-version:\s*"([^"]+)"/);

    expect(match?.[1]).toBeDefined();
    expect(match?.[1]).not.toContain("+");
  });
});
