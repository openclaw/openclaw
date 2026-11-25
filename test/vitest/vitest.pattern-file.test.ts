import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { convertPathToPattern, globSync } from "tinyglobby";
import { afterEach, expect, it, vi } from "vitest";
import { parseCLI } from "vitest/node";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import * as cliPatterns from "./vitest.include-patterns.ts";
import * as cli from "./vitest.pattern-file.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const withTsx = (files: string[]) => [...files, ...files.map((file) => `${file}x`)];
const testPaths = (dir: string, names: string[]) => names.map((name) => `${dir}/${name}.test.ts`);
const filterFiles = (files: string[], patterns: string[]) =>
  cliPatterns.filterFilesByPatterns(files, patterns, [], cli.matchesVitestGlob);
const intersect = (owner: string[], requested: string[]) =>
  cliPatterns.intersectIncludePatterns(owner, requested, cli.matchesVitestGlob)?.include ?? null;
const narrow = (include: string[], ...args: string[]) =>
  cli.narrowIncludePatternsForCli(include, ["node", "vitest", "run", ...args]);
const matches = (file: string, include: string[], ...args: string[]) =>
  cli.matchesVitestCliSelection(file, include, ["run", ...args], "", {});
const discover = (
  include: string[],
  args: string[],
  scopedDir: string,
  env: NodeJS.ProcessEnv,
  selectedPatterns?: readonly string[] | null,
  root?: string,
  exclude?: readonly string[],
) => {
  const native = cli.createVitestCliDiscovery(args, root);
  const dir = native.effectiveDir(scopedDir);
  const selection = cliPatterns.splitIncludePatterns(
    cli.relativizeScopedPatterns(
      selectedPatterns ??
        cli.loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env) ??
        include,
      scopedDir,
    ),
  );
  return native.discover(selection.include, dir, [
    ...cli.resolveNativeVitestExcludes(
      cli.relativizeScopedPatterns(exclude ?? [], scopedDir),
      selection.include,
      path.resolve(root ?? process.cwd(), scopedDir),
      dir,
    ),
    ...selection.exclude,
  ]);
};
function fixturePath(root: string, file: string) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

it("rejects parent traversal outside the owner without rejecting explicit outside ownership", () => {
  for (const root of [undefined, "/repo"]) {
    for (const [owner, requested] of [
      ["**/*.test.ts", "../outside/**/*.test.ts"],
      ["test/**/*.test.ts", "test/../src/**/*.test.ts"],
      ["test/**/*.test.ts", "test/**/../../src/*.test.ts"],
    ]) {
      let selection;
      try {
        selection = cliPatterns.intersectIncludePatterns(
          [owner!],
          [requested!],
          cli.matchesNativeVitestGlob,
          root,
          root,
          cli.resolveNativeVitestPattern,
        );
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("cannot safely intersect");
        continue;
      }
      expect(selection?.include).toEqual([]);
    }
    expect(
      cliPatterns.intersectIncludePatterns(
        ["../outside/**/*.test.ts"],
        ["../outside/nested/**/*.test.ts"],
        cli.matchesNativeVitestGlob,
        root,
        root,
        cli.resolveNativeVitestPattern,
      )?.include,
    ).toEqual(["../outside/nested/**/*.test.ts"]);
  }
});

