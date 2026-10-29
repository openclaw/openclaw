import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import type { OxlintConfig } from "oxlint";
import { describe, expect, it } from "vitest";
import { resolveRepoToolBinPath } from "../../scripts/lib/local-check-runtime.mts";
import { createChangedOxlintEnv } from "../../scripts/lib/oxlint-changed-scope.mts";
import { copyOxlintConfigFixture, createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function runTool(
  root: string,
  args: string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {},
) {
  return spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", ...options });
}

function writeFixture(root: string, file: string, content: string) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function linkDependencies(root: string) {
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
}

function git(root: string, args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout.trim();
}

function makeFixture(name: string, config?: unknown, copyConfig = !config) {
  const root = fs.realpathSync(createTempDir(`openclaw-oxlint-${name}-`));
  const write = (file: string, content: string) => writeFixture(root, file, content);
  const copy = (file: string) => write(file, fs.readFileSync(file, "utf8"));
  const json = (file: string, value: unknown) => write(file, JSON.stringify(value));
  if (copyConfig) {
    copyOxlintConfigFixture(root);
  }
  if (config) {
    fs.mkdirSync(path.join(root, ".git"));
    json(".oxlintrc.json", config);
  }
  return { root, write, copy, json };
}

type LintReport = {
  number_of_files: number;
  diagnostics: Array<{
    filename: string;
    code: string;
    severity: string;
    help?: string;
    labels: Array<{ span: { line: number } }>;
  }>;
};

function checked(result: ReturnType<typeof runTool>, status: number) {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(status);
  return result.stdout;
}

const parseReport = (output: string): LintReport => JSON.parse(output);
const normalized = (value: string) => value.replaceAll("\\", "/");
const byFile = (report: LintReport, file: string) =>
  report.diagnostics.filter((item) => normalized(item.filename) === file);
const tsgolint = resolveRepoToolBinPath(process.platform === "win32" ? "tsgolint.CMD" : "tsgolint");

function runLint(
  root: string,
  files: string[],
  env: NodeJS.ProcessEnv = {},
  args: string[] = [],
  timeout = 10_000,
) {
  return runTool(root, [oxlintBin, "--threads=1", "--format=json", ...args, ...files], {
    timeout,
    env: { ...process.env, OXLINT_TSGOLINT_PATH: tsgolint, ...env },
  });
}

function runFocused(root: string, files: string[], env: NodeJS.ProcessEnv) {
  return runTool(
    root,
    [oxlintRunner, "--openclaw-focused-config", "--threads=1", "--format=json", ...files],
    {
      env: { ...process.env, ...env },
    },
  );
}

const oxlintBin = path.resolve("node_modules/oxlint/bin/oxlint");
const oxlintRunner = path.resolve("scripts/run-oxlint.mts");

const sourceProjectOwners = [
  "agents",
  "gateway",
  "infra",
  "commands",
  "plugins",
  "config",
  "cli",
  "auto-reply",
];
const sourceAugmentations = [
  "src/agents/sessions/keybindings.ts",
  "src/cli/program/openclaw-command.ts",
  "src/agents/bash-tools.exec.resolve-env-hook.test.ts",
  "src/plugin-sdk/channel-inbound.test.ts",
  "src/infra/host-env-security-policy.d.ts",
];

function writeSourceProjectFixture(root: string) {
  for (const file of [
    "config/tsconfig/oxlint.source.json",
    ...sourceProjectOwners.map((owner) => `src/${owner}/tsconfig.json`),
  ]) {
    writeFixture(root, file, fs.readFileSync(file, "utf8"));
  }
  writeSessionCompatibilityFixture(root);
  for (const file of sourceAugmentations) {
    writeFixture(root, file, "export {};\n");
  }
}

type OxlintTsconfig = {
  compilerOptions?: {
    allowJs?: boolean;
  };
  include?: string[];
  exclude?: string[];
};

function readJson(filePath: string): unknown {
  return JSON5.parse(fs.readFileSync(filePath, "utf8"));
}

function writeSessionCompatibilityFixture(root: string) {
  // Keep the real augmentation but avoid importing the whole session graph.
  const compatibility = "src/config/sessions/session-entry.test-compat.d.ts";
  writeFixture(root, compatibility, fs.readFileSync(compatibility, "utf8"));
  for (const [file, interfaces] of Object.entries({
    "types.ts": ["SessionEntry", "InternalSessionEntry"],
    "session-accessor.types.ts": [
      "SessionTranscriptRuntimeTarget",
      "SessionTranscriptTurnPersistResult",
      "SessionTranscriptReadTarget",
    ],
  })) {
    writeFixture(
      root,
      `src/config/sessions/${file}`,
      interfaces.map((name) => "export interface " + name + " { id: string; }").join("\n"),
    );
  }
}

describe("oxlint config", () => {
  it("enforces namespace, evaluation, and unused-binding policies with the installed binary", () => {
    const { root: tempRoot, write } = makeFixture("policy");
    const typescriptExtensions = ["ts", "tsx", "mts", "cts"];
    const javascriptExtensions = ["js", "jsx", "cjs", "mjs"];
    const allExtensions = [...typescriptExtensions, ...javascriptExtensions];
    const evaluation = 'eval("1 + 1");\nglobalThis.eval("1 + 1");\n';
    const variants = (name: string, source: string, rules: string[], extensions = allExtensions) =>
      extensions.map((extension) => ({ file: `src/${name}.${extension}`, source, rules }));
    const fixtures = [
      ...variants(
        "namespaces",
        [
          "export type Profile = { ready: boolean };",
          "export const Profile = { ready: true };",
          "export interface Adapter { ready: boolean; }",
          "export const Adapter: Adapter = { ready: true };",
        ].join("\n"),
        [],
        typescriptExtensions,
      ),
      ...variants(
        "redeclaration",
        "var duplicateBinding = 1;\nvar duplicateBinding = 2;\nconsole.log(duplicateBinding);\n",
        ["eslint(no-redeclare)", "eslint(no-var)", "eslint(no-var)"],
        javascriptExtensions,
      ),
      ...variants(
        "no-var",
        "export var legacyBinding = 1;\n",
        ["eslint(no-var)"],
        typescriptExtensions,
      ),
      ...variants("evaluation", evaluation, ["eslint(no-eval)", "eslint(no-eval)"]),
      ...variants(
        "unused",
        "function meaningful(_event) { return true; }\nfunction bare(_) { return true; }\nmeaningful(1);\nbare(1);\n",
        ["eslint(no-unused-vars)"],
      ),
      ...[
        "extensions/qa-lab/src/web-runtime.ts",
        "extensions/qa-lab/src/web-runtime.test.ts",
        "extensions/qa-lab/src/other-runtime.ts",
        "extensions/other/src/web-runtime.ts",
      ].map((file) => ({
        file,
        source: evaluation,
        rules:
          file === "extensions/qa-lab/src/web-runtime.ts"
            ? ["eslint(no-eval)"]
            : ["eslint(no-eval)", "eslint(no-eval)"],
      })),
    ];
    for (const fixture of fixtures) {
      write(fixture.file, fixture.source);
    }
    const result = runLint(
      tempRoot,
      fixtures.map((fixture) => fixture.file),
      {},
      ["--config", ".oxlintrc.json", "--report-unused-disable-directives-severity", "error"],
    );
    const report = parseReport(checked(result, 1));
    expect(report.number_of_files).toBe(fixtures.length);
    for (const fixture of fixtures) {
      const diagnostics = byFile(report, fixture.file);
      expect(
        diagnostics
          .map(({ code, severity }) => [code, severity])
          .toSorted((left, right) => left.join(",").localeCompare(right.join(","))),
        fixture.file,
      ).toEqual(
        fixture.rules
          .map((code) => [code, "error"])
          .toSorted((left, right) => left.join(",").localeCompare(right.join(","))),
      );
    }
    const ownerDiagnostics = byFile(report, "extensions/qa-lab/src/web-runtime.ts");
    expect(ownerDiagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line)).toEqual([1]);
    const unusedDiagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === "eslint(no-unused-vars)",
    );
    expect(unusedDiagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line)).toEqual(
      allExtensions.map(() => 2),
    );
  });

  it("checks unbound methods in TypeScript and CommonJS source test support", () => {
    const { root: tempRoot, write, copy } = makeFixture("source-support");
    for (const file of ["tsconfig.json", "src/tsconfig.json"]) {
      if (fs.existsSync(file)) {
        copy(file);
      }
    }
    writeSourceProjectFixture(tempRoot);
    linkDependencies(tempRoot);
    const supportFiles = [
      "src/cli/diagnostics.test-support.ts",
      "src/cli/diagnostics.test-support.cjs",
    ];
    const files = [...supportFiles, "src/cli/unrelated.cjs", "ui/unrelated.test-support.cjs"];
    const source = 'const emit = process.emit;\nemit("lint-fixture");\n';
    for (const file of files) {
      write(file, source);
    }
    const lint = () =>
      runLint(
        tempRoot,
        files,
        {
          OXLINT_TSGOLINT_PATH: path.resolve(
            "node_modules/.bin",
            process.platform === "win32" ? "tsgolint.CMD" : "tsgolint",
          ),
        },
        ["--type-aware"],
      );
    const broken = lint();
    const report = parseReport(checked(broken, 1));
    expect(report.diagnostics.map(({ filename, code }) => [normalized(filename), code])).toEqual(
      expect.arrayContaining(
        supportFiles.map((filename) => [filename, "typescript(unbound-method)"]),
      ),
    );
    expect(report.diagnostics).toHaveLength(supportFiles.length);
    for (const file of supportFiles) {
      write(file, source.replace("process.emit;", "process.emit.bind(process);"));
    }
    const fixed = lint();
    expect(parseReport(checked(fixed, 0)).diagnostics).toEqual([]);
  });

  it("bounds package fallback roots while preserving existing projects and ambient types", () => {
    const { root, write, copy } = makeFixture("package-project");
    const packageOwners = [
      "ai",
      "llm-core",
      "model-catalog-core",
      "normalization-core",
      "plugin-sdk",
    ];
    for (const file of [
      "tsconfig.json",
      "ui/src/css.d.ts",
      ...packageOwners.map((owner) => `packages/${owner}/tsconfig.json`),
    ]) {
      copy(file);
    }
    write("package.json", '{"type":"module"}');
    writeSourceProjectFixture(root);
    linkDependencies(root);
    // The original repository graph acquires ESNext through unrelated roots.
    write("src/library-owner.ts", '/// <reference lib="esnext" />\nexport {};');
    write("ui/unrelated.ts", "export {};");
    write("extensions/unrelated.ts", "export {};");
    const contract = "packages/example/contract.ts";
    write(contract, "export interface Contract {} export declare const contract: Contract;");
    for (const [index, file] of sourceAugmentations.entries()) {
      const imported = path
        .relative(path.dirname(file), contract)
        .replaceAll("\\", "/")
        .replace(/\.ts$/, ".js");
      write(
        file,
        `import ${JSON.stringify(imported)}; declare module ${JSON.stringify(imported)} { interface Contract { action${index}(): Promise<void>; } }`,
      );
    }
    const declarations = ["src", "packages", "ui", "extensions"].flatMap((directory) =>
      ["ts", "mts", "cts"].map((suffix) => `${directory}/ambient.d.${suffix}`),
    );
    for (const [index, file] of declarations.entries()) {
      write(file, `export {}; declare global { function ambient${index}(): Promise<void>; }`);
    }
    const fallback = [
      "packages/example/owner.ts",
      "packages/example/owner.test.ts",
      "packages/normalization-core/src/owner.test.ts",
      "packages/plugin-sdk/tests/owner.test.ts",
    ];
    for (const file of fallback) {
      let imported = path
        .relative(path.dirname(file), contract)
        .replaceAll("\\", "/")
        .replace(/\.ts$/, ".js");
      if (!imported.startsWith(".")) {
        imported = "./" + imported;
      }
      write(
        file,
        [
          `import { contract } from ${JSON.stringify(imported)};`,
          ...sourceAugmentations.map((_file, index) => `contract.action${index}();`),
          ...declarations.map((_file, index) => `ambient${index}();`),
          "Promise.try(() => undefined);",
        ].join("\n"),
      );
    }
    const configured = packageOwners
      .filter((owner) => owner !== "plugin-sdk")
      .map((owner) => `packages/${owner}/src/owner.ts`);
    const inferred = [
      "packages/example/frame.js",
      "packages/example/probe.test-support.mjs",
      "packages/example/other.test-support.mjs",
    ];
    for (const file of [...configured, ...inferred]) {
      write(file, "Promise.resolve();");
    }
    write(
      "packages/example/ambient-contract.ts",
      [
        'import type { SessionEntry } from "../../src/config/sessions/types.js";',
        'import asset from "./frame.js?url&no-inline";',
        'export const hasCompatibility: "sessionFile" extends keyof SessionEntry ? true : false = false;',
        "export const assetUrl: string = asset;",
      ].join("\n"),
    );
    const selected = [...fallback, ...configured, ...inferred];
    const lint = () =>
      runLint(root, selected, { OXC_LOG: "debug", GOMAXPROCS: "2" }, ["--type-aware"], 30_000);
    const baseline = lint();
    copy("packages/tsconfig.json");
    const narrowed = lint();
    const reports = [baseline, narrowed].map((result) => parseReport(checked(result, 1)));
    expect(reports.map((report) => report.number_of_files)).toEqual([
      selected.length,
      selected.length,
    ]);
    expect(reports[0]!.diagnostics.map((item) => JSON.stringify(item)).toSorted()).toEqual(
      reports[1]!.diagnostics.map((item) => JSON.stringify(item)).toSorted(),
    );
    const expectProject = (result: ReturnType<typeof runTool>, file: string, project: string) => {
      expect(normalized(result.stderr)).toContain(
        `Got tsconfig for file ${normalized(path.join(root, file))}: ${normalized(path.join(root, project))}`,
      );
    };
    for (const file of fallback) {
      expect(byFile(reports[1]!, file).map((item) => item.code)).toEqual(
        Array.from(
          { length: sourceAugmentations.length + declarations.length + 1 },
          () => "typescript(no-floating-promises)",
        ),
      );
      expectProject(baseline, file, "tsconfig.json");
      expectProject(narrowed, file, "packages/tsconfig.json");
    }
    for (const result of [baseline, narrowed]) {
      for (const file of configured) {
        expectProject(result, file, file.split("/").slice(0, 2).join("/") + "/tsconfig.json");
      }
      for (const file of inferred) {
        expect(normalized(result.stderr)).toContain(
          `Unmatched file: ${normalized(path.join(root, file))}`,
        );
      }
    }
    const expanded = spawnSync(
      resolveRepoToolBinPath("tsgo"),
      ["--showConfig", "--project", "packages/tsconfig.json"],
      { cwd: root, encoding: "utf8", timeout: 10_000 },
    );
    const roots = (JSON.parse(checked(expanded, 0)) as { files: string[] }).files.map((file) =>
      path.resolve(root, "packages", file),
    );
    for (const file of [...fallback, ...configured, ...sourceAugmentations, ...declarations]) {
      expect(roots, file).toContain(path.resolve(root, file));
    }
    for (const file of [
      "src/library-owner.ts",
      "ui/unrelated.ts",
      "extensions/unrelated.ts",
      "src/config/sessions/session-entry.test-compat.d.ts",
      ...inferred,
    ]) {
      expect(roots, file).not.toContain(path.resolve(root, file));
    }
    const typecheck = spawnSync(
      resolveRepoToolBinPath("tsgo"),
      ["--project", "packages/tsconfig.json", "--noEmit", "--pretty", "false"],
      { cwd: root, encoding: "utf8", timeout: 10_000 },
    );
    checked(typecheck, 0);
  });

  it("has a discoverable scripts tsconfig for type-aware linting", () => {
    const tsconfig = readJson("scripts/tsconfig.json") as OxlintTsconfig;

    expect(tsconfig).toMatchObject({
      compilerOptions: { allowJs: true },
      include: expect.arrayContaining(["**/*.ts", "**/*.mts"]),
    });
    expect(tsconfig.exclude ?? []).not.toContain("**/*.ts");
    expect(tsconfig.exclude ?? []).not.toContain("**/*.mts");
  });

  it("keeps native cap scopes and correctness while warning on untouched local line debt", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;
    const { root, write, json } = makeFixture(
      "ci-limits",
      {
        ...config,
        env: { browser: true },
        globals: { configuredGlobal: "readonly" },
        rules: { ...config.rules, "no-undef": "error" },
        ignorePatterns: [...(config.ignorePatterns ?? []), "src/ignored-by-config.ts"],
        overrides: [
          ...(config.overrides ?? []),
          {
            files: ["src/disabled/**"],
            rules: { "max-lines": "off" },
          },
        ],
      },
      true,
    );
    linkDependencies(root);
    const sources = {
      "src/oversized.ts": 702,
      "src/within-cap.test.ts": 902,
      "extensions/copilot/src/event-bridge.ts": 902,
      "src/generated/ignored.ts": 1402,
      "src/ignored-by-config.ts": 1402,
      "src/disabled/ignored.ts": 1402,
    };
    for (const [file, lines] of Object.entries(sources)) {
      write(file, `export const values = [\n${"  0,\n".repeat(lines - 2)}];\n`);
    }
    write("src/correctness.ts", "export var legacy = 1;\n");
    write("src/globals.js", "window.console.log(configuredGlobal);\n");
    const ownConfig = readJson(path.join(root, ".oxlintrc.json")) as OxlintConfig;
    json("base.json", {});
    type Scenario = [
      severity: "error" | "warning",
      github?: boolean,
      correctness?: boolean,
      evidence?: boolean,
      changedPaths?: string[],
      inherited?: boolean,
    ];
    const scenarios: Scenario[] = [
      ["error"],
      ["warning", true],
      ["warning", true, true],
      ["warning", true, true, true],
      ["error", false, false, true, ["src/globals.js"], true],
      ...[false, true].flatMap((evidence) =>
        [false, true].map((correctness): Scenario => [
          "warning",
          false,
          correctness,
          evidence,
          ["src/globals.js"],
        ]),
      ),
      ...[
        [],
        ["src/oversized.ts"],
        [".oxlintrc.json"],
        ["src/.oxlintrc.json"],
        ["package.json"],
        ["pnpm-lock.yaml"],
        ["pnpm-workspace.yaml"],
        ["patches/oxlint.patch"],
        ["scripts/run-oxlint.mts"],
      ].map((changedPaths): Scenario => ["error", false, false, false, changedPaths]),
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const [severity, github, correctness, evidence, changedPaths, inherited] = scenario;
      json(".oxlintrc.json", inherited ? { ...ownConfig, extends: ["./base.json"] } : ownConfig);
      const summary = path.join(root, `summary-${index}.md`);
      const result = runFocused(
        root,
        [...Object.keys(sources), "src/globals.js", ...(correctness ? ["src/correctness.ts"] : [])],
        {
          CI: "true",
          GITHUB_ACTIONS: github ? "true" : "false",
          GITHUB_STEP_SUMMARY: summary,
          OPENCLAW_OXLINT_CHANGED_PATHS: changedPaths && JSON.stringify(changedPaths),
          OPENCLAW_CI_STATIC_EVIDENCE: evidence ? "1" : "0",
          OPENCLAW_CI_STATIC_EVIDENCE_ID: "limits:0",
        },
      );
      const expectedStatus = severity === "warning" && !correctness ? 0 : 1;
      const marker = "\n[ci-static:oxlint:leaf] ";
      const [output, receipt] = checked(result, expectedStatus).split(marker);
      assert.ok(output !== undefined, "Missing lint diagnostic output");
      const report = parseReport(output);
      if (evidence) {
        assert.ok(receipt !== undefined, "Missing lint evidence receipt");
        expect(JSON.parse(receipt)).toMatchObject({
          version: 1,
          id: "limits:0",
          config: ".oxlintrc.json",
          exitCode: expectedStatus,
          stdout: output,
          stderr: "",
        });
        expect(fs.readdirSync(root).filter((file) => file.startsWith(".oxlint-limits-"))).toEqual(
          [],
        );
      } else {
        expect(receipt).toBeUndefined();
      }
      expect(report.diagnostics).toHaveLength(correctness ? 2 : 1);
      expect(
        report.diagnostics.find((diagnostic) => diagnostic.code === "eslint(max-lines)"),
      ).toMatchObject({
        severity,
        help: "Maximum allowed is 700.",
      });
      if (github) {
        expect(result.stderr).toContain("::warning file=src/oversized.ts,");
        expect(fs.readFileSync(summary, "utf8")).toContain("Maximum allowed is 700.");
      }
      if (correctness) {
        expect(
          report.diagnostics.find((diagnostic) => diagnostic.code === "eslint(no-var)")?.severity,
        ).toBe("error");
      }
    }
  });

  it("matches changed paths literally and keeps inherited config limits strict", () => {
    const config = { categories: { correctness: "off" }, rules: { "max-lines": ["error", 2] } };
    const { root, write, json } = makeFixture("changed-paths", config);
    linkDependencies(root);
    const sources = [
      "!root.ts",
      "src/!root.ts",
      "src/special[ab]{x,y}!file.ts",
      "src/specialax!file.ts",
      "src/wild-star.ts",
      "src/wild-question.ts",
    ];
    for (const file of sources) {
      write(file, "export const values = [\n  0,\n  1,\n];\n");
    }
    const changedPaths = [
      "!root.ts",
      "src/special[ab]{x,y}!file.ts",
      "src/wild*.ts",
      "src/wild-questio?.ts",
    ];
    for (const inherited of [false, true]) {
      if (inherited) {
        json("base.json", config);
        json(".oxlintrc.json", { extends: ["./base.json"] });
      }
      const result = runFocused(root, sources, {
        GITHUB_ACTIONS: "false",
        OPENCLAW_OXLINT_CHANGED_PATHS: JSON.stringify(changedPaths),
      });
      const report = parseReport(checked(result, 1));
      expect(report.diagnostics).toHaveLength(sources.length);
      for (const file of sources) {
        expect(byFile(report, file)[0], file).toMatchObject({
          code: "eslint(max-lines)",
          severity: inherited || changedPaths.includes(file) ? "error" : "warning",
        });
      }
    }
  });

  it("keeps untouched limits advisory for release-version-only manifest changes", () => {
    const config = { categories: { correctness: "off" }, rules: { "max-lines": ["error", 2] } };
    const { root, write, json } = makeFixture("release-version-scope", config);
    linkDependencies(root);
    write("src/changed.ts", "export const changed = [\n  0,\n  1,\n];\n");
    write("src/untouched.ts", "export const untouched = [\n  0,\n  1,\n];\n");
    json("package.json", { name: "fixture", version: "2026.10.10-beta.3" });
    git(root, ["init", "--quiet"]);
    git(root, ["add", "."]);
    git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "base",
    ]);
    const base = git(root, ["rev-parse", "HEAD"]);
    json("package.json", { name: "fixture", version: "2026.10.10-beta.4" });

    const result = runFocused(root, ["src/changed.ts", "src/untouched.ts"], {
      GITHUB_ACTIONS: "false",
      OPENCLAW_OXLINT_CHANGED_PATHS: JSON.stringify(["package.json", "src/changed.ts"]),
      OPENCLAW_OXLINT_CHANGED_BASE: base,
    });
    const report = parseReport(checked(result, 1));
    expect(byFile(report, "src/changed.ts")[0]?.severity).toBe("error");
    expect(byFile(report, "src/untouched.ts")[0]?.severity).toBe("warning");
  });

  it("trusts changed lint policy files only when they match authoritative main", () => {
    const config = { categories: { correctness: "off" }, rules: { "max-lines": ["error", 2] } };
    const { root, write, json } = makeFixture("trusted-release-policy", config);
    linkDependencies(root);
    write("src/changed.ts", "export const changed = [\n  0,\n  1,\n];\n");
    write("src/untouched.ts", "export const untouched = [\n  0,\n  1,\n];\n");
    write("scripts/lib/oxlint-changed-scope.mts", 'export const policy = "base";\n');
    json("package.json", { name: "fixture", version: "2026.10.10-beta.3" });
    git(root, ["init", "--quiet"]);
    git(root, ["add", "."]);
    git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "base",
    ]);
    const base = git(root, ["rev-parse", "HEAD"]);
    write("scripts/lib/oxlint-changed-scope.mts", 'export const policy = "trusted";\n');
    git(root, ["add", "scripts/lib/oxlint-changed-scope.mts"]);
    git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "trusted policy",
    ]);
    const trustedPolicyRef = git(root, ["rev-parse", "HEAD"]);
    json("package.json", { name: "fixture", version: "2026.10.10-beta.4" });

    const changedPaths = ["package.json", "scripts/lib/oxlint-changed-scope.mts", "src/changed.ts"];
    const trustedEnv = createChangedOxlintEnv(
      changedPaths,
      {
        CHECKOUT_BASE_SHA: base,
        GITHUB_ACTIONS: "false",
        OPENCLAW_OXLINT_TRUSTED_POLICY_REF: trustedPolicyRef,
      },
      { cwd: root },
    );
    expect(trustedEnv.OPENCLAW_OXLINT_CHANGED_BASE).toBe(base);
    expect(trustedEnv.OPENCLAW_OXLINT_CHANGED_PATHS).toBe(JSON.stringify(changedPaths));
    const trusted = runFocused(root, ["src/changed.ts", "src/untouched.ts"], {
      GITHUB_ACTIONS: "false",
      ...trustedEnv,
    });
    const trustedReport = parseReport(checked(trusted, 1));
    expect(byFile(trustedReport, "src/changed.ts")[0]?.severity).toBe("error");
    expect(byFile(trustedReport, "src/untouched.ts")[0]?.severity).toBe("warning");

    write("scripts/lib/oxlint-changed-scope.mts", 'export const policy = "untrusted";\n');
    const untrusted = runFocused(root, ["src/changed.ts", "src/untouched.ts"], {
      GITHUB_ACTIONS: "false",
      OPENCLAW_OXLINT_CHANGED_PATHS: JSON.stringify(changedPaths),
      OPENCLAW_OXLINT_CHANGED_BASE: base,
      OPENCLAW_OXLINT_TRUSTED_POLICY_REF: trustedPolicyRef,
    });
    const untrustedReport = parseReport(checked(untrusted, 1));
    expect(byFile(untrustedReport, "src/changed.ts")[0]?.severity).toBe("error");
    expect(byFile(untrustedReport, "src/untouched.ts")[0]?.severity).toBe("error");
  });

  it("preserves native config validation locally and in Actions", () => {
    const { root, write } = makeFixture("invalid-limit", {});
    linkDependencies(root);
    write("fixture.ts", "console.log(1);\n");
    const invalidConfigs = [
      ...["not-a-severity", 3, null].map((severity) =>
        JSON.stringify({
          categories: { correctness: "off" },
          rules: { "max-lines": [severity, { max: 1 }] },
        }),
      ),
      '{categories: {correctness: "off"}, rules: {"max-lines": ["error", {max: 1}]}}',
    ];
    for (const config of invalidConfigs) {
      write(".oxlintrc.json", config);
      for (const { github, changedPaths } of [
        { github: false, changedPaths: undefined },
        { github: true, changedPaths: undefined },
        { github: false, changedPaths: ["src/changed.ts"] },
      ]) {
        const result = runTool(root, [oxlintRunner, "--openclaw-focused-config", "fixture.ts"], {
          env: {
            ...process.env,
            CI: github ? "true" : "false",
            GITHUB_ACTIONS: github ? "true" : "false",
            OPENCLAW_OXLINT_CHANGED_PATHS: changedPaths && JSON.stringify(changedPaths),
            OPENCLAW_CI_STATIC_EVIDENCE: "1",
            OPENCLAW_CI_STATIC_EVIDENCE_ID: "invalid:0",
          },
        });
        checked(result, 1);
        expect(result.stdout + result.stderr).toMatch(/Failed to (?:parse|load)[^\n]*config/u);
        expect(result.stdout).not.toContain("[ci-static:oxlint:leaf]");
      }
    }
  });
});
