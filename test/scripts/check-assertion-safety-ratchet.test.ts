import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  collectAssertionSafetyReport as assertionReport,
  collectCurrentAssertionSafetyCounts as currentCounts,
  countUnsafeAssertions as countAssertions,
  isGovernedAssertionSourcePath,
  main,
} from "../../scripts/check-assertion-safety-ratchet.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { parseRatchetCounts } from "../../scripts/lib/shrink-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const parser = createNativeTypeScriptParser();
const baselineFile = "config/assertion-safety-baseline.txt";
const firstAssertion = "export const first = value as string;\n";
const safety = "// SAFETY: fixture parser validated the value.\n";
const sha256 = (source: string | Buffer) => createHash("sha256").update(source).digest("hex");
afterAll(() => parser.close());

function count(source: string, fileName = "src/example.ts") {
  return countAssertions(source, fileName, parser.parseSourceFile(fileName, source), parser);
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nestedGitEnvKeys = `ALTERNATE_OBJECT_DIRECTORIES COMMON_DIR CONFIG CONFIG_COUNT
CONFIG_PARAMETERS DIR GRAFT_FILE IMPLICIT_WORK_TREE INDEX_FILE NAMESPACE NO_REPLACE_OBJECTS
OBJECT_DIRECTORY PREFIX QUARANTINE_PATH REPLACE_REF_BASE SHALLOW_FILE WORK_TREE`
  .split(/\s+/u)
  .map((key) => `GIT_${key}`);

function git(cwd: string, args: string[], input?: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of nestedGitEnvKeys) {
    delete env[key];
  }
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
    {
      cwd,
      env,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
}

function fileFixture(files: Record<string, string>, committed = false) {
  const root = tempDirs.make("openclaw-assertion-safety-");
  for (const [file, source] of Object.entries(files)) {
    fixtureFiles(root).write(file, source);
  }
  git(root, ["init"]);
  if (committed) {
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "fixture"]);
  }
  return root;
}

function sourceFiles(size: number, source: (index: number) => string, extensions = ["ts"]) {
  return Object.fromEntries(
    Array.from({ length: size }, (_, index) => [
      `src/source-${String(index).padStart(2, "0")}.${extensions[index % extensions.length]!}`,
      source(index),
    ]),
  );
}

function ratchetFixture(source = firstAssertion) {
  const root = fileFixture(
    {
      "src/example.ts": source,
      [baselineFile]: "src/example.ts\t1\n",
    },
    true,
  );
  const baselinePath = path.join(root, baselineFile);
  const sourcePath = path.join(root, "src/example.ts");
  vi.spyOn(console, "log").mockImplementation(() => {});
  return { root, baselinePath, sourcePath };
}