it("retains native escaped exclusions in either operand and installed CLI selection", () => {
  const root = tempDirs.make("openclaw-native-negative-");
  const files = ["test/keep.test.ts", "test/a[1].test.ts"];
  for (const file of files) writeFileSync(fixturePath(root, file), "");
  const include = ["test/**/*.test.ts"];
  const negative = "!test/a\\[1\\].test.ts";
  for (const [owner, candidate] of [
    [include, [...include, negative]],
    [[...include, negative], include],
  ]) {
    const selected = cliPatterns.intersectIncludePatterns(
      owner!,
      candidate!,
      cli.matchesNativeVitestGlob,
    )!;
    expect(
      cliPatterns.filterFilesByPatterns(
        files,
        selected.include,
        selected.exclude,
        cli.matchesNativeVitestGlob,
      ),
    ).toEqual([files[0]]);
    expect(globSync(selected.include, { cwd: root, dot: true, ignore: selected.exclude })).toEqual([
      files[0],
    ]);
    expect(
      files.filter((file) =>
        cli.matchesVitestCliSelection(
          file,
          include,
          ["run"],
          "",
          {},
          cliPatterns.serializeIncludePatterns(selected),
          cli.matchesNativeVitestGlob,
        ),
      ),
    ).toEqual([files[0]]);
  }
  expect(
    files.filter((file) =>
      cli.matchesVitestCliSelection(
        file,
        include,
        ["run", "--exclude", negative.slice(1)],
        "",
        {},
        include,
        cli.matchesNativeVitestGlob,
      ),
    ),
  ).toEqual([files[0]]);
  for (const ignoredNegative of ["!test/a\\[1\\].test.ts", "!!test/keep.test.ts"]) {
    expect(
      files
        .filter((file) =>
          cli.matchesVitestCliSelection(
            file,
            include,
            ["run", "--exclude", ignoredNegative],
            "",
            {},
            include,
            cli.matchesNativeVitestGlob,
          ),
        )
        .toSorted(),
    ).toEqual(globSync(include, { cwd: root, dot: true, ignore: [ignoredNegative] }).toSorted());
  }
});

it("escapes physical prefixes while preserving positive and negative pattern syntax", () => {
  const root = path.join(tempDirs.make("openclaw-native-prefix-"), "work[1]{a,b}");
  const dir = path.join(root, "sub");
  mkdirSync(dir, { recursive: true });
  const files = ["test/keep.test.ts", "test/a[1].test.ts"];
  for (const file of files) writeFileSync(fixturePath(root, file), "");
  const relative = "test/**/*.test.ts";
  const absolute = cli.resolveNativeVitestPattern(relative, root);
  for (const owner of [
    [relative, absolute],
    [absolute, relative],
  ]) {
    const selected = cliPatterns.intersectIncludePatterns(
      [...owner, "!test/a\\[1\\].test.ts"],
      ["../test/**/*.test.ts"],
      cli.matchesNativeVitestGlob,
      root,
      dir,
      cli.resolveNativeVitestPattern,
    )!;
    expect(selected.include).toEqual(
      owner.map((pattern) => (pattern === relative ? "../test/**/*.test.ts" : absolute)),
    );
    expect(selected.exclude).toEqual([
      cli.resolveNativeVitestPattern("test/a\\[1\\].test.ts", root),
    ]);
    expect(
      globSync(selected.include, { cwd: dir, dot: true, absolute: true, ignore: selected.exclude }),
    ).toEqual([path.join(root, files[0]!)]);
  }
});

it.skipIf(process.platform === "win32")(
  "preserves POSIX glob escapes through coordinate projection",
  () => {
    const root = path.join(tempDirs.make("openclaw-pattern-escapes-"), "root[1]");
    for (const file of ["test/a[1].test.ts", "test/a\\b.test.ts"]) {
      writeFileSync(fixturePath(root, file), "");
      const pattern = convertPathToPattern(file);
      const selected = cliPatterns.intersectIncludePatterns(
        [pattern],
        [pattern],
        cli.matchesNativeVitestGlob,
        root,
        root,
        cli.resolveNativeVitestPattern,
      )!;
      expect(selected.include).toEqual([pattern]);
      expect(cli.matchesNativeVitestGlob(file, pattern)).toBe(true);
      expect(
        cliPatterns.filterFilesByPatterns(
          [file],
          selected.include,
          selected.exclude,
          cli.matchesNativeVitestGlob,
        ),
      ).toEqual([file]);
      expect(globSync(selected.include, { cwd: root, ignore: selected.exclude })).toEqual([file]);
    }
  },
);

