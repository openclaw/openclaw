import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Workflow = { jobs: Record<string, { steps: { name?: string; run?: string }[] }> };

function verifyPluginRun(
  mode:
    | "recovery"
    | "canonical"
    | "untrusted"
    | "wrong-workflow"
    | "wrong-path"
    | "wrong-source"
    | "candidate-publisher",
) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-plugin-recovery-"));
  const trusted = join(root, "trusted-workflow");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Release Test", "-c", "user.email=release@example.test", ...args],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    ).trim();
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "scripts/openclaw-npm-extended-stable-release.mjs"),
      'throw new Error("Candidate verifier must not own recovery policy");\n',
    );
    git(root, "init", "--initial-branch=main");
    git(root, "commit", "--allow-empty", "-m", "candidate");
    const sourceSha = git(root, "rev-parse", "HEAD");
    mkdirSync(join(trusted, "scripts/lib"), { recursive: true });
    for (const path of [
      "scripts/openclaw-npm-extended-stable-release.mjs",
      "scripts/lib/release-version.mjs",
    ]) {
      copyFileSync(path, join(trusted, path));
    }
    git(trusted, "init", "--initial-branch=main");
    git(trusted, "commit", "--allow-empty", "-m", "trusted tooling");
    const toolingSha = git(trusted, "rev-parse", "HEAD");
    git(trusted, "checkout", "--orphan", "untrusted");
    git(trusted, "commit", "--allow-empty", "-m", "untrusted tooling");
    const untrustedSha = git(trusted, "rev-parse", "HEAD");
    git(trusted, "checkout", "main");
    mkdirSync(join(root, "bin"));
    writeFileSync(
      join(root, "bin/gh"),
      `#!/bin/sh
set -eu
test "$1" = api
case "$2" in
  repos/openclaw/openclaw/actions/runs/123) fixture="$PLUGIN_RUN_FIXTURE" ;;
  repos/openclaw/openclaw/actions/workflows/247919831) fixture="$PLUGIN_WORKFLOW_FIXTURE" ;;
  *) echo "Unexpected GitHub API endpoint: $2" >&2; exit 1 ;;
esac
shift 2
if [ "$#" -eq 0 ]; then
  cat "$fixture"
else
  test "$1" = --jq
  jq -r "$2" "$fixture"
fi
`,
      { mode: 0o755 },
    );
    const runFile = join(root, "run.json");
    const workflowFile = join(root, "workflow.json");
    const runTitle = `Plugin NPM Release [extended-stable] ${mode === "wrong-source" ? "c".repeat(40) : sourceSha}`;
    writeFileSync(
      workflowFile,
      JSON.stringify({ name: mode === "wrong-workflow" ? "CI" : "Plugin NPM Release" }),
    );
    writeFileSync(
      runFile,
      JSON.stringify({
        // Real REST runs expose their dynamic title in both fields, not the workflow name.
        name: runTitle,
        display_title: runTitle,
        workflow_id: 247919831,
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        head_branch: mode === "canonical" ? "extended-stable/2026.7.33" : "main",
        head_sha:
          mode === "canonical" ? sourceSha : mode === "untrusted" ? untrustedSha : toolingSha,
        path:
          mode === "wrong-path"
            ? ".github/workflows/ci.yml"
            : ".github/workflows/plugin-npm-release.yml",
      }),
    );
    const workflow = parse(
      readFileSync(".github/workflows/openclaw-npm-release.yml", "utf8"),
    ) as Workflow;
    const command = workflow.jobs.publish_openclaw_npm?.steps.find(
      (step) => step.name === "Verify plugin npm release run metadata",
    )?.run;
    if (!command) {
      throw new Error("Missing plugin evidence verification step");
    }
    return spawnSync("bash", ["-euo", "pipefail", "-c", command], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PLUGIN_RUN_FIXTURE: runFile,
        PLUGIN_WORKFLOW_FIXTURE: workflowFile,
        PLUGIN_NPM_RUN_ID: "123",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        RELEASE_NPM_DIST_TAG: "extended-stable",
        EXPECTED_EXTENDED_STABLE_BRANCH: "extended-stable/2026.7.33",
        RUN_KIND: "plugin",
        WORKFLOW_REF:
          mode === "candidate-publisher"
            ? "refs/heads/extended-stable/2026.7.33"
            : "refs/heads/main",
        WORKFLOW_SHA: toolingSha,
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Publication runs on Ubuntu; the fixture executes its POSIX shell and PATH.
describe.skipIf(process.platform === "win32")(
  "core publication consumes plugin recovery evidence",
  () => {
    it.each(["recovery", "canonical"] as const)(
      "accepts %s REST evidence with a dynamic run name through the trusted verifier",
      (mode) => {
        const result = verifyPluginRun(mode);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("Verified referenced plugin run.");
      },
    );

    it.each([
      "untrusted",
      "wrong-workflow",
      "wrong-path",
      "wrong-source",
      "candidate-publisher",
    ] as const)("rejects %s evidence", (mode) => {
      const result = verifyPluginRun(mode);
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).not.toContain("Candidate verifier must not own recovery policy");
    });
  },
);
