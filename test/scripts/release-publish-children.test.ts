import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const roots: string[] = [];
const workflowSha = "a".repeat(40);
const repository = "openclaw/openclaw";
const dispatchArgs = ["-f", "publish_scope=all-publishable", "-f", `ref=${"b".repeat(40)}`];
const workflow = parse(readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8")) as {
  jobs: { publish: { steps: { name?: string; run?: string }[] } };
};
const startCorePublication = workflow.jobs.publish.steps.find(
  (step) => step.name === "Start core npm publication",
)?.run;

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
function fixture(
  runs: Record<string, RunState[]>,
  readFailure?: { count: number; message: string },
) {
  const root = mkdtempSync(join(tmpdir(), "release-publish-children-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "calls"), "");
  writeFileSync(join(root, "summary"), "");
  writeFileSync(join(root, "output"), "");
  writeFileSync(join(root, "state.json"), JSON.stringify({ index: {}, dispatched: 0 }));
  writeFileSync(join(root, "plugin-npm-dispatch-args"), dispatchArgs.join("\0") + "\0");
  const harnessRoot = join(root, ".release-harness/scripts/lib");
  mkdirSync(harnessRoot, { recursive: true });
  writeFileSync(
    join(harnessRoot, "release-publish-children.sh"),
    'source "$HELPER_SCRIPT"\nverify_release_tag_target() { :; }\ncleanup_clawhub_children() { echo cleanup >> "$GITHUB_OUTPUT"; echo cleanup >> "$FIXTURE_ROOT/calls"; }\nsleep() { :; }\n',
  );
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
const readFailure = ${JSON.stringify(readFailure) ?? "null"};
if (readFailure && json === 'status,url,updatedAt') {
  state.reads = (state.reads ?? 0) + 1; save();
  appendFileSync(root + '/calls', 'read ' + state.reads + '\\n');
  if (state.reads <= readFailure.count) { console.error(readFailure.message); process.exit(7); }
}
const url = (id) => 'https://github.com/${repository}/actions/runs/' + id;
if (args[0] === 'run' && args[1] === 'view') {
  const id = args[args.indexOf('--repo') + 2];
  const timeline = runs[id];
  if (json === 'status,url,updatedAt') { state.index[id] = (state.index[id] ?? -1) + 1; save(); }
  const current = timeline[Math.min(Math.max(state.index[id] ?? 0, 0), timeline.length - 1)];
  if (json === 'status,url,updatedAt') {
    appendFileSync(root + '/calls', 'observed ' + id + ' ' + current.status + '\\n');
    console.log(JSON.stringify({ status: current.status, url: url(id), updatedAt: 'T' + state.index[id] }));
  }
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
      const result = spawnSync("bash", ["-c", command], {
        encoding: "utf8",
        env: {
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          FIXTURE_ROOT: root,
          HELPER_SCRIPT: resolve("scripts/lib/release-publish-children.sh"),
          GITHUB_REF: "refs/tags/release-publish/aaaaaaaaaaaa-123",
          GITHUB_REPOSITORY: repository,
          GITHUB_STEP_SUMMARY: join(root, "summary"),
          GITHUB_OUTPUT: join(root, "output"),
          GITHUB_WORKSPACE: root,
          RUNNER_TEMP: root,
          CHILD_WORKFLOW_REF: "release-publish/aaaaaaaaaaaa-123",
          CHILD_PLUGIN_NPM_RUN_ID: "91",
          PARENT_WORKFLOW_SHA: workflowSha,
          PUBLISH_OPENCLAW_NPM: "false",
        },
      });
      return {
        ...result,
        dispatches: readFileSync(join(root, "calls"), "utf8")
          .split("\n")
          .filter((line) => line.startsWith("dispatch "))
          .map((line) => JSON.parse(line.slice("dispatch ".length)) as { inputs: unknown }),
        summary: readFileSync(join(root, "summary"), "utf8"),
        outputs: readFileSync(join(root, "output"), "utf8"),
        events: readFileSync(join(root, "calls"), "utf8").trim().split("\n"),
      };
    },
  };
}

describe("plugin npm child failure propagation", () => {
  it.each([
    {
      label: "a pre-publish failure while the child is still running",
      states: failedBeforePublish,
    },
    {
      label: "a terminal pre-publish failure",
      states: [failedBeforePublish[1]!],
    },
    {
      label: "a failed job while a sibling publisher is still running",
      states: [
        { status: "in_progress", jobs: [previewFailed, publish(null, "in_progress")] },
        { status: "in_progress", jobs: [previewFailed, publish(null, "in_progress")] },
        { status: "completed", conclusion: "failure", jobs: [previewFailed, publish("success")] },
      ],
    },
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
    },
  ])("fails the publication step without replacing $label", ({ states }) => {
    expect(startCorePublication).toBeDefined();
    const result = fixture({ 91: states, 92: succeeded }).run(startCorePublication!);
    expect(result.status).toBe(1);
    expect(result.dispatches).toHaveLength(0);
    expect(result.stderr).toContain("Plugin npm publish failed");
    expect(result.outputs).toBe("cleanup\n");
    expect(result.events).toEqual([
      ...states.map(({ status }) => `observed 91 ${status}`),
      "cleanup",
    ]);
  });

  it("records the successful original child before continuing publication", () => {
    expect(startCorePublication).toBeDefined();
    const result = fixture({ 91: succeeded }).run(startCorePublication!);
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toHaveLength(0);
    expect(result.outputs).toBe("plugin_npm_completed=true\nplugin_npm_run_id=91\n");
    expect(result.summary).toContain("plugin-npm-release.yml: success");
  });
});

describe("parent read retries", () => {
  it.each([
    { count: 2, message: "gh: Server Error (HTTP 502)", calls: 3, succeeds: true },
    { count: 4, message: "gh: Server Error (HTTP 502)", calls: 4, succeeds: false },
    { count: 4, message: "gh: Not Found (HTTP 404)", calls: 1, succeeds: false },
  ])("bounds retries for $message ($count failures)", ({ count, message, calls, succeeds }) => {
    const result = fixture({ 91: [succeeded[1]!] }, { count, message }).run(
      'source "${GITHUB_WORKSPACE}/.release-harness/scripts/lib/release-publish-children.sh"\n' +
        'wait_for_run plugin-npm-release.yml 91 "$PARENT_WORKFLOW_SHA"',
    );
    expect(result.status, result.stderr).toBe(succeeds ? 0 : 7);
    expect(result.events.filter((event) => event.startsWith("read "))).toHaveLength(calls);
    if (succeeds) {
      expect(result.summary).toContain("plugin-npm-release.yml: success");
    } else {
      expect(result.stderr).toContain(message);
    }
  });
});
