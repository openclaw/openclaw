import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { filterFilesByPatterns, intersectIncludePatterns } from "./vitest.include-patterns.ts";
import {
  collectVitestExcludePatterns,
  matchesVitestCliSelection,
  matchesVitestGlob,
  narrowIncludePatternsForCli,
} from "./vitest.pattern-file.ts";

describe("native CLI selection", () => {
  it("plans Node CI test ownership before dependencies are installed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-selection-preflight-"));
    try {
      for (const relative of [
        "test/vitest/vitest.pattern-file.ts",
        "test/vitest/vitest.include-patterns.ts",
        "scripts/lib/vitest-cli-mode.mts",
      ]) {
        const target = path.join(root, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(path.resolve(import.meta.dirname, "../..", relative), target);
      }
      writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
      const result = spawnSync(
        process.versions.bun ? "node" : process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { matchesVitestGlob } from './test/vitest/vitest.pattern-file.ts';
           import { filterFilesByPatterns } from './test/vitest/vitest.include-patterns.ts';
           console.log(JSON.stringify(filterFilesByPatterns(
             ['ui/src/example.test.ts', 'ui/src/example.browser.test.ts'],
             ['ui/src/**/!(*.browser).test.ts'], [], matchesVitestGlob
           )));`,
        ],
        { cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" } },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('["ui/src/example.test.ts"]');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { file: "ui/src/pages/devices/capability-chips.test.ts", selected: true },
    { file: "ui/src/pages/devices/capability-chips.browser.test.ts", selected: false },
  ])("preserves UI extglob ownership for $file", ({ file, selected }) => {
    const include = ["ui/src/**/!(*.browser).test.ts"];
    const expected = selected ? [file] : [];
    expect(narrowIncludePatternsForCli(include, ["node", "vitest", "run", file])).toEqual(expected);
    expect(intersectIncludePatterns(include, [file], matchesVitestGlob)).toEqual(expected);
    expect(matchesVitestCliSelection(file, include, ["run", file], "", {})).toBe(selected);
  });

  const infraFile = "src/infra/sqlite-worker-operation-attachment.test.ts";
  const absoluteInfra = path.resolve(import.meta.dirname, "../..", infraFile);
  it.each([
    { include: ["src/infra/**/*.test.ts"], candidate: absoluteInfra, selected: true },
    { include: [absoluteInfra], candidate: infraFile, selected: true },
    { include: ["extensions/qa-lab/**/*.test.ts"], candidate: absoluteInfra, selected: false },
    { include: [absoluteInfra], candidate: path.resolve("../outside.test.ts"), selected: false },
  ])(
    "intersects CLI $candidate with its actual owner $include",
    ({ include, candidate, selected }) => {
      expect(narrowIncludePatternsForCli(include, ["node", "vitest", "run", candidate])).toEqual(
        selected ? [candidate.replaceAll("\\", "/")] : [],
      );
      expect(matchesVitestCliSelection(infraFile, include, ["run", candidate], "", {})).toBe(
        selected,
      );
    },
  );

  it("keeps absolute Windows operands selected after discovery", async () => {
    const windowsPath = {
      ...path.win32,
      resolve: (...parts: string[]) => path.win32.resolve("C:\\", ...parts),
    };
    const candidate = windowsPath
      .resolve(import.meta.dirname, "../..", infraFile)
      .replaceAll("\\", "/");
    vi.resetModules();
    vi.doMock("node:path", () => ({ default: windowsPath }));
    try {
      const selector = await import("./vitest.pattern-file.ts");
      const include = ["src/infra/**/*.test.ts"];
      expect(
        selector.narrowIncludePatternsForCli(include, ["node", "vitest", "run", candidate]),
      ).toEqual([candidate]);
      expect(
        selector.matchesVitestCliSelection(infraFile, include, ["run", candidate], "", {}),
      ).toBe(true);
      expect(
        selector.matchesVitestCliSelection(
          infraFile,
          include,
          ["run", candidate, "--exclude", infraFile],
          "",
          {},
        ),
      ).toBe(false);
      expect(
        selector.matchesVitestCliSelection(
          infraFile,
          ["extensions/qa-lab/**/*.test.ts"],
          ["run", candidate],
          "",
          {},
        ),
      ).toBe(false);
    } finally {
      vi.doUnmock("node:path");
      vi.resetModules();
    }
  });

  const file = "extensions/qa-lab/src/suite-process-lifecycle.test.ts";
  it.each([
    { args: ["--configLoader", "runner"], selected: true },
    { args: ["--configLoader=", "runner"], selected: true },
    { args: ["--isolate=", "false"], selected: true },
    { args: ["--config-loader", "runner"], selected: true },
    { args: ["--isolate", "false"], selected: true },
    { args: ["--passWithNoTests", "true"], selected: true },
    { args: ["--no-isolate", "false"], selected: false },
    { args: ["-no-isolate", "true"], selected: false },
    { args: ["--", "unrelated.test.ts"], selected: true },
    { args: ["--", `--exclude=${file}`], selected: true },
    { args: [`${file}:12`], selected: true },
    { args: ["--testNamePattern", "unrelated.test.ts"], selected: true },
    { args: ["unrelated.test.ts", "run"], selected: false },
  ])("projects native operands without consuming controls: $args", ({ args, selected }) => {
    expect(matchesVitestCliSelection(file, [file], ["run", ...args], "", {})).toBe(selected);
  });

  it("does not narrow discovery from config-loader operands or separator tails", () => {
    const include = [file];
    for (const args of [
      ["--configLoader", "test/runner.test.ts"],
      ["--", "test/other.test.ts"],
    ]) {
      expect(narrowIncludePatternsForCli(include, ["node", "vitest", "run", ...args])).toBeNull();
    }
    expect(collectVitestExcludePatterns(["--exclude", "before", "--", "--exclude=after"])).toEqual([
      "before",
    ]);
  });
});

describe("batch file selection", () => {
  const files = Object.freeze([
    "ui/src/b.test.ts",
    "ui/src/a.browser.test.ts",
    "ui/src/a.test.ts",
    "ui/src/b.test.ts",
    "ui/src/.hidden.test.ts",
    "ui/src/../src/a.test.ts",
    "ui//src/a.test.ts",
    "ui\\src\\a.test.ts",
    "UI/src/a.test.ts",
    "!ui/src/a.test.ts",
    "#ui/src/a.test.ts",
  ]);

  it.each([
    { include: ["ui/src/**/!(*.browser).test.ts"], exclude: [] },
    { include: ["ui/src/a*", "ui/src/b*"], exclude: ["**/*.browser.test.ts"] },
    { include: ["{ui,UI}/src/[ab].test.ts"], exclude: ["ui/**/b.test.ts"] },
    { include: ["!ui/**", "#ui/**"], exclude: [] },
    { include: ["./ui/src/*.test.ts", "ui\\src\\*.test.ts"], exclude: ["**/.hidden*"] },
    { include: [], exclude: [] },
    { include: ["**"], exclude: ["**"] },
  ])("retains single-file matcher semantics and input order: $include", ({ include, exclude }) => {
    const expected = files.filter(
      (file) =>
        include.some((pattern) => path.matchesGlob(file, pattern)) &&
        !exclude.some((pattern) => path.matchesGlob(file, pattern)),
    );
    expect(
      filterFilesByPatterns(
        files,
        Object.freeze(include),
        Object.freeze(exclude),
        path.matchesGlob,
      ),
    ).toEqual(expected);
  });

  it.skipIf(Boolean(process.versions.bun))(
    "keeps a large exclusion inventory within Node's compiled-pattern cache budget",
    () => {
      const candidates = Array.from({ length: 12 }, (_, index) => `src/keep-${index}.test.ts`);
      const exclude = Array.from({ length: 260 }, (_, index) => `src/excluded-${index}.test.ts`);
      const nativeMatch = path.matchesGlob;
      // Node's matcher cache evicts the oldest entry when its size reaches 250.
      const cache = new Set<string>();
      let compilations = 0;
      const matcher = vi.spyOn(path, "matchesGlob").mockImplementation((file, pattern) => {
        if (!cache.has(pattern)) {
          compilations += 1;
          cache.add(pattern);
          if (cache.size >= 250) {
            cache.delete(cache.values().next().value!);
          }
        }
        return nativeMatch(file, pattern);
      });
      try {
        expect(
          filterFilesByPatterns(candidates, ["src/**/*.test.ts"], exclude, path.matchesGlob),
        ).toEqual(candidates);
        expect(compilations).toBeLessThanOrEqual(exclude.length + 1);
      } finally {
        matcher.mockRestore();
      }
    },
  );
});

describe("intersectIncludePatterns", () => {
  it("projects arbitrary candidate globs onto a finite literal owner", () => {
    const owner = [
      "ui/src/e2e/chat.e2e.test.ts",
      "ui/src/e2e/chat.capture.e2e.test.ts",
      "ui/src/pages/workboard/workboard.e2e.test.ts",
    ];

    expect(
      intersectIncludePatterns(owner, ["ui/src/e2e/*.e2e.test.ts"], matchesVitestGlob),
    ).toEqual(["ui/src/e2e/chat.e2e.test.ts", "ui/src/e2e/chat.capture.e2e.test.ts"]);
    expect(
      intersectIncludePatterns(
        owner,
        ["ui/src/e2e/chat*.e2e.test.ts", "ui/src/e2e/chat.e2e.test.ts"],
        matchesVitestGlob,
      ),
    ).toEqual(["ui/src/e2e/chat.e2e.test.ts", "ui/src/e2e/chat.capture.e2e.test.ts"]);
  });

  it("retains the ambiguity guard for glob-owned inventories", () => {
    expect(() =>
      intersectIncludePatterns(
        ["ui/src/**/*.e2e.test.ts"],
        ["ui/src/e2e/*.e2e.test.ts"],
        matchesVitestGlob,
      ),
    ).toThrow("cannot safely intersect non-literal include path");
  });
});
