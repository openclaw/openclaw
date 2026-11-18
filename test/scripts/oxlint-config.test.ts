import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
function runFocused(root: string, files: string[], env: NodeJS.ProcessEnv) {
  return runTool(
    root,
    [oxlintRunner, "--openclaw-focused-config", "--threads=1", "--format=json", ...files],
    {
      env: { ...process.env, ...env },
    },
  );
}

const oxlintRunner = path.resolve("scripts/run-oxlint.mts");

describe("oxlint config", () => {
  it("keeps release line limits advisory and suppression checks strict", () => {
    const { root, write } = makeFixture("release-limits", {
      categories: { correctness: "off" },
      overrides: [
        {
          files: ["*.ts"],
          rules: {
            "max-lines": ["error", { max: 1 }],
            "max-lines-per-function": ["error", { max: 1 }],
            "max-params": ["error", 1],
            "no-var": "error",
          },
        },
      ],
    });
    linkDependencies(root);
    write(
      "fixture.ts",
      "export function f(a: number, b: number) {\n  var c = a;\n  return c + b;\n}\n",
    );
    const env = { GITHUB_ACTIONS: "false", OPENCLAW_RELEASE_CONTEXT_REF: "release/2026.11.4" };
    const suppressed =
      "/* oxlint-disable max-lines, max-lines-per-function -- retained size exception */\nexport function f(a: number) {\n  return a;\n}\n";
    write("suppressed.ts", suppressed);
    const strictSuppressions = () =>
      runTool(
        root,
        [
          oxlintRunner,
          "--openclaw-focused-config",
          "--report-unused-disable-directives-severity",
          "error",
          "--format=json",
          "suppressed.ts",
        ],
        { env: { ...process.env, ...env } },
      );
    expect(parseReport(checked(strictSuppressions(), 0)).diagnostics).toEqual([]);
    write(
      "suppressed.ts",
      suppressed + "/* oxlint-disable no-var -- unused correctness exception */\n",
    );
    expect(parseReport(checked(strictSuppressions(), 1)).diagnostics).toMatchObject([
      { severity: "error" },
    ]);
    const report = parseReport(checked(runFocused(root, ["fixture.ts"], env), 1));
    expect(
      report.diagnostics
        .map(({ code, severity }) => ({ code, severity }))
        .toSorted((left, right) => left.code.localeCompare(right.code)),
    ).toEqual([
      { code: "eslint(max-lines-per-function)", severity: "warning" },
      { code: "eslint(max-lines)", severity: "warning" },
      { code: "eslint(max-params)", severity: "error" },
      { code: "eslint(no-var)", severity: "error" },
    ]);
    write("fixture.ts", "export function f(a: number) {\n  const c = a;\n  return c;\n}\n");
    expect(
      parseReport(checked(runFocused(root, ["fixture.ts"], env), 0)).diagnostics.map(
        ({ severity }) => severity,
      ),
    ).toEqual(["warning", "warning"]);
  });

  it.each([
    { github: false, correctness: false, status: 1, severity: "error" },
    { github: true, correctness: false, status: 0, severity: "warning" },
    { github: true, correctness: true, status: 1, severity: "warning" },
  ])(
    "keeps native limits and correctness with $github Actions/$correctness correctness",
    ({ github, correctness, status, severity }) => {
      const { root, write } = makeFixture("ci-limits");
      linkDependencies(root);
      write("src/oversized.ts", `export const values = [\n${"  0,\n".repeat(700)}];\n`);
      write("src/correctness.ts", "export var legacy = 1;\n");
      const result = runFocused(
        root,
        ["src/oversized.ts", ...(correctness ? ["src/correctness.ts"] : [])],
        { CI: "true", GITHUB_ACTIONS: github ? "true" : "false" },
      );
      const report = parseReport(checked(result, status));
      expect(report.diagnostics.find(({ code }) => code === "eslint(max-lines)")).toMatchObject({
        severity,
        help: "Maximum allowed is 700.",
      });
      if (correctness) {
        expect(report.diagnostics.find(({ code }) => code === "eslint(no-var)")?.severity).toBe(
          "error",
        );
      }
    },
  );

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
