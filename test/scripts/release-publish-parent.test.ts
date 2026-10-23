import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sha = "a".repeat(40);
const target = "b".repeat(40);
const repo = "openclaw/openclaw";
const tag = "v2026.9.6";
const clawhub = "plugin-clawhub-release.yml";
const bootstrap = "plugin-clawhub-new.yml";
const coreNpm = "openclaw-npm-release.yml";
const url = (id: number) => `https://github.com/${repo}/actions/runs/${id}`;
const workflow = parse(readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8")) as {
  jobs: { publish: { steps: { name: string; run?: string; env?: Record<string, string> }[] } };
};
const step = (name: string) => workflow.jobs.publish.steps.find((entry) => entry.name === name)!;
const source =
  'source "$GITHUB_WORKSPACE/.release-harness/scripts/lib/release-publish-children.sh"\n';
const dispatch = (name = clawhub) =>
  `${source}${name.startsWith("plugin-clawhub-") ? `require_clawhub_dispatch_available main ${name}` : `sweep_superseded_children ${name}`}\ndispatch_workflow_at_ref main "$PARENT_WORKFLOW_SHA" ${name}`;
const childWorkflow = (name: string, parent = "80/1") => ({
  path: `.github/workflows/${name}`,
  display_title: `${name} [${tag}] publish parent=${parent}`,
});

function child(overrides: Record<string, unknown> = {}) {
  return {
    id: 91,
    repository: { full_name: repo },
    head_repository: { full_name: repo },
    actor: { login: "github-actions[bot]" },
    event: "workflow_dispatch",
    ...childWorkflow(clawhub),
    head_branch: "main",
    created_at: "2026-09-24T00:00:00Z",
    status: "waiting",
    jobs: [{ name: "publish", status: "waiting" }],
    ...overrides,
  };
}

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
const active = (preview: Job, publisherStatus: string): RunState => ({
  status: "in_progress",
  jobs: [preview, publish(null, publisherStatus)],
});
const terminal = (conclusion: string, ...jobs: Job[]): RunState => ({
  status: "completed",
  conclusion,
  jobs,
});
const failedBeforePublish: RunState[] = [
  active(previewFailed, "waiting"),
  terminal("failure", previewFailed, publish("skipped")),
];
const succeeded: RunState[] = [
  active(previewPassed, "in_progress"),
  terminal("success", previewPassed, publish("success")),
];

type Fixture = {
  runs?: Record<string, RunState[]>;
  readFailure?: { count: number; message: string };
  children?: ReturnType<typeof child>[];
  parent?: Record<string, unknown>;
  cancelStates?: string[];
  rejectFails?: boolean;
  cancelFails?: boolean;
  capped?: boolean;
  completedBeforeSweep?: boolean;
  registry?: (Record<string, unknown> | null)[];
  ledger?: { status: string; conclusion?: string }[];
  dispatchFails?: boolean;
  sleepSeconds?: number;
  harness?: string;
};
type Call = { binary: string; args: string[]; body?: string; ledgerToken: boolean };
const noops = (...names: string[]) => names.map((name) => `${name}() { :; }`).join("\n");
const ledgerStates = (...states: string[]) =>
  states.map((state) =>
    ["success", "failure"].includes(state)
      ? { status: "completed", conclusion: state }
      : { status: state },
  );

