import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const LIVE_E2E_WORKFLOW = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
const EXACT_TARGET_REF = "1".repeat(40);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeArtifact(fileName: string, payload: unknown) {
  const root = tempDirs.make("openclaw-docker-e2e-helper-");
  const file = path.join(root, fileName);
  writeFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
  return file;
}

function runHelper(script: string, ...args: Array<string | Record<string, string>>) {
  const maybeEnv = args.at(-1);
  const env =
    maybeEnv && typeof maybeEnv === "object"
      ? (args.pop() as unknown as Record<string, string>)
      : {};
  const nodeArgs = script.endsWith(".mts")
    ? ["--import", "tsx", script, ...(args as string[])]
    : [script, ...(args as string[])];
  return spawnSync(process.execPath, nodeArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      GH_FORCE_TTY: "0",
      NO_COLOR: "1",
      ...env,
    },
  });
}

function rerun(...args: Array<string | Record<string, string>>) {
  return runHelper("scripts/docker-e2e-rerun.mts", ...args);
}

function writeFailures(overrides: Record<string, unknown> = {}) {
  return writeArtifact("failures.json", {
    lanes: [{ name: "gateway-network", status: 1 }],
    status: "failed",
    ...overrides,
  });
}

function expectUsageError(result: ReturnType<typeof runHelper>, message: string) {
  expect(result).toMatchObject({ status: 1, stdout: "" });
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toContain("Error:");
  expect(result.stderr).not.toContain("at file:");
}

