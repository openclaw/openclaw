import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { devNull } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function copyRunOpengrepFiles(repo: string): void {
  for (const file of [
    "run-opengrep.sh",
    "lib/merge-head-diff-base.mjs",
    "lib/arg-utils.runtime.mjs",
  ]) {
    writeFile(
      path.join(repo, "scripts", file),
      fs.readFileSync(path.join("scripts", file), "utf8"),
    );
  }
  fs.chmodSync(path.join(repo, "scripts/run-opengrep.sh"), 0o755);
}

function createRepo(prefix: string, make = createTempDir) {
  const repo = make(`openclaw-opengrep-${prefix}-`);
  git(repo, "init", "-q", "--initial-branch=main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  copyRunOpengrepFiles(repo);
  writeFile(path.join(repo, "security/opengrep/precise.yml"), "rules: []\n");
  return repo;
}

function commit(repo: string, message = "initial") {
  git(repo, "add", ".");
  git(repo, "commit", "-qm", message);
}

function runScan(repo: string, binDir: string, args = ["--changed"], base = "HEAD") {
  return spawnSync("bash", ["scripts/run-opengrep.sh", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      OPENCLAW_OPENGREP_BASE_REF: base,
    },
  });
}

function installOpengrepStub(repo: string): { argsPath: string; binDir: string } {
  const argsPath = path.join(repo, "opengrep-args.txt");
  const binDir = path.join(repo, "bin");
  fs.mkdirSync(binDir);
  writeFile(
    path.join(binDir, "opengrep"),
    ["#!/usr/bin/env bash", `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`, "exit 0", ""].join(
      "\n",
    ),
  );
  fs.chmodSync(path.join(binDir, "opengrep"), 0o755);
  return { argsPath, binDir };
}

type OpengrepWorkflowStep = {
  name: string;
  id?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  if?: string;
};

const workflowSteps = (): OpengrepWorkflowStep[] =>
  parse(fs.readFileSync(".github/workflows/opengrep-precise.yml", "utf8")).jobs.scan.steps;
const bash = (repo: string, command: string, env: NodeJS.ProcessEnv = process.env) =>
  spawnSync("bash", ["-euo", "pipefail", "-c", command], { cwd: repo, encoding: "utf8", env });

function runChangedPathsWorkflow(repo: string, base: string, env: NodeJS.ProcessEnv) {
  const steps = workflowSteps();
  const values = new Map([
    ["github.event.pull_request.base.sha", base],
    ["github.event.pull_request.base.ref", "main"],
  ]);
  const output = path.join(repo, "step-output.txt");
  const interpolate = (value: string) =>
    value.replace(/\$\{\{\s*(.*?)\s*\}\}/gu, (_match, expression: string) => {
      const resolved = values.get(expression);
      if (resolved === undefined) {
        throw new Error(`Unbound workflow expression: ${expression}`);
      }
      return resolved;
    });
  const renderEnv = (bindings: Record<string, string> = {}) =>
    Object.fromEntries(Object.entries(bindings).map(([key, value]) => [key, interpolate(value)]));
  const run = (step: OpengrepWorkflowStep) => {
    let command = step.run;
    let commandEnv = renderEnv(step.env);
    if (step.uses) {
      const actionPath = path.join(repo, step.uses);
      values.set("github.action_path", actionPath);
      for (const [key, value] of Object.entries(step.with ?? {})) {
        values.set(`inputs.${key}`, interpolate(value));
      }
      const action = parse(fs.readFileSync(path.join(actionPath, "action.yml"), "utf8"));
      const actionStep: OpengrepWorkflowStep = action.runs.steps[0];
      command = actionStep.run;
      commandEnv = { ...commandEnv, ...renderEnv(actionStep.env) };
    }
    if (!command) {
      throw new Error(`Workflow step has no executable command: ${step.name}`);
    }
    fs.writeFileSync(output, "");
    const result = bash(repo, interpolate(command), {
      ...env,
      ...commandEnv,
      GITHUB_OUTPUT: output,
    });
    if (step.id) {
      for (const line of fs.readFileSync(output, "utf8").trim().split("\n")) {
        const [key, ...value] = line.split("=");
        if (value.length) {
          values.set(`steps.${step.id}.outputs.${key}`, value.join("="));
        }
      }
    }
    return result;
  };
  const ensureIndex = steps.findIndex((step) => step.name === "Ensure PR base commit");
  expect(steps[1]).toEqual({
    name: "Setup supported Node runtime",
    uses: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
    with: { "node-version": "24.21.0", "package-manager-cache": false },
  });
  expect(ensureIndex).toBeGreaterThan(1);
  // The fixture already has a supported Node; exercise the repository-owned preparation below.
  for (const step of steps.slice(2, ensureIndex + 1)) {
    const result = run(step);
    if (result.status !== 0) {
      return result;
    }
  }
  const scan = steps.find((step) => step.name === "Run opengrep on PR diff");
  if (!scan) {
    throw new Error("Workflow has no scan step");
  }
  return run(scan);
}

