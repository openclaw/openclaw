import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectChangedLanes } from "../../scripts/changed-lanes.mts";
import { createChangedCheckPlan, createChangedCiLintPlan } from "../../scripts/check-changed.mts";
import {
  createOxlintShards,
  selectExtensionOxlintStripe,
  selectCoreOxlintStripe,
  createOxlintPackageScope,
  filterOxlintShards,
  parseShardRunnerArgs,
  resolveChangedOxlintPackageScope,
} from "../../scripts/run-oxlint-shards.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Documentation reachability is independent of the lint commands projected here.
vi.mock("../../scripts/test-projects.test-support.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/test-projects.test-support.mts")>()),
  hasImportGraphImpactOnTargets: () => false,
}));

describe("CI changed lint", () => {
  it("includes unchanged same-package callers without adding other packages or test-root coverage", async () => {
    const cwd = tempDirs.make("ci-package-lint-");
    const write = (file: string, content: string) => {
      const target = path.join(cwd, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    };
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
    write("scripts/helper.ts", "export {};\n");
    write("test/outside-canonical-lint.ts", "export {};\n");
    const full = createOxlintShards({
      cwd,
      splitCore: true,
      splitExtensions: true,
      platform: "linux",
    });
    const packageScope = await resolveChangedOxlintPackageScope(
      ["packages/example/callee.ts", "extensions/channel/callee.ts"],
      cwd,
    );
    expect(packageScope?.packages).toEqual(["extensions/channel", "packages/example"]);
    const packageTargets =
      packageScope?.selectShards(full).flatMap(({ args }) => args.slice(2)) ?? [];
    expect(packageTargets.toSorted()).toEqual(["extensions/channel", "packages/example"]);
    const rootTargets = (await createOxlintPackageScope(["."], cwd))
      .selectShards(full)
      .flatMap(({ args }) => args.slice(2));
    expect(rootTargets.toSorted()).toEqual(["scripts", "src/callee.ts", "src/caller.ts"]);
    expect(
      await resolveChangedOxlintPackageScope(["packages/example/deleted.ts"], cwd),
    ).toBeUndefined();
    expect(
      await resolveChangedOxlintPackageScope(["packages/example/package.json"], cwd),
    ).toBeUndefined();
    for (const roots of [
      ["../outside"],
      ["packages/example", "packages/example"],
      ["packages/missing"],
    ]) {
      await expect(createOxlintPackageScope(roots, cwd)).rejects.toThrow(
        "canonical workspace roots",
      );
    }
    // One invocation carries admitted package facts through every stripe;
    // a later invocation must admit the new workspace metadata independently.
    write("pnpm-workspace.yaml", "packages: []\n");
    expect(
      packageScope
        ?.selectShards(full)
        .flatMap(({ args }) => args.slice(2))
        .toSorted(),
    ).toEqual(["extensions/channel", "packages/example"]);
    await expect(createOxlintPackageScope(["packages/example"], cwd)).rejects.toThrow(
      "canonical workspace roots",
    );
  });

  it.each(["hybrid", "github", "blacksmith"])(
    "keeps complete package lint with the existing %s owners",
    async (runnerProfile) => {
      const paths = [
        "src/utils.ts",
        "ui/src/app-navigation.ts",
        "extensions/telegram/src/send.ts",
        "scripts/lib/arg-utils.mts",
        "test/scripts/ci-changed-lint.test.ts",
      ];
      const result = detectChangedLanes(paths);
      const plan = await createChangedCiLintPlan(result, { runnerProfile });
      expect(plan).not.toBeNull();
      if (!plan) {
        throw new Error("Expected a package lint plan");
      }
      expect(plan.central.packages).toEqual([".", "extensions/telegram", "ui"]);
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
      const full = createOxlintShards({
        splitCore: true,
        splitExtensions: true,
        platform: "linux",
      });
      const packageScope = await createOxlintPackageScope(plan.central.packages);
      const expected = packageScope
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
            expect(parsed.packages).toEqual(packageScope.packages);
            const selected = packageScope.selectShards(
              selectExtensionOxlintStripe(
                selectCoreOxlintStripe(filterOxlintShards(shards, parsed.only), parsed.coreStripe),
                parsed.extensionStripe,
              ),
            );
            // Full central Programs can group src/ while hosted stripes split its
            // directories; coverage is checked through the canonical split below.
            return selected.flatMap(({ args: commandArgs }) =>
              commandArgs.slice(2).map((target) => `${commandArgs[1]}:${target}`),
            );
          });
      });
      if (runnerProfile !== "blacksmith") {
        expect(actual.toSorted()).toEqual(expected);
        expect(plan.core).toHaveLength(runnerProfile === "hybrid" ? 2 : 5);
        expect(plan.central.groups).toEqual(["scripts"]);
        expect(plan.central.extensionStripes).toEqual(runnerProfile === "github" ? [6] : []);
      } else {
        expect(plan.core).toEqual([]);
        expect(plan.extensions).toEqual([]);
        expect(actual).toContain("config/tsconfig/oxlint.core.json:src");
        expect(actual).toContain("config/tsconfig/oxlint.scripts.json:scripts");
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

  it("retains full semantic lint when lint configuration changes", () => {
    const commands = createChangedCheckPlan(detectChangedLanes([".oxlintrc.json"]), {
      lintOnly: true,
    }).commands;
    expect(commands.map(({ args }) => args)).toEqual([
      ["format:check", "--no-error-on-unmatched-pattern", "--", ".oxlintrc.json"],
      ["lint"],
    ]);
  });

  it("retains the full owning lint lane for a deleted source", () => {
    const commands = createChangedCheckPlan(
      detectChangedLanes(["extensions/telegram/deleted-ci-fixture.ts"]),
      { lintOnly: true },
    ).commands;
    expect(commands.map(({ args }) => args)).toContainEqual(["lint:extensions"]);
  });
});
