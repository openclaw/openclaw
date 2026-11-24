import { execFileSync } from "node:child_process";
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

it.each([
  ...["ts", "tsx", "cts", "ctsx", "mts", "mtsx", "js", "jsx", "cjs", "cjsx", "mjs", "mjsx"].map(
    (extension) => ({ extension, excluded: true }),
  ),
  ...["json", "ts.map", "txt"].map((extension) => ({ extension, excluded: false })),
])("classifies .$extension specialized suites (excluded: $excluded)", ({ extension, excluded }) => {
  const directory = "extensions/example/src";
  for (const kind of ["e2e", "live"]) {
    const file = `${directory}/example.${kind}.test.${extension}`;
    expect(cli.isSharedVitestExcludedPath(file), file).toBe(excluded);
    expect(cli.isSharedVitestExcludedPath(file.replaceAll("/", "\\")), file).toBe(excluded);
    expect(cli.isSharedVitestExcludedPath(file, directory), file).toBe(excluded);
  }
  expect(cli.isSharedVitestExcludedPath(`${directory}/example.test.${extension}`)).toBe(false);
});

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
  const result = execFileSync(
    process.versions.bun ? "node" : process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { matchesVitestGlob } from './test/vitest/vitest.pattern-file.ts';
           import { nonBrowserTestBasenamePattern } from './test/vitest/vitest.include-patterns.ts';
           console.log(matchesVitestGlob('ui/src/example.test.ts', 'ui/src/**/' + nonBrowserTestBasenamePattern));`,
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" } },
  );
  expect(result.trim()).toBe("true");
});

const infraFile = "src/infra/example.test.ts";
const absoluteInfra = path.resolve(import.meta.dirname, "../..", infraFile);
const helperFile = "ui/src/helper.ts";
const uiOwner = ["ui/src/**/" + cliPatterns.nonBrowserTestBasenamePattern];
it.each([
  [infraFile, ["src/infra/**/*.test.ts"], absoluteInfra, true],
  [infraFile, [absoluteInfra], infraFile, true],
  [infraFile, ["extensions/qa-lab/**/*.test.ts"], absoluteInfra, false],
  [infraFile, [absoluteInfra], path.resolve("../outside.test.ts"), false],
  [helperFile, uiOwner, helperFile, false],
  [helperFile, uiOwner, path.resolve(helperFile), false],
])("selects %s within owner %j for CLI %s", (file, include, candidate, selected) => {
  expect(matches(file, include, candidate)).toBe(selected);
});

it("keeps absolute Windows operands selected after discovery", async () => {
  const windowsPath = {
    ...path.win32,
    resolve: (...parts: string[]) => path.win32.resolve("C:\\", ...parts),
  };
  const candidate = windowsPath.resolve(absoluteInfra).replaceAll("\\", "/");
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
  [["--configLoader", "test/runner.test.ts"], true],
  [["-no-isolate", "true"], false],
  [["--", `--exclude=${qaFile}`], true],
  [[`${qaFile}:12`], true],
  [["unrelated.test.ts", "run"], false],
])("projects native operands without consuming controls: %j", (args, selected) => {
  expect(matches(qaFile, [qaFile], ...args)).toBe(selected);
});

it("stops collecting excludes at the separator", () => {
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
it("preserves native non-browser discovery and shallow extension bounds", () => {
  const root = tempDirs.make("vitest-ui-selector-");
  const uiTs = testPaths("ui/src", ["a", "a.browser-import", "b.browser/a", "a.browser.x"]);
  const pluginTs = testPaths("extensions/example/browser", ["shared.browser-import"]);
  const browserTs = testPaths("ui/src", ["only.browser", "helper.browser-helper.browser"]);
  const files = withTsx([...uiTs, ...pluginTs, ...browserTs]).concat("ui/src/a.ts", "a.test.ts");
  for (const file of files) {
    writeFileSync(fixturePath(root, file), "");
  }
  const owner = ["ui/src", "extensions/*/browser"].map(
    (dir) => `${dir}/**/${cliPatterns.nonBrowserTestBasenamePattern}`,
  );
  const check = (include: string[], requested: string[], expected: readonly string[]) => {
    const selected = intersect(include, requested)!;
    const native = globSync(selected, { cwd: root, dot: true, expandDirectories: false });
    const sorted = expected.toSorted();
    for (const actual of [filterFiles(files, selected), native]) {
      expect(actual.map((file) => file.replaceAll("\\", "/")).toSorted()).toEqual(sorted);
    }
  };
  for (const extension of ["ts", "tsx"]) {
    const expected = [...uiTs, ...pluginTs].map((file) => (extension === "ts" ? file : `${file}x`));
    check(owner, [`**/*.test.${extension}`], expected);
  }
  for (const [includeExtension, requestedExtension, expected] of [
    ["ts", "tsx", []],
    ["ts", "{ts,tsx}", [uiTs[2]!]],
    ["{ts,tsx}", "tsx", [`${uiTs[2]}x`]],
  ] as const) {
    check(
      [`ui/src/**/*.test.${includeExtension}`],
      [`ui/src/b.browser/*.test.${requestedExtension}`],
      expected,
    );
  }
  check(uiTs, ["ui/src/a*.test.ts", uiTs[0]!], [uiTs[0]!, uiTs[1]!, uiTs[3]!]);
  expect(intersect(owner, ["ui/src/a.ts"])).toEqual([]);
  expect(filterFiles(files, narrow(owner, "ui/src")!).toSorted()).toEqual(withTsx(uiTs).toSorted());
});

it.each([
  ["ui/src/**/*.e2e.test.ts", "ui/src/e2e/*.e2e.test.ts"],
  ["ui/src/**/prefix" + cliPatterns.nonBrowserTestBasenamePattern, "ui/src/**/*.test.ts"],
])("retains the ambiguity guard for glob-owned inventory %s", (owner, requested) => {
  expect(() => intersect([owner], [requested])).toThrow(
    "cannot safely intersect non-literal include path",
  );
});
