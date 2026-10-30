import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { detectChangedLanes } from "../../scripts/changed-lanes.mts";
import { createChangedCheckPlan } from "../../scripts/check-changed.mts";
import { resolveCiExtensionLintSelection } from "../../scripts/lib/ci-extension-lint-plan.mts";
import {
  createExtensionOxlintShards,
  createOxlintExtensionRootScope,
  parseShardRunnerArgs,
  selectExtensionOxlintStripe,
} from "../../scripts/run-oxlint-shards.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function workspace(files: Record<string, string> = {}) {
  const cwd = tempDirs.make("extension-lint-");
  const write = (file: string, contents: string) => {
    const target = path.join(cwd, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  for (const [file, contents] of Object.entries(files)) {
    write(file, contents);
  }
  return { cwd, write };
}

const emptySelection = {
  files: [],
  coreStripes: [],
  extensionStripes: [],
  groups: [],
  central: false,
};
const rootSelection = {
  ...emptySelection,
  extensionStripes: [1],
  extensionRoots: ["extensions/discord"],
  extensionStripeCount: 3,
} satisfies NonNullable<Parameters<typeof createChangedCheckPlan>[1]>["lintSelection"];

function selectedCommands(
  selection: NonNullable<Parameters<typeof createChangedCheckPlan>[1]>["lintSelection"],
) {
  return createChangedCheckPlan(detectChangedLanes([".oxlintrc.json"]), {
    lintOnly: true,
    lintSelection: selection,
  }).commands;
}

it("keeps package ownership in its canonical stripes", () => {
  const total = 3;
  const { cwd } = workspace({ "extensions/root.ts": "export {};\n" });
  for (let index = 0; index < 25; index++) {
    mkdirSync(path.join(cwd, "extensions", `plugin-${String(index).padStart(2, "0")}`), {
      recursive: true,
    });
  }
  const all = createExtensionOxlintShards({ cwd, platform: "linux" });
  const roots = ["extensions/plugin-00", "extensions/plugin-08", "extensions/plugin-24"];
  const scope = createOxlintExtensionRootScope(roots, cwd);
  const actual = Array.from({ length: total }, (_, index) => {
    const stripe = { index: index + 1, total };
    const canonical = selectExtensionOxlintStripe(all, stripe);
    const selected = scope.selectShards(canonical);
    for (const shard of selected) {
      const original = canonical.find((candidate) => candidate.name === shard.name)!;
      expect(shard.canonicalTargets).toEqual(original.args.slice(2));
      expect(shard.args.slice(2)).toEqual(
        original.args.slice(2).filter((root) => roots.includes(root)),
      );
    }
    return selected.flatMap((shard) => shard.args.slice(2));
  }).flat();
  expect(actual.toSorted()).toEqual(roots);
});

it("rejects paths outside exact native package roots before execution", () => {
  const { cwd } = workspace({ "extensions/not-a-package.ts": "export {};\n" });
  mkdirSync(path.join(cwd, "extensions/alpha"), { recursive: true });
  const root = (name: string) => path.join(cwd, "extensions", name);
  symlinkSync(root("alpha"), root("linked"), "junction");
  for (const roots of [
    [],
    ["extensions/alpha", "extensions/alpha"],
    ["extensions/ALPHA"],
    ["extensions/alpha/"],
    ["extensions/../alpha"],
    ["extensions/missing"],
    ["extensions/not-a-package.ts"],
    ["extensions/linked"],
  ]) {
    expect(() => createOxlintExtensionRootScope(roots, cwd)).toThrow("canonical package roots");
  }
  const rootsArg = ["--extension-roots-json", '["extensions/alpha"]'];
  expect(() => parseShardRunnerArgs(["--only=core", ...rootsArg])).toThrow("--only=extensions");
  expect(() =>
    parseShardRunnerArgs([
      "--only=extensions",
      ...rootsArg,
      "--files-json",
      '["extensions/alpha/a.ts"]',
    ]),
  ).toThrow("without --files-json");
});

it("transports roots with empty files and keeps mixed core files separate", () => {
  const commands = selectedCommands({
    ...rootSelection,
    files: ["src/changed.ts", "extensions/discord/old-file-selection.ts"],
    coreStripes: [2],
  });
  expect(commands).toHaveLength(2);
  const core = commands.find(({ name }) => name === "lint core file stripe 2")!;
  expect(core.args).toContain("--core-stripe=2/5");
  expect(core.args.at(-1)).toBe('["src/changed.ts"]');
  const extension = commands.find(({ name }) => name === "lint extension package stripe 1")!;
  const parsed = parseShardRunnerArgs(extension.args.slice(3));
  expect([parsed.extensionRoots, parsed.extensionStripe]).toEqual([
    ["extensions/discord"],
    { index: 1, total: 3 },
  ]);
  expect(extension.args).not.toContain("--files-json");
  expect(selectedCommands(rootSelection)).toHaveLength(1);
  expect(
    selectedCommands({ ...rootSelection, files: ["src/changed.ts"], groups: ["extensions"] }),
  ).toHaveLength(1);
  expect(selectedCommands(emptySelection)).toEqual([]);
});

it("keeps full owner invocations unscoped beside selected packages", () => {
  const full = [
    ...selectedCommands({ ...rootSelection, fullCoreStripes: [2], fullGroups: ["scripts"] }).filter(
      ({ name }) => name.startsWith("lint full"),
    ),
    ...selectedCommands({ ...emptySelection, fullExtensionStripes: [1], extensionStripeCount: 1 }),
  ];
  expect(full).toHaveLength(3);
  for (const { args } of full) {
    expect(args).not.toContain("--files-json");
    expect(args).not.toContain("--extension-roots-json");
  }
});

it("retains native imported and ambient types while reporting only the selected package", () => {
  const { cwd } = workspace({
    "package.json": '{"type":"module"}',
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, module: "nodenext", target: "es2022", types: [] },
      include: ["extensions/**/*"],
    }),
    "extensions/tsconfig.json": '{"extends":"../tsconfig.json","include":["**/*"]}',
    ".oxlintrc.json": JSON.stringify({
      plugins: ["typescript"],
      rules: { "typescript/no-floating-promises": "error" },
    }),
    "extensions/provider/api.ts":
      "export function work(): Promise<void> { return Promise.resolve(); }\n",
    "extensions/unrelated/globals.d.ts": "declare function ambientWork(): Promise<void>;\n",
    "extensions/unrelated/unreported.ts": "Promise.resolve();\n",
    "extensions/selected/consumer.ts":
      'import { work } from "../provider/api.js"; work(); ambientWork();\n',
  });
  const scope = createOxlintExtensionRootScope(["extensions/selected"], cwd);
  const [shard] = scope.selectShards(createExtensionOxlintShards({ cwd, platform: "linux" }));
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("node_modules/oxlint/bin/oxlint"),
      "--config",
      ".oxlintrc.json",
      "--type-aware",
      "--format=json",
      "--threads=1",
      ...shard!.args,
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        GOMAXPROCS: "2",
        OXLINT_TSGOLINT_PATH: path.resolve(
          "node_modules/.bin",
          process.platform === "win32" ? "tsgolint.CMD" : "tsgolint",
        ),
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(1);
  const report = JSON.parse(result.stdout) as {
    number_of_files: number;
    diagnostics: Array<{ filename: string; code: string }>;
  };
  expect(report.number_of_files).toBe(1);
  const diagnostic = ["extensions/selected/consumer.ts", "typescript(no-floating-promises)"];
  expect(
    report.diagnostics.map(({ filename, code }) => [filename.replaceAll("\\", "/"), code]),
  ).toEqual([diagnostic, diagnostic]);
});

