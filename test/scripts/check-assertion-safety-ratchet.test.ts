import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  collectAssertionSafetyReport,
  collectCurrentAssertionSafetyCounts,
  countUnsafeAssertions,
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
const nestedGitEnvKeys = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("check-assertion-safety-ratchet", () => {
  it("counts mixed source files and reports the first malformed source in path order", () => {
    const root = tempDirs.make("openclaw-assertion-safety-files-");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const extensions = ["ts", "tsx", "mts", "cts"];
    const sources = Array.from({ length: 36 }, (_, index) => ({
      file: `src/source-${String(index).padStart(2, "0")}.${extensions[index % extensions.length]!}`,
      source:
        index === 17 ? "export const value = 17;\n" : "export const value = input as Shape;\n",
    }));
    for (const { file, source } of sources) {
      fs.writeFileSync(path.join(root, file), source);
    }
    git(root, ["init"]);

    expect(collectCurrentAssertionSafetyCounts(root)).toEqual(
      new Map(sources.filter((_, index) => index !== 17).map(({ file }) => [file, 1])),
    );

    const malformed = [sources[5]!, sources[17]!, sources[35]!];
    for (const { file } of malformed) {
      fs.writeFileSync(path.join(root, file), "const broken = ;\n");
    }
    for (const { file, source } of malformed) {
      expect(() => collectCurrentAssertionSafetyCounts(root)).toThrow(
        `${file}:1: Expression expected.`,
      );
      fs.writeFileSync(path.join(root, file), source);
    }
  });

  it("keeps worktree counts and staged read failures with unmerged index entries", () => {
    const root = tempDirs.make("openclaw-assertion-safety-unmerged-");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const files = Array.from(
      { length: 36 },
      (_, index) => `src/source-${String(index).padStart(2, "0")}.ts`,
    );
    for (const file of files) {
      fs.writeFileSync(path.join(root, file), "export const value = input as Shape;\n");
    }
    git(root, ["init"]);
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

    expect(collectCurrentAssertionSafetyCounts(root)).toEqual(
      new Map(files.map((file) => [file, 1])),
    );
    expect(() => collectCurrentAssertionSafetyCounts(root, { staged: true })).toThrow(
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

    expect(countUnsafeAssertions(...parseFixture(source, "src/example.ts"))).toBe(3);
    expect(
      countUnsafeAssertions(
        ...parseFixture("value as unknown as Shape;", "src/agents/agent-model-discovery.ts"),
      ),
    ).toBe(1);
    expect(
      countUnsafeAssertions(...parseFixture("value as unknown as Shape;", "src/example.ts")),
    ).toBe(1);
    expect(
      countUnsafeAssertions(
        ...parseFixture("declare const value: unknown as Shape;", "src/example.d.ts"),
      ),
    ).toBe(0);
    expect(isGovernedAssertionSourcePath("src/example.ts")).toBe(true);
    expect(isGovernedAssertionSourcePath("extensions/example/src/index.tsx")).toBe(true);
    expect(isGovernedAssertionSourcePath("src/example.test.ts")).toBe(false);
    expect(isGovernedAssertionSourcePath("packages/example/test-utils/value.ts")).toBe(false);
    expect(isGovernedAssertionSourcePath("scripts/example.ts")).toBe(false);
  });

  it("blocks new debt, accepts SAFETY comments, and prunes reduced counts", () => {
    const root = tempDirs.make("openclaw-assertion-safety-");
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const baselinePath = path.join(root, "config/assertion-safety-baseline.txt");
    const sourcePath = path.join(root, "src/example.ts");
    fs.writeFileSync(baselinePath, "src/example.ts\t1\n");
    fs.writeFileSync(sourcePath, "export const first = value as string;\n");
    for (const args of [["init"], ["add", "."], ["commit", "-m", "base"]]) {
      git(root, args);
    }

    fs.appendFileSync(sourcePath, "export const second = value as number;\n");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(main(root, ["--base", "HEAD", "--prune"])).toBe(1);
    expect(errors.join("\n")).toContain("src/example.ts: 2 > 1");
    expect(errors.join("\n")).toContain("// SAFETY:");

    fs.writeFileSync(
      sourcePath,
      [
        "export const first = value as string;",
        "// SAFETY: the parser guarantees this value is numeric.",
        "export const second = value as number;",
        "",
      ].join("\n"),
    );
    expect(main(root, ["--base", "HEAD"])).toBe(0);

    fs.writeFileSync(
      sourcePath,
      [
        "// SAFETY: the parser guarantees this value is text.",
        "export const first = value as string;",
        "// SAFETY: the parser guarantees this value is numeric.",
        "export const second = value as number;",
        "",
      ].join("\n"),
    );
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(main(root, ["--base", "HEAD", "--prune"])).toBe(0);
    expect(
      parseRatchetCounts(fs.readFileSync(baselinePath, "utf8"), path.relative(root, baselinePath)),
    ).toEqual(new Map());
  });

  it("allows rebaselining assertion debt already present in the base tree", () => {
    const root = tempDirs.make("openclaw-assertion-safety-base-drift-");
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const baselinePath = path.join(root, "config/assertion-safety-baseline.txt");
    const sourcePath = path.join(root, "src/example.ts");
    fs.writeFileSync(baselinePath, "src/example.ts\t1\n");
    fs.writeFileSync(
      sourcePath,
      [
        "export const first = value as string;",
        "export const mergedConcurrently = value as number;",
        "",
      ].join("\n"),
    );
    for (const args of [
      ["init"],
      ["add", "."],
      ["commit", "-m", "base with stale assertion baseline"],
    ]) {
      git(root, args);
    }

    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(main(root, ["--base", "HEAD"])).toBe(0);
    expect(main(root, ["--base", "HEAD", "--prune"])).toBe(0);
    expect(
      parseRatchetCounts(fs.readFileSync(baselinePath, "utf8"), path.relative(root, baselinePath)),
    ).toEqual(new Map([["src/example.ts", 2]]));
  });

  it("reports frozen sites, policy exemptions, unused allowances, and ambiguous fingerprints", () => {
    const root = tempDirs.make("openclaw-assertion-report-");
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
    for (const [file, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), source);
    }
    for (const args of [["init"], ["add", "."], ["commit", "-m", "report fixture"]]) {
      git(root, args);
    }
    const commit = git(root, ["rev-parse", "HEAD"]).trim();
    // A report ref selects source bytes, unlike the ratchet's comparison-only --base.
    fs.writeFileSync(path.join(root, "src/a.ts"), "const broken = ;");
    fs.rmSync(path.join(root, "src/b.ts"));
    const report = collectAssertionSafetyReport(root, "HEAD");
    expect(report.complete).toBe(true);
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
    expect(report.coverage).toEqual({
      discovered: 7,
      parsed: 3,
      failed: 0,
      unvisited: 0,
      excluded: 3,
      missing: 1,
    });
    expect(report.totals).toEqual({ allowances: 25, counted: 3, exempt: 3, unusedAllowance: 22 });
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
    expect(report.matching).toBe("not-performed");
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
    const root = tempDirs.make("openclaw-assertion-report-errors-");
    fs.mkdirSync(path.join(root, "config"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "config/assertion-safety-baseline.txt"),
      "src/00.ts\t1\nsrc/33.ts\t1\n",
    );
    for (let index = 0; index < 34; index += 1) {
      fs.writeFileSync(
        path.join(root, `src/${String(index).padStart(2, "0")}.ts`),
        index === 0 || index === 33 ? "const broken = ;" : "const value = 1;",
      );
    }
    for (const args of [["init"], ["add", "."], ["commit", "-m", "malformed fixture"]]) {
      git(root, args);
    }
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
    const report = collectAssertionSafetyReport(root, "missing-ref");
    expect(report.complete).toBe(false);
    expect(report.source.commit).toBeNull();
    expect(report.coverage.discovered).toBeNull();
    expect(report.totals).toEqual({
      allowances: null,
      counted: null,
      exempt: null,
      unusedAllowance: null,
    });
    expect(report.files).toEqual([]);
    expect(report.errors).toHaveLength(1);
  });
});
