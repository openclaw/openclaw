import { rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitArgs,
  createContentGuardFixture,
  literals,
  run,
  runFailure,
  stageContent as stage,
} from "./git-hooks-pre-commit.test-support.js";
import { cleanupTempDirs } from "./helpers/temp-dir.js";

const tempDirs: string[] = [];
afterEach(() => cleanupTempDirs(tempDirs));

// Real guard, real freshness selector and a real `node` check runner; only the
// checker is a fixture that echoes working-tree bytes like markdownlint's MD051 context.
function freshnessFixture() {
  const dir = createContentGuardFixture(tempDirs);
  const script = path.join(dir, "scripts/pre-commit/check-staged-freshness.mts");
  rmSync(script);
  symlinkSync(path.join(process.cwd(), "scripts/pre-commit/check-staged-freshness.mts"), script);
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ scripts: { "lint:docs": "node lint-docs.cjs" } }),
  );
  writeFileSync(
    path.join(dir, "lint-docs.cjs"),
    [
      'const fs = require("node:fs");',
      'for (const file of ["docs/page.md", "notes.txt"].filter(fs.existsSync)) {',
      '  console.error(`${file}: ${fs.readFileSync(file, "utf8")}`);',
      "}",
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  stage(dir, "docs/page.md", "# Page\n");
  run(dir, "git", ["add", "package.json", "lint-docs.cjs"]);
  run(dir, "git", ["commit", "-qm", "fixture", "--no-verify"]);
  return dir;
}

describe("pre-commit freshness checks", () => {
  it("skips a check whose staged input also has unstaged edits", () => {
    const dir = freshnessFixture();
    stage(dir, "docs/page.md", "# Page\n\nClean line.\n");
    appendFileSync(path.join(dir, "docs/page.md"), `[link](#${literals[0]})\n`);

    const output = run(dir, "bash", ["git-hooks/pre-commit"]);

    expect(output).toContain("docs markdown lint skipped: its inputs have unstaged changes.");
    expect(output).not.toContain(literals[0]);
    run(dir, "git", commitArgs);
    expect(run(dir, "git", ["show", "HEAD:docs/page.md"])).toBe("# Page\n\nClean line.");
  });

  it("redacts private literals that a failing check prints from the working tree", () => {
    const dir = freshnessFixture();
    writeFileSync(path.join(dir, "notes.txt"), `local ${literals[0]} note\n`);
    stage(dir, "docs/page.md", "# Page\n\nClean line.\n");

    const result = runFailure(dir, "git", commitArgs);
    const output = result.stdout + result.stderr;

    expect(result.status).toBe(1);
    expect(output).toContain("notes.txt: local [REDACTED] note");
    expect(output).toContain("docs markdown lint failed (pnpm lint:docs)");
    expect(output).not.toContain(literals[0]);
  });
});