it("retains negative constraints from either operand without treating extglobs as exclusions", () => {
  const files = testPaths("test/scripts", ["keep", "blocked"]);
  const operands: [string[], string[]][] = [
    [files, ["test/scripts/**/*.test.ts", "!test/scripts/blocked.test.ts"]],
    [[...files, "!test/scripts/blocked.test.ts"], ["test/scripts/**/*.test.ts"]],
  ];
  for (const [owner, requested] of operands) {
    const selected = cliPatterns.intersectIncludePatterns(owner, requested, cli.matchesVitestGlob)!;
    expect(selected.exclude).toEqual(["test/scripts/blocked.test.ts"]);
    expect(
      cliPatterns.filterFilesByPatterns(
        files,
        selected.include,
        selected.exclude,
        cli.matchesVitestGlob,
      ),
    ).toEqual([files[0]]);
    expect(filterFiles(files, cliPatterns.serializeIncludePatterns(selected))).toEqual([files[0]]);
  }
  expect(
    cliPatterns.splitIncludePatterns(["!file", "!(file)", "!!file", "!!(file)", "\\!file"]),
  ).toEqual({ include: ["!(file)", "\\!file"], exclude: ["file", "!(file)"] });
  expect(
    cliPatterns.intersectIncludePatterns(
      files,
      ["!test/scripts/blocked.test.ts"],
      cli.matchesVitestGlob,
    ),
  ).toEqual({ include: [], exclude: ["test/scripts/blocked.test.ts"] });
  expect(cliPatterns.intersectIncludePatterns(files, null, cli.matchesVitestGlob)).toBeNull();
});

it("preserves each origin when narrowing a recursive basename beneath a directory", () => {
  const root = tempDirs.make("openclaw-pattern-origins-");
  const relative = "src/agents/**/*.test.ts";
  const absolute = `${root}/src/agents/**/run*.test.ts`;
  const requested = ["src/agents/runner/**/*.test.ts"];
  for (const owner of [
    [relative, absolute],
    [absolute, relative],
  ]) {
    const selected = cliPatterns.intersectIncludePatterns(
      owner,
      requested,
      cli.matchesVitestGlob,
      root,
    )!;
    expect(selected.include).toEqual(
      owner.map((pattern) =>
        pattern === relative ? requested[0] : `${root}/src/agents/runner/**/run*.test.ts`,
      ),
    );
  }
  expect(() =>
    cliPatterns.intersectIncludePatterns(
      ["src/agents/**/nested/run*.test.ts"],
      ["src/agents/nested/**/*.test.ts"],
      cli.matchesVitestGlob,
      root,
    ),
  ).toThrow("cannot safely intersect");
  for (const prefix of ["", `${root}/`]) {
    const owner = `${prefix}src/agents**/run*.test.ts`;
    const requested = `${prefix}src/agents/sub/**/*.test.ts`;
    writeFileSync(fixturePath(root, "src/agents/sub/run-one.test.ts"), "");
    expect(globSync(owner, { cwd: root })).toEqual([]);
    expect(globSync(requested, { cwd: root })).toHaveLength(1);
    expect(() =>
      cliPatterns.intersectIncludePatterns([owner], [requested], cli.matchesVitestGlob, root),
    ).toThrow("cannot safely intersect");
  }
});

it("compares owner paths with inherited paths on the effective native directory", () => {
  const root = tempDirs.make("openclaw-pattern-basis-");
  const files = testPaths("test/scripts", ["keep", "blocked"]);
  const selected = cliPatterns.intersectIncludePatterns(
    files,
    ["*.test.ts", "!blocked.test.ts"],
    cli.matchesVitestGlob,
    root,
    path.join(root, "test/scripts"),
  )!;
  expect(selected).toEqual({
    include: ["keep.test.ts", "blocked.test.ts"],
    exclude: ["blocked.test.ts"],
  });
});

