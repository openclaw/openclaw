// docs-list tests cover source docs metadata discovery for docs-aware tooling.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const repoRoot = path.resolve(import.meta.dirname, "../..");
const docsListScriptPath = path.join(repoRoot, "scripts", "docs-list.js");

function makeTempRepoRoot(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runDocsList(cwd: string): string {
  return execFileSync(process.execPath, [docsListScriptPath], {
    cwd,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("docs-list", () => {
  it("prints single-line read_when strings as read hints", () => {
    const tempRepoRoot = makeTempRepoRoot("openclaw-docs-list-");
    mkdirSync(path.join(tempRepoRoot, "docs"), { recursive: true });
    writeFileSync(
      path.join(tempRepoRoot, "docs", "page.md"),
      `---
summary: "Single-line read_when page"
read_when: "Read this page when the hint is inline."
---
`,
      "utf8",
    );

    const output = runDocsList(tempRepoRoot);

    expect(output).toContain("page.md - Single-line read_when page");
    expect(output).toContain("Read when: Read this page when the hint is inline.");
  });
});