function selectionWorkspace() {
  const { cwd, write: writeFile } = workspace();
  const flags = [
    "core.hooksPath=/dev/null",
    "commit.gpgSign=false",
    "user.name=Fixture",
    "user.email=fixture@example.invalid",
  ].flatMap((value) => ["-c", value]);
  const git = (args: string[]) =>
    execFileSync("git", [...flags, ...args], { cwd, encoding: "utf8" });
  const write = (file: string, content: string) => {
    writeFile(file, content);
    git(["add", "--", file]);
  };
  git(["init", "--quiet"]);
  write("scripts/lib/plugin-sdk-entrypoints.json", '["api", "public"]');
  write("scripts/lib/plugin-sdk-private-local-only-subpaths.json", "[]");
  for (const id of ["alpha", "beta", "unrelated", "telegram", "codex", "slack"]) {
    write(`extensions/${id}/package.json`, '{"private":true}');
  }
  write(
    "extensions/alpha/index.ts",
    'import type { Result } from "openclaw/plugin-sdk/public"; export type Response = Result;\n',
  );
  write(
    "extensions/beta/index.ts",
    'import type { Response } from "../alpha/index.js"; export type Reply = Response;\n',
  );
  git(["commit", "--quiet", "--allow-empty", "-m", "fixture base"]);
  return { cwd, write, baseRef: git(["rev-parse", "HEAD"]).trim() };
}

