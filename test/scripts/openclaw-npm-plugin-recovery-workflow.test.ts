import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type Workflow = { jobs: Record<string, { steps: { name?: string; run?: string }[] }> };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const modes = [
  ["recovery", true],
  ["canonical", true],
  ["untrusted", false],
  ["wrong-workflow", false],
  ["wrong-path", false],
  ["wrong-source", false],
  ["candidate-publisher", false],
] as const;
const releaseBranch = "extended-stable/2026.7.33";
function verifyPluginRun(mode: (typeof modes)[number][0]) {
  const root = tempDirs.make("openclaw-plugin-recovery-");
  const trusted = join(root, "trusted-workflow");
  const write = (file: string, data: string | Record<string, unknown>, fileMode = 0o666) => {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data), { mode: fileMode });
    return path;
  };
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
  const init = (cwd: string, message: string) => {
    git(cwd, "init", "--initial-branch=main");
    git(cwd, "commit", "--allow-empty", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  write(
    "scripts/openclaw-npm-extended-stable-release.mjs",
    'throw new Error("Candidate verifier must not own recovery policy");\n',
  );
  const sourceSha = init(root, "candidate");
  mkdirSync(join(trusted, "scripts/lib"), { recursive: true });
  for (const path of [
    "scripts/openclaw-npm-extended-stable-release.mjs",
    "scripts/plugin-sdk-api-release-evidence.mjs",
    "scripts/lib/release-version.mjs",
  ]) {
    copyFileSync(path, join(trusted, path));
  }
  const toolingSha = init(trusted, "trusted tooling");
  git(trusted, "checkout", "--orphan", "untrusted");
  git(trusted, "commit", "--allow-empty", "-m", "untrusted tooling");
  const untrustedSha = git(trusted, "rev-parse", "HEAD");
  git(trusted, "checkout", "main");
  write(
    "bin/gh",
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
    0o755,
  );
  const runTitle = `Plugin NPM Release [extended-stable] ${mode === "wrong-source" ? "c".repeat(40) : sourceSha}`;
  const workflowFile = write("workflow.json", {
    name: mode === "wrong-workflow" ? "CI" : "Plugin NPM Release",
  });
  const runFile = write("run.json", {
    // Real REST runs expose their dynamic title in both fields, not the workflow name.
    name: runTitle,
    display_title: runTitle,
    workflow_id: 247919831,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_branch: mode === "canonical" ? releaseBranch : "main",
    head_sha: mode === "canonical" ? sourceSha : mode === "untrusted" ? untrustedSha : toolingSha,
    path: `.github/workflows/${mode === "wrong-path" ? "ci" : "plugin-npm-release"}.yml`,
  });
  const workflow = parse(
    readFileSync(".github/workflows/openclaw-npm-release.yml", "utf8"),
  ) as Workflow;
  const command = expectDefined(
    workflow.jobs.publish_openclaw_npm?.steps.find(
      (step) => step.name === "Verify plugin npm release run metadata",
    )?.run,
    "plugin evidence verification step",
  );
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
      EXPECTED_EXTENDED_STABLE_BRANCH: releaseBranch,
      RUN_KIND: "plugin",
      WORKFLOW_REF: `refs/heads/${mode === "candidate-publisher" ? releaseBranch : "main"}`,
      WORKFLOW_SHA: toolingSha,
    },
  });
}

// Publication runs on Ubuntu; exercise its shell and trusted verifier, not candidate code.
it.skipIf(process.platform === "win32").each(modes)(
  "verifies %s recovery evidence",
  (mode, accepted) => {
    const result = verifyPluginRun(mode);
    expect(result.status === 0, result.stderr).toBe(accepted);
    if (accepted) {
      expect(result.stdout).toContain("Verified referenced plugin run.");
    } else {
      expect(result.stderr).not.toContain("Candidate verifier must not own recovery policy");
    }
  },
);
