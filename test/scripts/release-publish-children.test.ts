import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const workflowSha = "a".repeat(40);
const repository = "openclaw/openclaw";
const dispatchArgs = ["-f", "publish_scope=all-publishable", "-f", `ref=${"b".repeat(40)}`];

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
const failedBeforePublish: RunState[] = [
  { status: "in_progress", jobs: [previewFailed, publish(null, "waiting")] },
  { status: "completed", conclusion: "failure", jobs: [previewFailed, publish("skipped")] },
];
const succeeded: RunState[] = [
  { status: "in_progress", jobs: [previewPassed, publish(null, "in_progress")] },
  { status: "completed", conclusion: "success", jobs: [previewPassed, publish("success")] },
];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// Each `gh run view --json status,...` poll advances that run through its
// states; a workflow dispatch creates the next run id in `runs` order.
function fixture(runs: Record<string, RunState[]>) {
  const root = mkdtempSync(join(tmpdir(), "release-publish-children-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "calls"), "");
  writeFileSync(join(root, "summary"), "");
  writeFileSync(join(root, "state.json"), JSON.stringify({ index: {}, dispatched: 0 }));
  writeFileSync(join(root, "plugin-npm-dispatch-args"), dispatchArgs.join("\0") + "\0");
  writeFileSync(
    join(root, "bin", "gh"),
    `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const root = process.env.FIXTURE_ROOT;
const args = process.argv.slice(2);
const runs = ${JSON.stringify(runs)};
const ids = Object.keys(runs);
const state = JSON.parse(readFileSync(root + '/state.json', 'utf8'));
const save = () => writeFileSync(root + '/state.json', JSON.stringify(state));
const json = args.includes('--json') ? args[args.indexOf('--json') + 1] : '';
const jq = args.includes('--jq') ? args[args.indexOf('--jq') + 1] : '';
const url = (id) => 'https://github.com/${repository}/actions/runs/' + id;
if (args[0] === 'run' && args[1] === 'view') {
  const id = args[args.indexOf('--repo') + 2];
  const timeline = runs[id];
  if (json === 'status,url,updatedAt') { state.index[id] = (state.index[id] ?? -1) + 1; save(); }
  const current = timeline[Math.min(Math.max(state.index[id] ?? 0, 0), timeline.length - 1)];
  if (json === 'status,url,updatedAt') console.log(JSON.stringify({ status: current.status, url: url(id), updatedAt: 'T' + state.index[id] }));
  else if (json === 'headSha,url') console.log(JSON.stringify({ headSha: ${JSON.stringify(workflowSha)}, url: url(id) }));
  else if (json === 'jobs') console.log(jq === '.jobs' ? JSON.stringify(current.jobs) : '');
  else if (json === 'conclusion,url,createdAt,updatedAt') console.log(JSON.stringify({ conclusion: current.conclusion, url: url(id), createdAt: '2026-09-23T20:00:00Z', updatedAt: '2026-09-23T20:05:00Z' }));
  else throw new Error('Unexpected view: ' + JSON.stringify(args));
} else if (args[0] === 'api' && args.some((arg) => arg.endsWith('/pending_deployments'))) {
  console.log('[]');
} else if (args[0] === 'api' && args.some((arg) => arg.includes('/commits/'))) {
  console.log(${JSON.stringify(workflowSha)});
} else if (args[0] === 'api' && args.some((arg) => arg.endsWith('/dispatches'))) {
  const id = ids[++state.dispatched]; save();
  appendFileSync(root + '/calls', 'dispatch ' + readFileSync(0, 'utf8').trim() + '\\n');
  console.log(JSON.stringify({ workflow_run_id: Number(id), html_url: url(id) }));
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
            RUNNER_TEMP: root,
            CHILD_WORKFLOW_REF: "release-publish/aaaaaaaaaaaa-123",
            PARENT_WORKFLOW_SHA: workflowSha,
          },
        },
      );
      return {
        ...result,
        dispatches: readFileSync(join(root, "calls"), "utf8")
          .split("\n")
          .filter((line) => line.startsWith("dispatch "))
          .map((line) => JSON.parse(line.slice("dispatch ".length)) as { inputs: unknown }),
        summary: readFileSync(join(root, "summary"), "utf8"),
      };
    },
  };
}

const watchPlugins =
  'plugin_npm_run_id=91\nwait_for_plugin_npm_release || status=$?\necho "final=${plugin_npm_run_id}"\nexit "${status:-0}"';

describe("plugin npm child pre-publish flake tolerance", () => {
  it("waits for the run, dispatches a fresh child after a pre-publish failure, and continues on its success", () => {
    const result = fixture({ 91: failedBeforePublish, 92: succeeded }).run(watchPlugins);
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches.map((dispatch) => dispatch.inputs)).toEqual([
      { publish_scope: "all-publishable", ref: "b".repeat(40) },
    ]);
    expect(result.stdout).toContain(
      "waiting for the run to finish before deciding whether to retry",
    );
    expect(result.stdout).toContain(
      "run 91 failed before any 'Publish plugin npm package' job ran",
    );
    expect(result.stdout).toContain("dispatching a fresh child (1 of 2)");
    expect(result.stdout).toContain("final=92");
    expect(result.summary).toContain("fresh child 92 dispatched (1 of 2)");
  });

  it.each([
    {
      label: "a failure after publication started",
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
      stderr: "failed after publication started; not dispatching a replacement",
    },
    {
      label: "a cancelled pre-publish job",
      states: [
        {
          status: "completed",
          conclusion: "cancelled",
          jobs: [job(previewFailed.name, "cancelled"), publish("skipped")],
        },
      ],
      stderr: "with a non-retryable job conclusion; not dispatching a replacement",
    },
  ])("aborts without a fresh child on $label", ({ states, stderr }) => {
    const result = fixture({ 91: states, 92: succeeded }).run(watchPlugins);
    expect(result.status).toBe(1);
    expect(result.dispatches).toHaveLength(0);
    expect(result.stderr).toContain(stderr);
    expect(result.stdout).toContain("final=91");
  });

  it("aborts after two fresh children fail before publication", () => {
    const result = fixture({
      91: failedBeforePublish,
      92: failedBeforePublish,
      93: failedBeforePublish,
      94: succeeded,
    }).run(watchPlugins);
    expect(result.status).toBe(1);
    expect(result.dispatches).toHaveLength(2);
    expect(result.stderr).toContain("failed after 2 fresh dispatches; not dispatching again");
    expect(result.stdout).toContain("final=93");
  });

  it("keeps failing fast for watchers without a publish stage", () => {
    const result = fixture({ 91: failedBeforePublish }).run(
      'wait_for_run ci.yml 91 "$PARENT_WORKFLOW_SHA" "" false',
    );
    expect(result.status).toBe(1);
    expect(result.dispatches).toHaveLength(0);
    expect(result.stderr).toContain("has failed jobs before the workflow completed");
  });
});
