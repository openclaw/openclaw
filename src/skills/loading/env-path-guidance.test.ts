import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

describe("plugin skill env-path guidance", () => {
  it("keeps the canvas skill aligned with OPENCLAW env overrides", () => {
    const content = fs.readFileSync(
      path.join(REPO_ROOT, "extensions/canvas/skills/canvas/SKILL.md"),
      "utf8",
    );

    expect(content).toContain("OPENCLAW_CONFIG_PATH");
    expect(content).not.toContain("cat ~/.openclaw/openclaw.json");
  });
});
