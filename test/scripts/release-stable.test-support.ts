import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReleasePhase, ReleaseState } from "../../scripts/lib/release-stable-state.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";

export const RELEASE = "2026.9.6";
export const CUT_SHA = "a".repeat(40);
export const TOOLING_SHA = "b".repeat(40);
export const REPOSITORY = "openclaw/openclaw";
export const PHASES = [
  "cut",
  "validate",
  "publish",
  "sync-beta",
  "flip-github",
  "macos",
  "closeout",
] as const;
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export type FakeStep = {
  bin: "git" | "gh" | "npm" | "pnpm";
  match: string[];
  stdout?: string;
  stderr?: string;
  exit?: number;
  times?: number;
  verifyLock?: boolean;
  request?: { phase: string; run?: { id: number; attempt: number } };
};
type FakeCall = { bin: string; args: string[] };

export function step(
  bin: FakeStep["bin"],
  match: string[],
  stdout = "",
  extra: Partial<Omit<FakeStep, "bin" | "match" | "stdout">> = {},
): FakeStep {
  return { bin, match, stdout, ...extra };
}

export function phaseState(phase: ReleasePhase): ReleaseState {
  const date = "2026-09-06T12:00:00.000Z";
  const state: ReleaseState = {
    version: 1,
    release: RELEASE,
    tag: `v${RELEASE}`,
    branch: `release/${RELEASE}`,
    repo: REPOSITORY,
    releasesRepo: "openclaw/releases",
    startedAt: date,
    operator: {
      name: "release-test",
      login: "release-test",
      cutShaConfirmed: CUT_SHA,
      publicationApproved: date,
    },
    phases: {
      cut: { status: "completed" },
      validate: { status: "completed" },
      publish: { status: "completed" },
      "sync-beta": { status: "completed" },
      "flip-github": { status: "completed" },
      macos: { status: "completed" },
      closeout: { status: "completed" },
    },
    cut: { cutSha: CUT_SHA, releaseSha: CUT_SHA },
    validate: { continues: 0 },
    publish: { approvedGates: [] },
    syncBeta: {},
    flipGithub: {},
    macos: {},
    closeout: {},
    history: [],
  };
  state.phases[phase] = { status: "pending" };
  return state;
}

export function postState(phase: ReleasePhase): ReleaseState {
  const state = phaseState(phase);
  state.validate = {
    toolingSha: TOOLING_SHA,
    toolingTag: "release-publish/bbbbbbbbbbbb-123",
    runId: "101",
    runAttempt: 1,
    continues: 0,
    stableSoakWaiver: "Operator-approved fixture's waiver; $no_shell `execution`",
    laneWaiver: "Deferred fixture lanes",
  };
  state.publish = {
    approvedGates: [],
    publishRunId: "301",
    npmVisibleAt: state.startedAt,
    macosValidateRunId: "201",
    macosPreflightRunId: "202",
  };
  state.capabilities = {
    toolingSha: TOOLING_SHA,
    probedAt: state.startedAt,
    parentSyncsBetaDistTag: false,
    parentSweepsStaleChildren: false,
    childNpmPublishEnvironment: false,
    closeoutResolvesWaivers: false,
  };
  return state;
}

export function actionRun(repo: string, id: number, conclusion = "success", attempt = 1): FakeStep {
  return step(
    "gh",
    ["api", `repos/${repo}/actions/runs/${id}`],
    JSON.stringify({ status: "completed", conclusion, run_attempt: attempt }),
  );
}

export function workflowDispatch(
  workflow: string,
  repo: string,
  id: number,
  displayTitle = `Release v${RELEASE}`,
): FakeStep[] {
  return [
    step("gh", ["workflow", "run", workflow, "--repo", repo, "--ref", "main"]),
    step(
      "gh",
      [
        "api",
        `repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=10`,
      ],
      JSON.stringify({
        workflow_runs: [
          {
            id,
            path: `.github/workflows/${workflow}`,
            event: "workflow_dispatch",
            actor: { login: "release-test" },
            head_branch: "main",
            display_title: displayTitle,
            created_at: new Date().toISOString(),
          },
        ],
      }),
    ),
  ];
}

export function githubRelease(draft: boolean): FakeStep {
  return step(
    "gh",
    ["release", "view", `v${RELEASE}`, "--repo", REPOSITORY],
    JSON.stringify({ isDraft: draft, tagName: `v${RELEASE}` }),
  );
}

export function macosWait(id: number, conclusion = "success", attempt = 1): FakeStep[] {
  return [
    step("gh", ["api", `repos/openclaw/releases/actions/runs/${id}/pending_deployments`], "[]"),
    actionRun("openclaw/releases", id, conclusion, attempt),
  ];
}

