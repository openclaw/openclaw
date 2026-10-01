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
const url = (id: number) => `https://github.com/${repo}/actions/runs/${id}`;
const workflow = parse(readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8")) as {
  jobs: { publish: { steps: { name: string; run?: string; env?: Record<string, string> }[] } };
};
const step = (name: string) => workflow.jobs.publish.steps.find((entry) => entry.name === name)!;
const source =
  'source "$GITHUB_WORKSPACE/.release-harness/scripts/lib/release-publish-children.sh"\n';
const dispatch = (name = "plugin-clawhub-release.yml") =>
  `${source}${name.startsWith("plugin-clawhub-") ? `require_clawhub_dispatch_available main ${name}` : `sweep_superseded_children ${name}`}\ndispatch_workflow_at_ref main "$PARENT_WORKFLOW_SHA" ${name}`;

function child(overrides: Record<string, unknown> = {}) {
  return {
    id: 91,
    repository: { full_name: repo },
    head_repository: { full_name: repo },
    actor: { login: "github-actions[bot]" },
    event: "workflow_dispatch",
    path: ".github/workflows/plugin-clawhub-release.yml",
    display_title: `plugin-clawhub-release.yml [${tag}] publish parent=80/1`,
    head_branch: "main",
    created_at: "2026-09-24T00:00:00Z",
    status: "waiting",
    jobs: [{ name: "publish", status: "waiting" }],
    ...overrides,
  };
}

type Fixture = {
  children?: ReturnType<typeof child>[];
  parent?: Record<string, unknown>;
  cancelStates?: string[];
  rejectFails?: boolean;
  capped?: boolean;
  completedBeforeSweep?: boolean;
  registry?: (Record<string, unknown> | null)[];
  ledger?: { status: string; conclusion?: string }[];
  dispatchFails?: boolean;
  sleepSeconds?: number;
  harness?: string;
};

// Polls advance external state; stubbed sleep advances Bash's clock without wall waits.
function fixture(config: Fixture = {}) {
  const root = tempDirs.make("release-publish-parent-");
  const harness = join(root, ".release-harness/scripts/lib");
  mkdirSync(harness, { recursive: true });
  mkdirSync(join(root, "bin"));
  for (const file of ["calls", "summary", "output"]) {
    writeFileSync(join(root, file), "");
  }
  writeFileSync(
    join(root, "state.json"),
    JSON.stringify({ cancelled: {}, polls: {}, registry: 0, ledger: 0 }),
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
def value(key): return args[args.index(key) + 1]
def emit(data): print(json.dumps(data))
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
    docs = config.get('registry', [])
    doc = docs[min(state['registry'], len(docs) - 1)] if docs else None
    state['registry'] += 1
    save()
    if doc is None: fail('registry unavailable', 22)
    emit(doc)
elif args[:2] == ['run', 'list']:
    matches = [run for run in children if run['path'].endswith('/' + value('--workflow')) and run['status'] == value('--status') and not state['cancelled'].get(str(run['id']))]
    emit([{}] * 1000 if config.get('capped') else [dict(databaseId=run['id'], displayTitle=run['display_title'], headBranch=run['head_branch'], url='https://github.com/${repo}/actions/runs/' + str(run['id']), createdAt=run['created_at']) for run in matches])
elif args[:2] == ['run', 'view']:
    run_id = args[args.index('--repo') + 2]
    if value('--json') == 'headSha,url': emit(dict(headSha='${sha}', url='${url(92)}'))
    else: emit(dict(jobs=next((run['jobs'] for run in children if str(run['id']) == run_id), [])))
elif args[:2] == ['run', 'cancel']:
    state['cancelled'][args[args.index('--repo') + 2]] = True
    save()
elif endpoint.endswith('/pending_deployments'):
    if post and config.get('rejectFails'): fail('HTTP 403')
    emit({} if post else [dict(environment=dict(id=7))])
elif endpoint.endswith('/dispatches'):
    if config.get('dispatchFails'): fail('HTTP 502')
    emit(dict(workflow_run_id=92, html_url='${url(92)}'))
elif '/commits/' in endpoint: print('${sha}')
elif '/actions/runs/' in endpoint:
    run_id = endpoint.split('/')[-1]
    if endpoint.startswith('repos/openclaw/releases/'):
        states = config.get('ledger', [dict(status='completed', conclusion='success')])
        emit(states[min(state['ledger'], len(states) - 1)])
        state['ledger'] += 1
        save()
    else:
        run = next((run for run in children if str(run['id']) == run_id), None)
        if run is None: emit(parent(run_id))
        else:
            states = config.get('cancelStates', ['waiting', 'completed'])
            index = state['polls'].get(run_id, 0)
            emit(run | dict(status=states[min(index, len(states) - 1)] if state['cancelled'].get(run_id) else 'completed' if config.get('completedBeforeSweep') else run['status']))
            if state['cancelled'].get(run_id):
                state['polls'][run_id] = index + 1
                save()
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
        .map(
          (line) =>
            JSON.parse(line) as {
              binary: string;
              args: string[];
              body?: string;
              ledgerToken: boolean;
            },
        );
      return { ...result, calls, summary: readFileSync(join(root, "summary"), "utf8") };
    },
  };
}

