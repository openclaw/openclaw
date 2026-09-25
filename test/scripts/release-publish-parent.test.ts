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
const dispatch = (name = "plugin-clawhub-release.yml", fields = "") =>
  `${source}dispatch_workflow_at_ref main "$PARENT_WORKFLOW_SHA" ${name} ${fields}`;

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
    `source "$HELPER_SCRIPT"\nsleep() { SECONDS=$((SECONDS + $1)); }\n${config.harness ?? ""}\n`,
  );
  const fake = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const root = process.env.FIXTURE_ROOT;
const config = ${JSON.stringify(config)};
const args = process.argv.slice(2);
const binary = process.argv[1].split('/').pop();
const state = JSON.parse(readFileSync(root + '/state.json', 'utf8'));
const save = () => writeFileSync(root + '/state.json', JSON.stringify(state));
const value = (key) => args[args.indexOf(key) + 1];
const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? '';
const post = args.includes('POST');
const body = args.includes('--input') ? readFileSync(0, 'utf8') : undefined;
appendFileSync(root + '/calls', JSON.stringify({ binary, args, body, ledgerToken: process.env.GH_TOKEN === 'fixture-ledger' }) + '\\n');
const emit = (value) => console.log(JSON.stringify(value));
const children = config.children ?? [];
const parent = (id) => ({ id: Number(id), repository: {full_name: '${repo}'}, head_repository: {full_name: '${repo}'}, event: 'workflow_dispatch', path: '.github/workflows/openclaw-release-publish.yml', run_attempt: id === '100' ? 2 : 1, status: id === '100' ? 'in_progress' : 'completed', conclusion: id === '100' ? null : 'failure', run_started_at: '2026-09-24T01:00:00Z', ...config.parent });
if (binary === 'curl') {
  const docs = config.registry ?? [];
  const doc = docs[Math.min(state.registry++, docs.length - 1)]; save();
  if (!doc) { console.error('registry unavailable'); process.exit(22); }
  emit(doc);
} else if (args[0] === 'run' && args[1] === 'list') {
  const matches = children.filter((run) => run.path.endsWith('/' + value('--workflow')) && run.status === value('--status') && !state.cancelled[run.id]);
  emit(config.capped ? Array(1000).fill({}) : matches.map((run) => ({ databaseId: run.id, displayTitle: run.display_title, headBranch: run.head_branch, url: '${url(0)}'.replace(/0$/, run.id), createdAt: run.created_at })));
} else if (args[0] === 'run' && args[1] === 'view') {
  const id = args[args.indexOf('--repo') + 2];
  if (value('--json') === 'headSha,url') emit({headSha: '${sha}', url: '${url(92)}'});
  else emit({ jobs: children.find((run) => String(run.id) === id)?.jobs ?? [] });
} else if (args[0] === 'run' && args[1] === 'cancel') {
  state.cancelled[args[args.indexOf('--repo') + 2]] = true; save();
} else if (endpoint.endsWith('/pending_deployments')) {
  if (post && config.rejectFails) { console.error('HTTP 403'); process.exit(1); }
  emit(post ? {} : [{environment: {id: 7}}]);
} else if (endpoint.endsWith('/dispatches')) {
  if (config.dispatchFails) { console.error('HTTP 502'); process.exit(1); }
  emit({ workflow_run_id: 92, html_url: '${url(92)}' });
} else if (endpoint.includes('/commits/')) console.log('${sha}');
else if (endpoint.includes('/actions/runs/')) {
  const id = endpoint.split('/').pop();
  if (endpoint.startsWith('repos/openclaw/releases/')) {
    const states = config.ledger ?? [{status: 'completed', conclusion: 'success'}];
    emit(states[Math.min(state.ledger++, states.length - 1)]); save();
  } else {
    const run = children.find((run) => String(run.id) === id);
    if (!run) emit(parent(id));
    else {
      const states = config.cancelStates ?? ['waiting', 'completed'];
      const index = state.polls[id] ?? 0;
      emit({...run, status: state.cancelled[id] ? states[Math.min(index, states.length - 1)] : config.completedBeforeSweep ? "completed" : run.status});
      if (state.cancelled[id]) { state.polls[id] = index + 1; save(); }
    }
  }
} else throw new Error('Unexpected call: ' + JSON.stringify(args));
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
    expect(result.stderr).toContain("::notice::");
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

  it("refuses capped inventories and skips sweeping dry runs", () => {
    const blocked = fixture({ capped: true }).run(dispatch());
    expect(blocked.status).toBe(1);
    expect(blocked.calls.some(isDispatch)).toBe(false);
    const dry = fixture({ children: [child()] }).run(
      dispatch("plugin-clawhub-release.yml", "-f dry_run=true"),
    );
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.calls.some((call) => call.args[1] === "list" || isCancel(call))).toBe(false);
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
    expect(result.calls.some((call) => call.args.includes("state=rejected"))).toBe(true);
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
    {
      label: "timeout",
      env: {
        RELEASE_LEDGER_TOKEN: "fixture-ledger",
        RELEASE_NPM_DIST_TAG_SYNC_TIMEOUT_SECONDS: "0",
      },
      config: { ledger: [{ status: "waiting" }] },
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
    { resume: false, visible: true },
    { resume: true, visible: true },
    { resume: false, visible: false },
    { resume: true, visible: false },
  ])(
    "gates verification on registry visibility (resume=$resume, visible=$visible)",
    ({ resume, visible: isVisible }) => {
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
      const result = fixture({ registry: [isVisible ? visible : {}], harness }).run(
        step("Complete publish workflows").run!,
        {
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
        },
      );
      expect(result.status, result.stderr).toBe(isVisible ? 0 : 1);
      expect(result.calls.filter((call) => call.binary === "curl")).toHaveLength(1);
      if (isVisible) {
        expect(result.summary).toMatch(/npm registry:[\s\S]*npm beta floor:[\s\S]*VERIFIED/);
      } else {
        expect(result.summary).not.toMatch(/VERIFIED|npm beta floor/);
      }
    },
  );
});
