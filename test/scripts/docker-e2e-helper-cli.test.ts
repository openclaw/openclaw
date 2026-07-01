// Docker E2E Helper Cli tests cover docker e2e helper cli script behavior.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function runHelper(script: string, ...args: Array<string | Record<string, string>>) {
  const maybeEnv = args.at(-1);
  const env =
    maybeEnv && typeof maybeEnv === "object"
      ? (args.pop() as unknown as Record<string, string>)
      : {};
  return spawnSync(process.execPath, [script, ...(args as string[])], {
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

function downloadedDir(stdout: string) {
  const match = stdout.match(/^Downloaded: (.+)$/mu);
  const dir = match?.[1];
  if (!dir) {
    throw new Error(`missing downloaded dir in stdout:\n${stdout}`);
  }
  return dir;
}

describe("Docker E2E helper CLIs", () => {
  it("prints scheduler helper help without throwing a stack trace", () => {
    const result = runHelper("scripts/docker-e2e.mjs", "--help");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("node scripts/docker-e2e.mjs github-outputs <plan.json>");
  });

  it("prints scheduler helper usage errors without a Node stack trace", () => {
    const result = runHelper("scripts/docker-e2e.mjs");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("node scripts/docker-e2e.mjs github-outputs <plan.json>");
    expect(result.stderr).not.toContain("Error:");
    expect(result.stderr).not.toContain("at file:");
  });

  it("rejects oversized scheduler helper JSON artifacts without a Node stack trace", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-helper-`);
    try {
      const file = path.join(root, "summary.json");
      writeFileSync(file, `${JSON.stringify({ filler: "x".repeat(128) })}\n`, "utf8");

      const result = runHelper("scripts/docker-e2e.mjs", "failed-reruns", file, {
        OPENCLAW_DOCKER_E2E_JSON_ARTIFACT_MAX_BYTES: "64",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("JSON artifact exceeded 64 bytes");
      expect(result.stderr).not.toContain("Error:");
      expect(result.stderr).not.toContain("at file:");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("prints timings help without treating --help as an artifact path", () => {
    const result = runHelper("scripts/docker-e2e-timings.mjs", "--help");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Usage: node scripts/docker-e2e-timings.mjs <summary.json|lane-timings.json>",
    );
  });

  it("rejects malformed timings limits without a Node stack trace", () => {
    const result = runHelper("scripts/docker-e2e-timings.mjs", "summary.json", "--limit=1e3");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--limit must be a positive integer");
    expect(result.stderr).not.toContain("Error:");
    expect(result.stderr).not.toContain("at file:");
  });

  it("rejects unknown timings options without treating them as artifact paths", () => {
    const result = runHelper("scripts/docker-e2e-timings.mjs", "--wat");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown argument: --wat");
    expect(result.stderr).toContain(
      "Usage: node scripts/docker-e2e-timings.mjs <summary.json|lane-timings.json>",
    );
    expect(result.stderr).not.toContain("ENOENT");
    expect(result.stderr).not.toContain("Error:");
    expect(result.stderr).not.toContain("at file:");
  });

  it("rejects oversized timing JSON artifacts without a Node stack trace", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-timings-`);
    try {
      const file = path.join(root, "summary.json");
      writeFileSync(file, `${JSON.stringify({ filler: "x".repeat(128) })}\n`, "utf8");

      const result = runHelper("scripts/docker-e2e-timings.mjs", file, {
        OPENCLAW_DOCKER_E2E_JSON_ARTIFACT_MAX_BYTES: "64",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("JSON artifact exceeded 64 bytes");
      expect(result.stderr).not.toContain("Error:");
      expect(result.stderr).not.toContain("at file:");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects missing timings limits without a Node stack trace", () => {
    for (const limit of [undefined, "-h"]) {
      const args = ["scripts/docker-e2e-timings.mjs", "summary.json", "--limit"];
      const result = runHelper(...(limit === undefined ? args : [...args, limit]));

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--limit requires a value");
      expect(result.stderr).not.toContain("Error:");
      expect(result.stderr).not.toContain("at file:");
    }
  });

  it("prints rerun help without detecting the GitHub repository", () => {
    const result = runHelper("scripts/docker-e2e-rerun.mjs", "--help");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "node scripts/docker-e2e-rerun.mjs <run-id|summary.json|failures.json>",
    );
  });

  it("rejects oversized rerun JSON artifacts without a Node stack trace", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-`);
    try {
      const file = path.join(root, "summary.json");
      writeFileSync(file, `${JSON.stringify({ filler: "x".repeat(128) })}\n`, "utf8");

      const result = runHelper("scripts/docker-e2e-rerun.mjs", file, "--ref", "abc123", {
        OPENCLAW_DOCKER_E2E_JSON_ARTIFACT_MAX_BYTES: "64",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("JSON artifact exceeded 64 bytes");
      expect(result.stderr).not.toContain("Error:");
      expect(result.stderr).not.toContain("at file:");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each(["summary.json", "failures.json"])(
    "prints local cleanup reruns without synthesizing Docker lane reruns from %s",
    (fileName) => {
      const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-`);
      try {
        const cleanupFailure = {
          lane: "cleanup-smoke",
          logFile: "cleanup-smoke.log",
          name: "cleanup-smoke",
          rerunCommand: "pnpm test:docker:cleanup",
          status: 42,
          targetable: false,
        };
        const payload =
          fileName === "summary.json"
            ? {
                failures: [cleanupFailure],
                lanes: [
                  {
                    name: "gateway-network",
                    status: 0,
                  },
                ],
                status: "failed",
              }
            : {
                lanes: [cleanupFailure],
                status: "failed",
              };
        const file = path.join(root, fileName);
        writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

        const result = runHelper("scripts/docker-e2e-rerun.mjs", file, "--ref", "abc123");

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("Failed Docker E2E entries: cleanup-smoke");
        expect(result.stdout).toContain("No targetable failed Docker E2E lanes found.");
        expect(result.stdout).toContain("- cleanup-smoke: pnpm test:docker:cleanup");
        expect(result.stdout).not.toContain("docker_lanes='cleanup-smoke'");
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("ignores artifact-provided GitHub rerun commands", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-command-`);
    try {
      const file = path.join(root, "failures.json");
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            lanes: [
              {
                ghWorkflowCommand: "echo poisoned-command",
                name: "gateway-network",
                status: 1,
              },
            ],
            status: "failed",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const result = runHelper("scripts/docker-e2e-rerun.mjs", file, "--ref", "abc123");

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("docker_lanes='gateway-network'");
      expect(result.stdout).not.toContain("poisoned-command");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("preserves whitelisted rerun inputs from artifact commands", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-inputs-`);
    try {
      const file = path.join(root, "failures.json");
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            lanes: [
              {
                ghWorkflowCommand:
                  "gh workflow run 'openclaw-live-and-e2e-checks-reusable.yml' --ref 'release/2026.6' -f package_artifact_run_id='12345' -f package_artifact_name='docker-e2e-package' -f docker_e2e_bare_image='ghcr.io/openclaw/openclaw-bare:test' -f published_upgrade_survivor_baselines='openclaw@2026.5.3' -f published_upgrade_survivor_scenarios='plugin-dependency-cleanup' -f unsafe_input='do-not-copy'",
                name: "published-upgrade-survivor-openclaw-2026-5-3",
                status: 1,
              },
            ],
            status: "failed",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const result = runHelper("scripts/docker-e2e-rerun.mjs", file, "--ref", "abc123");

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const combinedCommand = result.stdout.match(/Combined GitHub rerun:\n([^\n]+)/u)?.[1] ?? "";
      expect(combinedCommand).toContain("--ref 'release/2026.6'");
      expect(combinedCommand).toContain("package_artifact_run_id='12345'");
      expect(combinedCommand).toContain(
        "docker_e2e_bare_image='ghcr.io/openclaw/openclaw-bare:test'",
      );
      expect(combinedCommand).toContain(
        "published_upgrade_survivor_baselines='openclaw@2026.5.3'",
      );
      expect(combinedCommand).toContain(
        "published_upgrade_survivor_scenarios='plugin-dependency-cleanup'",
      );
      expect(combinedCommand).not.toContain("unsafe_input");
      expect(result.stdout).toContain("package_artifact_run_id='12345'");
      expect(result.stdout).toContain(
        "docker_e2e_bare_image='ghcr.io/openclaw/openclaw-bare:test'",
      );
      expect(result.stdout).toContain(
        "published_upgrade_survivor_baselines='openclaw@2026.5.3'",
      );
      expect(result.stdout).toContain(
        "published_upgrade_survivor_scenarios='plugin-dependency-cleanup'",
      );
      expect(result.stdout).not.toContain("unsafe_input");
      expect(result.stdout).not.toContain("do-not-copy");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("groups combined reruns by recovered workflow inputs", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-groups-`);
    try {
      const file = path.join(root, "failures.json");
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            lanes: [
              {
                ghWorkflowCommand:
                  "gh workflow run 'openclaw-live-and-e2e-checks-reusable.yml' --ref 'release/2026.6' -f published_upgrade_survivor_baselines='openclaw@2026.5.3'",
                name: "published-upgrade-survivor-openclaw-2026-5-3",
                status: 1,
              },
              {
                ghWorkflowCommand:
                  "gh workflow run 'openclaw-live-and-e2e-checks-reusable.yml' --ref 'release/2026.6' -f published_upgrade_survivor_baselines='openclaw@2026.5.2'",
                name: "published-upgrade-survivor-openclaw-2026-5-2",
                status: 1,
              },
            ],
            status: "failed",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const result = runHelper("scripts/docker-e2e-rerun.mjs", file, "--ref", "abc123");

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Combined GitHub reruns:");
      expect(result.stdout).toContain(
        "- published-upgrade-survivor-openclaw-2026-5-3: gh workflow run",
      );
      expect(result.stdout).toContain(
        "- published-upgrade-survivor-openclaw-2026-5-2: gh workflow run",
      );
      expect(result.stdout).toContain(
        "docker_lanes='published-upgrade-survivor-openclaw-2026-5-3'",
      );
      expect(result.stdout).toContain(
        "docker_lanes='published-upgrade-survivor-openclaw-2026-5-2'",
      );
      expect(result.stdout).not.toContain(
        "docker_lanes='published-upgrade-survivor-openclaw-2026-5-3 published-upgrade-survivor-openclaw-2026-5-2'",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("merges duplicate lane entries before printing reruns", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-merge-`);
    try {
      const file = path.join(root, "failures.json");
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            lanes: [
              {
                name: "published-upgrade-survivor-openclaw-2026-5-3",
                status: 1,
              },
              {
                ghWorkflowCommand:
                  "gh workflow run 'openclaw-live-and-e2e-checks-reusable.yml' --ref 'release/2026.6' -f published_upgrade_survivor_baselines='openclaw@2026.5.3'",
                name: "published-upgrade-survivor-openclaw-2026-5-3",
                status: 1,
              },
            ],
            status: "failed",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const result = runHelper("scripts/docker-e2e-rerun.mjs", file, "--ref", "abc123");

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const combinedCommand = result.stdout.match(/Combined GitHub rerun:\n([^\n]+)/u)?.[1] ?? "";
      expect(combinedCommand).toContain("--ref 'release/2026.6'");
      expect(combinedCommand).toContain(
        "published_upgrade_survivor_baselines='openclaw@2026.5.3'",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("downloads GitHub run artifacts into distinct default directories", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-gh-`);
    const generatedDirs: string[] = [];
    try {
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
          "  console.log(JSON.stringify({",
          "    conclusion: 'failure',",
          "    databaseId: 12345,",
          "    headBranch: 'main',",
          "    headSha: 'abc123',",
          "    status: 'completed',",
          "    url: 'https://github.com/openclaw/openclaw/actions/runs/12345',",
          "    workflowName: 'OpenClaw Live and E2E Checks',",
          "  }));",
          "  process.exit(0);",
          "}",
          "if (args[0] === 'api') {",
          "  console.log(JSON.stringify([{ expired: false, name: 'docker-e2e-gateway-network' }]));",
          "  process.exit(0);",
          "}",
          "if (args[0] === 'run' && args[1] === 'download') {",
          "  const dir = args[args.indexOf('--dir') + 1];",
          "  fs.mkdirSync(path.join(dir, 'artifact'), { recursive: true });",
          "  fs.writeFileSync(path.join(dir, 'artifact', 'failures.json'), JSON.stringify({",
          "    lanes: [{ name: 'gateway-network', status: 1 }],",
          "    status: 'failed',",
          "  }));",
          "  process.exit(0);",
          "}",
          "console.error(`unexpected gh args: ${args.join(' ')}`);",
          "process.exit(1);",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(ghPath, 0o755);

      const env = {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      };
      const first = runHelper(
        "scripts/docker-e2e-rerun.mjs",
        "12345",
        "--repo",
        "openclaw/openclaw",
        env,
      );
      const second = runHelper(
        "scripts/docker-e2e-rerun.mjs",
        "12345",
        "--repo",
        "openclaw/openclaw",
        env,
      );

      expect(first.status, first.stderr).toBe(0);
      expect(second.status, second.stderr).toBe(0);
      const firstDir = downloadedDir(first.stdout);
      const secondDir = downloadedDir(second.stdout);
      generatedDirs.push(firstDir, secondDir);
      expect(firstDir).not.toBe(secondDir);
      expect(path.basename(firstDir)).toMatch(/^openclaw-docker-e2e-rerun-12345-/u);
      expect(path.basename(secondDir)).toMatch(/^openclaw-docker-e2e-rerun-12345-/u);
      expect(existsSync(path.join(firstDir, "artifact", "failures.json"))).toBe(true);
      expect(existsSync(path.join(secondDir, "artifact", "failures.json"))).toBe(true);
    } finally {
      for (const dir of generatedDirs) {
        rmSync(dir, { force: true, recursive: true });
      }
      rmSync(root, { force: true, recursive: true });
    }
  });
});
