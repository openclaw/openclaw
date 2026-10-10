import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { resolveRepoToolBinPath } from "../../scripts/lib/local-check-runtime.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

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
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }
  writeSessionCompatibilityFixture(root);
  for (const file of sourceAugmentations) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "export {};\n");
  }
}

type OxlintConfig = {
  ignorePatterns?: string[];
  overrides?: Array<{
    excludeFiles?: string[];
    files?: string[];
    rules?: Record<string, unknown>;
  }>;
  rules?: Record<string, unknown>;
};

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
  const directory = path.join(root, "src/config/sessions");
  fs.mkdirSync(directory, { recursive: true });
  // Real editor configs explicitly root this augmentation. Keep its real contents,
  // with fixture-owned base modules rather than importing the whole session graph.
  fs.copyFileSync(
    "src/config/sessions/session-entry.test-compat.d.ts",
    path.join(directory, "session-entry.test-compat.d.ts"),
  );
  for (const [file, interfaces] of [
    ["types.ts", ["SessionEntry", "InternalSessionEntry"]],
    [
      "session-accessor.types.ts",
      [
        "SessionTranscriptRuntimeTarget",
        "SessionTranscriptTurnPersistResult",
        "SessionTranscriptReadTarget",
      ],
    ],
  ] as const) {
    fs.writeFileSync(
      path.join(directory, file),
      interfaces.map((name) => "export interface " + name + " { id: string; }").join("\n"),
    );
  }
}