export function compatibilityInventory(version = RELEASE): FakeStep[] {
  return [
    step("git", ["fetch", "origin", "main:refs/remotes/origin/main"]),
    step(
      "git",
      ["show", "origin/main:scripts/lib/update-compat-inventory.json"],
      JSON.stringify({ releases: [{ version }] }),
    ),
  ];
}

export function closeoutMain(version = RELEASE, notes = `## ${RELEASE}\n`): FakeStep[] {
  return [
    actionRun(REPOSITORY, 301),
    step("git", ["fetch", "origin", "main:refs/remotes/origin/main"]),
    step("git", ["show", "origin/main:package.json"], JSON.stringify({ version })),
    step("git", ["show", `origin/main:CHANGELOG/${RELEASE}.md`], notes),
    step("git", ["show", `v${RELEASE}:CHANGELOG/${RELEASE}.md`], `## ${RELEASE}\n`),
  ];
}

export const PUBLISH_WAIVER = "Operator's waiver; $NO_SHELL `no_shell`; approved=yes";
export const CANDIDATE_COMMAND =
  String.raw`gh workflow run openclaw-release-publish.yml --repo openclaw/openclaw --ref release-publish/bbbbbbbbbbbb-123 \
  -f tag=v2026.9.6 \
  -f full_release_validation_run_id=101 \
  -f full_release_validation_run_attempt=3 \
  -f npm_dist_tag=latest \
  -f plugin_publish_scope=all-publishable \
  -f 'stable_soak_waiver=Operator'\''s waiver; $NO_SHELL \`no_shell\`; approved=yes' \
  -f 'lane_waiver=Deferred fixture lanes' \
  -f publish_openclaw_npm=true \
  -f wait_for_clawhub=true`.replaceAll("\\`", "`");

export const publishParentRun = () => ({
  id: 301,
  path: ".github/workflows/openclaw-release-publish.yml",
  event: "workflow_dispatch",
  actor: { login: "release-test" },
  head_branch: "release-publish/bbbbbbbbbbbb-123",
  display_title: `Publish v${RELEASE}`,
  created_at: new Date().toISOString(),
});

export const publishChild = (
  id: number,
  name = "Plugin NPM Release",
  workflow = "plugin-npm-release.yml",
) => ({
  id,
  name,
  path: `.github/workflows/${workflow}`,
  head_branch: "release-publish/bbbbbbbbbbbb-123",
  event: "workflow_dispatch",
  status: "waiting",
  created_at: new Date(Date.now() + 60_000).toISOString(),
  actor: { login: "github-actions[bot]" },
  display_title: name,
});

export function publishState(npmPublishEnvironment = false): ReleaseState {
  const state = postState("publish");
  delete state.publish.publishRunId;
  delete state.publish.npmVisibleAt;
  state.validate.stableSoakWaiver = PUBLISH_WAIVER;
  if (state.capabilities) {
    state.capabilities.childNpmPublishEnvironment = npmPublishEnvironment;
  }
  return state;
}

export function publishPreparation(createTag = false): FakeStep[] {
  return [
    step("pnpm", ["release:candidate", "--", "--tag", `v${RELEASE}`]),
    step(
      "git",
      ["ls-remote", "--tags", "origin", `v${RELEASE}`, `v${RELEASE}^{}`],
      createTag
        ? ""
        : `${"d".repeat(40)}\trefs/tags/v${RELEASE}\n${CUT_SHA}\trefs/tags/v${RELEASE}^{}\n`,
    ),
    ...(createTag
      ? [
          step("git", ["tag", "-a", `v${RELEASE}`, CUT_SHA, "-m", `OpenClaw ${RELEASE}`]),
          step("git", ["push", "origin", `refs/tags/v${RELEASE}`]),
        ]
      : []),
  ];
}

export function pendingGates(
  id: number,
  environments: { id: number; name: string }[] = [],
): FakeStep {
  return step(
    "gh",
    ["api", `repos/${REPOSITORY}/actions/runs/${id}/pending_deployments`],
    JSON.stringify(environments.map((environment) => ({ environment }))),
  );
}

export function gateApproval(id: number, environment: number): FakeStep {
  return step("gh", [
    "api",
    "-X",
    "POST",
    `repos/${REPOSITORY}/actions/runs/${id}/pending_deployments`,
    "-f",
    "state=approved",
    "-f",
    `comment=${RELEASE} stable publish approved by release-test`,
    "-F",
    `environment_ids[]=${environment}`,
  ]);
}

