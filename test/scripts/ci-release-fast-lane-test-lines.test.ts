import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readCiWorkflow,
  requiredWorkflowStep,
  runWorkflowShellScript,
} from "./ci-workflow.test-support.js";

type WorkflowStep = {
  name?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
};

const workflow = readCiWorkflow() as { jobs: Record<string, { steps: WorkflowStep[] }> };
const securityFast = workflow.jobs["security-fast"];
if (!securityFast) {
  throw new Error("ci.yml is missing the security-fast job");
}
const step = requiredWorkflowStep(securityFast.steps, "Check release fast lane test-line budget");
const stepShell = step.run;
if (!stepShell) {
  throw new Error("release fast lane step has no run script");
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function runStep(params: { baseSha: string; checkerExit: number }) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-fast-lane-"));
  roots.push(root);
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  const argsFile = path.join(root, "args.json");
  writeFileSync(
    path.join(root, "scripts", "check-test-lines-ratchet.mts"),
    [
      'import { writeFileSync } from "node:fs";',
      "const argsFile = process.env.STUB_ARGS_FILE;",
      "if (argsFile) {",
      '  writeFileSync(argsFile, JSON.stringify(process.argv.slice(2)), "utf8");',
      "}",
      'console.log(process.env.STUB_MESSAGE ?? "stub");',
      'process.exit(Number(process.env.STUB_EXIT ?? "0"));',
      "",
    ].join("\n"),
    "utf8",
  );
  const result = runWorkflowShellScript(stepShell, {
    cwd: root,
    env: {
      ...process.env,
      BASE_SHA: params.baseSha,
      STUB_ARGS_FILE: argsFile,
      STUB_EXIT: String(params.checkerExit),
      STUB_MESSAGE:
        params.checkerExit === 0
          ? "Test lines: 10; ceiling: 12; slack: 2."
          : "Test lines: 15; ceiling: 12; over by: 3; net delta: +3.",
    },
  });
  return { result, argsFile };
}

describe("release fast lane test-line budget", () => {
  it("runs only for labeled fast-lane pull requests after the verified base", () => {
    expect(step.if).toContain("github.event_name == 'pull_request'");
    expect(step.if).toContain(
      "contains(github.event.pull_request.labels.*.name, 'release-fast-lane')",
    );
    expect(step.if).toContain("steps.node_setup.outcome == 'success'");
    expect(step.if).toContain("steps.diff_base.outcome == 'success'");
    expect(step.env?.BASE_SHA).toBe("${{ steps.diff_base.outputs.sha }}");
    expect(stepShell).toContain(
      'node scripts/check-test-lines-ratchet.mts --base "$BASE_SHA" --no-merge-base',
    );
  });

  it("rejects unallocated growth against the merge's first parent", () => {
    const baseSha = "a".repeat(40);
    const { result, argsFile } = runStep({ baseSha, checkerExit: 1 });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("over by: 3");
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual([
      "--base",
      baseSha,
      "--no-merge-base",
    ]);
  });

  it("passes when the checker accepts the tree", () => {
    const { result } = runStep({ baseSha: "b".repeat(40), checkerExit: 0 });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("slack: 2");
  });

  it("fails closed when the merge has no verified first parent", () => {
    const { result } = runStep({ baseSha: "0".repeat(40), checkerExit: 0 });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("verified first parent");
  });
});
