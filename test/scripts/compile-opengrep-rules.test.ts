import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const compiler = path.resolve("security/opengrep/compile-rules.mjs");
const rule = (id: string, pattern = "old($VALUE)") => ({
  id,
  languages: ["javascript"],
  message: "fixture",
  severity: "ERROR",
  pattern,
  metadata: { "advisory-id": "TEST-REPORT", "advisory-url": "https://example.com/report" },
});

const prefix =
  '# retained header\nrules:\n  - id: untouched.before\n    pattern: "before(...)" # retained comment\n';
const suffix =
  "  # retained separator\n  - id: untouched.after\n    pattern: |\n      after(...)\n";
const original = `${prefix}  - id: test-report.target\n    pattern: old(...)\n${suffix}`;

let files: ReturnType<typeof fixtureFiles>;
beforeEach(() => {
  files = fixtureFiles(tempDirs.make("opengrep-compiler-test-"));
  writeOutput(original);
  source([rule("target", "new($VALUE)")]);
  const validator = files.write(
    "bin/opengrep",
    `#!${process.execPath}\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nconst input = fs.readFileSync(args[args.indexOf("--config") + 1], "utf8");\nconst invalid = input.includes("invalid-fixture-pattern");\nconsole.log(JSON.stringify({errors: invalid ? [{rule_id: "test-report.target", type: "PatternParseError"}] : []}));\nprocess.exitCode = invalid ? 2 : 0;\n`,
  );
  chmodSync(validator, 0o700);
});

function source(rules: ReturnType<typeof rule>[], file = "source.yml") {
  files.write(`rules/${file}`, stringify({ rules }));
}
const writeSource = (text: string) => files.write("rules/source.yml", text);
const writeOutput = (text: string) => files.write("out/precise.yml", text);
function compile(...args: string[]) {
  return spawnSync(
    process.execPath,
    [compiler, "--rules-dir", files.file("rules"), "--out-dir", files.file("out"), ...args],
    {
      encoding: "utf8",
      env: { PATH: `${files.file("bin")}${path.delimiter}${path.dirname(process.execPath)}` },
    },
  );
}
const output = () => files.read("out/precise.yml");

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
  ["unknown", () => source([rule("unknown")])],
  ["duplicate-source", () => source([rule("target")], "second.yml")],
  [
    "duplicate-existing",
    () => writeOutput(`${original}  - id: test-report.target\n    pattern: duplicate(...)\n`),
  ],
  ["bad-yaml", () => writeSource("rules: [")],
  [
    "missing-metadata",
    () => writeSource(stringify({ rules: [{ ...rule("target"), metadata: {} }] })),
  ],
  ["invalid-pattern", () => source([rule("target", "invalid-fixture-pattern")])],
  ["empty", () => writeSource("rules: []\n")],
  ["conflicting-flags", () => {}],
] as const)("rejects %s without publishing any changes", (scenario, prepare) => {
  prepare();
  const args = scenario === "conflicting-flags" ? ["--replace-precise"] : [];
  const before = output();
  expect(compile("--update-existing", ...args).status).toBe(1);
  expect(output()).toBe(before);
});

it("keeps append as the default and does not replace an existing rule", () => {
  source([rule("target", "replacement(...)"), rule("new")]);
  const result = compile();
  expect(result.status, result.stderr).toBe(0);
  const rules = parse(output()).rules;
  expect(rules).toHaveLength(4);
  expect(rules.find((entry: { id: string }) => entry.id === "test-report.target").pattern).toBe(
    "old(...)",
  );
  expect(rules.at(-1).id).toBe("test-report.new");
});