export function npmVisibility(visible = true): FakeStep {
  return step(
    "npm",
    ["view", `openclaw@${RELEASE}`, "version", "--json", "--prefer-online"],
    visible ? JSON.stringify(RELEASE) : "",
    visible ? {} : { exit: 1, stderr: "E404 not published yet" },
  );
}

export function releaseFixture(root: string) {
  const node = resolveTestNodeExecPath();
  const stateDir = join(root, "release");
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  mkdirSync(join(root, "tmp"));
  const fake = `#!${node}
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
const root = process.env.FIXTURE_ROOT;
const bin = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(root + '/calls.log', JSON.stringify({ bin, args }) + '\\n');
const script = JSON.parse(readFileSync(root + '/script.json', 'utf8'));
const expected = script[0];
if (!expected || expected.bin !== bin || !expected.match.every((word, index) => word === '*' || args[index] === word)) {
  const message = 'Unexpected command: ' + JSON.stringify({ bin, args, expected });
  appendFileSync(root + '/unexpected.log', message + '\\n');
  console.error(message);
  process.exit(97);
}
if ((expected.times ?? 1) > 1) expected.times -= 1;
else script.shift();
writeFileSync(root + '/script.json', JSON.stringify(script));
if (expected.verifyLock) {
  const locks = readdirSync(root + '/release').filter((name) => name.endsWith('.lock'));
  const lock = JSON.parse(readFileSync(root + '/release/state.lock', 'utf8'));
  if (locks.length !== 1 || locks[0] !== 'state.lock' || lock.pid !== process.ppid || !Number.isFinite(Date.parse(lock.startedAt))) {
    throw new Error('Release process does not exclusively own the replacement lock');
  }
}
if (expected.request) {
  const index = args.indexOf('--request-file');
  if (bin !== 'pnpm' || args[0] !== 'ci:full-release' || index < 0) throw new Error('Invalid request writer');
  const target = resolve(args[index + 1]);
  if (!target.startsWith(resolve(root) + sep)) throw new Error('Request escaped fixture');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(expected.request));
}
process.stdout.write(expected.stdout ?? '');
process.stderr.write(expected.stderr ?? '');
process.exit(expected.exit ?? 0);
`;
  for (const bin of ["gh", "git", "npm", "pnpm"]) {
    writeFileSync(join(binDir, bin), fake, { mode: 0o755 });
  }
  writeFileSync(join(root, "calls.log"), "");
  writeFileSync(join(root, "script.json"), "[]");
  return {
    root,
    stateDir,
    stateFile: join(stateDir, "state.json"),
    seed(state: ReleaseState) {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "state.json"), JSON.stringify(state));
    },
    candidate(publishCommand: string, attempt = 3) {
      const candidateDir = join(stateDir, "candidate");
      mkdirSync(candidateDir, { recursive: true });
      writeFileSync(
        join(candidateDir, "release-candidate-evidence.json"),
        JSON.stringify({ publishCommand, fullReleaseValidationRunAttempt: attempt }),
      );
    },
    readState(): ReleaseState {
      return JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
    },
    run(script: FakeStep[], args: string[] = []) {
      writeFileSync(join(root, "script.json"), JSON.stringify(script));
      const result = spawnSync(
        node,
        [
          "--import",
          resolve(REPO_ROOT, "scripts/tsx.mjs"),
          resolve(REPO_ROOT, "scripts/release-stable.mts"),
          RELEASE,
          "--state-dir",
          stateDir,
          "--operator",
          "release-test",
          ...args,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 15_000,
          env: {
            PATH: binDir,
            FIXTURE_ROOT: root,
            TMPDIR: join(root, "tmp"),
            TSX_DISABLE_CACHE: "1",
            OPENCLAW_RELEASE_STABLE_POLL_MS: "1",
            OPENCLAW_RELEASE_STABLE_BACKOFF_MS: "1",
          },
        },
      );
      const unexpected = join(root, "unexpected.log");
      if (existsSync(unexpected)) {
        throw new Error(readFileSync(unexpected, "utf8"));
      }
      if (result.error) {
        throw result.error;
      }
      const remaining: FakeStep[] = JSON.parse(readFileSync(join(root, "script.json"), "utf8"));
      if (remaining.length) {
        throw new Error(
          `Unconsumed commands: ${JSON.stringify(remaining)}\n${result.stdout}\n${result.stderr}`,
        );
      }
      const calls: FakeCall[] = readFileSync(join(root, "calls.log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line: string) => JSON.parse(line));
      return { ...result, output: `${result.stdout}\n${result.stderr}`, calls };
    },
  };
}