// Polls advance external state; stubbed sleep advances Bash's clock without wall waits.
function fixture(config: Fixture = {}) {
  const root = tempDirs.make("release-publish-parent-");
  const harness = join(root, ".release-harness/scripts/lib");
  mkdirSync(harness, { recursive: true });
  mkdirSync(join(root, "bin"));
  for (const file of ["calls", "summary", "output", "env"]) {
    writeFileSync(join(root, file), "");
  }
  writeFileSync(join(root, "state.json"), JSON.stringify({ cancelled: {} }));
  writeFileSync(
    join(root, "plugin-npm-dispatch-args"),
    ["-f", "publish_scope=all-publishable", "-f", `ref=${target}`, ""].join("\0"),
  );
  writeFileSync(
    join(harness, "release-publish-children.sh"),
    `source "$HELPER_SCRIPT"\nunset SECONDS; SECONDS=0\nsleep() { SECONDS=$((SECONDS + ${config.sleepSeconds ?? "$1"})); }\n${config.harness ?? ""}\n`,
  );
  // Inventory polling must not pay a Node startup for every fake gh read.
  const fake = `#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root = Path(os.environ['FIXTURE_ROOT'])
config = json.loads(${JSON.stringify(JSON.stringify(config))})
args = sys.argv[1:]
binary = Path(sys.argv[0]).name
state = json.loads((root / 'state.json').read_text())
def save(): (root / 'state.json').write_text(json.dumps(state))
def advance(key, values):
    index = state.get(key, 0)
    state[key] = index + 1
    save()
    return values[min(index, len(values) - 1)]
def value(key): return args[args.index(key) + 1]
def emit(data): print(json.dumps(data))
def event(line):
    state.setdefault('events', []).append(line)
    save()
def fail(message, code=1):
    print(message, file=sys.stderr)
    sys.exit(code)
endpoint = next((arg for arg in args if arg.startswith('repos/')), '')
post = 'POST' in args
body = sys.stdin.read() if '--input' in args else None
with (root / 'calls').open('a') as calls:
    calls.write(json.dumps(dict(binary=binary, args=args, body=body, ledgerToken=os.environ.get('GH_TOKEN') == 'fixture-ledger')) + '\\n')
children = config.get('children', [])
def parent(run_id):
    return dict(id=int(run_id), repository=dict(full_name='${repo}'), head_repository=dict(full_name='${repo}'), event='workflow_dispatch', path='.github/workflows/openclaw-release-publish.yml', run_attempt=2 if run_id == '100' else 1, status='in_progress' if run_id == '100' else 'completed', conclusion=None if run_id == '100' else 'failure', run_started_at='2026-09-24T01:00:00Z') | config.get('parent', {})
if binary == 'curl':
    doc = advance('registry', config.get('registry') or [None])
    if doc is None: fail('registry unavailable', 22)
    emit(doc)
elif args[:2] == ['run', 'list']:
    matches = [run for run in children if run['path'].endswith('/' + value('--workflow')) and run['status'] == value('--status') and ('--branch' not in args or value('--branch') == run['head_branch']) and not state['cancelled'].get(str(run['id']))]
    emit([{}] * 1000 if config.get('capped') else [dict(databaseId=run['id'], displayTitle=run['display_title'], headBranch=run['head_branch'], url='https://github.com/${repo}/actions/runs/' + str(run['id']), createdAt=run['created_at']) for run in matches])
elif args[:2] == ['run', 'view']:
    run_id = args[args.index('--repo') + 2]
    fields = value('--json')
    timeline = config.get('runs', {}).get(run_id)
    if timeline is not None:
        if fields == 'status,url,updatedAt':
            failure = config.get('readFailure')
            if failure:
                state['reads'] = state.get('reads', 0) + 1
                event('read ' + str(state['reads']))
                if state['reads'] <= failure['count']: fail(failure['message'], 7)
            state['index:' + run_id] = state.get('index:' + run_id, -1) + 1
            current = timeline[min(state['index:' + run_id], len(timeline) - 1)]
            event('observed ' + run_id + ' ' + current['status'])
            emit(dict(status=current['status'], url='https://github.com/${repo}/actions/runs/' + run_id, updatedAt='T' + str(state['index:' + run_id])))
        else:
            current = timeline[min(max(state.get('index:' + run_id, 0), 0), len(timeline) - 1)]
            if fields == 'jobs':
                if '--jq' not in args: emit(dict(jobs=current['jobs']))
                elif value('--jq') == '.jobs': emit(current['jobs'])
                else: print('')
            elif fields == 'headSha,url': emit(dict(headSha='${sha}', url='https://github.com/${repo}/actions/runs/' + run_id))
            elif fields == 'conclusion,url,createdAt,updatedAt': emit(dict(conclusion=current.get('conclusion'), url='https://github.com/${repo}/actions/runs/' + run_id, createdAt='2026-09-23T20:00:00Z', updatedAt='2026-09-23T20:05:00Z'))
            else: fail('Unexpected view: ' + json.dumps(args))
    elif fields == 'headSha,url': emit(dict(headSha='${sha}', url='${url(92)}'))
    else: emit(dict(jobs=next((run['jobs'] for run in children if str(run['id']) == run_id), [])))
elif args[:2] == ['run', 'cancel']:
    if config.get('cancelFails'): fail('HTTP 403')
    run_id = args[args.index('--repo') + 2]
    state['cancelled'][run_id] = True
    if config.get('runs'): event('cancel ' + run_id)
    save()
elif endpoint.endswith('/pending_deployments'):
    if post and config.get('rejectFails'): fail('HTTP 403')
    emit({} if post else [dict(environment=dict(id=7))])
elif endpoint.endswith('/dispatches'):
    if config.get('dispatchFails'): fail('HTTP 502')
    state['dispatched'] = True
    save()
    emit(dict(workflow_run_id=92, html_url='${url(92)}'))
elif '/commits/' in endpoint: print('${sha}')
elif '/actions/runs/' in endpoint:
    run_id = endpoint.split('/')[-1]
    if run_id in config.get('runs', {}): emit(config['runs'][run_id][0])
    elif endpoint.startswith('repos/openclaw/releases/'):
        emit(advance('ledger', config.get('ledger', [dict(status='completed', conclusion='success')])))
    else:
        run = next((run for run in children if str(run['id']) == run_id), None)
        if run is None: emit(dict(status='waiting') if run_id == '92' and state.get('dispatched') else parent(run_id))
        else:
            status = advance('poll:' + run_id, config.get('cancelStates', ['waiting', 'completed'])) if state['cancelled'].get(run_id) else 'completed' if config.get('completedBeforeSweep') else run['status']
            emit(run | dict(status=status))
else: fail('Unexpected call: ' + json.dumps(args))
`;
  for (const bin of ["gh", "curl"]) {
    writeFileSync(join(root, "bin", bin), fake, { mode: 0o755 });
  }
  return {
    run(command: string, env: NodeJS.ProcessEnv = {}) {
      const result = spawnSync("bash", ["-c", command], {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          FIXTURE_ROOT: root,
          HELPER_SCRIPT: resolve("scripts/lib/release-publish-children.sh"),
          GITHUB_WORKSPACE: root,
          RUNNER_TEMP: root,
          GITHUB_STEP_SUMMARY: join(root, "summary"),
          GITHUB_OUTPUT: join(root, "output"),
          GITHUB_ENV: join(root, "env"),
          CHILD_WORKFLOW_REF: "release-publish/aaaaaaaaaaaa-100",
          PARENT_WORKFLOW_BRANCH: "release-publish/aaaaaaaaaaaa-100",
          PARENT_WORKFLOW_FULL_REF: "refs/tags/release-publish/aaaaaaaaaaaa-100",
          PLUGIN_PUBLISH_SCOPE: "all-publishable",
          PLUGINS: "",
          PREPARED_PLUGINS: "",
          GITHUB_REF: "refs/tags/release-publish/aaaaaaaaaaaa-100",
          GITHUB_REPOSITORY: repo,
          GITHUB_RUN_ID: "100",
          GITHUB_RUN_ATTEMPT: "2",
          PARENT_WORKFLOW_SHA: sha,
          RELEASE_TAG: tag,
          TARGET_SHA: target,
          RELEASE_NPM_DIST_TAG: "latest",
          ...env,
        },
      });
      const calls = readFileSync(join(root, "calls"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Call);
      const state: { events?: string[] } = JSON.parse(
        readFileSync(join(root, "state.json"), "utf8"),
      );
      return {
        ...result,
        calls,
        summary: readFileSync(join(root, "summary"), "utf8"),
        outputs: readFileSync(join(root, "output"), "utf8"),
        savedEnv: readFileSync(join(root, "env"), "utf8"),
        events: state.events ?? [],
      };
    },
  };
}

