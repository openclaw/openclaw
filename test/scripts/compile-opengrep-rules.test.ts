import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

const compiler = path.resolve("security/opengrep/compile-rules.mjs");
const rule = (id: string, pattern = "old($VALUE)") => ({
  id,
  languages: ["javascript"],
  message: "fixture",
  severity: "ERROR",
  pattern,
  metadata: { "advisory-id": "TEST-REPORT", "advisory-url": "https://example.com/report" },
});

// Preserve this text byte-for-byte while replacing the middle rule, including YAML style/comments.
const prefix =
  '# retained header\nrules:\n  - id: untouched.before\n    pattern: "before(...)" # retained comment\n';
const suffix =
  "  # retained separator\n  - id: untouched.after\n    pattern: |\n      after(...)\n";
const original = `${prefix}  - id: test-report.target\n    pattern: old(...)\n${suffix}`;

describe("compile-opengrep-rules", () => {
  let directory: string;
  let rulesDir: string;
  let outDir: string;
  let binDir: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "opengrep-compiler-test-"));
    rulesDir = path.join(directory, "rules");
    outDir = path.join(directory, "out");
    binDir = path.join(directory, "bin");
    for (const dir of [rulesDir, outDir, binDir]) {
      mkdirSync(dir);
    }
    writeFileSync(path.join(outDir, "precise.yml"), original);
    writeFileSync(
      path.join(rulesDir, "source.yml"),
      stringify({ rules: [rule("target", "new($VALUE)")] }),
    );
    const validator = path.join(binDir, "opengrep");
    writeFileSync(
      validator,
      `#!${process.execPath}\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nconst input = fs.readFileSync(args[args.indexOf("--config") + 1], "utf8");\nconst invalid = input.includes("invalid-fixture-pattern");\nconsole.log(JSON.stringify({errors: invalid ? [{rule_id: "test-report.target", type: "PatternParseError"}] : []}));\nprocess.exitCode = invalid ? 2 : 0;\n`,
    );
    chmodSync(validator, 0o700);
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function compile(...args: string[]) {
    return spawnSync(
      process.execPath,
      [compiler, "--rules-dir", rulesDir, "--out-dir", outDir, ...args],
      {
        encoding: "utf8",
        env: { PATH: `${binDir}${path.delimiter}${path.dirname(process.execPath)}` },
      },
    );
  }
  function output() {
    return readFileSync(path.join(outDir, "precise.yml"), "utf8");
  }

  it("updates the selected rule while preserving all unrelated bytes", () => {
    const result = compile("--update-existing");
    expect(result.status, result.stderr).toBe(0);
    expect(output().startsWith(prefix)).toBe(true);
    expect(output().endsWith(suffix)).toBe(true);
    expect(parse(output()).rules).toHaveLength(3);
    expect(parse(output()).rules[1]).toMatchObject({
      id: "test-report.target",
      pattern: "new($VALUE)",
      metadata: { "source-rule-id": "target", "detector-bucket": "precise" },
    });
  });

  it.each([
    "unknown",
    "duplicate-source",
    "duplicate-existing",
    "bad-yaml",
    "missing-metadata",
    "invalid-pattern",
    "empty",
    "conflicting-flags",
  ])("rejects %s without publishing any changes", (scenario) => {
    let args = ["--update-existing"];
    if (scenario === "unknown") {
      writeFileSync(path.join(rulesDir, "source.yml"), stringify({ rules: [rule("unknown")] }));
    } else if (scenario === "duplicate-source") {
      writeFileSync(path.join(rulesDir, "second.yml"), stringify({ rules: [rule("target")] }));
    } else if (scenario === "duplicate-existing") {
      writeFileSync(
        path.join(outDir, "precise.yml"),
        `${original}  - id: test-report.target\n    pattern: duplicate(...)\n`,
      );
    } else if (scenario === "bad-yaml") {
      writeFileSync(path.join(rulesDir, "source.yml"), "rules: [");
    } else if (scenario === "missing-metadata") {
      writeFileSync(
        path.join(rulesDir, "source.yml"),
        stringify({ rules: [{ ...rule("target"), metadata: {} }] }),
      );
    } else if (scenario === "invalid-pattern") {
      writeFileSync(
        path.join(rulesDir, "source.yml"),
        stringify({ rules: [rule("target", "invalid-fixture-pattern")] }),
      );
    } else if (scenario === "empty") {
      writeFileSync(path.join(rulesDir, "source.yml"), "rules: []\n");
    } else {
      args = ["--update-existing", "--replace-precise"];
    }
    const before = output();
    expect(compile(...args).status).toBe(1);
    expect(output()).toBe(before);
  });

  it("keeps append as the default and does not replace an existing rule", () => {
    writeFileSync(
      path.join(rulesDir, "source.yml"),
      stringify({ rules: [rule("target", "replacement(...)"), rule("new")] }),
    );
    const result = compile();
    expect(result.status, result.stderr).toBe(0);
    const rules = parse(output()).rules;
    expect(rules).toHaveLength(4);
    expect(rules.find((entry: { id: string }) => entry.id === "test-report.target").pattern).toBe(
      "old(...)",
    );
    expect(rules.at(-1).id).toBe("test-report.new");
  });
});