it("keeps globstar owner exclusions active outside the native discovery directory", () => {
  const root = tempDirs.make("openclaw-pattern-exclusions-");
  const files = [
    "test/scripts/keep.test.ts",
    "test/scripts/vendor/leak.test.ts",
    "test/scripts/node_modules/leak.test.ts",
    "test/scripts/leak.live.test.ts",
    "test/scripts/blocked.test.ts",
  ];
  for (const file of files) writeFileSync(fixturePath(root, file), "");
  const dir = path.join(root, "test/helpers");
  mkdirSync(dir, { recursive: true });
  const selected = cliPatterns.intersectIncludePatterns(
    ["test/scripts/**/*.test.ts", "!test/scripts/blocked.test.ts"],
    [`${root}/test/scripts/**/*.test.ts`],
    cli.matchesVitestGlob,
    root,
    dir,
  )!;
  expect(
    globSync(selected.include, {
      cwd: dir,
      absolute: true,
      ignore: [
        ...cli.resolveNativeVitestExcludes(
          cli.sharedVitestExcludePatterns,
          selected.include,
          root,
          dir,
        ),
        ...selected.exclude,
      ],
    }),
  ).toEqual([path.join(root, files[0]!)]);
});

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
    "scripts/lib/vitest-cli.mts",
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
    const nativePatterns = await import("./vitest.include-patterns.ts");
    expect(() =>
      nativePatterns.intersectIncludePatterns(
        ["test/a/**/*.test.ts"],
        ["test/a\\[1\\].test.ts"],
        selector.matchesNativeVitestGlob,
      ),
    ).toThrow("cannot safely intersect");
    const root = "C:/work[1]{a,b}";
    const absolutePattern = (pattern: string, basis: string) =>
      windowsPath.isAbsolute(pattern)
        ? pattern
        : path.posix.normalize(`${convertPathToPattern(basis)}/${pattern}`);
    const projected = nativePatterns.intersectIncludePatterns(
      ["test/**/*.test.ts", "!test/a\\[1\\].test.ts"],
      ["../test/**/*.test.ts"],
      selector.matchesNativeVitestGlob,
      root,
      `${root}/sub`,
      absolutePattern,
    );
    expect(projected?.exclude).toEqual([`${convertPathToPattern(root)}/test/a\\[1\\].test.ts`]);
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

it.each([
  [infraFile, ["run"], "", true],
  [infraFile, ["run"], "src/infra", true],
  [infraFile, ["run"], "ui", false],
  [infraFile, ["run", "--exclude", "**/example.test.ts"], "src/infra", false],
  [infraFile, ["run", "unrelated"], "src/infra", false],
  ["src/infra/[example].test.ts", ["run"], "", false],
])("preserves exact inventory selection for %s with %j", (file, args, dir, selected) => {
  expect(cli.matchesVitestCliSelection(file, [file], args, dir, {}, [file])).toBe(selected);
});

it.each(["plain", "[selection]"])("matches native discovery exclusions under %s", (name) => {
  const root = path.join(tempDirs.make("vitest-effective-exclusions-"), name);
  const files = [
    "test/keep.test.ts",
    "test/excluded.test.ts",
    "test/.hidden.test.ts",
    "test/[literal].test.ts",
  ];
  for (const file of files) writeFileSync(fixturePath(root, file), "");
  const include = ["test/**/*.test.ts"];
  for (const exclusion of [
    files[1]!,
    path.resolve(root, files[1]!),
    path.resolve(root, files[1]!).replaceAll("\\", "/"),
    "test\\excluded.test.ts",
    "!test/excluded.test.ts",
    "test/",
    "test/{excluded,keep}.test.ts",
    "test/@(excluded|keep).test.ts",
    "test/!(keep).test.ts",
    "test/.hidden.test.ts",
    String.raw`test/\[literal\].test.ts`,
    '"test/excluded.test.ts"',
    "'test/excluded.test.ts'",
  ]) {
    const args = ["run", "--exclude", exclusion];
    const parsed = parseCLI(["vitest", ...args]);
    const { selected } = discover(include, args, "", {}, include, root);
    const native = globSync(include, {
      cwd: root,
      ignore: parsed.options.exclude,
      dot: true,
      expandDirectories: false,
    });
    expect(selected.toSorted(), exclusion).toEqual(native.toSorted());
  }
});

it.each([
  [String.raw`test\keep.test.ts`, ["test/keep.test.ts"]],
  ["test/other/../keep.test.ts", ["test/keep.test.ts"]],
  ["test//keep.test.ts:12", ["test/keep.test.ts"]],
  ["test\\", ["test/keep.test.ts", "test/other.test.ts"]],
  ['"test/keep.test.ts"', []],
  ["'test/keep.test.ts'", []],
])("uses native startup path normalization for positional %s", (filter, expected) => {
  const root = tempDirs.make("vitest-native-positional-");
  const include = ["test/**/*.test.ts"];
  for (const file of ["test/keep.test.ts", "test/other.test.ts"]) {
    writeFileSync(fixturePath(root, file), "");
  }
  const args = ["run", filter];
  const originalArgs = [...args];
  expect(parseCLI(["vitest", ...args]).filter).toEqual([filter]);
  const discovery = cli.createVitestCliDiscovery(args, root);
  expect(discovery.discover(include, discovery.effectiveDir()).selected.toSorted()).toEqual(
    expected,
  );
  expect(args).toEqual(originalArgs);
});

