import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workflowRef = "release-publish/aaaaaaaaaaaa-123";
const workflowSha = "a".repeat(40);
const releaseTag = "v2026.9.5";
const repository = "openclaw/openclaw";

const dispatchCommand =
  'require_clawhub_dispatch_available "$WORKFLOW_REF" "$WORKFLOW"\ndispatch_workflow_at_ref "$WORKFLOW_REF" "$PARENT_WORKFLOW_SHA" "$WORKFLOW" -f release_tag="$RELEASE_TAG"';

function fixture({
  workflow = "plugin-clawhub-release.yml",
  parentStatus = "completed",
  parentConclusion = "failure",
  childStatus = "waiting",
  titleTag = releaseTag,
  sameToolingRef = false,
  validation = false,
  legacyTitle = false,
  actor = "github-actions[bot]",
  cancellationFails = false,
  publisherRunning = false,
} = {}) {
  const root = tempDirs.make("release-clawhub-children-");
  const currentWorkflowRef = workflow === "plugin-clawhub-new.yml" ? "main" : workflowRef;
  mkdirSync(join(root, "bin"));
  const repo = { full_name: repository };
  const identity = { event: "workflow_dispatch", repository: repo, head_repository: repo };
  const child = {
    ...identity,
    id: 91,
    path: `.github/workflows/${workflow}`,
    actor: { login: actor },
    head_branch: sameToolingRef ? currentWorkflowRef : "release-publish/bbbbbbbbbbbb-123",
    display_title: legacyTitle
      ? "Plugin ClawHub New"
      : `${workflow} [${titleTag}] ${validation ? "validation" : "publish"} parent=80/1`,
    status: childStatus,
    html_url: `https://github.com/${repository}/actions/runs/91`,
  };
  const parent = {
    ...identity,
    id: 80,
    run_attempt: 1,
    path: ".github/workflows/openclaw-release-publish.yml",
    status: parentStatus,
    conclusion: parentConclusion || null,
  };
  writeFileSync(join(root, "child.json"), JSON.stringify(child));
  writeFileSync(join(root, "calls"), "");
  writeFileSync(join(root, "env"), "");
  writeFileSync(
    join(root, "bin", "gh"),
    `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const root = process.env.FIXTURE_ROOT;
const args = process.argv.slice(2);
appendFileSync(root + '/calls', JSON.stringify(args) + '\\n');
const child = JSON.parse(readFileSync(root + '/child.json', 'utf8'));
const endpoint = args.find(arg => arg.startsWith('repos/')) || '';
if (args[0] === 'run' && args[1] === 'list') {
  const matches = args[args.indexOf('--workflow') + 1] === ${JSON.stringify(workflow)} &&
    args[args.indexOf('--status') + 1] === child.status &&
    (!args.includes('--branch') || args[args.indexOf('--branch') + 1] === child.head_branch);
  console.log(JSON.stringify(matches ? [{ databaseId: child.id, headBranch: child.head_branch, displayTitle: child.display_title, url: child.html_url }] : []));
} else if (args[0] === 'api' && endpoint.endsWith('/pending_deployments')) {
  if (args.includes('POST')) {
    if (${cancellationFails}) { console.error('HTTP 403'); process.exit(1); }
    child.status = 'completed'; child.conclusion = 'failure';
    writeFileSync(root + '/child.json', JSON.stringify(child));
    console.log('[]');
  } else console.log(JSON.stringify(child.status === 'completed' ? [] : [{environment: {id: 7, name: 'clawhub-plugin-release'}, current_user_can_approve: false}]));
} else if (args[0] === 'api' && endpoint.endsWith('/runs/91')) {
  console.log(JSON.stringify(child));
} else if (args[0] === 'api' && endpoint.endsWith('/runs/80')) {
  console.log(JSON.stringify(${JSON.stringify(parent)}));
} else if (args[0] === 'api' && endpoint.endsWith('/runs/92')) {
  console.log(JSON.stringify({status: 'waiting'}));
} else if (args[0] === 'api' && endpoint.includes('/commits/')) {
  console.log(${JSON.stringify(workflowSha)});
} else if (args[0] === 'api' && endpoint.endsWith('/dispatches')) {
  console.log(JSON.stringify({workflow_run_id: 92, html_url: 'https://github.com/openclaw/openclaw/actions/runs/92'}));
} else if (args[0] === 'run' && args[1] === 'view') {
  console.log(JSON.stringify(args.includes('jobs') ? {jobs: [{status: ${JSON.stringify(publisherRunning ? "in_progress" : "waiting")}}]} : {headSha: ${JSON.stringify(workflowSha)}, url: 'https://github.com/openclaw/openclaw/actions/runs/92'}));
} else if (args[0] === 'run' && args[1] === 'cancel') {
  if (${cancellationFails}) process.exit(1);
  child.status = 'completed'; child.conclusion = 'cancelled';
  writeFileSync(root + '/child.json', JSON.stringify(child));
} else throw new Error('Unexpected operation: ' + JSON.stringify(args));
`,
    { mode: 0o755 },
  );
  return {
    run(command = dispatchCommand) {
      const result = spawnSync("bash", ["-c", `source "$HELPER_SCRIPT"\n${command}`], {
        encoding: "utf8",
        env: {
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          FIXTURE_ROOT: root,
          HELPER_SCRIPT: resolve("scripts/lib/release-publish-children.sh"),
          GITHUB_REF: `refs/tags/${workflowRef}`,
          GITHUB_REPOSITORY: repository,
          GITHUB_RUN_ID: "90",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_ENV: join(root, "env"),
          GITHUB_STEP_SUMMARY: join(root, "summary"),
          WORKFLOW_REF: currentWorkflowRef,
          WORKFLOW: workflow,
          PARENT_WORKFLOW_SHA: workflowSha,
          RELEASE_TAG: releaseTag,
          RELEASE_CHILD_SWEEP_TIMEOUT_SECONDS: "0",
        },
      });
      return {
        ...result,
        calls: readFileSync(join(root, "calls"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]),
        savedEnv: readFileSync(join(root, "env"), "utf8"),
      };
    },
  };
}