const isDispatch = (call: Call) => call.args.some((arg) => arg.endsWith("/dispatches"));
const isCancel = (call: Call) => call.args[1] === "cancel";
type Result = ReturnType<ReturnType<typeof fixture>["run"]>;
const cancellations = (result: Result) =>
  result.calls.filter(isCancel).map((call) => call.args.at(-1));

function childFixture(runs: Record<string, RunState[]>, readFailure?: Fixture["readFailure"]) {
  return {
    run(command: string) {
      const result = fixture({
        runs,
        readFailure,
        sleepSeconds: 0,
        harness: `${noops("verify_release_tag_target")}
cleanup_clawhub_children() { echo cleanup >> "$GITHUB_OUTPUT"; }`,
      }).run(command, {
        CHILD_PLUGIN_NPM_RUN_ID: "91",
        PUBLISH_OPENCLAW_NPM: "false",
      });
      return { ...result, dispatches: result.calls.filter(isDispatch) };
    },
  };
}

describe("optional Gateway publication notification", () => {
  const notificationName = "Notify Windows of published Gateway packages";
  const publisher = job("publish_openclaw_npm", "success");

  it.each(["failure", "timed_out", "cancelled"])(
    "preserves publisher start and background completion after notification %s",
    (conclusion) => {
      const jobs = [publisher, job(notificationName, conclusion)];
      const states: RunState[] = [{ status: "in_progress", jobs }, terminal("success", ...jobs)];
      const started = childFixture({ 91: states }).run(
        source +
          'wait_for_run openclaw-npm-release.yml 91 "$PARENT_WORKFLOW_SHA" publish_openclaw_npm false',
      );
      expect(started.status, started.stderr).toBe(0);
      expect(started.stdout).toContain("publish_openclaw_npm started");
      const completed = childFixture({ 91: states }).run(
        source +
          'wait_for_run_background openclaw-npm-release.yml 91 "$PARENT_WORKFLOW_SHA" "$RUNNER_TEMP/result" false; wait "$wait_run_pid"; cat "$RUNNER_TEMP/result"',
      );
      expect(completed.status, completed.stderr).toBe(0);
      expect(completed.stdout.trim().endsWith("success")).toBe(true);
      expect(completed.summary).toContain("openclaw-npm-release.yml: success");
      expect(completed.calls.some(isCancel)).toBe(false);
    },
  );

  it.each([
    { workflow: coreNpm, failed: "validate_publish_request", conclusion: "failure" },
    { workflow: coreNpm, failed: "publish_openclaw_npm", conclusion: "failure" },
    { workflow: coreNpm, failed: "unknown_job", conclusion: "failure" },
    { workflow: "plugin-npm-release.yml", failed: notificationName, conclusion: "failure" },
    { workflow: coreNpm, failed: notificationName, conclusion: "action_required" },
  ])(
    "still rejects $workflow / $failed / $conclusion",
    ({ workflow: workflowName, failed, conclusion }) => {
      const result = childFixture({
        91: [
          {
            status: "in_progress",
            jobs: [job(notificationName, "failure"), job(failed, conclusion)],
          },
        ],
      }).run(source + `wait_for_run ${workflowName} 91 "$PARENT_WORKFLOW_SHA" "" false`);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("has failed jobs");
    },
  );

  it("does not accept a cancelled overall npm run", () => {
    const result = childFixture({
      91: [terminal("cancelled", publisher, job(notificationName, "cancelled"))],
    }).run(source + 'wait_for_run openclaw-npm-release.yml 91 "$PARENT_WORKFLOW_SHA" "" false');
    expect(result.status, result.stderr).toBe(1);
    expect(result.summary).toContain("openclaw-npm-release.yml: cancelled");
  });
});

