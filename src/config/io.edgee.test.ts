import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("config io shell env expected keys", () => {
  it("includes EDGEE_API_KEY", () => {
    const sourcePath = path.resolve(import.meta.dirname, "io.ts");
    const source = fs.readFileSync(sourcePath, "utf8");
    expect(source).toContain('"EDGEE_API_KEY"');
  });
});
