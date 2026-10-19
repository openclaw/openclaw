import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { globSync } from "tinyglobby";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  filterFilesByPatterns,
  intersectIncludePatterns as intersectPatterns,
  nonBrowserTestBasenamePattern,
} from "./vitest.include-patterns.ts";
import {
  collectVitestExcludePatterns,
  matchesVitestCliSelection,
  matchesVitestGlob,
  narrowIncludePatternsForCli,
} from "./vitest.pattern-file.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const withTsx = (files: string[]) => [...files, ...files.map((file) => `${file}x`)];
const filterFiles = (files: string[], patterns: string[]) =>
  filterFilesByPatterns(files, patterns, [], matchesVitestGlob);
const intersect = (owner: string[], requested: string[]) =>
  intersectPatterns(owner, requested, matchesVitestGlob);
const narrow = (include: string[], ...args: string[]) =>
  narrowIncludePatternsForCli(include, ["node", "vitest", "run", ...args]);
function fixturePath(root: string, file: string) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

describe("native CLI selection", () => {
  it("plans Node CI test ownership before dependencies are installed", () => {
    const root = tempDirs.make("openclaw-selection-preflight-");
    for (const relative of [
      "test/vitest/vitest.pattern-file.ts",
      "test/vitest/vitest.include-patterns.ts",
      "scripts/lib/vitest-cli-mode.mts",
    ]) {
      copyFileSync(
        path.resolve(import.meta.dirname, "../..", relative),
        fixturePath(root, relative),
      );
    }
    writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    const result = spawnSync(
      process.versions.bun ? "node" : process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { matchesVitestGlob } from './test/vitest/vitest.pattern-file.ts';
           import { filterFilesByPatterns, nonBrowserTestBasenamePattern } from './test/vitest/vitest.include-patterns.ts';
           console.log(JSON.stringify(filterFilesByPatterns(
             ['ui/src/example.test.ts', 'ui/src/example.browser-import.test.ts', 'ui/src/example.browser.test.ts'],
             ['ui/src/**/' + nonBrowserTestBasenamePattern], [], matchesVitestGlob
           )));`,
      ],
      { cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      '["ui/src/example.test.ts","ui/src/example.browser-import.test.ts"]',
    );
  });

  it("keeps non-test paths outside UI discovery when CLI narrowing is unavailable", () => {
    const file = "ui/src/pages/devices/capability.ts";
    const absoluteFile = path.resolve(file);
    const include = ["ui/src/**/" + nonBrowserTestBasenamePattern];
    expect(narrow(include, file)).toEqual([]);
    expect(narrow(include, absoluteFile)).toBeNull();
    expect(intersect(include, [file])).toEqual([]);
    for (const target of [file, absoluteFile]) {
      expect(matchesVitestCliSelection(file, include, ["run", target], "", {})).toBe(false);
    }
  });

  const infraFile = "src/infra/sqlite-worker-operation-attachment.test.ts";
  const absoluteInfra = path.resolve(import.meta.dirname, "../..", infraFile);
  it.each([
    [["src/infra/**/*.test.ts"], absoluteInfra, true],
    [[absoluteInfra], infraFile, true],
    [["extensions/qa-lab/**/*.test.ts"], absoluteInfra, false],
    [[absoluteInfra], path.resolve("../outside.test.ts"), false],
  ])("intersects owner %j with CLI %s (selected: %s)", (include, candidate, selected) => {
    expect(narrow(include, candidate)).toEqual(selected ? [candidate.replaceAll("\\", "/")] : []);
    expect(matchesVitestCliSelection(infraFile, include, ["run", candidate], "", {})).toBe(
      selected,
    );
  });

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
    vi.stubGlobal("process", { ...process, platform: "win32" });
    try {
      const selector = await import("./vitest.pattern-file.ts");
      const include = ["src/infra/**/*.test.ts"];
      const args = ["run", candidate];
      const matches = (patterns: string[], cliArgs = args) =>
        selector.matchesVitestCliSelection(infraFile, patterns, cliArgs, "", {});
      expect(selector.narrowIncludePatternsForCli(include, ["node", "vitest", ...args])).toEqual([
        candidate,
      ]);
      expect(matches(include)).toBe(true);
      expect(matches(include, [...args, "--exclude", infraFile])).toBe(false);
      expect(matches(["extensions/qa-lab/**/*.test.ts"])).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.doUnmock("node:path");
      vi.resetModules();
    }
  });

  const file = "extensions/qa-lab/src/suite-process-lifecycle.test.ts";
  it.each([
    [["--config-loader", "runner"], true],
    [["-no-isolate", "true"], false],
    [["--", `--exclude=${file}`], true],
    [[`${file}:12`], true],
    [["--testNamePattern", "unrelated.test.ts"], true],
    [["unrelated.test.ts", "run"], false],
  ])("projects native operands without consuming controls: %j", (args, selected) => {
    expect(matchesVitestCliSelection(file, [file], ["run", ...args], "", {})).toBe(selected);
  });

  it("does not narrow discovery from config-loader operands or separator tails", () => {
    const include = [file];
    for (const args of [
      ["--configLoader", "test/runner.test.ts"],
      ["--", "test/other.test.ts"],
    ]) {
      expect(narrow(include, ...args)).toBeNull();
    }
    expect(collectVitestExcludePatterns(["--exclude", "before", "--", "--exclude=after"])).toEqual([
      "before",
    ]);
  });
});

describe("batch file selection", () => {
  it("keeps a large exclusion inventory within Node's compiled-pattern cache budget", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => `src/keep-${index}.test.ts`);
    const exclude = Array.from({ length: 260 }, (_, index) => `src/excluded-${index}.test.ts`);
    // Node's matcher cache evicts the oldest entry when its size reaches 250.
    const cache = new Set<string>();
    let compilations = 0;
    const matcher = (file: string, pattern: string) => {
      if (!cache.has(pattern)) {
        compilations += 1;
        cache.add(pattern);
        if (cache.size >= 250) {
          cache.delete(cache.values().next().value!);
        }
      }
      return path.matchesGlob(file, pattern);
    };
    expect(filterFilesByPatterns(candidates, ["src/**/*.test.ts"], exclude, matcher)).toEqual(
      candidates,
    );
    expect(compilations).toBeLessThanOrEqual(exclude.length + 1);
  });
});

describe("intersectIncludePatterns", () => {
  const view = (extension: string) => `ui/src/components/view.test.${extension}`;
  it.each([
    [["ts"], "tsx", []],
    [["tsx"], "ts", []],
    [["ts"], "{ts,tsx}", [view("ts")]],
    [["{ts,tsx}"], "tsx", [view("tsx")]],
    [["ts", "tsx"], "{ts,tsx}", withTsx([view("ts")])],
  ])("constrains owner %j for shallow %s globs", (owner, candidate, expected) => {
    const selected = intersect(
      owner.map((extension) => `ui/src/**/*.test.${extension}`),
      [`ui/src/components/*.test.${candidate}`],
    );
    const files = withTsx([view("ts"), "ui/src/elsewhere/view.test.ts"]);
    expect(filterFiles(files, selected!)).toEqual(expected);
  });

  it("preserves native non-browser TS and TSX discovery through directory selection", () => {
    const root = tempDirs.make("vitest-ui-selector-");
    const uiTs = [
      "ui/src/ordinary.test.ts",
      "ui/src/shared.browser-import.test.ts",
      "ui/src/folder.browser/ordinary.test.ts",
      "ui/src/shared.browser.contract.test.ts",
    ];
    const uiTsx = uiTs.map((file) => `${file}x`);
    const pluginTs = ["extensions/example/browser/shared.browser-import.test.ts"];
    const pluginTsx = pluginTs.map((file) => `${file}x`);
    const files = [
      ...uiTs,
      ...uiTsx,
      ...pluginTs,
      ...pluginTsx,
      ...withTsx([
        "ui/src/only.browser.test.ts",
        "ui/src/helper.browser-helper.browser.test.ts",
        "extensions/example/browser/only.browser.test.ts",
      ]),
      "ui/src/readme.ts",
      "other/example.test.ts",
    ];
    for (const file of files) {
      writeFileSync(fixturePath(root, file), "");
    }
    const owner = [
      "ui/src/**/" + nonBrowserTestBasenamePattern,
      "extensions/*/browser/**/" + nonBrowserTestBasenamePattern,
    ];
    for (const { requested, expected } of [
      { requested: ["ui/src/**/*.test.ts"], expected: uiTs },
      { requested: ["ui/src/**/*.test.tsx"], expected: uiTsx },
      { requested: ["ui/src/**/*.test.ts", "ui/src/**/*.test.tsx"], expected: [...uiTs, ...uiTsx] },
      { requested: ["extensions/**/*.test.ts"], expected: pluginTs },
      { requested: ["extensions/**/*.test.tsx"], expected: pluginTsx },
      { requested: ["**/*.test.ts"], expected: [...uiTs, ...pluginTs] },
      { requested: ["**/*.test.tsx"], expected: [...uiTsx, ...pluginTsx] },
    ]) {
      const selected = intersect(owner, requested);
      expect(filterFiles(files, selected!).toSorted()).toEqual(expected.toSorted());
      expect(
        globSync(selected!, { cwd: root, dot: true, expandDirectories: false })
          .map((file) => file.replaceAll("\\", "/"))
          .toSorted(),
      ).toEqual(expected.toSorted());
    }
    expect(filterFiles(files, narrow(owner, "ui/src")!).toSorted()).toEqual(
      [...uiTs, ...uiTsx].toSorted(),
    );
  });

  it("projects arbitrary candidate globs onto a finite literal owner", () => {
    const owner = [
      "ui/src/e2e/chat.e2e.test.ts",
      "ui/src/e2e/chat.capture.e2e.test.ts",
      "ui/src/pages/workboard/workboard.e2e.test.ts",
    ];

    expect(
      intersect(owner, ["ui/src/e2e/chat*.e2e.test.ts", "ui/src/e2e/chat.e2e.test.ts"]),
    ).toEqual(["ui/src/e2e/chat.e2e.test.ts", "ui/src/e2e/chat.capture.e2e.test.ts"]);
  });

  it.each([
    ["ui/src/**/*.e2e.test.ts", "ui/src/e2e/*.e2e.test.ts"],
    ["ui/src/**/!(*.browser.test.ts)", "ui/src/**/*.test.ts"],
    ["ui/src/**/prefix" + nonBrowserTestBasenamePattern, "ui/src/**/*.test.ts"],
  ])("retains the ambiguity guard for glob-owned inventory %s", (owner, requested) => {
    expect(() => intersect([owner], [requested])).toThrow(
      "cannot safely intersect non-literal include path",
    );
  });
});
