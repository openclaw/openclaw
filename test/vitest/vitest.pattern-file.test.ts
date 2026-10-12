import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { globSync } from "tinyglobby";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  filterFilesByPatterns,
  intersectIncludePatterns,
  nonBrowserTestBasenamePattern,
} from "./vitest.include-patterns.ts";
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { file: "ui/src/pages/devices/capability-chips.test.ts", selected: true },
    { file: "ui/src/pages/devices/capability.browser-import.test.ts", selected: true },
    { file: "ui/src/pages/devices.browser/capability.test.ts", selected: true },
    { file: "ui/src/pages/devices/capability.browser-helper.browser.test.ts", selected: false },
    { file: "ui/src/pages/devices/capability-chips.browser.test.ts", selected: false },
  ])("preserves UI extglob ownership for $file", ({ file, selected }) => {
    const include = ["ui/src/**/" + nonBrowserTestBasenamePattern];
    const expected = selected ? [file] : [];
    expect(narrowIncludePatternsForCli(include, ["node", "vitest", "run", file])).toEqual(expected);
    expect(intersectIncludePatterns(include, [file], matchesVitestGlob)).toEqual(expected);
    expect(matchesVitestCliSelection(file, include, ["run", file], "", {})).toBe(selected);
    expect(
      narrowIncludePatternsForCli(include, ["node", "vitest", "run", path.resolve(file)]),
    ).toEqual(selected ? [path.resolve(file).replaceAll("\\", "/")] : []);
  });

  it("keeps non-test paths outside UI discovery when CLI narrowing is unavailable", () => {
    const file = "ui/src/pages/devices/capability.ts";
    const absoluteFile = path.resolve(file);
    const include = ["ui/src/**/" + nonBrowserTestBasenamePattern];
    expect(narrowIncludePatternsForCli(include, ["node", "vitest", "run", file])).toEqual([]);
    expect(
      narrowIncludePatternsForCli(include, ["node", "vitest", "run", absoluteFile]),
    ).toBeNull();
    expect(intersectIncludePatterns(include, [file], matchesVitestGlob)).toEqual([]);
    for (const target of [file, absoluteFile]) {
      expect(matchesVitestCliSelection(file, include, ["run", target], "", {})).toBe(false);
    }
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
    { args: ["--config-loader", "runner"], selected: true },
    { args: ["-no-isolate", "true"], selected: false },
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
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each([
    { owner: ["ts"], candidate: "tsx", expected: [] },
    { owner: ["tsx"], candidate: "ts", expected: [] },
    { owner: ["ts"], candidate: "{ts,tsx}", expected: ["ui/src/components/view.test.ts"] },
    { owner: ["{ts,tsx}"], candidate: "tsx", expected: ["ui/src/components/view.test.tsx"] },
    {
      owner: ["ts", "tsx"],
      candidate: "{ts,tsx}",
      expected: ["ui/src/components/view.test.ts", "ui/src/components/view.test.tsx"],
    },
  ])(
    "preserves extension constraints for non-recursive $candidate globs in $owner",
    ({ owner, candidate, expected }) => {
      const selected = intersectIncludePatterns(
        owner.map((extension) => `ui/src/**/*.test.${extension}`),
        [`ui/src/components/*.test.${candidate}`],
        matchesVitestGlob,
      );
      expect(
        filterFilesByPatterns(
          [
            "ui/src/components/view.test.ts",
            "ui/src/components/view.test.tsx",
            "ui/src/elsewhere/view.test.ts",
            "ui/src/elsewhere/view.test.tsx",
          ],
          selected!,
          [],
          matchesVitestGlob,
        ),
      ).toEqual(expected);
    },
  );

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
      "ui/src/only.browser.test.ts",
      "ui/src/only.browser.test.tsx",
      "ui/src/helper.browser-helper.browser.test.ts",
      "ui/src/helper.browser-helper.browser.test.tsx",
      "ui/src/readme.ts",
      "extensions/example/browser/only.browser.test.ts",
      "extensions/example/browser/only.browser.test.tsx",
      "other/example.test.ts",
    ];
    for (const file of files) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "");
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
      const selected = intersectIncludePatterns(owner, requested, matchesVitestGlob);
      expect(filterFilesByPatterns(files, selected!, [], matchesVitestGlob).toSorted()).toEqual(
        expected.toSorted(),
      );
      expect(
        globSync(selected!, { cwd: root, dot: true, expandDirectories: false })
          .map((file) => file.replaceAll("\\", "/"))
          .toSorted(),
      ).toEqual(expected.toSorted());
    }
    const narrowed = narrowIncludePatternsForCli(owner, ["node", "vitest", "run", "ui/src"]);
    expect(filterFilesByPatterns(files, narrowed!, [], matchesVitestGlob).toSorted()).toEqual(
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
      intersectIncludePatterns(
        owner,
        ["ui/src/e2e/chat*.e2e.test.ts", "ui/src/e2e/chat.e2e.test.ts"],
        matchesVitestGlob,
      ),
    ).toEqual(["ui/src/e2e/chat.e2e.test.ts", "ui/src/e2e/chat.capture.e2e.test.ts"]);
  });

  it.each([
    ["ui/src/**/*.e2e.test.ts", "ui/src/e2e/*.e2e.test.ts"],
    ["ui/src/**/!(*.browser.test.ts)", "ui/src/**/*.test.ts"],
    ["ui/src/**/prefix" + nonBrowserTestBasenamePattern, "ui/src/**/*.test.ts"],
  ])("retains the ambiguity guard for glob-owned inventory %s", (owner, requested) => {
    expect(() => intersectIncludePatterns([owner], [requested], matchesVitestGlob)).toThrow(
      "cannot safely intersect non-literal include path",
    );
  });
});
