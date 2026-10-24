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

function commitFixture(root: string, message: string) {
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    message,
  ]);
  return git(root, ["rev-parse", "HEAD"]);
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

function makeReleaseFixture(name: string, policy?: string) {
  const fixture = makeFixture(name, tinyLimit);
  const { root, write, json } = fixture;
  linkDependencies(root);
  for (const stem of ["changed", "untouched"]) {
    write(`src/${stem}.ts`, `export const ${stem} = [\n  0,\n  1,\n];\n`);
  }
  if (policy) {
    write(
      "scripts/lib/oxlint-changed-scope.mts",
      `export const policy = ${JSON.stringify(policy)};\n`,
    );
  }
  json("package.json", { name: "fixture", version: "2026.10.10-beta.3" });
  git(root, ["init", "--quiet"]);
  return { ...fixture, base: commitFixture(root, "base") };
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
const codes = (report: LintReport, file: string) => byFile(report, file).map((item) => item.code);
const tinyLimit = { categories: { correctness: "off" }, rules: { "max-lines": ["error", 2] } };
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

function expectSeverities(root: string, env: NodeJS.ProcessEnv, severities: string[]) {
  const files = ["src/changed.ts", "src/untouched.ts"];
  const report = parseReport(
    checked(runFocused(root, files, { GITHUB_ACTIONS: "false", ...env }), 1),
  );
  expect(files.map((file) => byFile(report, file)[0]?.severity)).toEqual(severities);
}

const oxlintBin = path.resolve("node_modules/oxlint/bin/oxlint");
const oxlintRunner = path.resolve("scripts/run-oxlint.mts");

const sourceProjectOwners = "agents gateway infra commands plugins config cli auto-reply".split(
  " ",
);
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
    const evaluation = 'eval("1 + 1");\nglobalThis.eval("1 + 1");\n';
    const unused =
      "function meaningful(_event) { return true; }\nfunction bare(_) { return true; }\nmeaningful(1);\nbare(1);\n";
    const makeCase = (file: string, source: string, ...rules: string[]) => ({
      file,
      source,
      rules,
    });
    const fixtures = [
      makeCase(
        "src/namespaces.ts",
        "export type A = { ready: boolean }; export const A = { ready: true }; export interface B { ready: boolean } export const B: B = { ready: true };",
      ),
      makeCase(
        "src/redeclaration.js",
        "var duplicateBinding = 1;\nvar duplicateBinding = 2;\nconsole.log(duplicateBinding);\n",
        "eslint(no-redeclare)",
        "eslint(no-var)",
        "eslint(no-var)",
      ),
      makeCase("src/no-var.ts", "export var legacyBinding = 1;\n", "eslint(no-var)"),
      makeCase("src/evaluation.ts", evaluation, "eslint(no-eval)", "eslint(no-eval)"),
      ...["ts", "js"].map((extension) =>
        makeCase(`src/unused.${extension}`, unused, "eslint(no-unused-vars)"),
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
    expect(unusedDiagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line)).toEqual([2, 2]);
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
    const lint = () => runLint(tempRoot, files, {}, ["--type-aware"]);
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
    const packageOwners = "ai llm-core model-catalog-core normalization-core plugin-sdk".split(" ");
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
    // Type errors outside the package graph must not leak into its typecheck.
    for (const file of ["src/library-owner.ts", "ui/unrelated.ts", "extensions/unrelated.ts"]) {
      write(file, "export const outside: never = 1;");
    }
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
    copy("packages/tsconfig.json");
    const narrowed = runLint(root, selected, { GOMAXPROCS: "2" }, ["--type-aware"], 30_000);
    const report = parseReport(checked(narrowed, 1));
    for (const file of fallback) {
      expect(codes(report, file)).toEqual(
        Array.from(
          { length: sourceAugmentations.length + declarations.length + 1 },
          () => "typescript(no-floating-promises)",
        ),
      );
    }
    for (const file of configured) {
      expect(codes(report, file)).toEqual(["typescript(no-floating-promises)"]);
    }
    for (const file of inferred) {
      expect(codes(report, file)).toEqual([]);
    }
    const typecheck = spawnSync(
      resolveRepoToolBinPath("tsgo"),
      ["--project", "packages/tsconfig.json", "--noEmit", "--pretty", "false"],
      { cwd: root, encoding: "utf8", timeout: 10_000 },
    );
    checked(typecheck, 0);
  });

  it("keeps native cap scopes and correctness while warning on untouched local line debt", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;
    const { root, write } = makeFixture(
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
    type Scenario = [
      severity: "error" | "warning",
      github?: boolean,
      correctness?: boolean,
      evidence?: boolean,
      changedPaths?: string[],
    ];
    const scenarios: Scenario[] = [
      ["error"],
      ["warning", true],
      ["warning", true, true, true],
      ["warning", false, false, true, ["src/globals.js"]],
      ["warning", false, true, false, ["src/globals.js"]],
      ...[
        [],
        ["src/oversized.ts"],
        [".oxlintrc.json"],
        ["src/.oxlintrc.json"],
        ["package.json"],
        ["pnpm-lock.yaml"],
        ["patches/oxlint.patch"],
        ["scripts/run-oxlint.mts"],
      ].map((changedPaths): Scenario => ["error", false, false, false, changedPaths]),
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const [severity, github, correctness, evidence, changedPaths] = scenario;
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
    const { root, write, json } = makeFixture("changed-paths", tinyLimit);
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
        json("base.json", tinyLimit);
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
    const { root, json, base } = makeReleaseFixture("release-version-scope");
    json("package.json", { name: "fixture", version: "2026.10.10-beta.4" });
    expectSeverities(
      root,
      {
        OPENCLAW_OXLINT_CHANGED_PATHS: JSON.stringify(["package.json", "src/changed.ts"]),
        OPENCLAW_OXLINT_CHANGED_BASE: base,
      },
      ["error", "warning"],
    );
  });

  it("trusts changed lint policy files only when they match authoritative main", () => {
    const { root, write, json, base } = makeReleaseFixture("trusted-release-policy", "base");
    write("scripts/lib/oxlint-changed-scope.mts", 'export const policy = "trusted";\n');
    const trustedPolicyRef = commitFixture(root, "trusted policy");
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
    expectSeverities(root, trustedEnv, ["error", "warning"]);

    write("scripts/lib/oxlint-changed-scope.mts", 'export const policy = "untrusted";\n');
    expectSeverities(
      root,
      {
        OPENCLAW_OXLINT_CHANGED_PATHS: JSON.stringify(changedPaths),
        OPENCLAW_OXLINT_CHANGED_BASE: base,
        OPENCLAW_OXLINT_TRUSTED_POLICY_REF: trustedPolicyRef,
      },
      ["error", "error"],
    );
  });

  it("preserves native config validation locally and in Actions", () => {
    const { root, write } = makeFixture("invalid-limit", {});
    linkDependencies(root);
    write("fixture.ts", "console.log(1);\n");
    const invalidConfigs = [
      JSON.stringify({ ...tinyLimit, rules: { "max-lines": ["not-a-severity", { max: 1 }] } }),
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
            GITHUB_ACTIONS: github ? "true" : "false",
            OPENCLAW_OXLINT_CHANGED_PATHS: changedPaths && JSON.stringify(changedPaths),
            OPENCLAW_CI_STATIC_EVIDENCE: "1",
            OPENCLAW_CI_STATIC_EVIDENCE_ID: "invalid:0",
          },
        });
        checked(result, 1);
        expect(result.stdout + result.stderr).toContain("Failed to parse");
        expect(result.stdout).not.toContain("[ci-static:oxlint:leaf]");
      }
    }
  });
});
