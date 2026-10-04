import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectChangedLanes } from "../../scripts/changed-lanes.mts";
import {
  createChangedCheckPlan,
  createChangedCiLintPlan,
  resolveChangedOxlintFileScope,
} from "../../scripts/check-changed.mts";
import {
  createOxlintShards,
  selectExtensionOxlintStripe,
  selectCoreOxlintStripe,
  createOxlintFileScope,
  filterOxlintShards,
  parseShardRunnerArgs,
} from "../../scripts/run-oxlint-shards.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(prefix: string) {
  const cwd = tempDirs.make(prefix);
  const write = (file: string, source: string) => {
    const target = path.join(cwd, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
  };
  return { cwd, write };
}

vi.mock("../../scripts/test-projects.test-support.mts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../scripts/test-projects.test-support.mts")>();
  return {
    ...original,
    // Repository cases prove stripe placement; synthetic workspaces prove real reachability.
    resolveImportGraphDependents: (
      ...args: Parameters<typeof original.resolveImportGraphDependents>
    ) =>
      (args[1] ?? process.cwd()) === process.cwd()
        ? []
        : original.resolveImportGraphDependents(...args),
    hasImportGraphImpactOnTargets: () => false,
  };
});

describe("CI changed lint", () => {
  it("includes transitive and aliased type consumers without widening to their packages", async () => {
    const { cwd, write } = fixture("ci-file-lint-");
    write("pnpm-workspace.yaml", "packages:\n  - .\n  - ui\n  - packages/*\n  - extensions/*\n");
    for (const root of [
      ".",
      "ui",
      "packages/example",
      "packages/unrelated",
      "extensions/channel",
      "extensions/unrelated",
    ]) {
      write(`${root}/package.json`, '{"private":true}');
      write(`${root === "." ? "src" : root}/callee.ts`, "export function work(): void {}\n");
      write(
        `${root === "." ? "src" : root}/caller.ts`,
        'import { work } from "./callee.js"; work();\n',
      );
    }
    write("packages/example/callee.js", "export function work() { return 1; }\n");
    write("scripts/helper.ts", "export {};\n");
    write(
      "test/outside-canonical-lint.ts",
      'import type { Work } from "../src/type-consumer.js"; export type RootWork = Work;\n',
    );
    write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { paths: { "@fixture/callee": ["./packages/example/callee.ts"] } },
      }),
    );
    write(
      "src/type-consumer.ts",
      'import type { work } from "@fixture/callee"; export type Work = typeof work;\n',
    );
    write(
      "ui/transitive.ts",
      'import type { Work } from "../src/type-consumer.js"; export type Invoke = Work;\n',
    );
    const full = createOxlintShards({
      cwd,
      splitCore: true,
      splitExtensions: true,
      platform: "linux",
    });
    const fileScope = await resolveChangedOxlintFileScope(
      ["packages/example/callee.ts", "extensions/channel/callee.ts"],
      cwd,
    );
    const expected = [
      "extensions/channel/callee.ts",
      "extensions/channel/caller.ts",
      "packages/example/callee.ts",
      "packages/example/caller.ts",
      "src/type-consumer.ts",
      "ui/transitive.ts",
    ];
    expect(fileScope?.files).toEqual(expected);
    expect(fileScope?.rootTestFiles).toEqual(["test/outside-canonical-lint.ts"]);
    const fileTargets = fileScope?.selectShards(full).flatMap(({ args }) => args.slice(2)) ?? [];
    expect(fileTargets.toSorted()).toEqual(expected);
    const rootTargets = createOxlintFileScope(["scripts/helper.ts", "src/callee.ts"], cwd)
      .selectShards(full)
      .flatMap(({ args }) => args.slice(2));
    expect(rootTargets.toSorted()).toEqual(["scripts/helper.ts", "src/callee.ts"]);
    write("src/globals.ts", "export {}; declare /* contract */ global { interface Window {} }\n");
    expect(await resolveChangedOxlintFileScope(["src/globals.ts"], cwd)).toBeUndefined();
    expect(
      await resolveChangedOxlintFileScope(["packages/example/deleted.ts"], cwd),
    ).toBeUndefined();
    expect(
      await resolveChangedOxlintFileScope(["packages/example/package.json"], cwd),
    ).toBeUndefined();
    for (const files of [
      ["../outside.ts"],
      ["packages/example/callee.ts", "packages/example/callee.ts"],
      ["packages/missing.ts"],
      ["test/outside-canonical-lint.ts"],
    ]) {
      expect(() => createOxlintFileScope(files, cwd)).toThrow("canonical source paths");
    }
    // Existing selections carry admitted facts; a later worker must reject a missing source.
    unlinkSync(path.join(cwd, "packages/example/callee.ts"));
    expect(
      fileScope
        ?.selectShards(full)
        .flatMap(({ args }) => args.slice(2))
        .toSorted(),
    ).toEqual(expected);
    expect(() => createOxlintFileScope(["packages/example/callee.ts"], cwd)).toThrow(
      "canonical source paths",
    );
  });

  it.each([
    [
      "globals.ts",
      'import type { Work } from "./value.js"; declare global { interface Window { work: Work; } }',
    ],
    ["globals.d.ts", 'interface Window { work: import("./value.js").Work; }'],
  ])(
    "retains full lint when an affected consumer augments globals through %s",
    async (file, source) => {
      const { cwd, write } = fixture("ci-ambient-consumer-");
      write("package.json", '{"type":"module"}');
      write("src/value.ts", "export type Work = () => Promise<void>;\n");
      write(`src/${file}`, source);
      write("src/reader.ts", "window.work();\n");
      expect(await resolveChangedOxlintFileScope(["src/value.ts"], cwd)).toBeUndefined();
    },
  );

  it("runs native rules on a changed file and unchanged consumers of its changed type", () => {
    const { cwd, write } = fixture("ci-file-lint-native-");
    write("package.json", '{"private":true,"type":"module"}');
    write("pnpm-workspace.yaml", "packages: [.]\n");
    write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "nodenext",
          target: "es2022",
          types: [],
          paths: { "@fixture/work": ["./src/barrel.ts"] },
        },
        include: ["src/**/*.ts"],
      }),
    );
    mkdirSync(path.join(cwd, "config/tsconfig"), { recursive: true });
    copyFileSync(".oxlintrc.json", path.join(cwd, ".oxlintrc.json"));
    copyFileSync(
      "config/tsconfig/oxlint.core.json",
      path.join(cwd, "config/tsconfig/oxlint.core.json"),
    );
    symlinkSync(path.resolve("node_modules"), path.join(cwd, "node_modules"), "junction");
    mkdirSync(path.join(cwd, "scripts"));
    symlinkSync(path.resolve("scripts/lib"), path.join(cwd, "scripts/lib"), "junction");
    for (const file of [
      "run-oxlint.mjs",
      "run-oxlint.mts",
      "run-oxlint-shards.mts",
      "generate-kysely-types.mts",
      "tsx.mjs",
      "windows-cmd-helpers.mjs",
    ]) {
      copyFileSync(path.join("scripts", file), path.join(cwd, "scripts", file));
    }
    write("src/contract.ts", "export type Work = () => number;\n");
    write("src/contract.js", "export const compiled = true;\n");
    write("src/barrel.ts", 'export type { Work } from "./contract.js";\n');
    write(
      "src/caller.ts",
      'import type { Work } from "@fixture/work"; export function invoke(work: Work): void { work(); }\n',
    );
    write("src/changed.ts", "export const changed = 1;\n");
    mkdirSync(path.join(cwd, "ui"));
    mkdirSync(path.join(cwd, "packages"));
    // This preexisting violation belongs to the full lane, outside the changed dependency graph.
    write("src/unrelated.ts", "Promise.resolve(1);\n");
    const sourceUrl = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
    const driver = `
      import { spawnSync } from "node:child_process";
      import { detectChangedLanes } from ${sourceUrl("scripts/changed-lanes.mts")};
      import { createChangedCiLintPlan, createChangedCheckPlan } from ${sourceUrl("scripts/check-changed.mts")};
      const changed = detectChangedLanes(["src/contract.ts", "src/changed.ts"]);
      const plan = await createChangedCiLintPlan(changed, { runnerProfile: "blacksmith" });
      if (!plan) throw new Error("Expected a changed-file lint plan");
      const selections = [plan.central, ...[...plan.core, ...plan.extensions].map(row => JSON.parse(row.lint_selection_json))];
      console.error("CI_LINT_SELECTED_FILES=" + JSON.stringify(selections.flatMap(selection => selection.files).sort()));
      const commands = selections.flatMap(lintSelection =>
        createChangedCheckPlan(changed, { lintOnly: true, lintSelection, lintThreads: 1 }).commands
      ).filter(command => command.args[2] === "scripts/run-oxlint-shards.mts");
      if (commands.length === 0) throw new Error("PR planner omitted semantic lint");
      for (const command of commands) {
        const result = spawnSync(process.execPath, [...command.args, "--format", "json"], {
          encoding: "utf8", env: { ...process.env, ...command.env }
        });
        if (result.error) throw result.error;
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        if (result.status !== 0) process.exitCode = result.status ?? 1;
      }
    `;
    const lintChanged = () => {
      const result = spawnSync(
        process.execPath,
        ["--import", path.resolve("scripts/tsx.mjs"), "--input-type=module", "--eval", driver],
        { cwd, encoding: "utf8", env: { ...process.env, OPENCLAW_LOCAL_CHECK: "0" } },
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toContain(
        `CI_LINT_SELECTED_FILES=${JSON.stringify(["src/barrel.ts", "src/caller.ts", "src/changed.ts", "src/contract.ts"])}`,
      );
      return result;
    };
    const full = createOxlintShards({
      cwd,
      platform: "linux",
      hostResources: { logicalCpuCount: 16, totalMemoryBytes: 32 * 1024 ** 3 },
    });
    const lint = (args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [path.resolve("scripts/run-oxlint.mjs"), ...args, "--format", "json", "--threads=1"],
        { cwd, encoding: "utf8", env: { ...process.env, OPENCLAW_LOCAL_CHECK: "0" } },
      );
      expect(result.error).toBeUndefined();
      return result;
    };
    const before = lintChanged();
    expect(before.status, before.stderr + before.stdout).toBe(0);
    write("src/contract.ts", "export type Work = () => Promise<number>;\n");
    write("src/changed.ts", "export function changed(): void { Promise.resolve(1); }\n");
    const after = lintChanged();
    expect(after.status, after.stderr + after.stdout).toBe(1);
    const diagnosticFiles = (output: string) => {
      const report = JSON.parse(output) as {
        diagnostics: Array<{ filename: string; code: string }>;
      };
      expect(
        report.diagnostics.every(({ code }) => code === "typescript(no-floating-promises)"),
      ).toBe(true);
      return report.diagnostics.map(({ filename }) => filename.replaceAll("\\", "/")).toSorted();
    };
    expect(diagnosticFiles(after.stdout)).toEqual(["src/caller.ts", "src/changed.ts"]);
    const complete = lint(full.find(({ name }) => name === "core")!.args);
    expect(complete.status, complete.stderr + complete.stdout).toBe(1);
    expect(diagnosticFiles(complete.stdout)).toEqual([
      "src/caller.ts",
      "src/changed.ts",
      "src/unrelated.ts",
    ]);
  });

  it.each(["hybrid", "github", "blacksmith"])(
    "keeps complete selected-file lint with the existing %s owners",
    async (runnerProfile) => {
      const paths = [
        "src/utils.ts",
        "ui/src/app-navigation.ts",
        "extensions/telegram/src/send.ts",
        "scripts/lib/arg-utils.mts",
        "test/scripts/ci-check-plan.test.ts",
      ];
      const result = detectChangedLanes(paths);
      const plan = await createChangedCiLintPlan(result, { runnerProfile });
      expect(plan).not.toBeNull();
      if (!plan) {
        throw new Error("Expected a file lint plan");
      }
      const central = createChangedCheckPlan(result, {
        lintOnly: true,
        lintSelection: plan.central,
        lintThreads: runnerProfile === "blacksmith" ? 8 : 1,
      }).commands;
      expect(central.find(({ args }) => args[0] === "format:check")?.args).toEqual([
        "format:check",
        "--no-error-on-unmatched-pattern",
        "--",
        ...paths.toSorted(),
      ]);
      expect(central.some(({ args }) => args[0] === "lint:ui:i18n")).toBe(true);
      expect(
        central.some(
          ({ args }) =>
            args[0] === "scripts/run-oxlint.mjs" &&
            args.includes("test/tsconfig/tsconfig.test.root.json"),
        ),
      ).toBe(true);
      expect(
        central.find(
          ({ args }) =>
            args[0] === "scripts/run-oxlint.mjs" &&
            args.includes("test/tsconfig/tsconfig.test.root.json"),
        )?.args,
      ).toContain(`--threads=${runnerProfile === "blacksmith" ? 8 : 1}`);
      const selections = [
        plan.central,
        ...[...plan.core, ...plan.extensions].map(
          (row) => JSON.parse(row.lint_selection_json) as typeof plan.central,
        ),
      ];
      const selectedFiles = selections.flatMap(({ files }) => files).toSorted();
      expect(selectedFiles).toEqual(paths.filter((file) => !file.startsWith("test/")).toSorted());
      const full = createOxlintShards({
        splitCore: true,
        splitExtensions: true,
        platform: "linux",
      });
      const fileScope = createOxlintFileScope(selectedFiles);
      const expected = fileScope
        .selectShards(full)
        .flatMap(({ args }) => args.slice(2).map((target) => `${args[1]}:${target}`))
        .toSorted();
      const actual = selections.flatMap((selection) => {
        const commands = createChangedCheckPlan(result, {
          lintOnly: true,
          lintSelection: selection,
          lintThreads: 1,
        }).commands;
        return commands
          .filter(({ args }) => args[2] === "scripts/run-oxlint-shards.mts")
          .flatMap(({ args }) => {
            const parsed = parseShardRunnerArgs(args.slice(3));
            const shards = createOxlintShards({
              splitCore: parsed.splitCore,
              splitExtensions: parsed.extensionStripe !== undefined,
              platform: "linux",
              hostResources: { logicalCpuCount: 16, totalMemoryBytes: 32 * 1024 ** 3 },
            });
            expect(parsed.files).toEqual(selection.files);
            const selected = createOxlintFileScope(selection.files).selectShards(
              selectExtensionOxlintStripe(
                selectCoreOxlintStripe(filterOxlintShards(shards, parsed.only), parsed.coreStripe),
                parsed.extensionStripe,
              ),
            );
            return selected.flatMap(({ args: commandArgs }) =>
              commandArgs.slice(2).map((target) => `${commandArgs[1]}:${target}`),
            );
          });
      });
      expect(actual.toSorted()).toEqual(expected);
      if (runnerProfile !== "blacksmith") {
        expect(plan.core.length).toBeGreaterThan(0);
        expect(plan.core.length).toBeLessThanOrEqual(runnerProfile === "hybrid" ? 2 : 5);
        expect(plan.central.groups).toEqual(["scripts"]);
        if (runnerProfile === "github") {
          expect(plan.central.extensionStripes.every((stripe) => stripe === 6)).toBe(true);
          expect(plan.central.extensionStripes.length).toBeLessThanOrEqual(1);
        } else {
          expect(plan.central.extensionStripes).toEqual([]);
        }
      } else {
        expect(plan.core).toEqual([]);
        expect(plan.extensions).toEqual([]);
        expect(actual).toContain("config/tsconfig/oxlint.core.json:src/utils.ts");
        expect(actual).toContain("config/tsconfig/oxlint.scripts.json:scripts/lib/arg-utils.mts");
        expect(plan.central.groups).toEqual(["core", "extensions", "scripts"]);
      }
      for (const row of [...plan.core, ...plan.extensions]) {
        const selection = JSON.parse(row.lint_selection_json) as typeof plan.central;
        expect(selection.central).toBe(false);
        expect(
          createChangedCheckPlan(result, {
            lintOnly: true,
            lintSelection: selection,
          }).commands.every(
            ({ args }) =>
              args[2] === "scripts/run-oxlint-shards.mts" && args.includes("--threads=1"),
          ),
        ).toBe(true);
      }
    },
  );

  it.each([
    ".oxlintrc.json",
    "package.json",
    "tsconfig.json",
    "src/types/node-runtime-globals.d.ts",
    "extensions/telegram/deleted-ci-fixture.ts",
    "unowned/source.ts",
  ])("retains the original full lint layout for %s", async (file) =>
    expect(
      await createChangedCiLintPlan(detectChangedLanes([file]), {
        runnerProfile: "hybrid",
      }),
    ).toBeNull(),
  );

  it("uses the owning compiler configs for changed files without unrelated lint or type checks", () => {
    const paths = [
      "src/utils.ts",
      "extensions/telegram/src/send.ts",
      "scripts/lib/ci-check-family-scope.mts",
    ];
    const commands = createChangedCheckPlan(detectChangedLanes(paths), { lintOnly: true }).commands;
    expect(commands[0]?.args).toEqual([
      "format:check",
      "--no-error-on-unmatched-pattern",
      "--",
      ...paths.toSorted(),
    ]);
    const semantic = commands.filter(
      ({ bin, args }) => bin === "node" && args[0] === "scripts/run-oxlint.mjs",
    );
    expect(semantic.map(({ args }) => args)).toEqual([
      ["scripts/run-oxlint.mjs", "--tsconfig", "config/tsconfig/oxlint.core.json", "src/utils.ts"],
      [
        "scripts/run-oxlint.mjs",
        "--tsconfig",
        "extensions/tsconfig.json",
        "extensions/telegram/src/send.ts",
      ],
      [
        "scripts/run-oxlint.mjs",
        "--tsconfig",
        "config/tsconfig/oxlint.scripts.json",
        "scripts/lib/ci-check-family-scope.mts",
      ],
    ]);
    expect(commands.some(({ args }) => args.some((arg) => arg.startsWith("tsgo:")))).toBe(false);
    expect(
      commands.some(({ args }) =>
        ["lint", "lint:core", "lint:extensions", "lint:scripts"].includes(args[0]!),
      ),
    ).toBe(false);
    const localCommands = createChangedCheckPlan(detectChangedLanes(paths)).commands;
    for (const guard of ["lint:docker-e2e", "lint:tmp:no-raw-http2-imports"]) {
      expect(localCommands.some(({ args }) => args[0] === guard)).toBe(true);
      expect(commands.some(({ args }) => args[0] === guard)).toBe(false);
    }
  });

  it.each([
    {
      file: ".oxlintrc.json",
      expected: [
        ["format:check", "--no-error-on-unmatched-pattern", "--", ".oxlintrc.json"],
        ["lint"],
      ],
      exact: true,
    },
    {
      file: "extensions/telegram/deleted-ci-fixture.ts",
      expected: [["lint:extensions"]],
      exact: false,
    },
  ])("retains the full owning lint lane for $file", ({ file, expected, exact }) => {
    const commands = createChangedCheckPlan(detectChangedLanes([file]), {
      lintOnly: true,
    }).commands.map(({ args }) => args);
    expect(commands).toEqual(exact ? expected : expect.arrayContaining(expected));
  });
});