it.each([
  [[], ["tooling", "tooling-isolated", "cli-process"]],
  [["--project=tooling"], ["tooling"]],
  [["--project", "TOOLING"], ["tooling"]],
  [["-p", "tooling*", "-p", "!tooling-isolated"], ["tooling"]],
  [["--project=!tooling*"], ["cli-process"]],
  [
    ["--project=tooling", "--project=cli-process"],
    ["tooling", "cli-process"],
  ],
  [["--project=tooling?"], []],
  [["--project=[t]ooling"], []],
  [["--project=missing"], []],
])("prepares native project eligibility for %j", (args, expected) => {
  const original = [...args];
  const discovery = cli.createVitestCliDiscovery(args);
  expect(
    ["tooling", "tooling-isolated", "cli-process"].filter(
      (name) => discovery.projectStatus(name) === "eligible",
    ),
  ).toEqual(expected);
  expect(args).toEqual(original);
});

it("keeps crawler-root, hidden-file and matching-parent discovery semantics", () => {
  const root = path.join(tempDirs.make("vitest-native-crawl-"), "repo");
  const files = ["test/.hidden.test.ts", "test/excluded.test.ts", "test/keep.test.ts"];
  for (const file of files) writeFileSync(fixturePath(root, file), "");
  const include = ["test/**/*.test.ts"];
  for (const [ignore, expected] of [
    [[], files],
    [["test/"], files],
    [["../repo/test/excluded.test.ts"], [files[0]!, files[2]!]],
  ] as const) {
    const args = ignore.flatMap((pattern) => ["--exclude", pattern]);
    const actual = discover(include, args, "", {}, include, root);
    expect(actual.available.toSorted()).toEqual([...expected].toSorted());
    expect(actual.selected.toSorted()).toEqual([...expected].toSorted());
  }
});

it("uses invocation roots for fallback narrowing and forwarded discovery controls", () => {
  const root = tempDirs.make("vitest-selection-root-");
  const file = "test/example.test.ts";
  const include = ["test/**/*.test.ts"];
  const absolute = path.resolve(root, file);
  writeFileSync(fixturePath(root, file), "");
  expect(cli.narrowIncludePatternsForCli(include, ["node", "vitest", absolute], { root })).toEqual([
    absolute,
  ]);
  const selected = (args: string[]) =>
    discover(include, args, "", {}, undefined, root).selected.includes(file);
  expect(selected(["run", absolute])).toBe(true);
  expect(selected(["run", "--root", root, absolute])).toBe(true);
  expect(selected(["run", `--dir=${root}`, absolute])).toBe(true);
  expect(selected(["run", "--root", "test"])).toBe(true);
  expect(selected(["run", "--dir", "test"])).toBe(false);
  expect(selected(["run", "--root", "other", "--dir", "."])).toBe(true);
  expect(selected(["run", "--root", ".", "--dir", "test"])).toBe(false);
  expect(
    discover(include, ["run", "--root", "other"], "test", {}, include, root).selected.includes(
      file,
    ),
  ).toBe(true);
  expect(selected(["run", "--", "--dir=test"])).toBe(true);
});

it("uses normalized native operands when narrowing an unprepared scoped selection", () => {
  const root = tempDirs.make("vitest-scoped-fallback-");
  const file = "test/scripts/example.test.ts";
  const include = ["test/scripts/**/*.test.ts"];
  writeFileSync(fixturePath(root, file), "");
  for (const operand of [
    "test/scripts//example.test.ts",
    "test/scripts/other/../example.test.ts",
    String.raw`test\scripts\example.test.ts`,
    `${path.resolve(root, file)}:12`,
  ]) {
    for (const forwarded of [[], ["--dir", path.join(root, "test/scripts")]]) {
      const args = ["run", operand, ...forwarded];
      const original = [...args];
      expect(discover(include, args, "test/scripts", {}, undefined, root).selected).toEqual([file]);
      expect(
        discover(include, [...args, "--exclude", "*.test.ts"], "test/scripts", {}, undefined, root)
          .selected,
      ).toEqual([]);
      expect(args).toEqual(original);
    }
  }
  for (const quoted of ['"test/scripts/example.test.ts"', "'test/scripts/example.test.ts'"]) {
    expect(
      discover(include, ["run", quoted], "test/scripts", {}, undefined, root).selected,
    ).toEqual([]);
  }
});

