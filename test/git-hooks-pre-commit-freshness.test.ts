import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { pnpmLockfileDocuments } from "../scripts/lib/pnpm-lockfile-documents.mjs";
import {
  commitArgs,
  createContentGuardFixture,
  literals,
  run,
  runFailure,
  stageContent as stage,
} from "./git-hooks-pre-commit.test-support.js";
import { cleanupTempDirs } from "./helpers/temp-dir.js";
import { installLineCapToolingFixture } from "./scripts/tooling-dependencies.test-support.mts";

const tempDirs: string[] = [];
const { environment } = pnpmLockfileDocuments(fs.readFileSync("pnpm-lock.yaml", "utf8"));
afterEach(() => cleanupTempDirs(tempDirs));
let dir: string;
const write = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);
const writeScripts = (scripts: Record<string, string>) =>
  write("package.json", JSON.stringify({ packageManager: packageJson.packageManager, scripts }));

// Real guard, real freshness selector and a real `node` check runner; only the
// checker is a fixture that echoes working-tree bytes like markdownlint's MD051 context.
beforeEach(() => {
  dir = createContentGuardFixture(tempDirs);
  // pnpm resolves its own pin even for `run`; reuse its locked metadata without registry access.
  write("pnpm-workspace.yaml", "offline: true\nfrozenLockfile: true\n");
  write("pnpm-lock.yaml", `---\n${environment}\n---\nlockfileVersion: '9.0'\nimporters: {}\n`);
  const script = path.join(dir, "scripts/pre-commit/check-staged-freshness.mts");
  fs.rmSync(script);
  fs.symlinkSync(path.join(process.cwd(), "scripts/pre-commit/check-staged-freshness.mts"), script);
  writeScripts({
    "lint:docs": "node lint-docs.cjs",
    "protocol:check": "node protocol-check.cjs",
    "check:line-cap-ratchet": "node line-cap.cjs",
  });
  write(
    "lint-docs.cjs",
    `const fs = require("node:fs");
for (const file of ["docs/page.md", "notes.txt"].filter(fs.existsSync)) {
  console.error(\`\${file}: \${fs.readFileSync(file, "utf8")}\`);
}
process.exit(1);
`,
  );
  // The protocol stand-in fails on any working-tree bytes it would import.
  write("protocol-check.cjs", 'console.error("protocol models drift"); process.exit(1);\n');
  write("line-cap.cjs", 'console.log("line-cap ran");\n');
  stage(dir, "docs/page.md", "# Page\n");
  stage(dir, "packages/gateway-protocol/src/schema/logs-chat.ts", "export const a = 1;\n");
  stage(dir, "src/gateway/methods/core-method-policy.ts", "export const b = 1;\n");
  run(dir, "git", ["add", "package.json", "lint-docs.cjs", "protocol-check.cjs", "line-cap.cjs"]);
  run(dir, "git", ["commit", "-qm", "fixture", "--no-verify"]);
});