const isDispatch = (call: { args: string[] }) =>
  call.args.some((arg) => arg.endsWith("/dispatches"));
const isCancel = (call: { args: string[] }) => call.args[1] === "cancel";

describe("superseded release children", () => {
  it.each([
    { name: "openclaw-npm-release.yml", blocked: false },
    { name: "plugin-clawhub-new.yml", blocked: true },
  ])("preflights a gate-blocked stale $name before any dispatch", ({ name, blocked }) => {
    const result = fixture({
      children: [
        child({
          path: `.github/workflows/${name}`,
          display_title: `${name} [${tag}] publish parent=80/1`,
        }),
      ],
      rejectFails: true,
      cancelStates: ["waiting"],
      harness: `
verify_release_tag_target() { :; }
render_github_release_notes() { :; }
guard_existing_public_release() { :; }
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
    expect(result.stderr.match(/HTTP 403/g)).toHaveLength(1);
    expect(result.summary).toContain(url(91));
    expect(result.summary).toContain("cancellation unconfirmed");
    expect(result.calls.filter(isCancel).map((call) => call.args.at(-1))).toEqual(["91"]);
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
          "plugin-clawhub-release.yml",
          "plugin-clawhub-new.yml",
          "openclaw-npm-release.yml",
        ]),
      );
      expect(
        result.calls.slice(firstDispatch).some((call) => call.args[1] === "list" || isCancel(call)),
      ).toBe(false);
    }
  });

  it("rejects the gate, cancels, and observes completion before dispatching", () => {
    const result = fixture({ children: [child()] }).run(dispatch());
    expect(result.status, result.stderr).toBe(0);
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
      expect.arrayContaining([
        "POST",
        `repos/${repo}/actions/workflows/plugin-clawhub-release.yml/dispatches`,
      ]),
    ]);
    const afterCancel = result.calls.slice(
      result.calls.findIndex(isCancel) + 1,
      result.calls.findIndex(isDispatch),
    );
    expect(
      afterCancel.filter((call) => call.args.includes(`repos/${repo}/actions/runs/91`)),
    ).toHaveLength(2);
    expect(result.summary).toContain(
      `Reclaimed superseded plugin-clawhub-release.yml child: ${url(91)}`,
    );
  });

  it.each([
    { label: "a live publisher", overrides: { jobs: [{ status: "in_progress" }] } },
    {
      label: "this parent attempt",
      overrides: { display_title: `plugin-clawhub-release.yml [${tag}] publish parent=100/2` },
    },
    { label: "another actor", overrides: { actor: { login: "someone" } } },
  ])("preserves and blocks on $label", ({ overrides }) => {
    const result = fixture({ children: [child(overrides)] }).run(dispatch());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ClawHub dispatch blocked by waiting run");
    expect(result.calls.some(isCancel)).toBe(false);
    expect(result.calls.some(isDispatch)).toBe(false);
  });

  it.each(["success", "in_progress"])("preserves a child with a %s parent", (parentState) => {
    const parent =
      parentState === "success"
        ? { conclusion: "success" }
        : { status: "in_progress", conclusion: null };
    const result = fixture({ children: [child()], parent }).run(dispatch());
    expect(result.status).toBe(1);
    expect(result.calls.some(isCancel)).toBe(false);
  });

  it("reclaims an older attempt and tolerates a rejected reviewer request", () => {
    const result = fixture({
      children: [
        child({ display_title: `plugin-clawhub-release.yml [${tag}] publish parent=100/1` }),
      ],
      rejectFails: true,
    }).run(dispatch());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("::warning::");
    expect(result.calls.filter(isCancel)).toHaveLength(1);
  });

  it.each(["openclaw-npm-release.yml", "plugin-clawhub-new.yml"])(
    "sweeps correlated %s children",
    (name) => {
      const result = fixture({
        children: [
          child({
            path: `.github/workflows/${name}`,
            display_title: `${name} [${tag}] publish parent=80/1`,
          }),
        ],
      }).run(dispatch(name));
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls.filter(isCancel)).toHaveLength(1);
    },
  );

  it("ignores a child completed since the active inventory was read", () => {
    const result = fixture({ children: [child()], completedBeforeSweep: true }).run(dispatch());
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.some(isCancel)).toBe(false);
    expect(result.calls.some(isDispatch)).toBe(true);
  });

  it("skips legacy core titles", () => {
    const result = fixture({
      children: [
        child({
          path: ".github/workflows/openclaw-npm-release.yml",
          display_title: "OpenClaw NPM Release",
        }),
      ],
    }).run(dispatch("openclaw-npm-release.yml"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.some(isCancel)).toBe(false);
  });

  it("only reclaims plugin npm runs older than the parent and excludes its known child", () => {
    const npm = {
      path: ".github/workflows/plugin-npm-release.yml",
      display_title: `Plugin NPM Release [all-publishable] ${target}`,
    };
    const result = fixture({
      children: [
        child(npm),
        child({ ...npm, id: 93, created_at: "2026-09-24T02:00:00Z" }),
        child({ ...npm, id: 94 }),
      ],
    }).run(dispatch("plugin-npm-release.yml"), { CHILD_PLUGIN_NPM_RUN_ID: "94" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter(isCancel).map((call) => call.args.at(-1))).toEqual(["91"]);
    expect(
      result.calls.filter((call) => call.args.includes(`repos/${repo}/actions/runs/100`)),
    ).toHaveLength(1);
  });

  it("leaves plugin npm children alone while another publish parent is live", () => {
    const result = fixture({
      children: [
        child({
          path: ".github/workflows/plugin-npm-release.yml",
          display_title: `Plugin NPM Release [all-publishable] ${target}`,
        }),
        child({
          id: 80,
          path: ".github/workflows/openclaw-release-publish.yml",
          display_title: "OpenClaw Release Publish",
          status: "in_progress",
        }),
      ],
    }).run(dispatch("plugin-npm-release.yml"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Another publish parent is live");
    expect(result.calls.some(isCancel)).toBe(false);
    expect(result.calls.some(isDispatch)).toBe(true);
  });

  it("refuses capped inventories", () => {
    const blocked = fixture({ capped: true }).run(dispatch());
    expect(blocked.status).toBe(1);
    expect(blocked.calls.some(isDispatch)).toBe(false);
  });

  it("shares the sweep deadline and prints manual reject/cancel commands", () => {
    const result = fixture({
      children: [child(), child({ id: 93 })],
      cancelStates: ["waiting", "completed"],
    }).run(dispatch(), { RELEASE_CHILD_SWEEP_TIMEOUT_SECONDS: "5" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(url(93));
    expect(result.stderr).toContain("environment_ids[]=<id>");
    expect(result.stderr).toContain(`gh run cancel --repo ${repo} 93`);
    expect(result.calls.some(isDispatch)).toBe(false);
  });

  it("failure cleanup cancels a waiting npm child and preserves an active one", () => {
    const result = fixture({
      children: [
        child(),
        child({ id: 93, status: "in_progress", jobs: [{ status: "in_progress" }] }),
      ],
    }).run(
      `${source}cleanup_clawhub_children() { :; }\n${step("Clean up ClawHub children after failure").run}`,
      { CHILD_PLUGIN_NPM_RUN_ID: "91", CHILD_OPENCLAW_NPM_RUN_ID: "93" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter(isCancel).map((call) => call.args.at(-1))).toEqual(["91"]);
    // Same-tooling npm children publish in npm-publish and have no gate to reject.
    expect(result.calls.some((call) => call.args.includes("state=rejected"))).toBe(false);
  });
});

const visible = { versions: { "2026.9.6": {} }, "dist-tags": { latest: "2026.9.6" } };
describe("npm completion barriers", () => {
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
    expect(result.status).toBe(1);
    expect(result.calls).toHaveLength(1);
    expect(result.stderr).toContain("2026.9.5");
    expect(result.summary).toBe("");
  });

  it("dispatches and waits for the release ledger using only its token", () => {
    const result = fixture({
      ledger: [{ status: "queued" }, { status: "completed", conclusion: "success" }],
    }).run(`${source}sync_npm_beta_floor`, { RELEASE_LEDGER_TOKEN: "fixture-ledger" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.calls[0]!.body!)).toEqual({
      ref: "main",
      inputs: { mode: "sync_beta_to_stable" },
    });
    expect(result.calls[0]?.args).toContain("X-GitHub-Api-Version: 2026-03-10");
    expect(result.calls.every((call) => call.ledgerToken)).toBe(true);
    expect(result.calls).toHaveLength(3);
    expect(result.stderr).toContain(`${url(92)} status=queued elapsed=0s`);
    expect(result.stderr).toContain(`${url(92)} status=completed elapsed=15s`);
    expect(result.summary).toContain(`npm beta floor: synced (${url(92)})`);
  });

  it.each([
    { label: "missing token", env: {}, config: {}, calls: 0 },
    {
      label: "failed dispatch",
      env: { RELEASE_LEDGER_TOKEN: "fixture-ledger" },
      config: { dispatchFails: true },
      calls: 1,
    },
    {
      label: "failed sync",
      env: { RELEASE_LEDGER_TOKEN: "fixture-ledger" },
      config: { ledger: [{ status: "completed", conclusion: "failure" }] },
      calls: 2,
    },
  ])("leaves verification authoritative after $label", ({ env, config, calls }) => {
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
    expect(result.status).toBe(0);
    expect(result.calls).toHaveLength(0);
    expect(result.summary).toBe("");
  });
});

describe("complete publish workflow", () => {
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
resolve_clawhub_release_plan() { :; }
verify_release_tag_target() { :; }
wait_for_run_background() { (printf success > "$4") & wait_run_pid=$!; }
verify_published_release() { echo VERIFIED >> "$GITHUB_STEP_SUMMARY"; }
record_postpublish_diagnostics() { :; }
upload_dependency_evidence_release_asset() { :; }
upload_release_evidence_assets() { :; }
append_release_proof_to_github_release() { :; }
`;
      const result = fixture({
        registry: [isVisible ? visible : {}],
        harness,
        sleepSeconds: 300,
        ledger:
          sync === "timeout"
            ? [{ status: "in_progress" }]
            : [
                { status: "queued" },
                { status: "in_progress" },
                { status: "in_progress" },
                { status: "in_progress" },
                { status: "completed", conclusion: "success" },
              ],
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
});