const smokeRoots = ["extensions/codex", "extensions/slack", "extensions/telegram"];
const alpha = "extensions/alpha";
const unrelated = "extensions/unrelated";
const selectedCases: [string[], string[]][] = [
  [["ui/src/leaf.ts", `${unrelated}/README.md`], []],
  [["src/leaf.ts", `${unrelated}/README.md`], smokeRoots],
  [[`${alpha}/index.ts`, `${unrelated}/README.md`], [alpha]],
  [[`${alpha}/test/fixtures/README.md`], [alpha]],
  [[`${alpha}/prompts/runtime.md`], [alpha]],
  [["scripts/lib/settings.mts"], smokeRoots],
];
const fullCases: [string, { forceFull?: boolean; baseRef?: string }?, string?][] = [
  ["pnpm-lock.yaml"],
  ["extensions/shared.ts", {}, "direct shared extension source: extensions/shared.ts"],
  ["docs/example.md", { forceFull: true }, "OPENCLAW_CI_EXTENSION_LINT_FULL"],
  [
    "src/plugin-sdk/public.ts",
    { baseRef: "a".repeat(40) },
    "direct public-entry inventory unavailable",
  ],
];

it("rejects invalid paths before excluding documentation", async () => {
  const { cwd } = selectionWorkspace();
  await expect(resolveCiExtensionLintSelection(["../docs/README.md"], cwd)).rejects.toThrow(
    "Invalid changed extension lint path",
  );
});

it.each(selectedCases)("selects direct owners and smoke consumers of %j", async (files, roots) => {
  const { cwd } = selectionWorkspace();
  expect(await resolveCiExtensionLintSelection(files, cwd)).toMatchObject({
    mode: "selected",
    extensionRoots: roots,
    fullReasons: [],
    ...(roots.length ? {} : { reasons: {} }),
  });
});

it("includes direct SDK importers in production and test sources, not transitive consumers", async () => {
  const { cwd, write, baseRef } = selectionWorkspace();
  write(`${unrelated}/api.test.ts`, 'import type { Result } from "openclaw/plugin-sdk/api";\n');
  expect(
    await resolveCiExtensionLintSelection(
      ["src/plugin-sdk/public.ts", "src/plugin-sdk/api.ts"],
      cwd,
      { baseRef },
    ),
  ).toMatchObject({
    mode: "selected",
    extensionRoots: [alpha, ...smokeRoots, unrelated],
    fullReasons: [],
    reasons: {
      [alpha]: [
        `direct import of changed public entry openclaw/plugin-sdk/public: ${alpha}/index.ts`,
      ],
      [unrelated]: [
        `direct import of changed public entry openclaw/plugin-sdk/api: ${unrelated}/api.test.ts`,
      ],
    },
  });
});

it.each(fullCases)("retains full lint for %s", async (file, options, reason) => {
  const { cwd } = selectionWorkspace();
  const selection = await resolveCiExtensionLintSelection([file], cwd, options);
  expect(selection).toMatchObject({ mode: "full", fullReasons: [reason ?? expect.any(String)] });
  if (file === "extensions/shared.ts") {
    expect(selection.extensionRoots).toEqual([]);
  }
});