it("applies native basename filters after discovering unprepared owner includes", () => {
  const root = tempDirs.make("vitest-native-basename-");
  const files = ["test/example.test.ts", "test/nested/example.test.ts", "test/other.test.ts"];
  for (const file of files) writeFileSync(fixturePath(root, file), "");
  const include = ["test/**/*.test.ts"];
  const args = ["run", "--coverage.enabled", "example.test.ts"];
  const originalArgs = [...args];
  const selection = (env = {}, prepared?: string[]) =>
    discover(include, args, "test", env, prepared, root).selected.toSorted();
  expect(selection()).toEqual(files.slice(0, 2).toSorted());
  const file = path.join(root, "include.json");
  writeFileSync(file, JSON.stringify([files[1]]));
  const env = { OPENCLAW_VITEST_INCLUDE_FILE: file };
  expect(selection(env)).toEqual([files[1]]);
  expect(selection(env, ["test/example.test.ts"])).toEqual(["test/example.test.ts"]);
  expect(args).toEqual(originalArgs);
});

it("keeps owner exclusions anchored when absolute selections use another native directory", () => {
  const root = tempDirs.make("vitest-native-exclusions-");
  const files = [
    "test/scripts/owned.test.ts",
    "test/scripts/keep.test.ts",
    "test/scripts/cli.test.ts",
    "test/scripts/node_modules/ignored.test.ts",
  ];
  for (const file of files) writeFileSync(fixturePath(root, file), "");
  const include = [path.resolve(root, "test/scripts/**/*.test.ts").replaceAll("\\", "/")];
  const exclusions = ["test/scripts/owned.test.ts", "**/node_modules/**"];
  const args = ["run", "--dir", path.join(root, "test/scripts"), "--exclude", "cli.test.ts"];
  const originalArgs = [...args];
  expect(discover(include, args, "", {}, include, root, exclusions)).toEqual({
    available: ["test/scripts/keep.test.ts"],
    selected: ["test/scripts/keep.test.ts"],
  });
  expect(cli.resolveNativeVitestExcludes(exclusions, ["test/**/*.test.ts"], root)).toEqual(
    exclusions,
  );
  expect(args).toEqual(originalArgs);
});