describe("plugin npm child lifecycle", () => {
  it.each<[string, RunState[]]>([
    ["a pre-publish failure while the child is still running", failedBeforePublish],
    ["a terminal pre-publish failure", [failedBeforePublish[1]!]],
    [
      "a failed job while a sibling publisher is still running",
      [
        active(previewFailed, "in_progress"),
        active(previewFailed, "in_progress"),
        terminal("failure", previewFailed, publish("success")),
      ],
    ],
    [
      "a failure after publication started",
      [
        terminal(
          "failure",
          previewPassed,
          publish("success"),
          job("Publish plugin npm package (@openclaw/x)", "failure"),
        ),
      ],
    ],
    [
      "a cancelled pre-publish job",
      [terminal("cancelled", job(previewFailed.name, "cancelled"), publish("skipped"))],
    ],
  ])("fails the publication step without replacing %s", (_label, states) => {
    const result = childFixture({ 91: states, 92: succeeded }).run(
      step("Start core npm publication").run!,
    );
    expect(result).toMatchObject({ status: 1, dispatches: [], outputs: "" });
    expect(result.stderr).toContain("Plugin npm publish failed");
    expect(result.events).toEqual(states.map(({ status }) => `observed 91 ${status}`));
    expect(result.stderr).toContain("deferred cleanup will preserve ClawHub recovery evidence");
  });

  it("records the successful original child before continuing publication", () => {
    const result = childFixture({ 91: succeeded }).run(step("Start core npm publication").run!);
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toHaveLength(0);
    expect(result.outputs).toBe("plugin_npm_completed=true\nplugin_npm_run_id=91\n");
    expect(result.summary).toContain("plugin-npm-release.yml: success");
  });
  it.each([
    { status: "waiting", jobs: [publish(null, "waiting")], cancelled: true },
    { status: "in_progress", jobs: [publish(null, "in_progress")], cancelled: false },
    { status: "completed", jobs: [publish("success")], cancelled: false },
  ])(
    "preserves active publishers and cancels only waiting children ($status)",
    ({ status, jobs, cancelled }) => {
      const result = childFixture({ 91: [{ status, jobs }] }).run(
        source + "cleanup_waiting_npm_children",
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.events.filter(Boolean)).toEqual(cancelled ? ["cancel 91"] : []);
    },
  );
  it.each([
    { count: 2, message: "gh: Server Error (HTTP 502)", calls: 3, succeeds: true },
    { count: 4, message: "gh: Server Error (HTTP 502)", calls: 4, succeeds: false },
    { count: 4, message: "gh: Not Found (HTTP 404)", calls: 1, succeeds: false },
  ])("bounds retries for $message ($count failures)", ({ count, message, calls, succeeds }) => {
    const result = childFixture({ 91: [succeeded[1]!] }, { count, message }).run(
      source + 'wait_for_run plugin-npm-release.yml 91 "$PARENT_WORKFLOW_SHA" "" false',
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

it.each([
  { name: coreNpm, blocked: false },
  { name: bootstrap, blocked: true },
])("preflights a gate-blocked stale $name before any dispatch", ({ name, blocked }) => {
  const result = fixture({
    children: [child(childWorkflow(name))],
    rejectFails: true,
    cancelStates: ["waiting"],
    harness: `
${noops("verify_release_tag_target", "render_github_release_notes", "guard_existing_public_release")}
resolve_openclaw_npm_publish_state() { openclaw_npm_already_published=false; }
resolve_clawhub_release_plan() {
  clawhub_plan_path="$RUNNER_TEMP/plan.json"
  printf '%s' '{"normal":{"shouldDispatch":true,"ref":"main","workflow":"plugin-clawhub-release.yml"},"bootstrap":{"shouldDispatch":true,"ref":"main","workflow":"plugin-clawhub-new.yml"}}' > "$clawhub_plan_path"
}
verify_bootstrap_workflow_sha() { echo "$PARENT_WORKFLOW_SHA"; }
append_clawhub_dispatch_args() { clawhub_dispatch_args=(); }
`,
  }).run(step("Dispatch publish workflows").run!, {
    PUBLISH_OPENCLAW_NPM: "true",
    WAIT_FOR_CLAWHUB: "false",
    RELEASE_CHILD_SWEEP_TIMEOUT_SECONDS: "0",
  });
  expect(result.status, result.stderr).toBe(blocked ? 1 : 0);
  expect(result.stderr).toContain("needs a reviewer:");
  expect(result.summary).toContain(url(91));
  expect(result.summary).toContain("cancellation unconfirmed");
  expect(result.stderr.match(/HTTP 403/g)).toHaveLength(1);
  expect(cancellations(result)).toEqual(["91"]);
  const firstDispatch = result.calls.findIndex(isDispatch);
  if (blocked) {
    expect(firstDispatch).toBe(-1);
    expect(result.stderr).toContain("Publisher slot for plugin-clawhub-new.yml remains occupied");
  } else {
    expect(firstDispatch).toBeGreaterThan(result.calls.findIndex(isCancel));
    const sweeps = result.calls.filter((call) => call.args[1] === "list");
    expect(new Set(sweeps.map((call) => call.args[call.args.indexOf("--workflow") + 1]))).toEqual(
      new Set([
        "openclaw-release-publish.yml",
        "plugin-npm-release.yml",
        clawhub,
        bootstrap,
        coreNpm,
      ]),
    );
    expect(
      result.calls.slice(firstDispatch).some((call) => call.args[1] === "list" || isCancel(call)),
    ).toBe(false);
  }
});

it.each([
  { name: clawhub, parent: "80/1", rejectFails: false },
  { name: clawhub, parent: "100/1", rejectFails: true },
  { name: coreNpm, parent: "80/1", rejectFails: false },
  { name: bootstrap, parent: "80/1", rejectFails: false },
])(
  "reclaims terminal $name children from $parent (rejectFails=$rejectFails)",
  ({ name, parent, rejectFails }) => {
    const result = fixture({
      children: [
        child({ ...childWorkflow(name, parent), head_branch: "release-publish/bbbbbbbbbbbb-123" }),
      ],
      rejectFails,
    }).run(dispatch(name));
    expect(result.status, result.stderr).toBe(0);
    if (rejectFails) {
      expect(result.stderr).toContain("::warning::");
    }
    expect(result.summary).toContain(`Reclaimed superseded ${name} child: ${url(91)}`);
    if (name === clawhub || name === bootstrap) {
      expect(result.savedEnv).toContain("=92");
    }
    expect(result.calls.filter(isCancel)).toHaveLength(1);
    const mutations = result.calls.filter((call) => call.args.includes("POST") || isCancel(call));
    expect(mutations.map((call) => call.args)).toEqual([
      expect.arrayContaining([
        "POST",
        `repos/${repo}/actions/runs/91/pending_deployments`,
        "state=rejected",
        "environment_ids[]=7",
        "comment=Superseded release child; rejected by publish parent 100/2",
      ]),
      expect.arrayContaining(["run", "cancel", "91"]),
      expect.arrayContaining(["POST", `repos/${repo}/actions/workflows/${name}/dispatches`]),
    ]);
    const afterCancel = result.calls.slice(
      result.calls.findIndex(isCancel) + 1,
      result.calls.findIndex(isDispatch),
    );
    expect(
      afterCancel.filter((call) => call.args.includes(`repos/${repo}/actions/runs/91`)),
    ).toHaveLength(2);
  },
);

it.each<[string, Record<string, unknown>, Record<string, unknown>?]>([
  ["live publisher", { jobs: [{ status: "in_progress" }] }],
  ["this parent attempt", childWorkflow(clawhub, "100/2")],
  ["another actor", { actor: { login: "someone" } }],
  ["successful parent", {}, { conclusion: "success" }],
  ["live parent", {}, { status: "in_progress", conclusion: null }],
])("preserves children without cancellation authority: %s", (_, overrides, parent) => {
  const result = fixture({ children: [child(overrides)], parent }).run(dispatch());
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("ClawHub dispatch blocked by waiting run");
  expect(result.calls.filter((call) => isCancel(call) || isDispatch(call))).toEqual([]);
});

it.each([
  [clawhub, true, `${clawhub} [${tag}] publish parent=80/1`],
  [coreNpm, false, "OpenClaw NPM Release"],
] as const)(
  "ignores completed or uncorrelated %s children",
  (name, completedBeforeSweep, title) => {
    const result = fixture({
      children: [child({ ...childWorkflow(name), display_title: title })],
      completedBeforeSweep,
    }).run(dispatch(name));
    expect(result.status, result.stderr).toBe(0);
    expect(cancellations(result)).toEqual([]);
    expect(result.calls.some(isDispatch)).toBe(true);
  },
);

it.each([false, true])(
  "reclaims only older unowned plugin npm children (live parent=%s)",
  (otherParent) => {
    const npm = {
      path: ".github/workflows/plugin-npm-release.yml",
      display_title: `Plugin NPM Release [all-publishable] ${target}`,
    };
    const children = [
      child(npm),
      child({ ...npm, id: 93, created_at: "2026-09-24T02:00:00Z" }),
      child({ ...npm, id: 94 }),
    ];
    if (otherParent) {
      children.push(
        child({
          ...childWorkflow("openclaw-release-publish.yml"),
          id: 80,
          display_title: "OpenClaw Release Publish",
          status: "in_progress",
        }),
      );
    }
    const result = fixture({ children }).run(dispatch("plugin-npm-release.yml"), {
      CHILD_PLUGIN_NPM_RUN_ID: "94",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(cancellations(result)).toEqual(otherParent ? [] : ["91"]);
    if (otherParent) {
      expect(result.stderr).toContain("Another publish parent is live");
      expect(result.calls.some(isDispatch)).toBe(true);
    } else {
      expect(
        result.calls.filter((call) => call.args.includes(`repos/${repo}/actions/runs/100`)),
      ).toHaveLength(1);
    }
  },
);

const slotFixture = (name: string, title: string, status = "waiting"): Fixture => ({
  children: [child({ ...childWorkflow(name), display_title: title, status })],
});
it.each<[string, Fixture, boolean]>([
  ["failed cancellation", { children: [child()], rejectFails: true, cancelFails: true }, false],
  ["other release", slotFixture(clawhub, `${clawhub} [v2026.9.4] publish parent=80/1`), true],
  [
    "other bootstrap release",
    slotFixture(bootstrap, `${bootstrap} [v2026.9.4] publish parent=80/1`),
    true,
  ],
  [
    "validation run",
    slotFixture(clawhub, `${clawhub} [${tag}] validation parent=80/1`, "in_progress"),
    true,
  ],
  ["legacy bootstrap", slotFixture(bootstrap, "Plugin ClawHub New"), true],
])("checks same-ref ClawHub slot ownership: %s", (_name, config, available) => {
  const name = config.children?.[0]?.path.endsWith(`/${bootstrap}`) ? bootstrap : clawhub;
  const result = fixture(config).run(dispatch(name), { RELEASE_CHILD_SWEEP_TIMEOUT_SECONDS: "0" });
  expect(result.status === 0, result.stderr).toBe(available);
  expect(result.calls.some(isDispatch)).toBe(available);
  if (!config.cancelFails) {
    expect(cancellations(result)).toEqual([]);
  }
});

it("cleans up recorded ClawHub children after a later dispatch fails", () => {
  const f = fixture({
    children: [child({ display_title: `${clawhub} [v2026.9.4] publish parent=80/1` })],
  });
  const dispatched = f.run(`${dispatch()}\nexit 1`);
  expect(dispatched.status).toBe(1);
  expect(dispatched.savedEnv).toContain("=92");
  const cleanup = f.run(`${source}source "$GITHUB_ENV"\ncleanup_clawhub_children`);
  expect(cleanup.status, cleanup.stderr).toBe(0);
  expect(cancellations(cleanup)).toContain("92");
});

it.each<{ config: Fixture; env: NodeJS.ProcessEnv; messages: string[] }>([
  { config: { capped: true }, env: {}, messages: [] },
  {
    config: { children: [child(), child({ id: 93 })], cancelStates: ["waiting", "completed"] },
    env: { RELEASE_CHILD_SWEEP_TIMEOUT_SECONDS: "5" },
    messages: [url(93), "environment_ids[]=<id>", `gh run cancel --repo ${repo} 93`],
  },
])(
  "refuses dispatch when inventory or cancellation cannot establish a free slot: $config",
  ({ config, env, messages }) => {
    const result = fixture(config).run(dispatch(), env);
    expect(result.status, result.stderr).toBe(1);
    for (const message of messages) {
      expect(result.stderr).toContain(message);
    }
    expect(result.calls.some(isDispatch)).toBe(false);
  },
);

it("failure cleanup cancels a waiting npm child and preserves an active one", () => {
  const result = fixture({
    children: [
      child(),
      child({ id: 93, status: "in_progress", jobs: [{ status: "in_progress" }] }),
    ],
  }).run(
    `${source}cleanup_clawhub_children() { :; }\n${step("Clean up npm children after failure").run}`,
    { CHILD_PLUGIN_NPM_RUN_ID: "91", CHILD_OPENCLAW_NPM_RUN_ID: "93" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(cancellations(result)).toEqual(["91"]);
  // Same-tooling npm children publish in npm-publish and have no gate to reject.
  expect(result.calls.some((call) => call.args.includes("state=rejected"))).toBe(false);
});

const visible = { versions: { "2026.9.6": {} }, "dist-tags": { latest: "2026.9.6" } };
it("waits through missing version, missing selector and transport failure", () => {
  const result = fixture({ registry: [null, {}, { versions: { "2026.9.6": {} } }, visible] }).run(
    `${source}wait_for_core_npm_visibility`,
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls).toHaveLength(4);
  expect(result.calls[0]?.args).toEqual(
    expect.arrayContaining([
      "--connect-timeout",
      "10",
      "--max-time",
      "60",
      "Cache-Control: no-cache",
      "Accept: application/vnd.npm.install-v1+json",
      "https://registry.npmjs.org/openclaw",
    ]),
  );
  expect(result.summary).toMatch(/openclaw@2026.9.6 visible under latest after \d+s/);
});

it("fails on visibility timeout with the observed selector", () => {
  const result = fixture({ registry: [{ ...visible, "dist-tags": { latest: "2026.9.5" } }] }).run(
    `${source}wait_for_core_npm_visibility`,
    { RELEASE_NPM_VISIBILITY_TIMEOUT_SECONDS: "0" },
  );
  expect(result).toMatchObject({ status: 1, summary: "" });
  expect(result.calls).toHaveLength(1);
  expect(result.stderr).toContain("2026.9.5");
});

it("dispatches and waits for the release ledger using only its token", () => {
  const result = fixture({
    ledger: ledgerStates("queued", "success"),
  }).run(`${source}sync_npm_beta_floor`, { RELEASE_LEDGER_TOKEN: "fixture-ledger" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain(`${url(92)} status=queued elapsed=0s`);
  expect(result.stderr).toContain(`${url(92)} status=completed elapsed=15s`);
  expect(result.summary).toContain(`npm beta floor: synced (${url(92)})`);
  expect(JSON.parse(result.calls[0]!.body!)).toEqual({
    ref: "main",
    inputs: { mode: "sync_beta_to_stable" },
  });
  expect(result.calls[0]?.args).toContain("X-GitHub-Api-Version: 2026-03-10");
  expect(result.calls.every((call) => call.ledgerToken)).toBe(true);
  expect(result.calls).toHaveLength(3);
});

it.each<[string, Fixture, number]>([
  ["missing token", {}, 0],
  ["failed dispatch", { dispatchFails: true }, 1],
  ["failed sync", { ledger: ledgerStates("failure") }, 2],
])("leaves verification authoritative after %s", (_, config, calls) => {
  const env = calls ? { RELEASE_LEDGER_TOKEN: "fixture-ledger" } : {};
  const result = fixture(config).run(`${source}sync_npm_beta_floor`, env);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("::warning::");
  expect(result.summary).toContain(
    "gh workflow run openclaw-npm-dist-tags.yml --repo openclaw/releases --ref main -f mode=sync_beta_to_stable before verification",
  );
  expect(result.calls).toHaveLength(calls);
});

it("does not sync non-latest channels", () => {
  const result = fixture().run(`${source}sync_npm_beta_floor`, {
    RELEASE_NPM_DIST_TAG: "beta",
    RELEASE_LEDGER_TOKEN: "fixture-ledger",
  });
  expect(result).toMatchObject({ status: 0, calls: [], summary: "" });
});

it.each([
  { resume: false, visible: true, sync: "absent" },
  { resume: true, visible: true, sync: "absent" },
  { resume: false, visible: false, sync: "absent" },
  { resume: true, visible: false, sync: "absent" },
  { resume: false, visible: true, sync: "late" },
  { resume: true, visible: true, sync: "timeout" },
])(
  "gates verification on registry visibility and own sync (resume=$resume, visible=$visible, sync=$sync)",
  ({ resume, visible: isVisible, sync }) => {
    const harness = `
${noops("resolve_clawhub_release_plan", "verify_release_tag_target", "record_postpublish_diagnostics", "upload_dependency_evidence_release_asset", "upload_release_evidence_assets", "append_release_proof_to_github_release")}
wait_for_run_background() { (printf success > "$4") & wait_run_pid=$!; }
verify_published_release() { echo VERIFIED >> "$GITHUB_STEP_SUMMARY"; }
`;
    const result = fixture({
      registry: [isVisible ? visible : {}],
      harness,
      sleepSeconds: 300,
      ledger:
        sync === "timeout"
          ? ledgerStates("in_progress")
          : ledgerStates("queued", "in_progress", "in_progress", "in_progress", "success"),
    }).run(step("Complete publish workflows").run!, {
      CHILD_PLUGIN_NPM_RUN_ID: "90",
      CHILD_PLUGIN_CLAWHUB_RUN_ID: "",
      CHILD_PLUGIN_CLAWHUB_BOOTSTRAP_RUN_ID: "",
      CHILD_BOOTSTRAP_WORKFLOW_SHA: "",
      CHILD_OPENCLAW_NPM_ALREADY_PUBLISHED: String(resume),
      CHILD_OPENCLAW_NPM_EXPECTED_WORKFLOW_REF: "main",
      CHILD_OPENCLAW_NPM_EXPECTED_WORKFLOW_SHA: sha,
      CHILD_OPENCLAW_NPM_RUN_ATTEMPT: "1",
      CHILD_OPENCLAW_NPM_RUN_ID: resume ? "" : "92",
      CORE_START_OUTCOME: "success",
      CLAWHUB_AUTHORIZATION_OUTCOME: "skipped",
      CLAWHUB_RECEIPT_OUTCOME: "skipped",
      WAIT_FOR_CLAWHUB: "false",
      RELEASE_NPM_VISIBILITY_TIMEOUT_SECONDS: "0",
      ...(sync !== "absent" ? { RELEASE_LEDGER_TOKEN: "fixture-ledger" } : {}),
      ...(sync === "timeout" ? { RELEASE_NPM_DIST_TAG_SYNC_TIMEOUT_SECONDS: "900" } : {}),
    });
    expect(result.status, result.stderr).toBe(isVisible && sync !== "timeout" ? 0 : 1);
    expect(result.calls.filter((call) => call.binary === "curl")).toHaveLength(1);
    if (sync === "timeout") {
      expect(result.stderr).toContain(`parent's own sync run is still in progress (${url(92)})`);
      expect(result.summary).toContain("verification was not judged against it");
      expect(result.summary).not.toContain("VERIFIED");
    } else if (isVisible) {
      expect(result.summary).toMatch(/npm registry:[\s\S]*npm beta floor:[\s\S]*VERIFIED/);
      if (sync === "late") {
        expect(result.stderr).toContain("status=in_progress elapsed=900s");
        expect(result.stderr).toContain("status=completed elapsed=1200s");
        expect(result.summary).toContain("npm beta floor: synced");
      }
    } else {
      expect(result.summary).not.toMatch(/VERIFIED|npm beta floor/);
    }
  },
);