describe("pre-commit freshness checks", () => {
  it("runs the real code-only ratchet and rejects staged growth despite an under-cap worktree", () => {
    fs.rmSync(path.join(dir, "node_modules"), { recursive: true });
    const { env } = installLineCapToolingFixture(dir);
    stage(dir, "package.json", fs.readFileSync(path.join(dir, "package.json")));
    stage(
      dir,
      ".oxlintrc.json",
      '{"overrides":[{"files":["src/**/*.ts"],"rules":{"max-lines":["error",{"max":3,"skipBlankLines":true,"skipComments":true}]}}]}',
    );
    const underCap = "export const a = 1;\nexport const b = 2;\n";
    stage(dir, "src/line-cap.ts", underCap);
    run(dir, "/bin/bash", ["git-hooks/pre-commit"], env);
    expect(fs.existsSync(path.join(dir, "node_modules"))).toBe(false);

    stage(dir, "src/line-cap.ts", underCap + "export const c = 3;\nexport const d = 4;\n");
    write("src/line-cap.ts", underCap);
    const result = runFailure(dir, "/bin/bash", ["git-hooks/pre-commit"], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/line-cap.ts: 3 -> 4 counted lines (cap 3)");
    expect(result.stderr).toContain("line-cap growth ratchet failed");
    expect(fs.readFileSync(path.join(dir, "src/line-cap.ts"), "utf8")).toBe(underCap);
    expect(fs.existsSync(path.join(dir, "node_modules"))).toBe(false);
  });

  it("runs compound package scripts through the pinned pnpm CLI", () => {
    writeScripts({ "lint:docs": "node lint-docs.cjs && node lint-docs.cjs" });
    write("lint-docs.cjs", "process.exit(0);\n");
    run(dir, "git", ["add", "package.json", "lint-docs.cjs"]);
    stage(dir, "docs/page.md", "# Updated page\n");

    run(dir, "git", commitArgs);

    expect(run(dir, "git", ["show", "HEAD:docs/page.md"])).toBe("# Updated page");
  });

  it.each([0, 1])("runs package-script checks and preserves exit code %i", (exitCode) => {
    // Quoted executables take the package-manager path, not the direct-node fast path.
    writeScripts({ "lint:docs": 'node "lint-docs.cjs"' });
    run(dir, "git", ["add", "package.json"]);
    stage(
      dir,
      "lint-docs.cjs",
      `require("node:fs").writeFileSync("checker-args.json", JSON.stringify(process.argv.slice(2)));
console.error("package-script checker ran");
process.exit(${exitCode});`,
    );
    stage(dir, "docs/page with spaces.md", "# Updated page\n");

    if (exitCode === 0) {
      run(dir, "bash", ["git-hooks/pre-commit"]);
    } else {
      const result = runFailure(dir, "bash", ["git-hooks/pre-commit"]);
      expect(result.status).toBe(exitCode);
      expect(result.stderr).toContain("package-script checker ran");
      expect(result.stderr).toContain("docs markdown lint failed (pnpm lint:docs)");
    }
    expect(JSON.parse(fs.readFileSync(path.join(dir, "checker-args.json"), "utf8"))).toEqual([
      "--no-globs",
      "docs/page with spaces.md",
    ]);
  });
  it("skips a check whose staged input also has unstaged edits", () => {
    stage(dir, "docs/page.md", "# Page\n\nClean line.\n");
    fs.appendFileSync(path.join(dir, "docs/page.md"), `[link](#${literals[0]})\n`);

    const output = run(dir, "bash", ["git-hooks/pre-commit"]);

    expect(output).toContain("docs markdown lint skipped: its inputs have unstaged changes.");
    expect(output).not.toContain(literals[0]);
    run(dir, "git", commitArgs);
    expect(run(dir, "git", ["show", "HEAD:docs/page.md"])).toBe("# Page\n\nClean line.");
  });

  it("skips working-tree checks for unstaged edits outside their trigger paths", () => {
    const schema = "packages/gateway-protocol/src/schema/logs-chat.ts";
    stage(dir, schema, "export const a = 2;\n");
    expect(runFailure(dir, "bash", ["git-hooks/pre-commit"]).stderr).toContain(
      "protocol generated models failed",
    );

    // protocol-gen imports this owner, but it is not a protocol trigger path.
    fs.appendFileSync(
      path.join(dir, "src/gateway/methods/core-method-policy.ts"),
      "export const = ;\n",
    );
    const output = run(dir, "bash", ["git-hooks/pre-commit"]);

    expect(output).toContain(
      "protocol generated models skipped: its inputs have unstaged changes.",
    );
    // The line-cap ratchet reads the index, so it still runs.
    expect(output).not.toContain("line-cap growth ratchet skipped");
  });

  it("redacts private literals that a failing check prints from the working tree", () => {
    write("notes.txt", `local ${literals[0]} note\n`);
    stage(dir, "docs/page.md", "# Page\n\nClean line.\n");

    const result = runFailure(dir, "git", commitArgs);
    const output = result.stdout + result.stderr;

    expect(result.status).toBe(1);
    expect(output).toContain("notes.txt: local [REDACTED] note");
    expect(output).toContain("docs markdown lint failed (pnpm lint:docs)");
    expect(output).not.toContain(literals[0]);
  });
});
