import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const workflowSha = "a".repeat(40);
const repository = "openclaw/openclaw";
const runUrl = `https://github.com/${repository}/actions/runs/91`;

type Job = { name: string; status: string; conclusion: string | null };
type RunState = { status: string; conclusion?: string; jobs: Job[] };

const job = (name: string, conclusion: string | null, status = "completed"): Job => ({
  name,
  status,
  conclusion,
});
const previewFailed = job("preview_plugin_pack (featherless, ...)", "failure");
const previewPassed = job("preview_plugin_pack (featherless, ...)", "success");
const publish = (conclusion: string | null, status = "completed") =>
  job("Publish plugin npm package (@openclaw/featherless)", conclusion, status);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// Each `gh run view --json status,...` poll advances through `states`; a
// `gh run rerun` switches to `rerunStates` and bumps the run attempt.
function fixture(scenario: { states: RunState[]; rerunStates?: RunState[]; attempt?: number }) {
  const root = mkdtempSync(join(tmpdir(), "release-publish-children-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "calls"), "");
  writeFileSync(join(root, "summary"), "");
  writeFileSync(
    join(root, "state.json"),
    JSON.stringify({ phase: "states", index: -1, attempt: scenario.attempt ?? 1 }),
  );
  writeFileSync(
    join(root, "bin", "gh"),
    `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const root = process.env.FIXTURE_ROOT;
const args = process.argv.slice(2);
appendFileSync(root + '/calls', JSON.stringify(args) + '\\n');
const scenario = ${JSON.stringify(scenario)};
const state = JSON.parse(readFileSync(root + '/state.json', 'utf8'));
const save = () => writeFileSync(root + '/state.json', JSON.stringify(state));
const timeline = scenario[state.phase];
const current = () => timeline[Math.min(Math.max(state.index, 0), timeline.length - 1)];
const json = args.includes('--json') ? args[args.indexOf('--json') + 1] : '';
const jq = args.includes('--jq') ? args[args.indexOf('--jq') + 1] : '';
if (args[0] === 'run' && args[1] === 'view' && json === 'status,url,updatedAt') {
  state.index += 1; save();
  console.log(JSON.stringify({ status: current().status, url: ${JSON.stringify(runUrl)}, updatedAt: 'T' + state.index }));
} else if (args[0] === 'run' && args[1] === 'view' && json === 'headSha,url') {
  console.log(JSON.stringify({ headSha: ${JSON.stringify(workflowSha)}, url: ${JSON.stringify(runUrl)} }));
} else if (args[0] === 'run' && args[1] === 'view' && json === 'jobs') {
  console.log(jq === '.jobs' ? JSON.stringify(current().jobs) : '');
} else if (args[0] === 'run' && args[1] === 'view' && json === 'conclusion') {
  console.log(current().conclusion ?? '');
} else if (args[0] === 'run' && args[1] === 'view' && json === 'conclusion,url,createdAt,updatedAt') {
  console.log(JSON.stringify({ conclusion: current().conclusion, url: ${JSON.stringify(runUrl)}, createdAt: '2026-09-23T20:00:00Z', updatedAt: '2026-09-23T20:05:00Z' }));
} else if (args[0] === 'run' && args[1] === 'rerun') {
  if (!args.includes('--failed') || !scenario.rerunStates) throw new Error('unexpected rerun');
  state.phase = 'rerunStates'; state.index = -1; state.attempt += 1; save();
} else if (args[0] === 'api' && args.some((arg) => arg.endsWith('/pending_deployments'))) {
  console.log('[]');
} else if (args[0] === 'api' && args.some((arg) => arg.endsWith('/actions/runs/91'))) {
  console.log(state.attempt);
} else throw new Error('Unexpected operation: ' + JSON.stringify(args));
`,
    { mode: 0o755 },
  );
  return {
    run(command: string) {
      const result = spawnSync(
        "bash",
        ["-c", `source "$HELPER_SCRIPT"\nsleep() { :; }\n${command}`],
        {
          encoding: "utf8",
          env: {
            PATH: `${join(root, "bin")}:${process.env.PATH}`,
            FIXTURE_ROOT: root,
            HELPER_SCRIPT: resolve("scripts/lib/release-publish-children.sh"),
            GITHUB_REF: "refs/tags/release-publish/aaaaaaaaaaaa-123",
            GITHUB_REPOSITORY: repository,
            GITHUB_STEP_SUMMARY: join(root, "summary"),
            PARENT_WORKFLOW_SHA: workflowSha,
          },
        },
      );
      return {
        ...result,
        reruns: readFileSync(join(root, "calls"), "utf8")
          .split("\n")
          .filter((line) => line.startsWith('["run","rerun"')).length,
        summary: readFileSync(join(root, "summary"), "utf8"),
      };
    },
  };
}

const watchPlugins =
  'wait_for_run plugin-npm-release.yml 91 "$PARENT_WORKFLOW_SHA" "" true "" "Publish plugin npm package"';
const failedBeforePublish: RunState[] = [
  { status: "in_progress", jobs: [previewFailed, publish(null, "waiting")] },
  { status: "completed", conclusion: "failure", jobs: [previewFailed, publish("skipped")] },
];

describe("plugin npm child pre-publish flake tolerance", () => {
  it("waits for the run, reruns a pre-publish failure once, and continues on success", () => {
    const result = fixture({
      states: failedBeforePublish,
      rerunStates: [
        { status: "in_progress", jobs: [previewPassed, publish(null, "in_progress")] },
        { status: "completed", conclusion: "success", jobs: [previewPassed, publish("success")] },
      ],
    }).run(watchPlugins);
    expect(result.status, result.stderr).toBe(0);
    expect(result.reruns).toBe(1);
    expect(result.stdout).toContain(
      "waiting for the run to finish before deciding whether to retry",
    );
    expect(result.stdout).toContain("rerunning its failed jobs once");
    expect(result.stdout).toContain("attempt 2 started after the automatic retry");
    expect(result.summary).toContain("failed jobs rerun automatically once");
    expect(result.summary).toContain("plugin-npm-release.yml: success");
  });

  it.each([
    {
      label: "a failure after publication started",
      scenario: {
        states: [
          {
            status: "completed",
            conclusion: "failure",
            jobs: [
              previewPassed,
              publish("success"),
              job("Publish plugin npm package (@openclaw/x)", "failure"),
            ],
          },
        ],
        rerunStates: [],
      },
      stderr: "failed after publication started; not retrying",
    },
    {
      label: "a cancelled pre-publish job",
      scenario: {
        states: [
          {
            status: "completed",
            conclusion: "cancelled",
            jobs: [job(previewFailed.name, "cancelled"), publish("skipped")],
          },
        ],
        rerunStates: [],
      },
      stderr: "with a non-retryable job conclusion; not retrying",
    },
    {
      label: "a failure on an attempt that was already rerun",
      scenario: { states: failedBeforePublish, rerunStates: [], attempt: 2 },
      stderr: "covers only attempt 1, not retrying",
    },
  ])("aborts without a rerun on $label", ({ scenario, stderr }) => {
    const result = fixture(scenario).run(watchPlugins);
    expect(result.status).toBe(1);
    expect(result.reruns).toBe(0);
    expect(result.stderr).toContain(stderr);
  });

  it("aborts when the single retry fails again", () => {
    const result = fixture({ states: failedBeforePublish, rerunStates: failedBeforePublish }).run(
      watchPlugins,
    );
    expect(result.status).toBe(1);
    expect(result.reruns).toBe(1);
    expect(result.stderr).toContain("failed again after its single automatic retry");
  });

  it("aborts when the rerun never starts a second attempt", () => {
    const result = fixture({ states: failedBeforePublish, rerunStates: failedBeforePublish }).run(
      `gh() { [[ "$1 $2" == "run rerun" ]] || command gh "$@"; }\n${watchPlugins}`,
    );
    expect(result.status).toBe(1);
    expect(result.reruns).toBe(0);
    expect(result.stderr).toContain("did not start attempt 2 within 5 minutes");
  });

  it("keeps failing fast for watchers without a publish stage", () => {
    const result = fixture({ states: failedBeforePublish }).run(
      'wait_for_run ci.yml 91 "$PARENT_WORKFLOW_SHA" "" false',
    );
    expect(result.status).toBe(1);
    expect(result.reruns).toBe(0);
    expect(result.stderr).toContain("has failed jobs before the workflow completed");
  });
});
