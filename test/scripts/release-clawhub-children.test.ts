import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const workflowRef = "release-publish/aaaaaaaaaaaa-123";
const workflowSha = "a".repeat(40);
const releaseTag = "v2026.9.5";
const repository = "openclaw/openclaw";

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

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
  const root = mkdtempSync(join(tmpdir(), "release-clawhub-children-"));
  const currentWorkflowRef = workflow === "plugin-clawhub-new.yml" ? "main" : workflowRef;
  roots.push(root);
  mkdirSync(join(root, "bin"));
  const child = {
    id: 91,
    run_attempt: 1,
    path: `.github/workflows/${workflow}`,
    event: "workflow_dispatch",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    actor: { login: actor },
    head_branch: sameToolingRef ? currentWorkflowRef : "release-publish/bbbbbbbbbbbb-123",
    head_sha: "b".repeat(40),
    display_title: legacyTitle
      ? "Plugin ClawHub New"
      : `${workflow} [${titleTag}] ${validation ? "validation" : "publish"} parent=80/1`,
    status: childStatus,
    conclusion: null,
    html_url: `https://github.com/${repository}/actions/runs/91`,
  };
  const parent = {
    id: 80,
    run_attempt: 1,
    path: ".github/workflows/openclaw-release-publish.yml",
    event: "workflow_dispatch",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
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
    child.status = 'completed'; child.conclusion = 'failure';
    writeFileSync(root + '/child.json', JSON.stringify(child));
    console.log('[]');
  } else console.log(JSON.stringify(child.status === 'completed' ? [] : [{environment: {id: 7, name: 'clawhub-plugin-release'}, current_user_can_approve: false}]));
} else if (args[0] === 'api' && endpoint.endsWith('/91/jobs?per_page=100')) {
  console.log(JSON.stringify({total_count: 1, jobs: [{status: ${JSON.stringify(publisherRunning ? "in_progress" : "waiting")}}]}));
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
    root,
    run(command: string) {
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
        },
      });
      return {
        ...result,
        calls: readFileSync(join(root, "calls"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]),
        savedEnv: readFileSync(join(root, "env"), "utf8"),
      };
    },
  };
}

describe("ClawHub child lifecycle", () => {
  it.each(["plugin-clawhub-release.yml", "plugin-clawhub-new.yml"])(
    "reclaims an older failed parent's waiting %s before dispatch",
    (workflow) => {
      const f = fixture({ workflow });
      const result = f.run(
        'dispatch_workflow_at_ref "$WORKFLOW_REF" "$PARENT_WORKFLOW_SHA" "$WORKFLOW" -f release_tag="$RELEASE_TAG"',
      );
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
    { parentStatus: "in_progress", parentConclusion: "", label: "live parent" },
    { parentConclusion: "success", label: "successful detached parent" },
    { actor: "operator", label: "manual recovery" },
    { publisherRunning: true, label: "active publisher" },
    { cancellationFails: true, label: "failed cancellation" },
  ])("does not dispatch past $label", (options) => {
    const result = fixture(options).run(
      'dispatch_workflow_at_ref "$WORKFLOW_REF" "$PARENT_WORKFLOW_SHA" "$WORKFLOW" -f release_tag="$RELEASE_TAG"',
    );
    expect(result.status).not.toBe(0);
    expect(result.calls.some((args) => args.some((arg) => arg.endsWith("/dispatches")))).toBe(
      false,
    );
    if (!options.cancellationFails) {
      expect(result.calls.some((args) => args[1] === "cancel")).toBe(false);
    }
  });

  it.each([
    ["plugin-clawhub-release.yml", false],
    ["plugin-clawhub-release.yml", true],
    ["plugin-clawhub-new.yml", false],
    ["plugin-clawhub-new.yml", true],
  ] as const)(
    "leaves another tag's waiting %s alone (same tooling: %s)",
    (workflow, sameToolingRef) => {
      const result = fixture({ workflow, titleTag: "v2026.9.4", sameToolingRef }).run(
        'dispatch_workflow_at_ref "$WORKFLOW_REF" "$PARENT_WORKFLOW_SHA" "$WORKFLOW" -f release_tag="$RELEASE_TAG"',
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls.some((args) => args[1] === "cancel")).toBe(false);
    },
  );

  it.each(["plugin-clawhub-release.yml", "plugin-clawhub-new.yml"])(
    "leaves same-tag validation on the same tooling ref independent in %s",
    (workflow) => {
      const result = fixture({
        workflow,
        sameToolingRef: true,
        validation: true,
        childStatus: "in_progress",
      }).run(
        'dispatch_workflow_at_ref "$WORKFLOW_REF" "$PARENT_WORKFLOW_SHA" "$WORKFLOW" -f release_tag="$RELEASE_TAG"',
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls.some((args) => args[1] === "cancel")).toBe(false);
    },
  );

  it("preserves bootstrap's existing independent slots for unidentified main runs", () => {
    const result = fixture({
      workflow: "plugin-clawhub-new.yml",
      sameToolingRef: true,
      legacyTitle: true,
    }).run(
      'dispatch_workflow_at_ref "$WORKFLOW_REF" "$PARENT_WORKFLOW_SHA" "$WORKFLOW" -f release_tag="$RELEASE_TAG"',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.some((args) => args[1] === "cancel")).toBe(false);
  });

  it("cleans up immediately recorded children after a later dispatch step fails", () => {
    const f = fixture({ titleTag: "v2026.9.4" });
    const dispatched = f.run(
      'dispatch_workflow_at_ref "$WORKFLOW_REF" "$PARENT_WORKFLOW_SHA" "$WORKFLOW" -f release_tag="$RELEASE_TAG"\nexit 1',
    );
    expect(dispatched.status).toBe(1);
    expect(dispatched.savedEnv).toContain("=92");
    const cleanup = f.run('source "$GITHUB_ENV"\ncleanup_clawhub_children');
    expect(cleanup.status, cleanup.stderr).toBe(0);
    expect(cleanup.calls.some((args) => args[1] === "cancel" && args.includes("92"))).toBe(true);
  });
});
