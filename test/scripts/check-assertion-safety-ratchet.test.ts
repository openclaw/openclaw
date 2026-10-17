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

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function parseFixture(source: string, fileName: string) {
  return [source, fileName, parser.parseSourceFile(fileName, source), parser] as const;
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

function commitFixture(root: string) {
  for (const args of [["init"], ["add", "."], ["commit", "-m", "fixture"]]) {
    git(root, args);
  }
}

function fileFixture(files: Record<string, string>, committed = false) {
  const root = tempDirs.make("openclaw-assertion-safety-");
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  if (committed) {
    commitFixture(root);
  } else {
    git(root, ["init"]);
  }
  return root;
}

function ratchetFixture(source = "export const first = value as string;\n") {
  const root = fileFixture(
    {
      "src/example.ts": source,
      "config/assertion-safety-baseline.txt": "src/example.ts\t1\n",
    },
    true,
  );
  const baselinePath = path.join(root, "config/assertion-safety-baseline.txt");
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
    const extensions = ["ts", "tsx", "mts", "cts"];
    const sources = Array.from({ length: 36 }, (_, index) => ({
      file: `src/source-${String(index).padStart(2, "0")}.${extensions[index % extensions.length]!}`,
      source:
        index === 17 ? "export const value = 17;\n" : "export const value = input as Shape;\n",
    }));
    const root = fileFixture(Object.fromEntries(sources.map(({ file, source }) => [file, source])));

    expect(currentCounts(root)).toEqual(
      new Map(sources.filter((_, index) => index !== 17).map(({ file }) => [file, 1])),
    );

    const malformed = [sources[5]!, sources[17]!, sources[35]!];
    for (const { file } of malformed) {
      fs.writeFileSync(path.join(root, file), "const broken = ;\n");
    }
    for (const { file, source } of malformed) {
      expect(() => currentCounts(root)).toThrow(`${file}:1: Expression expected.`);
      fs.writeFileSync(path.join(root, file), source);
    }
  });

  it("keeps worktree counts and staged read failures with unmerged index entries", () => {
    const files = Array.from(
      { length: 36 },
      (_, index) => `src/source-${String(index).padStart(2, "0")}.ts`,
    );
    const root = fileFixture(
      Object.fromEntries(files.map((file) => [file, "export const value = input as Shape;\n"])),
    );
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

    expect(countAssertions(...parseFixture(source, "src/example.ts"))).toBe(3);
    for (const file of ["src/agents/agent-model-discovery.ts", "src/example.ts"]) {
      expect(countAssertions(...parseFixture("value as unknown as Shape;", file))).toBe(1);
    }
    expect(
      countAssertions(
        ...parseFixture("declare const value: unknown as Shape;", "src/example.d.ts"),
      ),
    ).toBe(0);
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

    const safeSecond =
      "// SAFETY: the parser guarantees this value is numeric.\nexport const second = value as number;\n";
    fs.writeFileSync(sourcePath, `export const first = value as string;\n${safeSecond}`);
    expect(main(root, ["--base", "HEAD"])).toBe(0);

    fs.writeFileSync(
      sourcePath,
      `// SAFETY: the parser guarantees this value is text.\nexport const first = value as string;\n${safeSecond}`,
    );
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(main(root, ["--base", "HEAD", "--prune"])).toBe(0);
    expect(readBaseline(root, baselinePath)).toEqual(new Map());
  });

  it("allows rebaselining assertion debt already present in the base tree", () => {
    const { root, baselinePath } = ratchetFixture(
      "export const first = value as string;\nexport const mergedConcurrently = value as number;\n",
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
      "config/assertion-safety-baseline.txt": [
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
    fs.writeFileSync(path.join(root, "src/a.ts"), "const broken = ;");
    fs.rmSync(path.join(root, "src/b.ts"));
    const report = assertionReport(root, "HEAD");
    expect(report).toMatchObject({ complete: true, matching: "not-performed" });
    expect(report.source).toEqual({
      commit,
      tree: git(root, ["rev-parse", "HEAD^{tree}"]).trim(),
      baselineBlob: git(root, ["rev-parse", "HEAD:config/assertion-safety-baseline.txt"]).trim(),
      packageBlob: null,
      lockfileBlob: null,
    });
    expect(report.tooling.sha256["scripts/check-assertion-safety-ratchet.mts"]).toBe(
      createHash("sha256")
        .update(
          fs.readFileSync(
            new URL("../../scripts/check-assertion-safety-ratchet.mts", import.meta.url),
          ),
        )
        .digest("hex"),
    );
    expect([report.coverage, report.totals]).toEqual([
      { discovered: 7, parsed: 3, failed: 0, unvisited: 0, excluded: 3, missing: 1 },
      { allowances: 25, counted: 3, exempt: 3, unusedAllowance: 22 },
    ]);
    expect(report.files.map((file) => file.path)).toEqual([
      "scripts/example.ts",
      "src/a.ts",
      "src/b.ts",
      "src/deleted.ts",
      "src/example.d.ts",
      "src/example.test.ts",
      "src/zero.ts",
    ]);
    const first = report.files.find((file) => file.path === "src/a.ts");
    expect(first?.blob).toBe(git(root, ["rev-parse", "HEAD:src/a.ts"]).trim());
    expect(first?.sites.map((site) => site.exemption)).toEqual([
      null,
      "unknown",
      "const",
      "safety-comment",
      null,
    ]);
    expect(first?.sites[0]).toMatchObject({
      kind: "as",
      line: 1,
      column: files["src/a.ts"].indexOf("as Shape") + 1,
      start: files["src/a.ts"].indexOf("value as Shape"),
    });
    expect(report.ambiguousFingerprints).toEqual([
      {
        fingerprint: createHash("sha256").update("value as Shape").digest("hex"),
        occurrences: 2,
      },
    ]);
    expect(
      report.files.filter((file) => file.status === "excluded").map((file) => file.exclusion),
    ).toEqual(["outside-scope", "declaration", "test-support"]);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(root, ["--report", commit])).toBe(0);
    expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify(report, null, 2));
    expect(fs.readFileSync(path.join(root, "config/assertion-safety-baseline.txt"), "utf8")).toBe(
      files["config/assertion-safety-baseline.txt"],
    );
  });

  it("reports parse failures across batches without treating unknown counts as zero", () => {
    const root = fileFixture(
      {
        ...Object.fromEntries(
          Array.from({ length: 34 }, (_, index) => [
            `src/${String(index).padStart(2, "0")}.ts`,
            index === 0 || index === 33 ? "const broken = ;" : "const value = 1;",
          ]),
        ),
        "config/assertion-safety-baseline.txt": "src/00.ts\t1\nsrc/33.ts\t1\n",
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
    });
    expect(report.totals).toEqual({
      allowances: null,
      counted: null,
      exempt: null,
      unusedAllowance: null,
    });
    expect(report.errors).toHaveLength(1);
  });
});