function mockGitHub(
  root: string,
  artifactNames: string[],
  download: string[],
  runInfo: Record<string, unknown> = {
    headBranch: "main",
    headSha: "f".repeat(40),
    url: "https://example.invalid/run",
    workflowName: "Live E2E",
  },
) {
  const binDir = path.join(root, "bin");
  const ghPath = path.join(binDir, "gh");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    ghPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'run' && args[1] === 'view') {",
      `  console.log(JSON.stringify(${JSON.stringify(runInfo)}));`,
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api') {",
      `  console.log(JSON.stringify(${JSON.stringify(artifactNames.map((name) => ({ expired: false, name })))}));`,
      "  process.exit(0);",
      "}",
      "if (args[0] === 'run' && args[1] === 'download') {",
      ...download,
      "  process.exit(0);",
      "}",
      "console.error(`unexpected gh args: ${args.join(' ')}`);",
      "process.exit(1);",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(ghPath, 0o755);
  return { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
}

function downloadedDir(stdout: string) {
  const match = stdout.match(/^Downloaded: (.+)$/mu);
  const dir = match?.[1];
  if (!dir) {
    throw new Error(`missing downloaded dir in stdout:\n${stdout}`);
  }
  return dir;
}

function emittedWorkflowCommands(stdout: string): string[] {
  return stdout
    .split(/\r?\n/u)
    .filter((line) => line.includes("gh workflow run"))
    .map((line) => line.slice(line.indexOf("gh workflow run")));
}

function expectDeclaredDispatchInputs(command: string): void {
  const workflow = parse(readFileSync(LIVE_E2E_WORKFLOW, "utf8")) as {
    on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
  };
  const declared = new Set(Object.keys(workflow.on?.workflow_dispatch?.inputs ?? {}));
  const emitted = [...command.matchAll(/(?:^|\s)-f\s+([a-z0-9_]+)=/gu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  expect(emitted.length).toBeGreaterThan(0);
  for (const input of emitted) {
    expect(declared.has(input), `undeclared workflow_dispatch input: ${input}`).toBe(true);
  }
}

describe("Docker E2E helper CLIs", () => {
  it("prints scheduler helper help without throwing a stack trace", () => {
    const result = runHelper("scripts/docker-e2e.mjs", "--help");

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("node scripts/docker-e2e.mjs github-outputs <plan.json>");
  });

  it("prints scheduler helper usage errors without a Node stack trace", () => {
    const result = runHelper("scripts/docker-e2e.mjs");

    expectUsageError(result, "node scripts/docker-e2e.mjs github-outputs <plan.json>");
  });

  it("rejects oversized scheduler helper JSON artifacts without a Node stack trace", () => {
    const file = writeArtifact("summary.json", { filler: "x".repeat(128) });

    const result = runHelper("scripts/docker-e2e.mjs", "failed-reruns", file, {
      OPENCLAW_DOCKER_E2E_JSON_ARTIFACT_MAX_BYTES: "64",
    });

    expectUsageError(result, "JSON artifact exceeded 64 bytes");
  });

  it("prints timings help without treating --help as an artifact path", () => {
    const result = runHelper("scripts/docker-e2e-timings.mts", "--help");

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain(
      "Usage: node --import tsx scripts/docker-e2e-timings.mts <summary.json|lane-timings.json>",
    );
  });

  it("rejects unknown timings options without treating them as artifact paths", () => {
    const result = runHelper("scripts/docker-e2e-timings.mts", "--wat");

    expectUsageError(result, "unknown argument: --wat");
    expect(result.stderr).toContain(
      "Usage: node --import tsx scripts/docker-e2e-timings.mts <summary.json|lane-timings.json>",
    );
    expect(result.stderr).not.toContain("ENOENT");
  });

  it("rejects missing timings limits without a Node stack trace", () => {
    for (const limit of [undefined, "-h"]) {
      const args = ["scripts/docker-e2e-timings.mts", "summary.json", "--limit"];
      const result = runHelper(args[0]!, ...args.slice(1), ...(limit === undefined ? [] : [limit]));

      expectUsageError(result, "--limit requires a value");
    }
  });

  it("prints rerun help without detecting the GitHub repository", () => {
    const result = rerun("--help");

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain(
      "node --import tsx scripts/docker-e2e-rerun.mts <run-id|summary.json|failures.json>",
    );
  });

  it("prints local cleanup reruns without synthesizing Docker lane reruns from failures.json", () => {
    const cleanupFailure = {
      lane: "cleanup-smoke",
      logFile: "cleanup-smoke.log",
      name: "cleanup-smoke",
      rerunCommand: "pnpm test:docker:cleanup",
      status: 42,
      targetable: false,
    };
    const file = writeFailures({ lanes: [cleanupFailure], ref: "HEAD" });

    const result = rerun(file);

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("Failed Docker E2E entries: cleanup-smoke");
    expect(result.stdout).toContain("No targetable failed Docker E2E lanes found.");
    expect(result.stdout).toContain("- cleanup-smoke: pnpm test:docker:cleanup");
    expect(result.stdout).not.toContain("docker_lanes='cleanup-smoke'");
  });

  it("ignores artifact-provided GitHub rerun commands", () => {
    const file = writeArtifact("failures.json", {
      lanes: [
        {
          ghWorkflowCommand: "echo poisoned-command",
          name: "gateway-network",
          status: 1,
        },
      ],
      status: "failed",
    });

    const result = rerun(file, "--ref", EXACT_TARGET_REF);

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("docker_lanes='gateway-network'");
    expect(result.stdout).not.toContain("poisoned-command");
  });

  it("uses the exact artifact target from summary.json instead of the workflow head", () => {
    const targetRef = "a".repeat(40);
    const workflowHead = "b".repeat(40);
    const file = writeArtifact("summary.json", {
      github: { selectedSha: targetRef },
      failures: [{ name: "gateway-network", status: 1 }],
      lanes: [{ name: "gateway-network", status: 1 }],
      status: "failed",
    });

    const result = rerun(file, {
      GITHUB_SHA: workflowHead,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Ref: ${targetRef}`);
    expect(result.stdout).toContain(`-f ref='${targetRef}'`);
    expect(result.stdout).not.toContain(workflowHead);
  });

  it("lets an explicit target ref override artifact refs", () => {
    const artifactRef = "a".repeat(40);
    const explicitRef = "c".repeat(40);
    const file = writeFailures({
      images: { bare: "ghcr.io/openclaw/openclaw-bare:artifact-a" },
      ref: artifactRef,
    });

    const result = rerun(file, "--ref", explicitRef);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Ref: ${explicitRef}`);
    expect(result.stdout).toContain(`-f ref='${explicitRef}'`);
    expect(result.stdout).not.toContain(`-f ref='${artifactRef}'`);
    expect(result.stdout).not.toContain("docker_e2e_bare_image=");
    expect(result.stdout).not.toContain("shared_image_policy=existing-only");
  });

  it("requires an artifact target ref when no explicit ref is supplied", () => {
    const file = writeFailures();

    const result = rerun(file);

    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.stderr).toContain("missing an exact target ref");
    expect(result.stderr).toContain("pass --ref explicitly");
    expect(result.stderr).not.toContain("HEAD");
  });

  it("rejects a non-exact artifact target for a targetable rerun", () => {
    const file = writeFailures({ ref: "HEAD" });

    const result = rerun(file);

    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.stderr).toContain("invalid artifact target ref");
    expect(result.stderr).toContain("full commit SHA");
  });

  it.each(["abc123"])("rejects a non-exact explicit target ref: %s", (explicitRef) => {
    const file = writeFailures();

    const result = rerun(file, "--ref", explicitRef);

    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.stderr).toContain("exact lowercase 40-character target SHA");
  });

  it("preserves declared rerun inputs but ignores package and workflow refs", () => {
    const file = writeArtifact("failures.json", {
      lanes: [
        {
          ghWorkflowCommand:
            "gh workflow run 'openclaw-live-and-e2e-checks-reusable.yml' --ref 'full-release-validation-temp-deleted' -f package_artifact_run_id='12345' -f package_artifact_name='docker-e2e-package' -f docker_e2e_bare_image='ghcr.io/openclaw/openclaw-bare:test' -f published_upgrade_survivor_baselines='openclaw@2026.5.3' -f published_upgrade_survivor_scenarios='plugin-dependency-cleanup' -f allow_unreleased_changelog=true -f unsafe_input='do-not-copy'",
          name: "published-upgrade-survivor-openclaw-2026-5-3",
          status: 1,
        },
      ],
      ref: EXACT_TARGET_REF,
      status: "failed",
    });

    const result = rerun(file, "--ref", EXACT_TARGET_REF);

    expect(result).toMatchObject({ status: 0, stderr: "" });
    const combinedCommand = result.stdout.match(/Combined GitHub rerun:\n([^\n]+)/u)?.[1] ?? "";
    expect(combinedCommand).not.toContain("--ref 'full-release-validation-temp-deleted'");
    expect(combinedCommand).not.toContain("package_artifact_run_id=");
    expect(combinedCommand).not.toContain("package_artifact_name=");
    expect(combinedCommand).toContain(
      "docker_e2e_bare_image='ghcr.io/openclaw/openclaw-bare:test'",
    );
    expect(combinedCommand).toContain("shared_image_policy=existing-only");
    expect(combinedCommand).toContain("published_upgrade_survivor_baselines='openclaw@2026.5.3'");
    expect(combinedCommand).toContain(
      "published_upgrade_survivor_scenarios='plugin-dependency-cleanup'",
    );
    expect(combinedCommand).toContain("allow_unreleased_changelog=true");
    expect(combinedCommand).not.toContain("unsafe_input");
    expect(result.stdout).not.toContain("package_artifact_run_id=");
    expect(result.stdout).not.toContain("package_artifact_name=");
    expect(result.stdout).toContain("docker_e2e_bare_image='ghcr.io/openclaw/openclaw-bare:test'");
    expect(result.stdout).toContain("shared_image_policy=existing-only");
    expect(result.stdout).toContain("published_upgrade_survivor_baselines='openclaw@2026.5.3'");
    expect(result.stdout).toContain(
      "published_upgrade_survivor_scenarios='plugin-dependency-cleanup'",
    );
    expect(result.stdout).not.toContain("unsafe_input");
    expect(result.stdout).not.toContain("do-not-copy");
    const commands = emittedWorkflowCommands(result.stdout);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expectDeclaredDispatchInputs(command);
    }
  });

  it("downloads GitHub run artifacts into distinct default directories", () => {
    const root = tempDirs.make("openclaw-docker-e2e-rerun-gh-");
    const generatedDirs: string[] = [];
    try {
      const env = mockGitHub(
        root,
        ["docker-e2e-gateway-network"],
        [
          "  const dir = args[args.indexOf('--dir') + 1];",
          "  fs.mkdirSync(path.join(dir, 'artifact'), { recursive: true });",
          "  fs.writeFileSync(path.join(dir, 'artifact', 'failures.json'), JSON.stringify({",
          "    lanes: [{ name: 'gateway-network', status: 1 }],",
          "    ref: 'd'.repeat(40),",
          "    status: 'failed',",
          "  }));",
        ],
        {
          conclusion: "failure",
          databaseId: 12345,
          headBranch: "main",
          headSha: "abc123",
          status: "completed",
          url: "https://github.com/openclaw/openclaw/actions/runs/12345",
          workflowName: "OpenClaw Live and E2E Checks",
        },
      );
      const first = rerun("12345", "--repo", "openclaw/openclaw", env);
      const second = rerun("12345", "--repo", "openclaw/openclaw", env);

      expect(first.status, first.stderr).toBe(0);
      expect(second.status, second.stderr).toBe(0);
      const firstDir = downloadedDir(first.stdout);
      const secondDir = downloadedDir(second.stdout);
      generatedDirs.push(firstDir, secondDir);
      expect(firstDir).not.toBe(secondDir);
      for (const [dir, result] of [
        [firstDir, first],
        [secondDir, second],
      ] as const) {
        expect(path.basename(dir)).toMatch(/^openclaw-docker-e2e-rerun-12345-/u);
        const artifactDir = readdirSync(dir, { withFileTypes: true }).find((entry) =>
          entry.isDirectory(),
        );
        expect(artifactDir).toBeDefined();
        expect(
          existsSync(path.join(dir, artifactDir?.name ?? "", "artifact", "failures.json")),
        ).toBe(true);
        expect(result.stdout).toContain(`-f ref='${"d".repeat(40)}'`);
      }
      expect(first.stdout).not.toContain("-f ref='abc123'");
    } finally {
      for (const dir of generatedDirs) {
        rmSync(dir, { force: true, recursive: true });
      }
    }
  });

  it("isolates files with the same name across downloaded artifacts", () => {
    const root = tempDirs.make("openclaw-docker-e2e-rerun-collisions-");
    const env = mockGitHub(
      root,
      ["docker-e2e-a", "docker-e2e-b"],
      [
        "  const name = args[args.indexOf('--name') + 1];",
        "  const dir = args[args.indexOf('--dir') + 1];",
        "  fs.mkdirSync(dir, { recursive: true });",
        "  const plan = path.join(dir, 'targeted-plan.json');",
        "  if (fs.existsSync(plan)) {",
        "    console.error('targeted-plan.json already exists');",
        "    process.exit(2);",
        "  }",
        "  fs.writeFileSync(plan, '{}');",
        "  fs.writeFileSync(path.join(dir, 'failures.json'), JSON.stringify({",
        "    lanes: [{ name: name.endsWith('-a') ? 'gateway-network' : 'install-e2e', status: 1 }],",
        "    ref: 'd'.repeat(40),",
        "    status: 'failed',",
        "  }));",
      ],
    );
    const outputDir = path.join(root, "artifacts");

    const result = rerun("12345", "--repo", "openclaw/openclaw", "--dir", outputDir, env);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("gateway-network");
    expect(result.stdout).toContain("install-e2e");
    const artifactDirs = readdirSync(outputDir, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    );
    expect(artifactDirs).toHaveLength(2);
    for (const entry of artifactDirs) {
      expect(existsSync(path.join(outputDir, entry.name, "targeted-plan.json"))).toBe(true);
    }
  });

  it("fails closed when downloaded artifacts contain mixed target refs", () => {
    const root = tempDirs.make("openclaw-docker-e2e-rerun-mixed-refs-");
    const env = mockGitHub(
      root,
      ["docker-e2e-a", "docker-e2e-b"],
      [
        "  const name = args[args.indexOf('--name') + 1];",
        "  const dir = args[args.indexOf('--dir') + 1];",
        "  const target = path.join(dir, name);",
        "  fs.mkdirSync(target, { recursive: true });",
        "  fs.writeFileSync(path.join(target, 'failures.json'), JSON.stringify({",
        "    lanes: [{ name: name.endsWith('-a') ? 'gateway-network' : 'install-e2e', status: 1 }],",
        "    ref: (name.endsWith('-a') ? 'a' : 'b').repeat(40),",
        "    status: 'failed',",
        "  }));",
      ],
    );
    const outputDir = path.join(root, "artifacts");

    const result = rerun("12345", "--repo", "openclaw/openclaw", "--dir", outputDir, env);

    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.stderr).toContain("mixed target refs");
    expect(result.stderr).toContain("a".repeat(40));
    expect(result.stderr).toContain("b".repeat(40));

    const explicitRef = "c".repeat(40);
    const override = rerun(
      "12345",
      "--repo",
      "openclaw/openclaw",
      "--dir",
      outputDir,
      "--ref",
      explicitRef,
      env,
    );
    expect(override.status, override.stderr).toBe(0);
    expect(override.stdout).toContain(`-f ref='${explicitRef}'`);
  });
});
