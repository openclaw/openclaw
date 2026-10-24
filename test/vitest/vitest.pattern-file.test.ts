import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { globSync } from "tinyglobby";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import * as cliPatterns from "./vitest.include-patterns.ts";
import * as cli from "./vitest.pattern-file.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const withTsx = (files: string[]) => [...files, ...files.map((file) => `${file}x`)];
const testPaths = (dir: string, names: string[]) => names.map((name) => `${dir}/${name}.test.ts`);
const filterFiles = (files: string[], patterns: string[]) =>
  cliPatterns.filterFilesByPatterns(files, patterns, [], cli.matchesVitestGlob);
const intersect = (owner: string[], requested: string[]) =>
  cliPatterns.intersectIncludePatterns(owner, requested, cli.matchesVitestGlob);
const narrow = (include: string[], ...args: string[]) =>
  cli.narrowIncludePatternsForCli(include, ["node", "vitest", "run", ...args]);
const matches = (file: string, include: string[], ...args: string[]) =>
  cli.matchesVitestCliSelection(file, include, ["run", ...args], "", {});
function fixturePath(root: string, file: string) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

it.each(["ts", "tsx", "cts", "ctsx", "mts", "mtsx", "js", "jsx", "cjs", "cjsx", "mjs", "mjsx"])(
  "keeps .%s specialized suites opt-in across root and scoped discovery",
  (extension) => {
    for (const directory of ["test/example", "extensions/example/src"]) {
      for (const kind of ["e2e", "live"]) {
        const file = `${directory}/example.${kind}.test.${extension}`;
        expect(cli.isSharedVitestExcludedPath(file), file).toBe(true);
        expect(cli.isSharedVitestExcludedPath(file.replaceAll("/", "\\")), file).toBe(true);
        expect(cli.isSharedVitestExcludedPath(file, directory), file).toBe(true);
      }
      expect(cli.isSharedVitestExcludedPath(`${directory}/example.test.${extension}`)).toBe(false);
    }
  },
);

it.each(["json", "ts.map", "txt"])(
  "does not classify .%s assets as specialized tests",
  (extension) => {
    for (const kind of ["e2e", "live"]) {
      expect(cli.isSharedVitestExcludedPath(`test/example.${kind}.test.${extension}`)).toBe(false);
    }
  },
);

it("plans Node CI test ownership before dependencies are installed", () => {
  const root = tempDirs.make("openclaw-selection-preflight-");
  for (const relative of [
    "test/vitest/vitest.pattern-file.ts",
    "test/vitest/vitest.include-patterns.ts",
    "scripts/lib/vitest-cli-mode.mts",
  ]) {
    copyFileSync(path.resolve(import.meta.dirname, "../..", relative), fixturePath(root, relative));
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
  const file = "ui/src/helper.ts";
  const absoluteFile = path.resolve(file);
  const include = ["ui/src/**/" + cliPatterns.nonBrowserTestBasenamePattern];
  expect(narrow(include, file)).toEqual([]);
  expect(narrow(include, absoluteFile)).toBeNull();
  expect(intersect(include, [file])).toEqual([]);
  for (const target of [file, absoluteFile]) {
    expect(matches(file, include, target)).toBe(false);
  }
});

const infraFile = "src/infra/example.test.ts";
const absoluteInfra = path.resolve(import.meta.dirname, "../..", infraFile);
it.each([
  [["src/infra/**/*.test.ts"], absoluteInfra, true],
  [[absoluteInfra], infraFile, true],
  [["extensions/qa-lab/**/*.test.ts"], absoluteInfra, false],
  [[absoluteInfra], path.resolve("../outside.test.ts"), false],
])("intersects owner %j with CLI %s (selected: %s)", (include, candidate, selected) => {
  expect(narrow(include, candidate)).toEqual(selected ? [candidate.replaceAll("\\", "/")] : []);
  expect(matches(infraFile, include, candidate)).toBe(selected);
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
    const selectedBy = (patterns: string[], cliArgs = args) =>
      selector.matchesVitestCliSelection(infraFile, patterns, cliArgs, "", {});
    expect(selector.narrowIncludePatternsForCli(include, ["node", "vitest", ...args])).toEqual([
      candidate,
    ]);
    expect(selectedBy(include)).toBe(true);
    expect(selectedBy(include, [...args, "--exclude", infraFile])).toBe(false);
    expect(selectedBy(["extensions/qa-lab/**/*.test.ts"])).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    vi.doUnmock("node:path");
    vi.resetModules();
  }
});