describe("run-opengrep.sh", () => {
  it.each(["--help"])("prints complete usage without shell bootstrap code for %s", (flag) => {
    const repo = createTempDir("openclaw-run-opengrep-help-");
    copyRunOpengrepFiles(repo);
    const result = spawnSync("bash", ["scripts/run-opengrep.sh", flag], {
      cwd: repo,
      encoding: "utf8",
    });

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toMatch(/^# scripts\/run-opengrep\.sh\n/u);
    for (const line of [
      "# Usage:\n",
      "# Optional positional path overrides come last:\n",
      "# Exit code: non-zero on scan errors, and on findings when --error is passed.\n",
    ]) {
      expect(result.stdout).toContain(line);
    }
    expect(result.stdout).not.toContain("BASH_VERSINFO");
    expect(fs.existsSync(path.join(repo, ".opengrep-out"))).toBe(false);
  });

  it("fails before scanning with official installation advice when opengrep is missing", () => {
    const repo = createTempDir("openclaw-run-opengrep-missing-");
    copyRunOpengrepFiles(repo);
    writeFile(path.join(repo, "security/opengrep/precise.yml"), "rules: []\n");

    const binDir = path.join(repo, "bin");
    fs.mkdirSync(binDir);
    for (const command of ["bash", "dirname", "cat"]) {
      const executable = execFileSync("bash", ["-c", 'command -v "$1"', "_", command], {
        encoding: "utf8",
      }).trim();
      fs.symlinkSync(executable, path.join(binDir, command));
    }

    const result = spawnSync(
      "bash",
      ["scripts/run-opengrep.sh", "--changed", "--sarif", "--error"],
      { cwd: repo, env: { ...process.env, PATH: binDir }, encoding: "utf8" },
    );

    expect(result).toMatchObject({
      status: 127,
      stdout: "",
      stderr: expect.stringContaining("'opengrep' not found on PATH"),
    });
    expect(result.stderr).toMatch(
      /curl -fsSL https:\/\/raw\.githubusercontent\.com\/opengrep\/opengrep\/\S+\/install\.sh \| bash -s -- -v \S+/,
    );
    expect(fs.existsSync(path.join(repo, ".opengrep-out"))).toBe(false);
    for (const obsolete of ["pipx", "opengrep/tap/opengrep"]) {
      expect(result.stderr).not.toContain(obsolete);
    }
  });

  it.each(["rulepack", "empty", "missing-base...HEAD", "ls-files"] as const)(
    "handles changed-path discovery: %s",
    (scenario) => {
      const repo = createRepo(scenario);
      const changed =
        scenario === "rulepack"
          ? "security/opengrep/precise.yml"
          : scenario === "empty"
            ? ".github/actions/ensure-base-commit/action.yml"
            : null;
      if (scenario === "empty") {
        writeFile(path.join(repo, changed!), "name: ensure\n");
      }
      commit(repo);
      if (changed) {
        fs.appendFileSync(path.join(repo, changed), "# changed\n");
      }
      const { argsPath, binDir } = installOpengrepStub(repo);
      const sarifPath = path.join(repo, ".opengrep-out/precise.sarif");
      if (scenario === "ls-files") {
        const realGit = execFileSync("bash", ["-lc", "command -v git"], {
          encoding: "utf8",
        }).trim();
        writeFile(
          path.join(binDir, "git"),
          `#!/usr/bin/env bash
if [[ "\${1:-}" == "ls-files" ]]; then
  echo "forced git ls-files failure" >&2
  exit 71
fi
exec ${JSON.stringify(realGit)} "$@"
`,
        );
        fs.chmodSync(path.join(binDir, "git"), 0o755);
      }
      const result = runScan(
        repo,
        binDir,
        scenario === "rulepack" ? ["--changed"] : ["--changed", "--sarif", "--error"],
        scenario === "missing-base...HEAD" ? scenario : "HEAD",
      );
      if (scenario === "missing-base...HEAD" || scenario === "ls-files") {
        expect.soft(result.status).not.toBe(0);
        expect
          .soft(result.stderr)
          .toContain(scenario === "ls-files" ? "forced git ls-files failure" : scenario);
        expect.soft(fs.existsSync(argsPath)).toBe(false);
        expect.soft(fs.existsSync(sarifPath)).toBe(false);
      } else {
        expect(result.status, result.stderr).toBe(0);
        if (scenario === "rulepack") {
          expect(fs.readFileSync(argsPath, "utf8")).toContain("security/opengrep/precise.yml");
        } else {
          expect(JSON.parse(fs.readFileSync(sarifPath, "utf8"))).toMatchObject({
            version: "2.1.0",
            runs: [
              {
                tool: { driver: { name: "Opengrep OSS", semanticVersion: "1.30.2" } },
                results: [],
              },
            ],
          });
          expect(fs.existsSync(argsPath)).toBe(false);
        }
      }
    },
  );

  describe("shallow checkout preparation", () => {
    const sourceDirs = useAutoCleanupTempDirTracker(afterAll);
    let source: string;
    let staleBase: string;

    beforeAll(() => {
      source = createRepo("source", (prefix) => sourceDirs.make(prefix));
      git(source, "config", "uploadpack.allowFilter", "true");
      for (const name of ["ensure-base-commit", "git-owner"]) {
        fs.cpSync(`.github/actions/${name}`, path.join(source, ".github/actions", name), {
          recursive: true,
        });
      }
      commit(source, "base");
      staleBase = git(source, "rev-parse", "HEAD");
      git(source, "switch", "-q", "-c", "feature");
      writeFile(path.join(source, "src/pr.ts"), "export const pr = true;\n");
      commit(source, "feature");
      git(source, "switch", "-q", "main");
      writeFile(path.join(source, "src/main-only.ts"), "export const mainOnly = true;\n");
      commit(source, "main only");
      git(source, "merge", "--no-ff", "feature", "-m", "synthetic merge");
    });

    it.each([
      { shape: "partial merge", branch: "main", depth: 2, partial: true, passes: true },
      { shape: "merge without parents", branch: "main", depth: 1, partial: false, passes: false },
    ])(
      "prepares and scans a shallow $shape checkout without unrelated base fetches",
      ({ branch, depth, partial, passes }) => {
        const repo = createTempDir("openclaw-opengrep-shallow-");
        git(
          source,
          "clone",
          "--quiet",
          "--no-local",
          `--depth=${depth}`,
          ...(partial ? ["--filter=blob:none"] : []),
          "--branch",
          branch,
          source,
          repo,
        );
        expect(git(repo, "rev-parse", "--is-shallow-repository")).toBe("true");
        if (partial) {
          expect(git(repo, "config", "--get", "remote.origin.promisor")).toBe("true");
        }
        // Probe local storage only: resolving a missing object in a partial clone can fetch it.
        const localObjects = git(
          repo,
          "cat-file",
          "--batch-all-objects",
          "--batch-check=%(objectname)",
        );
        expect(localObjects.split("\n")).not.toContain(staleBase);
        const { argsPath, binDir } = installOpengrepStub(repo);
        const trace = path.join(createTempDir("openclaw-opengrep-trace-"), "git.jsonl");
        const result = runChangedPathsWorkflow(repo, staleBase, {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          RUNNER_OS:
            process.platform === "win32"
              ? "Windows"
              : process.platform === "darwin"
                ? "macOS"
                : "Linux",
          GIT_CONFIG_GLOBAL: devNull,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_ALLOW_PROTOCOL: "",
          GIT_TRACE2_EVENT: trace,
        });
        const traceEvents = fs
          .readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const fetches = traceEvents.filter(
          (event) => event.event === "cmd_name" && event.name === "fetch",
        );
        if (!passes) {
          expect(result.status, result.stderr).not.toBe(0);
          expect(result.stdout).toContain("Base commit still unavailable");
          expect(fetches).toHaveLength(6);
          const fetchArgs = (depthArg: string, ...refs: string[]) => [
            "fetch",
            "--filter=blob:none",
            "--no-tags",
            depthArg,
            "origin",
            ...refs,
          ];
          expect(
            fetches.map((event) => {
              const start = traceEvents.find(
                (candidate) => candidate.event === "start" && candidate.sid === event.sid,
              );
              expect(start).toBeDefined();
              return start.argv.slice(start.argv.indexOf("fetch"));
            }),
          ).toEqual([
            fetchArgs("--depth=1", staleBase),
            ...[25, 100, 300, 1000].map((deepenBy) =>
              fetchArgs(`--deepen=${deepenBy}`, "--", "main"),
            ),
            fetchArgs("--unshallow", "--", "main"),
          ]);
          expect(fs.existsSync(argsPath)).toBe(false);
          return;
        }
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(fetches).toEqual([]);
        const args = fs.readFileSync(argsPath, "utf8");
        expect(args).toContain("src/pr.ts");
        expect(args).not.toContain("src/main-only.ts");
      },
    );
  });
});

it("preserves raw SARIF evidence and uploads only findings without accepted source suppression", () => {
  const repo = createTempDir("openclaw-opengrep-sarif-");
  const ignored = [
    { ruleId: "in-source", suppressions: [{ kind: "inSource" }] },
    { ruleId: "accepted", suppressions: [{ kind: "inSource", status: "accepted" }] },
  ];
  const retained = [
    { ruleId: "active" },
    { ruleId: "empty", suppressions: [] },
    { ruleId: "unknown", suppressions: null },
    { ruleId: "external", suppressions: [{ kind: "external", status: "accepted" }] },
    { ruleId: "under-review", suppressions: [{ kind: "inSource", status: "underReview" }] },
    { ruleId: "rejected", suppressions: [{ kind: "inSource", status: "rejected" }] },
    { ruleId: "future-status", suppressions: [{ kind: "inSource", status: "unknown" }] },
    { ruleId: "null-status", suppressions: [{ kind: "inSource", status: null }] },
    { ruleId: "malformed", suppressions: [null] },
    {
      ruleId: "mixed",
      suppressions: [{ kind: "inSource" }, { kind: "inSource", status: "rejected" }],
    },
  ];
  const tool = { driver: { name: "Opengrep OSS", rules: [{ id: "unchanged-rule" }] } };
  const report = {
    version: "2.1.0",
    runs: [
      {
        tool,
        invocations: [{ executionSuccessful: false }],
        results: [...ignored, ...retained],
      },
      { tool, results: [] },
      { tool },
    ],
  };
  const raw = `${JSON.stringify(report, null, 2)}\n`;
  const reportPath = ".opengrep-out/precise.sarif";
  writeFile(path.join(repo, reportPath), raw);
  const steps = workflowSteps();
  const prepare = steps.find((step) => step.id === "github-sarif")!;
  writeFile(
    path.join(repo, "scripts/opengrep-github-sarif.mjs"),
    fs.readFileSync("scripts/opengrep-github-sarif.mjs", "utf8"),
  );
  expect(prepare.if).toBe("always() && hashFiles('.opengrep-out/precise.sarif') != ''");
  expect(bash(repo, prepare.run!)).toMatchObject({
    status: 0,
    stderr: expect.stringContaining(
      "Omitted 2 accepted in-source suppression(s); raw audit: .opengrep-out/precise.sarif",
    ),
  });
  const upload = steps.find((step) => step.name === "Upload SARIF to GitHub Code Scanning")!;
  const artifact = steps.find((step) => step.name === "Upload SARIF as workflow artifact")!;
  const uploadPath = upload.with?.sarif_file;
  if (!uploadPath) {
    throw new Error("Workflow must name its SARIF upload payload");
  }
  const uploaded = JSON.parse(fs.readFileSync(path.join(repo, uploadPath), "utf8"));
  expect(uploaded).toEqual({
    ...report,
    runs: [{ ...report.runs[0], results: retained }, ...report.runs.slice(1)],
  });
  expect(upload.if).toBe("always() && steps.github-sarif.outcome == 'success'");
  expect(artifact.with).toMatchObject({ path: reportPath, "if-no-files-found": "error" });
  expect(fs.readFileSync(path.join(repo, reportPath), "utf8")).toBe(raw);
});
