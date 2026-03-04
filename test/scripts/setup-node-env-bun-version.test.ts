import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("setup-node-env bun pin", () => {
  it("uses a stable bun-version without build metadata", () => {
    const actionPath = path.resolve(process.cwd(), ".github/actions/setup-node-env/action.yml");
    const content = fs.readFileSync(actionPath, "utf8");
    const match = content.match(/bun-version:\s*"([^"]+)"/);
    expect(match, "bun-version pin missing in setup-node-env action").not.toBeNull();
    const bunVersion = match?.[1] ?? "";
    expect(bunVersion).not.toContain("+");
    expect(bunVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