it.each(["plugin-clawhub-release.yml", "plugin-clawhub-new.yml"])(
  "reclaims an older failed parent's waiting %s before dispatch",
  (workflow) => {
    const result = fixture({ workflow }).run();
    expect(result.status, result.stderr).toBe(0);
    const cancellation = result.calls.findIndex((args) => args[1] === "cancel");
    const dispatch = result.calls.findIndex((args) =>
      args.some((arg) => arg.endsWith("/dispatches")),
    );
    expect(cancellation).toBeGreaterThanOrEqual(0);
    expect(dispatch).toBeGreaterThan(cancellation);
    expect(result.savedEnv).toContain("=92");
  },
);

it.each([
  [{ parentStatus: "in_progress", parentConclusion: "" }, false],
  [{ parentConclusion: "success" }, false],
  [{ actor: "operator" }, false],
  [{ publisherRunning: true }, false],
  [{ cancellationFails: true }, false],
  [{ workflow: "plugin-clawhub-release.yml", titleTag: "v2026.9.4", sameToolingRef: true }, true],
  [{ workflow: "plugin-clawhub-new.yml", titleTag: "v2026.9.4", sameToolingRef: true }, true],
  [{ validation: true, childStatus: "in_progress", sameToolingRef: true }, true],
  [{ workflow: "plugin-clawhub-new.yml", legacyTitle: true, sameToolingRef: true }, true],
] as const)("checks slot ownership before dispatch: %j (available=%s)", (options, available) => {
  const result = fixture(options).run();
  expect(result.status === 0, result.stderr).toBe(available);
  expect(result.calls.some((args) => args.some((arg) => arg.endsWith("/dispatches")))).toBe(
    available,
  );
  if (!("cancellationFails" in options)) {
    expect(result.calls.some((args) => args[1] === "cancel")).toBe(false);
  }
});

it("cleans up immediately recorded children after a later dispatch step fails", () => {
  const f = fixture({ titleTag: "v2026.9.4" });
  const dispatched = f.run(`${dispatchCommand}\nexit 1`);
  expect(dispatched.status).toBe(1);
  expect(dispatched.savedEnv).toContain("=92");
  const cleanup = f.run('source "$GITHUB_ENV"\ncleanup_clawhub_children');
  expect(cleanup.status, cleanup.stderr).toBe(0);
  expect(cleanup.calls.some((args) => args[1] === "cancel" && args.includes("92"))).toBe(true);
});
