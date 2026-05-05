import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_LINES,
  findOversizedAgentsFiles,
  isExempt,
  KNOWN_EXEMPTIONS,
} from "../../scripts/check-agents-md.ts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function writeAgentsFile(root: string, relPath: string, lineCount: number): string {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  // `lineCount` physical lines = that many `\n`-separated chunks.
  const content = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n");
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

describe("check-agents-md", () => {
  it("flags AGENTS.md files over the cap", async () => {
    const root = createTempDir("openclaw-agents-md-");
    writeAgentsFile(root, "src/foo/AGENTS.md", 200);

    const offenders = await findOversizedAgentsFiles(["src/foo/AGENTS.md"], 150, [], (p) =>
      Promise.resolve(fs.readFileSync(path.join(root, p), "utf8")),
    );

    expect(offenders).toEqual([{ filePath: "src/foo/AGENTS.md", lines: 200 }]);
  });

  it("passes files at or below the cap", async () => {
    const root = createTempDir("openclaw-agents-md-");
    writeAgentsFile(root, "src/small/AGENTS.md", 100);
    writeAgentsFile(root, "src/exact/AGENTS.md", 150);

    const offenders = await findOversizedAgentsFiles(
      ["src/small/AGENTS.md", "src/exact/AGENTS.md"],
      150,
      [],
      (p) => Promise.resolve(fs.readFileSync(path.join(root, p), "utf8")),
    );

    expect(offenders).toEqual([]);
  });

  it("skips files on the exemption allowlist", async () => {
    const root = createTempDir("openclaw-agents-md-");
    writeAgentsFile(root, "AGENTS.md", 400);

    const offenders = await findOversizedAgentsFiles(
      ["AGENTS.md"],
      150,
      [{ path: "AGENTS.md" }],
      (p) => Promise.resolve(fs.readFileSync(path.join(root, p), "utf8")),
    );

    expect(offenders).toEqual([]);
  });

  it("sorts offenders by size descending", async () => {
    const root = createTempDir("openclaw-agents-md-");
    writeAgentsFile(root, "src/a/AGENTS.md", 160);
    writeAgentsFile(root, "src/b/AGENTS.md", 300);
    writeAgentsFile(root, "src/c/AGENTS.md", 200);

    const offenders = await findOversizedAgentsFiles(
      ["src/a/AGENTS.md", "src/b/AGENTS.md", "src/c/AGENTS.md"],
      150,
      [],
      (p) => Promise.resolve(fs.readFileSync(path.join(root, p), "utf8")),
    );

    expect(offenders.map((o) => o.filePath)).toEqual([
      "src/b/AGENTS.md",
      "src/c/AGENTS.md",
      "src/a/AGENTS.md",
    ]);
  });

  it("normalizes Windows-style path separators when matching exemptions", () => {
    expect(isExempt("AGENTS.md", [{ path: "AGENTS.md" }])).toBe(true);
    expect(
      isExempt("docs\\reference\\templates\\AGENTS.md", [
        { path: "docs/reference/templates/AGENTS.md" },
      ]),
    ).toBe(true);
    expect(isExempt("extensions/AGENTS.md", [{ path: "AGENTS.md" }])).toBe(false);
  });

  it("exposes a default line cap of 150", () => {
    expect(DEFAULT_MAX_LINES).toBe(150);
  });

  it("documents every exemption with a reason", () => {
    for (const entry of KNOWN_EXEMPTIONS) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});