const qaFile = "extensions/qa-lab/example.test.ts";
it.each([
  [["--config-loader", "runner"], true],
  [["-no-isolate", "true"], false],
  [["--", `--exclude=${qaFile}`], true],
  [[`${qaFile}:12`], true],
  [["--testNamePattern", "unrelated.test.ts"], true],
  [["unrelated.test.ts", "run"], false],
])("projects native operands without consuming controls: %j", (args, selected) => {
  expect(matches(qaFile, [qaFile], ...args)).toBe(selected);
});

it("does not narrow discovery from config-loader operands or separator tails", () => {
  const include = [qaFile];
  for (const args of [
    ["--configLoader", "test/runner.test.ts"],
    ["--", "test/other.test.ts"],
  ]) {
    expect(narrow(include, ...args)).toBeNull();
  }
  expect(
    cli.collectVitestExcludePatterns(["--exclude", "before", "--", "--exclude=after"]),
  ).toEqual(["before"]);
});
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
  expect(
    cliPatterns.filterFilesByPatterns(candidates, ["src/**/*.test.ts"], exclude, matcher),
  ).toEqual(candidates);
  expect(compilations).toBeLessThanOrEqual(exclude.length + 1);
});
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
  const uiTs = testPaths("ui/src", ["a", "a.browser-import", "b.browser/a", "a.browser.x"]);
  const pluginTs = testPaths("extensions/example/browser", ["shared.browser-import"]);
  const files = [
    ...withTsx([
      ...uiTs,
      ...pluginTs,
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
  const owner = ["ui/src", "extensions/*/browser"].map(
    (dir) => `${dir}/**/${cliPatterns.nonBrowserTestBasenamePattern}`,
  );
  const check = (requested: string[], expected: readonly string[]) => {
    const selected = intersect(owner, requested);
    expect(filterFiles(files, selected!).toSorted()).toEqual(expected.toSorted());
    expect(
      globSync(selected!, { cwd: root, dot: true, expandDirectories: false })
        .map((file) => file.replaceAll("\\", "/"))
        .toSorted(),
    ).toEqual(expected.toSorted());
  };
  for (const [scope, expected] of [
    ["ui/src/", uiTs],
    ["extensions/", pluginTs],
    ["", [...uiTs, ...pluginTs]],
  ] as const) {
    check([`${scope}**/*.test.ts`], expected);
    const tsx = expected.map((file) => `${file}x`);
    check([`${scope}**/*.test.tsx`], tsx);
  }
  check(["ui/src/**/*.test.ts", "ui/src/**/*.test.tsx"], withTsx(uiTs));
  expect(filterFiles(files, narrow(owner, "ui/src")!).toSorted()).toEqual(withTsx(uiTs).toSorted());
});

it("projects arbitrary candidate globs onto a finite literal owner", () => {
  const selected = testPaths("ui/src/e2e", ["chat.e2e", "chat.capture.e2e"]);
  const owner = [...selected, "ui/src/pages/workboard/workboard.e2e.test.ts"];

  expect(intersect(owner, ["ui/src/e2e/chat*.e2e.test.ts", "ui/src/e2e/chat.e2e.test.ts"])).toEqual(
    selected,
  );
});

it.each([
  ["ui/src/**/*.e2e.test.ts", "ui/src/e2e/*.e2e.test.ts"],
  ["ui/src/**/!(*.browser.test.ts)", "ui/src/**/*.test.ts"],
  ["ui/src/**/prefix" + cliPatterns.nonBrowserTestBasenamePattern, "ui/src/**/*.test.ts"],
])("retains the ambiguity guard for glob-owned inventory %s", (owner, requested) => {
  expect(() => intersect([owner], [requested])).toThrow(
    "cannot safely intersect non-literal include path",
  );
});