function readBaseline(root: string, baselinePath: string) {
  return parseRatchetCounts(
    fs.readFileSync(baselinePath, "utf8"),
    path.relative(root, baselinePath),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("check-assertion-safety-ratchet", () => {
  it("counts mixed source files and reports the first malformed source in path order", () => {
    const sources = sourceFiles(
      36,
      (index) =>
        index === 17 ? "export const value = 17;\n" : "export const value = input as Shape;\n",
      ["ts", "tsx", "mts", "cts"],
    );
    const entries = Object.entries(sources);
    const root = fileFixture(sources);
    expect(currentCounts(root)).toEqual(
      new Map(entries.filter((_, index) => index !== 17).map(([file]) => [file, 1])),
    );
    const malformed = [entries[5]!, entries[17]!, entries[35]!];
    for (const [file] of malformed) {
      fixtureFiles(root).write(file, "const broken = ;\n");
    }
    for (const [file, source] of malformed) {
      expect(() => currentCounts(root)).toThrow(`${file}:1: Expression expected.`);
      fixtureFiles(root).write(file, source);
    }
  });

  it("keeps worktree counts and staged read failures with unmerged index entries", () => {
    const sources = sourceFiles(36, () => "export const value = input as Shape;\n");
    const files = Object.keys(sources);
    const root = fileFixture(sources);
    git(root, ["add", "."]);
    const oid = git(
      root,
      ["hash-object", "-w", "--stdin"],
      "export const conflicted = value as unknown;\n",
    ).trim();
    const conflictedFiles = [files[1]!, files[32]!];
    git(
      root,
      ["update-index", "-z", "--index-info"],
      conflictedFiles
        .flatMap((file) => [
          `0 ${"0".repeat(oid.length)}\t${file}\0`,
          ...[1, 2, 3].map((stage) => `100644 ${oid} ${stage}\t${file}\0`),
        ])
        .join(""),
    );

    expect(currentCounts(root)).toEqual(new Map(files.map((file) => [file, 1])));
    expect(() => currentCounts(root, { staged: true })).toThrow(
      `Could not read staged source ${conflictedFiles[0]}`,
    );
  });

  it("counts only governed assertions without a SAFETY invariant", () => {
    const source = [
      "const label = `count ${total} items`;",
      "const half = total / 2;",
      "const frozen = value as const;",
      "const checked = value satisfies Shape;",
      "// SAFETY: the schema parser established Shape.",
      "const safe = value as Shape;",
      "const inlineSafe = value as Shape; // SAFETY: the schema parser established Shape.",
      "const afterInline = value as Shape;",
      "const present = value!;",
      'const note = "// SAFETY: string content is not a comment.";',
      "const unsafe = value as Shape;",
      "const angle = <Shape>value;",
      "const unknown = value as unknown;",
      "const angleUnknown = <unknown>value;",
    ].join("\n");

    expect(count(source)).toBe(3);
    expect(count("value as unknown as Shape;")).toBe(1);
    expect(count("declare const value: unknown as Shape;", "src/example.d.ts")).toBe(0);
    expect(
      [
        "src/example.ts",
        "extensions/example/src/index.tsx",
        "src/example.test.ts",
        "packages/example/test-utils/value.ts",
        "scripts/example.ts",
      ].map(isGovernedAssertionSourcePath),
    ).toEqual([true, true, false, false, false]);
  });

  it("blocks new debt, accepts SAFETY comments, and prunes reduced counts", () => {
    const { root, baselinePath, sourcePath } = ratchetFixture();

    fs.appendFileSync(sourcePath, "export const second = value as number;\n");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));

    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(main(root, ["--base", "HEAD", "--prune"])).toBe(1);
    expect(errors.join("\n")).toContain("src/example.ts: 2 > 1");
    expect(errors.join("\n")).toContain("// SAFETY:");

    const safeSecond = `${safety}export const second = value as number;\n`;
    fs.writeFileSync(sourcePath, `${firstAssertion}${safeSecond}`);
    expect(main(root, ["--base", "HEAD"])).toBe(0);

    fs.writeFileSync(sourcePath, `${safety}${firstAssertion}${safeSecond}`);
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(main(root, ["--base", "HEAD", "--prune"])).toBe(0);
    expect(readBaseline(root, baselinePath)).toEqual(new Map());
  });

  it("allows rebaselining assertion debt already present in the base tree", () => {
    const { root, baselinePath } = ratchetFixture(
      `${firstAssertion}export const mergedConcurrently = value as number;\n`,
    );

    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root, ["--base", "HEAD"])).toBe(0);
    expect(main(root, ["--base", "HEAD", "--prune"])).toBe(0);
    expect(readBaseline(root, baselinePath)).toEqual(new Map([["src/example.ts", 2]]));
  });

  it("reports frozen sites, policy exemptions, unused allowances, and ambiguous fingerprints", () => {
    const files = {
      "src/a.ts": [
        'const emoji = "🦊"; const first = value as Shape;',
        "const second = value as unknown;",
        "const literal = { value: 1 } as const;",
        "// SAFETY: fixture policy marker, not remediation.",
        "const documented = other as Shape;",
        "const angle = <Shape>value;",
      ].join("\n"),
      "src/b.ts": "export const other = value as Shape;",
      "src/zero.ts": "export const zero = 0;",
      "src/example.test.ts": "const test = value as Shape;",
      "src/example.d.ts": "declare const value: Shape;",
      "scripts/example.ts": "const support = value as Shape;",
      [baselineFile]: [
        "src/a.ts\t4",
        "src/b.ts\t1",
        "src/zero.ts\t2",
        "src/example.test.ts\t3",
        "src/example.d.ts\t4",
        "src/deleted.ts\t5",
        "scripts/example.ts\t6",
        "",
      ].join("\n"),
    };
    const root = fileFixture(files, true);
    const commit = git(root, ["rev-parse", "HEAD"]).trim();
    // A report ref selects source bytes, unlike the ratchet's comparison-only --base.
    fixtureFiles(root).write("src/a.ts", "const broken = ;");
    fs.rmSync(path.join(root, "src/b.ts"));
    const report = assertionReport(root, "HEAD");
    expect(report).toMatchObject({ complete: true, matching: "not-performed" });
    expect(report.source.commit).toBe(commit);
    expect(report.tooling.sha256["scripts/check-assertion-safety-ratchet.mts"]).toBe(
      sha256(
        fs.readFileSync(
          new URL("../../scripts/check-assertion-safety-ratchet.mts", import.meta.url),
        ),
      ),
    );
    expect([report.coverage, report.totals]).toEqual([
      { discovered: 7, parsed: 3, failed: 0, unvisited: 0, excluded: 3, missing: 1 },
      { allowances: 25, counted: 3, exempt: 3, unusedAllowance: 22 },
    ]);
    const first = report.files.find((file) => file.path === "src/a.ts");
    expect(first).toMatchObject({
      blob: git(root, ["rev-parse", "HEAD:src/a.ts"]).trim(),
      sites: [
        {
          kind: "as",
          line: 1,
          exemption: null,
          column: files["src/a.ts"].indexOf("as Shape") + 1,
          start: files["src/a.ts"].indexOf("value as Shape"),
        },
        { exemption: "unknown" },
        { exemption: "const" },
        { exemption: "safety-comment" },
        { exemption: null },
      ],
    });
    expect(report.ambiguousFingerprints).toEqual([
      {
        fingerprint: sha256("value as Shape"),
        occurrences: 2,
      },
    ]);
    expect(
      report.files.filter((file) => file.status === "excluded").map((file) => file.exclusion),
    ).toEqual(["outside-scope", "declaration", "test-support"]);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(root, ["--report", commit])).toBe(0);
    expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify(report, null, 2));
    expect(fs.readFileSync(path.join(root, baselineFile), "utf8")).toBe(files[baselineFile]);
  });

  it("reports parse failures across batches without treating unknown counts as zero", () => {
    const root = fileFixture(
      {
        ...sourceFiles(34, (index) =>
          index === 0 || index === 33 ? "const broken = ;" : "const value = 1;",
        ),
        [baselineFile]: "src/source-00.ts\t1\nsrc/source-33.ts\t1\n",
      },
      true,
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(root, ["--report", "HEAD"])).toBe(1);
    const report = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(report).toMatchObject({
      complete: false,
      coverage: { discovered: 34, parsed: 32, failed: 2, unvisited: 0, excluded: 0, missing: 0 },
      totals: { allowances: 2, counted: null, exempt: null, unusedAllowance: null },
      errors: [],
    });
    for (const index of [0, 33]) {
      expect(report.files[index]).toMatchObject({
        status: "parse-error",
        counted: null,
        unusedAllowance: null,
        sites: [],
        diagnostics: [{ line: 1, column: 16, message: "Expression expected." }],
      });
    }
  });

  it("does not claim coverage when source resolution fails", () => {
    const root = tempDirs.make("openclaw-assertion-report-missing-");
    git(root, ["init"]);
    const report = assertionReport(root, "missing-ref");
    expect(report).toMatchObject({
      complete: false,
      source: { commit: null },
      coverage: { discovered: null },
      files: [],
      totals: { allowances: null, counted: null, exempt: null, unusedAllowance: null },
    });
    expect(report.errors).toHaveLength(1);
  });
});
