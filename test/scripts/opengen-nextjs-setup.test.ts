import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("opengen nextjs setup", () => {
  it("registers the app workspace and dev script", () => {
    const ws = fs.readFileSync("pnpm-workspace.yaml", "utf8");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

    expect(ws).toContain("apps/opengen-console");
    expect(pkg.scripts["opengen:dev"]).toBeDefined();
  });
});