it.each([
  "src/gateway",
  String.raw`src\gateway`,
  "src/../src/gateway",
  String.raw`src\..\src\gateway`,
])("normalizes the discovery directory through native CLI parsing: %s", (directory) => {
  const root = tempDirs.make("vitest-selection-directory-");
  const include = ["*.test.ts"];
  const args = ["run", "--dir", directory];
  const originalArgs = [...args];
  expect(parseCLI(["vitest", ...args]).options.dir).toBe("src/gateway");
  writeFileSync(fixturePath(root, "src/gateway/example.test.ts"), "");
  writeFileSync(fixturePath(root, "src/other/example.test.ts"), "");
  const { selected } = discover(include, args, "", {}, include, root);
  expect(selected).toEqual(["src/gateway/example.test.ts"]);
  expect(args).toEqual(originalArgs);
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

it.each(["posix", "win32"] as const)(
  "preserves both intersection operands' absolute provenance on %s",
  async (platform) => {
    const paths = path[platform];
    const root = platform === "win32" ? "C:/repo" : "/repo";
    const absolute = (pattern: string) => paths.resolve(root, pattern).replaceAll("\\", "/");
    const file = "test/scripts/example.test.ts";
    const other = "test/scripts/other.test.ts";
    const owner = "test/scripts/**/*.test.{ts,tsx}";
    vi.resetModules();
    vi.doMock("node:path", () => ({ default: paths }));
    try {
      const { intersectIncludePatterns } = await import("./vitest.include-patterns.ts");
      for (const [includes, selected, expected] of [
        [[file], [absolute(file)], [absolute(file)]],
        [[file, other], [absolute("test/**/*.test.ts")], [absolute(file), absolute(other)]],
        [[owner], [absolute("test/**/*.test.ts")], [absolute("test/scripts/**/*.test.ts")]],
        [[absolute(file)], ["test/**/*.test.ts"], [absolute(file)]],
        [[absolute(owner)], [file], [absolute(file)]],
        [
          [file, other],
          [file, other],
          [file, other],
        ],
        [[file], [absolute("src/foreign.test.ts")], []],
        [[absolute(file), other], ["test/**/*.test.ts"], [absolute(file), other]],
        [[file, absolute(file)], [file], [file, absolute(file)]],
        [[file], [absolute(file), file, absolute(file)], [absolute(file), file]],
        [[owner, absolute(file)], [owner], [owner, absolute(file)]],
        [[absolute(file), owner], [owner], [absolute(file), owner]],
        [
          ["test/**/*.test.ts", absolute("test/scripts/**/*.test.ts")],
          ["test/scripts/sub/**/*.test.ts"],
          ["test/scripts/sub/**/*.test.ts", absolute("test/scripts/sub/**/*.test.ts")],
        ],
        [
          [absolute("test/scripts/**/*.test.ts"), "test/**/*.test.ts"],
          ["test/scripts/sub/**/*.test.ts"],
          [absolute("test/scripts/sub/**/*.test.ts"), "test/scripts/sub/**/*.test.ts"],
        ],
        [
          [file, absolute(other), "test/scripts/last.test.ts"],
          [owner],
          [file, absolute(other), "test/scripts/last.test.ts"],
        ],
        [[owner, absolute("src/**/*.test.ts")], [owner], [owner]],
        [
          [owner, absolute("src/**/*.test.ts")],
          ["test/scripts/upgrade-survivor-native-*.test.ts"],
          ["test/scripts/upgrade-survivor-native-*.test.ts"],
        ],
        [
          [absolute("src/**/*.test.ts"), owner],
          ["test/scripts/upgrade-survivor-native-*.test.ts"],
          ["test/scripts/upgrade-survivor-native-*.test.ts"],
        ],
        [[owner, absolute(file)], [absolute(owner)], [absolute(owner)]],
        [[file], [], []],
      ] as const) {
        expect(
          intersectIncludePatterns([...includes], [...selected], paths.matchesGlob, root),
        ).toEqual({ include: [...expected], exclude: [] });
      }
    } finally {
      vi.doUnmock("node:path");
      vi.resetModules();
    }
  },
);

it.each([32, 128, 512])("prepares literal membership once for %i include paths", (size) => {
  const files = Array.from({ length: size }, (_, index) => `test/file-${index}.test.ts`);
  const originalEvery = Array.prototype.every;
  let visits = 0;
  const every = vi.spyOn(Array.prototype, "every").mockImplementation(function (
    this: unknown[],
    predicate,
    thisArg,
  ) {
    return originalEvery.call(this, (value, index, array) => {
      visits++;
      return predicate.call(thisArg, value, index, array);
    });
  });
  let actual: string[] | null;
  try {
    actual = intersect(files, files);
  } finally {
    every.mockRestore();
  }
  expect(actual).toEqual(files);
  // Include validation visits each path segment too; it must remain linear.
  expect(visits).toBeLessThanOrEqual(size * 10);
});

it.each([
  ["ui/src/**/*.e2e.test.ts", "ui/src/e2e/*.e2e.test.ts"],
  ["ui/src/**/prefix" + cliPatterns.nonBrowserTestBasenamePattern, "ui/src/**/*.test.ts"],
  ["src/logging/**/*.test.ts", "src/@(logging|shared)/redact*.test.ts"],
  ["src/logging/**/*.test.ts", "src/+(logging|shared)/redact*.test.ts"],
])("retains the ambiguity guard for glob-owned inventory %s", (owner, requested) => {
  expect(() => intersect([owner], [requested])).toThrow(
    "cannot safely intersect non-literal include path",
  );
});

it.each(["@", "+"])("keeps a proven disjoint %s extglob empty", (operator) => {
  expect(
    intersect(["src/logging/**/*.test.ts"], [`test/${operator}(logging|shared)/redact*.test.ts`]),
  ).toEqual([]);
});