describe("oxlint config", () => {
  it("enforces namespace, evaluation, and unused-binding policies with the installed binary", () => {
    const tempRoot = fs.realpathSync(createTempDir("openclaw-oxlint-policy-"));
    const typescriptExtensions = ["ts", "tsx", "mts", "cts"];
    const javascriptExtensions = ["js", "jsx", "cjs", "mjs"];
    const evaluation = 'eval("1 + 1");\nglobalThis.eval("1 + 1");\n';
    const fixtures = [
      ...typescriptExtensions.map((extension) => ({
        file: `src/namespaces.${extension}`,
        source: [
          "export type Profile = { ready: boolean };",
          "export const Profile = { ready: true };",
          "export interface Adapter { ready: boolean; }",
          "export const Adapter: Adapter = { ready: true };",
        ].join("\n"),
        rules: [],
      })),
      ...javascriptExtensions.map((extension) => ({
        file: `src/redeclaration.${extension}`,
        source:
          "var duplicateBinding = 1;\nvar duplicateBinding = 2;\nconsole.log(duplicateBinding);\n",
        rules: ["eslint(no-redeclare)", "eslint(no-var)", "eslint(no-var)"],
      })),
      ...typescriptExtensions.map((extension) => ({
        file: `src/no-var.${extension}`,
        source: "export var legacyBinding = 1;\n",
        rules: ["eslint(no-var)"],
      })),
      ...[...typescriptExtensions, ...javascriptExtensions].flatMap((extension) => [
        {
          file: `src/evaluation.${extension}`,
          source: evaluation,
          rules: ["eslint(no-eval)", "eslint(no-eval)"],
        },
        {
          file: `src/unused.${extension}`,
          source:
            "function meaningful(_event) { return true; }\nfunction bare(_) { return true; }\nmeaningful(1);\nbare(1);\n",
          rules: ["eslint(no-unused-vars)"],
        },
      ]),
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
    fs.copyFileSync(".oxlintrc.json", path.join(tempRoot, ".oxlintrc.json"));
    for (const fixture of fixtures) {
      const target = path.join(tempRoot, fixture.file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, fixture.source);
    }
    // These syntax-rule fixtures need no type program; one batch uses the real config and paths.
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("node_modules/oxlint/bin/oxlint"),
        "--config",
        ".oxlintrc.json",
        "--format",
        "json",
        "--threads=1",
        "--report-unused-disable-directives-severity",
        "error",
        ...fixtures.map((fixture) => fixture.file),
      ],
      { cwd: tempRoot, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(result.stdout) as {
      number_of_files: number;
      diagnostics: Array<{
        filename: string;
        code: string;
        severity: string;
        labels: Array<{ span: { line: number } }>;
      }>;
    };
    expect(report.number_of_files).toBe(fixtures.length);
    for (const fixture of fixtures) {
      const diagnostics = report.diagnostics.filter(
        (diagnostic) => diagnostic.filename.replaceAll("\\", "/") === fixture.file,
      );
      expect(diagnostics.map((diagnostic) => diagnostic.code).toSorted(), fixture.file).toEqual(
        fixture.rules.toSorted(),
      );
      expect(
        diagnostics.every((diagnostic) => diagnostic.severity === "error"),
        fixture.file,
      ).toBe(true);
    }
    const ownerDiagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.filename.replaceAll("\\", "/") === "extensions/qa-lab/src/web-runtime.ts",
    );
    expect(ownerDiagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line)).toEqual([1]);
    const unusedDiagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === "eslint(no-unused-vars)",
    );
    expect(unusedDiagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line)).toEqual(
      [...typescriptExtensions, ...javascriptExtensions].map(() => 2),
    );
  });

  it("checks unbound methods in TypeScript and CommonJS source test support", () => {
    const tempRoot = fs.realpathSync(createTempDir("openclaw-oxlint-source-support-"));
    for (const file of [".oxlintrc.json", "tsconfig.json", "src/tsconfig.json"]) {
      if (fs.existsSync(file)) {
        const target = path.join(tempRoot, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(file, target);
      }
    }
    writeSourceProjectFixture(tempRoot);
    fs.symlinkSync(path.resolve("node_modules"), path.join(tempRoot, "node_modules"), "junction");
    const supportFiles = [
      "src/cli/diagnostics.test-support.ts",
      "src/cli/diagnostics.test-support.cjs",
    ];
    const files = [...supportFiles, "src/cli/unrelated.cjs", "ui/unrelated.test-support.cjs"];
    const source = 'const emit = process.emit;\nemit("lint-fixture");\n';
    for (const file of files) {
      const target = path.join(tempRoot, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    }
    const lint = () =>
      spawnSync(
        process.execPath,
        [
          path.resolve("node_modules/oxlint/bin/oxlint"),
          "--type-aware",
          "--format",
          "json",
          "--threads=1",
          ...files,
        ],
        {
          cwd: tempRoot,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            OXLINT_TSGOLINT_PATH: path.resolve(
              "node_modules/.bin",
              process.platform === "win32" ? "tsgolint.CMD" : "tsgolint",
            ),
          },
        },
      );
    const broken = lint();
    expect(broken.error).toBeUndefined();
    expect(broken.status, broken.stdout + broken.stderr).toBe(1);
    const report = JSON.parse(broken.stdout) as {
      diagnostics: Array<{ filename: string; code: string }>;
    };
    expect(
      report.diagnostics.map(({ filename, code }) => ({
        filename: filename.replaceAll("\\", "/"),
        code,
      })),
    ).toEqual(
      expect.arrayContaining(
        supportFiles.map((filename) => ({ filename, code: "typescript(unbound-method)" })),
      ),
    );
    expect(report.diagnostics).toHaveLength(supportFiles.length);
    for (const file of supportFiles) {
      fs.writeFileSync(
        path.join(tempRoot, file),
        source.replace("process.emit;", "process.emit.bind(process);"),
      );
    }
    const fixed = lint();
    expect(fixed.error).toBeUndefined();
    expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0);
    expect(JSON.parse(fixed.stdout).diagnostics).toEqual([]);
  });

  it("bounds package fallback roots while preserving existing projects and ambient types", () => {
    const root = fs.realpathSync(createTempDir("openclaw-oxlint-package-project-"));
    const write = (file: string, content: string) => {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    };
    const copy = (file: string) => write(file, fs.readFileSync(file, "utf8"));
    const packageOwners = [
      "ai",
      "llm-core",
      "model-catalog-core",
      "normalization-core",
      "plugin-sdk",
    ];
    for (const file of [
      ".oxlintrc.json",
      "tsconfig.json",
      "ui/src/css.d.ts",
      ...packageOwners.map((owner) => `packages/${owner}/tsconfig.json`),
    ]) {
      copy(file);
    }
    write("package.json", '{"type":"module"}');
    writeSourceProjectFixture(root);
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
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
    for (const file of configured) {
      write(file, "Promise.resolve();");
    }
    const inferred = [
      "packages/example/frame.js",
      "packages/example/probe.test-support.mjs",
      "packages/example/other.test-support.mjs",
    ];
    for (const file of inferred) {
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
      spawnSync(
        process.execPath,
        [
          path.resolve("node_modules/oxlint/bin/oxlint"),
          "--type-aware",
          "--threads=1",
          "--format=json",
          ...selected,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            OXC_LOG: "debug",
            GOMAXPROCS: "2",
            OXLINT_TSGOLINT_PATH: resolveRepoToolBinPath(
              process.platform === "win32" ? "tsgolint.CMD" : "tsgolint",
            ),
          },
        },
      );
    const baseline = lint();
    copy("packages/tsconfig.json");
    const narrowed = lint();
    const reports = [baseline, narrowed].map((result) => {
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      return JSON.parse(result.stdout) as {
        number_of_files: number;
        diagnostics: Array<{ filename: string; code: string }>;
      };
    });
    expect(reports.map((report) => report.number_of_files)).toEqual([
      selected.length,
      selected.length,
    ]);
    expect(reports[0]!.diagnostics.map((item) => JSON.stringify(item)).toSorted()).toEqual(
      reports[1]!.diagnostics.map((item) => JSON.stringify(item)).toSorted(),
    );
    for (const file of fallback) {
      expect(
        reports[1]!.diagnostics
          .filter((item) => item.filename.replaceAll("\\", "/") === file)
          .map((item) => item.code),
      ).toEqual(
        Array.from(
          { length: sourceAugmentations.length + declarations.length + 1 },
          () => "typescript(no-floating-promises)",
        ),
      );
      expect(baseline.stderr.replaceAll("\\", "/")).toContain(
        `Got tsconfig for file ${path.join(root, file).replaceAll("\\", "/")}: ${path.join(root, "tsconfig.json").replaceAll("\\", "/")}`,
      );
      expect(narrowed.stderr.replaceAll("\\", "/")).toContain(
        `Got tsconfig for file ${path.join(root, file).replaceAll("\\", "/")}: ${path.join(root, "packages/tsconfig.json").replaceAll("\\", "/")}`,
      );
    }
    for (const result of [baseline, narrowed]) {
      for (const file of configured) {
        const project = file.split("/").slice(0, 2).join("/") + "/tsconfig.json";
        expect(result.stderr.replaceAll("\\", "/")).toContain(
          `Got tsconfig for file ${path.join(root, file).replaceAll("\\", "/")}: ${path.join(root, project).replaceAll("\\", "/")}`,
        );
      }
      for (const file of inferred) {
        expect(result.stderr.replaceAll("\\", "/")).toContain(
          `Unmatched file: ${path.join(root, file).replaceAll("\\", "/")}`,
        );
      }
    }
    const expanded = spawnSync(
      resolveRepoToolBinPath("tsgo"),
      ["--showConfig", "--project", "packages/tsconfig.json"],
      { cwd: root, encoding: "utf8", timeout: 10_000 },
    );
    expect(expanded.error).toBeUndefined();
    expect(expanded.status, expanded.stdout + expanded.stderr).toBe(0);
    const roots = (JSON.parse(expanded.stdout) as { files: string[] }).files.map((file) =>
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
    const checked = spawnSync(
      resolveRepoToolBinPath("tsgo"),
      ["--project", "packages/tsconfig.json", "--noEmit", "--pretty", "false"],
      { cwd: root, encoding: "utf8", timeout: 10_000 },
    );
    expect(checked.error).toBeUndefined();
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  });

  it("has a discoverable scripts tsconfig for type-aware linting", () => {
    const tsconfig = readJson("scripts/tsconfig.json") as OxlintTsconfig;

    expect(tsconfig.compilerOptions?.allowJs).toBe(true);
    expect(tsconfig.include).toContain("**/*.ts");
    expect(tsconfig.include).toContain("**/*.mts");
    expect(tsconfig.exclude ?? []).not.toContain("**/*.ts");
    expect(tsconfig.exclude ?? []).not.toContain("**/*.mts");
  });

  it("keeps native cap scopes and correctness while warning on untouched local line debt", () => {
    const root = fs.realpathSync(createTempDir("openclaw-oxlint-ci-limits-"));
    // Keep transient-config ownership inside this synthetic checkout.
    fs.mkdirSync(path.join(root, ".git"));
    const config = readJson(".oxlintrc.json") as OxlintConfig;
    fs.writeFileSync(
      path.join(root, ".oxlintrc.json"),
      JSON.stringify({
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
      }),
    );
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
    const sources = {
      "src/oversized.ts": 702,
      "src/within-cap.test.ts": 902,
      "extensions/copilot/src/event-bridge.ts": 902,
      "src/generated/ignored.ts": 1402,
      "src/ignored-by-config.ts": 1402,
      "src/disabled/ignored.ts": 1402,
    };
    for (const [file, lines] of Object.entries(sources)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(
        path.join(root, file),
        `export const values = [\n${"  0,\n".repeat(lines - 2)}];\n`,
      );
    }
    fs.writeFileSync(path.join(root, "src/correctness.ts"), "export var legacy = 1;\n");
    fs.writeFileSync(path.join(root, "src/globals.js"), "window.console.log(configuredGlobal);\n");
    const ownConfig = readJson(path.join(root, ".oxlintrc.json")) as OxlintConfig;
    fs.writeFileSync(path.join(root, "base.json"), "{}");
    const scenarios: {
      github: boolean;
      correctness: boolean;
      evidence?: boolean;
      inherited?: boolean;
      changedPaths?: string[];
      severity: "error" | "warning";
    }[] = [
      { github: false, correctness: false, severity: "error" },
      { github: true, correctness: false, severity: "warning" },
      { github: true, correctness: true, severity: "warning" },
      { github: true, correctness: true, evidence: true, severity: "warning" },
      {
        github: false,
        correctness: false,
        evidence: true,
        inherited: true,
        changedPaths: ["src/globals.js"],
        severity: "error",
      },
      ...[false, true].flatMap((evidence) =>
        [false, true].map((correctness) => ({
          github: false,
          correctness,
          evidence,
          changedPaths: ["src/globals.js"],
          severity: "warning" as const,
        })),
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
      ].map((changedPaths) => ({
        github: false,
        correctness: false,
        changedPaths,
        severity: "error" as const,
      })),
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const { github, correctness, evidence, inherited, changedPaths, severity } = scenario;
      fs.writeFileSync(
        path.join(root, ".oxlintrc.json"),
        JSON.stringify(inherited ? { ...ownConfig, extends: ["./base.json"] } : ownConfig),
      );
      const summary = path.join(root, `summary-${index}.md`);
      const result = spawnSync(
        process.execPath,
        [
          path.resolve("scripts/run-oxlint.mts"),
          "--openclaw-focused-config",
          "--threads=1",
          "--format",
          "json",
          ...Object.keys(sources),
          "src/globals.js",
          ...(correctness ? ["src/correctness.ts"] : []),
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            CI: "true",
            GITHUB_ACTIONS: github ? "true" : "false",
            GITHUB_STEP_SUMMARY: summary,
            OPENCLAW_OXLINT_CHANGED_PATHS: changedPaths && JSON.stringify(changedPaths),
            OPENCLAW_CI_STATIC_EVIDENCE: evidence ? "1" : "0",
            OPENCLAW_CI_STATIC_EVIDENCE_ID: "limits:0",
          },
        },
      );
      expect(result.error).toBeUndefined();
      const expectedStatus = severity === "warning" && !correctness ? 0 : 1;
      expect(result.status, JSON.stringify(changedPaths) + result.stdout + result.stderr).toBe(
        expectedStatus,
      );
      const marker = "\n[ci-static:oxlint:leaf] ";
      const [output, receipt] = result.stdout.split(marker);
      assert.ok(output !== undefined, "Missing lint diagnostic output");
      const report = JSON.parse(output) as {
        diagnostics: Array<{ code: string; severity: string; filename: string; help?: string }>;
      };
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
    const root = fs.realpathSync(createTempDir("openclaw-oxlint-changed-paths-"));
    fs.mkdirSync(path.join(root, ".git"));
    const config = { categories: { correctness: "off" }, rules: { "max-lines": ["error", 2] } };
    fs.writeFileSync(path.join(root, ".oxlintrc.json"), JSON.stringify(config));
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
    const sources = [
      "!root.ts",
      "src/!root.ts",
      "src/special[ab]{x,y}!file.ts",
      "src/specialax!file.ts",
      "src/wild-star.ts",
      "src/wild-question.ts",
    ];
    for (const file of sources) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), "export const values = [\n  0,\n  1,\n];\n");
    }
    const changedPaths = [
      "!root.ts",
      "src/special[ab]{x,y}!file.ts",
      "src/wild*.ts",
      "src/wild-questio?.ts",
    ];
    for (const inherited of [false, true]) {
      if (inherited) {
        fs.writeFileSync(path.join(root, "base.json"), JSON.stringify(config));
        fs.writeFileSync(
          path.join(root, ".oxlintrc.json"),
          JSON.stringify({ extends: ["./base.json"] }),
        );
      }
      const result = spawnSync(
        process.execPath,
        [
          path.resolve("scripts/run-oxlint.mts"),
          "--openclaw-focused-config",
          "--threads=1",
          "--format",
          "json",
          ...sources,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_ACTIONS: "false",
            OPENCLAW_OXLINT_CHANGED_PATHS: JSON.stringify(changedPaths),
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      const report = JSON.parse(result.stdout) as {
        diagnostics: Array<{ code: string; severity: string; filename: string }>;
      };
      expect(report.diagnostics).toHaveLength(sources.length);
      for (const file of sources) {
        expect(
          report.diagnostics.find(
            (diagnostic) => diagnostic.filename.replaceAll("\\", "/") === file,
          ),
          file,
        ).toMatchObject({
          code: "eslint(max-lines)",
          severity: inherited || changedPaths.includes(file) ? "error" : "warning",
        });
      }
    }
  });

  it("preserves native config validation locally and in Actions", () => {
    const root = fs.realpathSync(createTempDir("openclaw-oxlint-invalid-limit-"));
    fs.mkdirSync(path.join(root, ".git"));
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
    fs.writeFileSync(path.join(root, "fixture.ts"), "console.log(1);\n");
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
      fs.writeFileSync(path.join(root, ".oxlintrc.json"), config);
      for (const { github, changedPaths } of [
        { github: false, changedPaths: undefined },
        { github: true, changedPaths: undefined },
        { github: false, changedPaths: ["src/changed.ts"] },
      ]) {
        const result = spawnSync(
          process.execPath,
          [path.resolve("scripts/run-oxlint.mts"), "--openclaw-focused-config", "fixture.ts"],
          {
            cwd: root,
            encoding: "utf8",
            env: {
              ...process.env,
              GITHUB_ACTIONS: github ? "true" : "false",
              OPENCLAW_OXLINT_CHANGED_PATHS: changedPaths && JSON.stringify(changedPaths),
              OPENCLAW_CI_STATIC_EVIDENCE: "1",
              OPENCLAW_CI_STATIC_EVIDENCE_ID: "invalid:0",
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(
          result.status,
          `${config} / Actions=${github}: ${result.stdout}${result.stderr}`,
        ).toBe(1);
        expect(result.stdout + result.stderr).toContain("Failed to parse");
        expect(result.stdout).not.toContain("[ci-static:oxlint:leaf]");
      }
    }
  });
});
