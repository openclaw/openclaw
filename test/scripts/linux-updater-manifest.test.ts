import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repository = "fixture/openclaw";
const toolingSha = "a".repeat(40);
const sourceSha = "b".repeat(40);

const linuxVersion = "2026.9.4";
const sourceTag = "v2026.9.4";
const appImage = "OpenClaw-2026.9.4-amd64.AppImage";
const deb = "OpenClaw-2026.9.4-amd64.deb";
const publishWorkflow = ".github/workflows/openclaw-release-publish.yml";
const promoteWorkflow = ".github/workflows/openclaw-release-promote.yml";
const requestWorkflow = ".github/workflows/linux-app-release-request.yml";

type Release = {
  isDraft: boolean;
  isPrerelease: boolean;
  assets: string[];
  manifest?: string;
  immutable?: string;
  checksums?: string;
  digests?: Record<string, string>;
  assetState?: string;
  assetSize?: number;
  restId?: number;
  assetIds?: Record<string, number>;
};
type ActionRun = {
  id: number;
  run_attempt: number;
  repository: { full_name: string };
  head_sha: string;
  head_branch: string;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  display_title?: string;
};
type Remote = {
  latest: string | null;
  releases: Record<string, Release>;
  calls: string[][];
  uploads: number;
  requests?: Array<{ ref: string; inputs: Record<string, string> }>;
  requestRuns?: ActionRun[];
  requestReadRejected?: boolean;
  uploadBehavior?: "accepted-error" | "rejected-error" | "deleted-error" | "success-noop";
  dispatchRejected?: boolean;
  missingDispatchId?: boolean;
  toolingStatus?: string;
  parentAttempt?: number;
  currentRun?: ActionRun;
  currentRunOverrides?: Partial<ActionRun>;
  eventInputOverrides?: { tag?: string; npm_dist_tag?: string };
};

function fixtureRelease(remote: Remote, tag: string): Release {
  return expectDefined(remote.releases[tag], `release fixture ${tag}`);
}

function manifest(version: string, overrides: Record<string, unknown> = {}) {
  return `${JSON.stringify(
    {
      version,
      notes: "Linux update — original release notes 🦞",
      pub_date: "2026-09-13T00:00:00Z",
      platforms: {
        "linux-x86_64": {
          signature: Buffer.from("signed original AppImage").toString("base64"),
          url: `https://github.com/${repository}/releases/download/v${version}/OpenClaw-${version}-amd64.AppImage`,
        },
      },
      ...overrides,
    },
    null,
    3,
  )}\n\n`;
}

function release(version: string, overrides: Partial<Release> = {}): Release {
  return {
    isDraft: false,
    isPrerelease: false,
    assets: [`OpenClaw-${version}-amd64.AppImage`],
    manifest: manifest(version),
    ...overrides,
  };
}

function completeRelease(version: string): Release {
  const names = [`OpenClaw-${version}-amd64.AppImage`, `OpenClaw-${version}-amd64.deb`];
  const hashes = ["1".repeat(64), "2".repeat(64)];
  return release(version, {
    assets: names,
    checksums: names.map((name, index) => `${hashes[index]}  ./${name}\n`).join(""),
    digests: Object.fromEntries(names.map((name, index) => [name, `sha256:${hashes[index]}`])),
  });
}

function actionRun(overrides: Partial<ActionRun>): ActionRun {
  return {
    id: 200,
    run_attempt: 1,
    repository: { full_name: repository },
    head_sha: toolingSha,
    head_branch: "main",
    status: "in_progress",
    conclusion: null,
    event: "workflow_dispatch",
    path: ".github/workflows/openclaw-release-publish.yml@refs/heads/main",
    ...overrides,
  };
}

function publishedRelease(companion?: { name: string; sha256: string }): Release {
  const source = completeRelease(linuxVersion);
  const checksumBytes =
    expectDefined(source.checksums, "checksums") +
    (companion ? `${companion.sha256}  ./${companion.name}\n` : "");
  source.checksums = checksumBytes;
  source.immutable = manifest(linuxVersion, {
    linuxPublication: {
      schemaVersion: 1,
      releaseId: 42,
      sourceSha,
      toolingSha,
      channelSha: sourceSha,
      publicKeySha256: "d".repeat(64),
      assets: [
        ...source.assets.map((name, index) => ({
          id: index + 1,
          name,
          size: 1024,
          sha256: expectDefined(source.digests?.[name], "bundle digest").slice(7),
        })),
        {
          id: 3,
          name: "SHA256SUMS.linux-app.txt",
          size: Buffer.byteLength(checksumBytes),
          sha256: createHash("sha256").update(checksumBytes).digest("hex"),
        },
        ...(companion
          ? [{ id: 7, name: companion.name, size: 1024, sha256: companion.sha256 }]
          : []),
      ],
    },
  });
  source.manifest = source.immutable;
  return source;
}

function publishFixture(state: Remote, source: Release) {
  state.releases[sourceTag] = source;
  state.releases["linux-stable"] = {
    isDraft: false,
    isPrerelease: true,
    assets: [],
    manifest: source.immutable,
  };
}

function flags(values: Record<string, string>) {
  return Object.entries(values).flatMap(([key, value]) => [`--${key}`, value]);
}

function expectOutcome(
  remote: ReturnType<typeof fixture>,
  result: { status: number | null; stderr: string; evidence: { state: string } },
  state: string,
  exit = 0,
  uploads = 0,
) {
  expect(
    { exit: result.status, state: result.evidence.state, uploads: remote.read().uploads },
    result.stderr,
  ).toEqual({ exit, state, uploads });
}

function fixture(initial: Partial<Remote> = {}, mutate?: (state: Remote) => void) {
  const root = tempDirs.make("linux-updater-manifest-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const statePath = join(root, "github.json");
  const initialState: Remote = {
    latest: sourceTag,
    releases: {
      "v2026.9.3": release("2026.9.3"),
      [sourceTag]: release(linuxVersion, { manifest: manifest("2026.9.3") }),
      "v2026.9.5": release("2026.9.5", { isDraft: true, assets: [], manifest: undefined }),
    },
    calls: [],
    uploads: 0,
    ...initial,
  };
  mutate?.(initialState);
  writeFileSync(statePath, JSON.stringify(initialState));
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.GH_MOCK_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.calls.push(args);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const result = (value) => { save(); process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); };
const fail = (message) => { save(); process.stderr.write(message); process.exit(1); };
const metadata = (tag, entry) => ({databaseId: 42, tagName: tag, isDraft: entry.isDraft, isPrerelease: entry.isPrerelease,
  assets: [...entry.assets, ...(entry.manifest === undefined ? [] : ['latest.json']),
    ...(entry.immutable === undefined ? [] : ['OpenClaw-' + tag.slice(1) + '-linux.json']),
    ...(entry.checksums === undefined ? [] : ['SHA256SUMS.linux-app.txt'])]
    .map(name => {
      const bytes = name === 'latest.json' ? entry.manifest : name === 'SHA256SUMS.linux-app.txt' ? entry.checksums :
        name.endsWith('-linux.json') ? entry.immutable : undefined;
      return {name, digest: entry.digests?.[name] ?? (bytes === undefined ? undefined : 'sha256:' + require('node:crypto').createHash('sha256').update(bytes).digest('hex')),
        state: entry.assetState ?? 'uploaded', size: entry.assetSize ?? (bytes === undefined ? 1024 : Buffer.byteLength(bytes))};
    })});
if (args[0] === 'api') {
  const endpoint = args.find(value => value.startsWith('repos/'));
  if (endpoint === 'repos/${repository}/releases/latest') {
    const entry = state.releases[state.latest];
    if (!entry) fail('release not found (HTTP 404)');
    result(metadata(state.latest, entry));
  } else if (endpoint?.startsWith('repos/${repository}/releases/tags/')) {
    const tag = endpoint.slice('repos/${repository}/releases/tags/'.length);
    const entry = state.releases[tag];
    if (!entry) fail('release not found (HTTP 404)');
    const release = metadata(tag, entry);
    result({id: entry.restId ?? 42, tag_name: tag, draft: entry.isDraft, prerelease: entry.isPrerelease,
      assets: release.assets.map((asset, index) => ({...asset,
        id: entry.assetIds?.[asset.name] ?? (asset.name === 'SHA256SUMS.linux-app.txt' ? 3 : index + 1)}))});
  } else if (endpoint === 'repos/${repository}/compare/${toolingSha}...main') {
    result({status: state.toolingStatus || 'identical'});
  } else if (endpoint === 'repos/${repository}/actions/runs/123') {
    result({id: 123, run_attempt: state.parentAttempt || 1, event: 'workflow_dispatch',
      head_branch: 'main', head_sha: '${toolingSha}', repository: {full_name: '${repository}'},
      path: '.github/workflows/openclaw-release-publish.yml@refs/heads/main',
      status: 'completed', conclusion: 'success'});
  } else if (endpoint === 'repos/${repository}/actions/runs/200') {
    result(state.currentRun);
  } else if (endpoint === 'repos/${repository}/git/ref/heads/main' ||
      endpoint === 'repos/${repository}/commits/main') {
    result('${toolingSha}');
  } else if (endpoint?.startsWith('repos/${repository}/actions/workflows/linux-app-release-request.yml/runs?')) {
    if (state.requestReadRejected) fail('request history unavailable (HTTP 503)');
    const page = Number(new URLSearchParams(endpoint.split('?')[1]).get('page'));
    const runs = state.requestRuns || [];
    result({total_count: runs.length, workflow_runs: runs.slice((page - 1) * 100, page * 100)});
  } else if (endpoint === 'repos/${repository}/actions/workflows/linux-app-release-request.yml/dispatches') {
    if (state.dispatchRejected) fail('workflow dispatch refused (HTTP 403)');
    const request = JSON.parse(fs.readFileSync(0, 'utf8'));
    (state.requests ||= []).push(request);
    (state.requestRuns ||= []).unshift({id: 456, head_sha: '${toolingSha}', head_branch: request.ref,
      event: 'workflow_dispatch', status: 'queued', conclusion: null,
      display_title: 'Linux App Release Request [' + request.inputs.tag + '] desktop=' + request.inputs['desktop-test-bundles']});
    result({...(state.missingDispatchId ? {} : {workflow_run_id: 456}),
      html_url: 'https://github.com/${repository}/actions/runs/456'});
  } else if (endpoint?.startsWith('repos/${repository}/commits/')) {
    result('${sourceSha}');
  } else {
    fail('Unexpected API request: ' + args.join(' '));
  }
} else if (args[0] === 'run' && args[1] === 'view') {
  result({headSha: '${toolingSha}', url: 'https://github.com/${repository}/actions/runs/456'});
} else if (args[0] === 'release') {
  if (args[2]?.startsWith('--')) fail('Latest release reads must use the explicit REST selector.');
  const tag = args[2];
  const entry = state.releases[tag];
  if (!entry) fail('release not found (HTTP 404)');
  if (args[1] === 'view') {
    if (!args.includes('--json')) fail('Metadata reads must use JSON.');
    if (args[args.indexOf('--json') + 1].includes('databaseId')) fail('Unknown JSON field: databaseId');
    result(metadata(tag, entry));
  } else if (args[1] === 'download') {
    const name = args[args.indexOf('--pattern') + 1];
    if (!['latest.json', 'SHA256SUMS.linux-app.txt', 'OpenClaw-' + tag.slice(1) + '-linux.json'].includes(name) ||
        args[args.indexOf('--output') + 1] !== '-') fail('Only manifest downloads are permitted.');
    const bytes = name === 'latest.json' ? entry.manifest : name === 'SHA256SUMS.linux-app.txt' ? entry.checksums : entry.immutable;
    if (bytes === undefined) fail('asset not found (HTTP 404)');
    result(bytes);
  } else if (args[1] === 'upload') {
    if (!args[3].endsWith('/latest.json')) fail('Only manifest uploads are permitted.');
    state.uploads++;
    if (state.uploadBehavior === 'deleted-error') {
      delete entry.manifest;
    } else if (!['rejected-error', 'success-noop'].includes(state.uploadBehavior)) {
      entry.manifest = fs.readFileSync(args[3], 'utf8');
    }
    if (state.uploadBehavior?.endsWith('-error')) fail('simulated connection closed');
    result('');
  } else {
    fail('Unexpected release operation: ' + args.join(' '));
  }
} else {
  fail('Unexpected command: ' + args.join(' '));
}
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "git"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== 'ls-remote') throw new Error('Unexpected git command: ' + args.join(' '));
process.stdout.write('${sourceSha}\\trefs/tags/v2026.9.4\\n');
`,
    { mode: 0o755 },
  );
  const read = (): Remote => JSON.parse(readFileSync(statePath, "utf8"));
  const update = (change: (remote: Remote) => void) => {
    const remote = read();
    change(remote);
    writeFileSync(statePath, JSON.stringify(remote));
  };
  let runNumber = 0;
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    GH_MOCK_STATE: statePath,
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_NAME: "main",
    GITHUB_WORKFLOW_SHA: toolingSha,
  };
  const runNode = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, args, {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...env, ...extraEnv },
    });
  const prepareRun = (prepared: boolean) => {
    update((state) => {
      state.currentRun = actionRun({
        path: `${prepared ? promoteWorkflow : publishWorkflow}@refs/heads/main`,
        ...state.currentRunOverrides,
      });
    });
  };
  return {
    read,
    identity(writerArguments: string[]) {
      prepareRun(true);
      return runNode([
        resolve("scripts/release-tooling-identity.mjs"),
        "verify",
        ...flags({
          repository,
          "workflow-full-ref": "refs/heads/main",
          "workflow-ref": "main",
          "workflow-sha": toolingSha,
          "release-publish-run-id": "123",
          "release-publish-run-attempt": "1",
          "release-publish-ref": "main",
          "release-publish-full-ref": "refs/heads/main",
          "release-publish-parent-state-policy": "active-or-success",
        }),
        ...writerArguments,
      ]);
    },
    run(command: "carry" | "status", tag = "v2026.9.5", prepared = false) {
      const output = join(root, `operation-${++runNumber}`);
      const requestPath = join(root, "publication-request.json");
      const eventPath = join(root, `event-${runNumber}.json`);
      prepareRun(prepared);
      writeFileSync(
        eventPath,
        JSON.stringify({ inputs: { tag, npm_dist_tag: "latest", ...read().eventInputOverrides } }),
      );
      if (prepared) {
        writeFileSync(
          requestPath,
          JSON.stringify({
            repository,
            inputs: { tag },
            sourceSha,
            releaseRunId: 123,
            releaseRunAttempt: 1,
            tooling: { ref: "main", fullRef: "refs/heads/main", sha: toolingSha },
          }),
        );
      }
      const result = runNode(
        [
          resolve("scripts/linux-updater-manifest.mjs"),
          command,
          ...flags({ tag, repository, output, "source-sha": sourceSha }),
          ...(prepared ? ["--publication-request", requestPath] : []),
        ],
        { GITHUB_RUN_ID: "200", GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_PATH: eventPath },
      );
      const evidence = JSON.parse(readFileSync(join(output, "evidence.json"), "utf8"));
      return { ...result, evidence, output };
    },
    inspect(carrierTag: string) {
      const module = pathToFileURL(resolve("scripts/linux-updater-manifest.mjs")).href;
      return runNode([
        "--input-type=module",
        "-e",
        `import { inspectLinuxUpdaterManifest } from ${JSON.stringify(module)};
console.log(JSON.stringify(inspectLinuxUpdaterManifest(${JSON.stringify({ repository, carrierTag })})));`,
      ]);
    },
    dispatch(targetSha = sourceSha) {
      const output = join(root, `dispatch-${++runNumber}`);
      mkdirSync(output);
      const result = spawnSync(
        "bash",
        [
          "-c",
          'source scripts/lib/release-publish-children.sh; sleep() { :; }; result=0; dispatch_linux_release_assets || result=$?; exit "$result"',
        ],
        {
          cwd: resolve("."),
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...env,
            RUNNER_TEMP: output,
            GITHUB_STEP_SUMMARY: join(output, "summary.md"),
            GITHUB_REPOSITORY: repository,
            TARGET_SHA: targetSha,
            PARENT_WORKFLOW_SHA: toolingSha,
            RELEASE_TAG: sourceTag,
            RELEASE_NPM_DIST_TAG: "latest",
          },
        },
      );
      return {
        ...result,
        evidence: JSON.parse(readFileSync(join(output, "linux-dispatch.json"), "utf8")),
      };
    },
  };
}

it.each(["2026.9.3", "2026.9.5"])(
  "preserves an equal or newer valid target manifest byte-for-byte (%s)",
  (version) => {
    const remote = fixture({}, (state) => {
      fixtureRelease(state, "v2026.9.5").manifest = manifest(version);
      if (version === "2026.9.5") {
        fixtureRelease(state, "v2026.9.5").assets = ["OpenClaw-2026.9.5-amd64.AppImage"];
      }
    });
    const result = remote.run("carry");
    expectOutcome(remote, result, "unchanged");
    expect(fixtureRelease(remote.read(), "v2026.9.5").manifest).toBe(manifest(version));
  },
);

it.each(["missing-manifest", "missing-release"])(
  "records %s as pending without a write",
  (kind) => {
    const remote = fixture({}, (state) => {
      if (kind === "missing-release") {
        state.latest = null;
      } else {
        delete fixtureRelease(state, sourceTag).manifest;
      }
    });
    const result = remote.run("carry");
    expectOutcome(remote, result, "pending");
  },
);

it.each<{
  kind: string;
  platform?: Record<string, string>;
  original?: Partial<Release>;
  bytes?: string;
}>([
  {
    kind: "cross-repository",
    platform: {
      url: `https://github.com/foreign/repository/releases/download/v2026.9.3/OpenClaw-2026.9.3-amd64.AppImage`,
    },
  },
  { kind: "empty-signature", platform: { signature: "" } },
  { kind: "invalid-base64", platform: { signature: "invalid signature!" } },
  { kind: "invalid-json", bytes: "{" },
  { kind: "missing-AppImage", original: { assets: [] } },
  { kind: "empty-AppImage", original: { assetSize: 0 } },
  { kind: "uploading-AppImage", original: { assetState: "starter" } },
  { kind: "draft-original", original: { isDraft: true } },
  { kind: "prerelease-original", original: { isPrerelease: true } },
  { kind: "extended-stable-manifest", bytes: manifest("2026.8.33") },
])("rejects a $kind carrier without changing the next release", ({ platform, original, bytes }) => {
  const remote = fixture({}, (state) => {
    const value = JSON.parse(manifest("2026.9.3"));
    Object.assign(value.platforms["linux-x86_64"], platform);
    Object.assign(fixtureRelease(state, "v2026.9.3"), original);
    fixtureRelease(state, sourceTag).manifest = bytes ?? JSON.stringify(value);
  });
  const result = remote.run("carry");
  expectOutcome(remote, result, "failed", 1);
  expect(fixtureRelease(remote.read(), "v2026.9.5").manifest).toBeUndefined();
});

it.each([
  { behavior: "accepted-error", exit: 0, outcome: "reconciled" },
  { behavior: "rejected-error", exit: 1, outcome: "failed" },
  { behavior: "deleted-error", exit: 1, outcome: "failed" },
  { behavior: "success-noop", exit: 1, outcome: "failed" },
] as const)(
  "reconciles $behavior by remote bytes without repeating the write",
  ({ behavior, exit, outcome }) => {
    const remote = fixture({ uploadBehavior: behavior }, (state) => {
      state.releases["v2026.9.2"] = release("2026.9.2");
      fixtureRelease(state, "v2026.9.5").manifest = manifest("2026.9.2");
    });
    const result = remote.run("carry");
    expectOutcome(remote, result, outcome, exit, 1);
    expect(readFileSync(join(result.output, "latest.json"), "utf8")).toBe(manifest("2026.9.3"));
    expect(readFileSync(join(result.output, "previous.json"), "utf8")).toBe(manifest("2026.9.2"));
    expect(fixtureRelease(remote.read(), "v2026.9.5").manifest).toBe(
      behavior === "deleted-error"
        ? undefined
        : manifest(behavior === "accepted-error" ? "2026.9.3" : "2026.9.2"),
    );
  },
);

it("carries a manifest under the prepared publisher's still-valid authority", () => {
  const remote = fixture();
  const result = remote.run("carry", "v2026.9.5", true);
  expectOutcome(remote, result, "uploaded", 0, 1);
});

const writerCliFields = [
  ["--writer-run-id", "200"],
  ["--writer-run-attempt", "1"],
  ["--writer-workflow-path", promoteWorkflow],
  ["--writer-workflow-event", "workflow_dispatch"],
] as const;

it.each(["active", "cancelled", "unrequested"])(
  "verifies the identity CLI's writer authority before returning identity (%s)",
  (writer) => {
    const remote = fixture({
      currentRunOverrides:
        writer === "active" ? {} : { status: "completed", conclusion: "cancelled" },
    });
    const result = remote.identity(writer === "unrequested" ? [] : writerCliFields.flat());
    expect(result.status, result.stderr).toBe(writer === "cancelled" ? 1 : 0);
    if (writer === "cancelled") {
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("release workflow run");
    } else {
      expect(JSON.parse(result.stdout)).toEqual({
        fullRef: "refs/heads/main",
        ref: "main",
        route: "main",
        sha: toolingSha,
      });
    }
    const calls = remote.read().calls;
    if (writer === "unrequested") {
      expect(calls.some((args) => args[1] === `repos/${repository}/actions/runs/200`)).toBe(false);
    } else {
      expect(calls.at(-1)?.[1]).toBe(`repos/${repository}/actions/runs/200`);
      if (writer === "active") {
        expect(calls.some((args) => args[1] === `repos/${repository}/actions/runs/123`)).toBe(true);
      }
    }
  },
);

it.each([
  { name: "incomplete writer tuple", arguments: ["--writer-run-id", "200"] },
  { name: "missing writer value", arguments: ["--writer-run-id"] },
])("refuses partial identity CLI writer arguments: $name", (scenario) => {
  const remote = fixture();
  const result = remote.identity(scenario.arguments);
  expect(result).toMatchObject({
    status: 1,
    stdout: "",
    stderr: expect.stringContaining("must be provided together"),
  });
  expect(remote.read().calls).toEqual([]);
});

const uploadAuthorityCases: Array<{
  reason: string;
  initial: Partial<Remote>;
  message: string;
  prepared?: boolean;
}> = [
  { reason: "unreachable tooling", initial: { toolingStatus: "behind" }, message: "not reachable" },
  {
    reason: "stale prepared parent",
    initial: { parentAttempt: 2 },
    message: "runAttempt",
    prepared: true,
  },
  ...[
    { reason: "stale attempt", currentRunOverrides: { run_attempt: 2 } },
    { reason: "wrong path", currentRunOverrides: { path: ".github/workflows/other.yml" } },
    { reason: "wrong source SHA", currentRunOverrides: { head_sha: "c".repeat(40) } },
    {
      reason: "cancelled run",
      currentRunOverrides: { status: "completed", conclusion: "cancelled" },
    },
  ].map(({ reason, currentRunOverrides }) => ({
    reason,
    initial: { currentRunOverrides },
    message: "release workflow run",
  })),
  ...[
    { reason: "another tag", eventInputOverrides: { tag: sourceTag } },
    { reason: "another channel", eventInputOverrides: { npm_dist_tag: "beta" } },
  ].map(({ reason, eventInputOverrides }) => ({
    reason,
    initial: { eventInputOverrides },
    message: "Actions release inputs differ",
  })),
];
it.each(uploadAuthorityCases)(
  "revalidates manifest upload authority: $reason",
  ({ initial, message, prepared }) => {
    const remote = fixture(initial);
    const result = remote.run("carry", "v2026.9.5", prepared);
    expect(result.stderr).toContain(message);
    expectOutcome(remote, result, "failed", 1);
  },
);

it.each(["current", "missing", "older", "replaced-release", "replaced-asset"])(
  "checks the actual same-tag legacy selector and REST identities (%s)",
  (kind) => {
    const remote = fixture({}, (state) => {
      const source = publishedRelease();
      source.manifest =
        kind === "missing" ? undefined : kind === "older" ? manifest("2026.9.3") : source.immutable;
      if (kind === "replaced-release") {
        source.restId = 43;
      }
      if (kind === "replaced-asset") {
        source.assetIds = { [appImage]: 99 };
      }
      publishFixture(state, source);
    });
    const result = remote.run("status", sourceTag);
    if (kind === "replaced-release" || kind === "replaced-asset") {
      expectOutcome(remote, result, "failed", 1);
      const dispatch = remote.dispatch();
      expect(dispatch.status).toBe(1);
      expect(remote.read().uploads).toBe(0);
      expect(remote.read().requests ?? []).toEqual([]);
      return;
    }
    expect(result.status, result.stderr).toBe(0);
    expect(result.evidence).toMatchObject({
      assetsComplete: true,
      needsUpdaterPublication: kind !== "current",
      needsChannelPublication: false,
    });
    const dispatch = remote.dispatch();
    expect(dispatch.status, dispatch.stderr).toBe(0);
    expect(dispatch.evidence.state).toBe(
      kind === "current" ? "published-assets-reused" : "request-dispatched",
    );
    expect(remote.read().uploads).toBe(0);
    expect(remote.read().requests ?? []).toHaveLength(kind === "current" ? 0 : 1);
  },
);

it.each(["present", "withdrawn", "replaced", "changed-digest", "missing-appimage", "missing-deb"])(
  "accepts only a withdrawn non-Linux companion in a four-asset Linux publication (%s)",
  (kind) => {
    const exe = "OpenClaw-2026.9.4-windows-x86_64.exe";
    const exeSha256 = "e".repeat(64);
    const remote = fixture({}, (state) => {
      // The immutable checksum file keeps the withdrawn companion's row.
      const source = publishedRelease({ name: exe, sha256: exeSha256 });
      const removed = {
        withdrawn: exe,
        "missing-appimage": appImage,
        "missing-deb": deb,
      }[kind];
      source.assets = [...source.assets, exe].filter((name) => name !== removed);
      source.assetIds = { [exe]: kind === "replaced" ? 8 : 7 };
      source.digests = {
        ...source.digests,
        [exe]: `sha256:${kind === "changed-digest" ? "f".repeat(64) : exeSha256}`,
      };
      publishFixture(state, source);
    });
    const observed = remote.inspect(sourceTag);
    const status = remote.run("status", sourceTag);
    if (kind !== "present" && kind !== "withdrawn") {
      expect(observed.status).toBe(1);
      expect(observed.stderr).toContain(
        kind === "missing-appimage"
          ? "Linux manifest source v2026.9.4 must have its published AppImage."
          : "Immutable Linux publication differs from its public asset inventory.",
      );
      expectOutcome(remote, status, "failed", 1);
      return;
    }
    expect(observed.status, observed.stderr).toBe(0);
    const withdrawn = kind === "withdrawn" ? { withdrawnCompanionAssets: [exe] } : {};
    expect(JSON.parse(observed.stdout).immutableManifest).toEqual({
      name: "OpenClaw-2026.9.4-linux.json",
      sha256: createHash("sha256")
        .update(expectDefined(remote.read().releases[sourceTag]?.immutable, "immutable"))
        .digest("hex"),
      ...withdrawn,
    });
    expect(status.status, status.stderr).toBe(0);
    expect(status.evidence).toMatchObject({ state: "published", assetsComplete: true });
    expect(status.evidence.withdrawnCompanionAssets).toEqual(withdrawn.withdrawnCompanionAssets);
  },
);

it.each(["same-tag", "missing", "older", "newer"])(
  "reports whether complete Linux assets need propagation into a %s latest manifest",
  (kind) => {
    const remote = fixture({ latest: kind === "same-tag" ? sourceTag : "v2026.9.5" }, (state) => {
      state.releases[sourceTag] = completeRelease(linuxVersion);
      state.releases["v2026.9.5"] = release("2026.9.5", {
        manifest:
          kind === "missing" ? undefined : manifest(kind === "older" ? "2026.9.3" : "2026.9.5"),
      });
    });
    const result = remote.run("status", sourceTag);
    expectOutcome(remote, result, "published");
    expect(result.evidence.needsUpdaterPublication).toBe(kind === "missing" || kind === "older");
    if (kind === "same-tag") {
      expect(result.evidence).toMatchObject({
        assetsComplete: true,
        needsChannelPublication: true,
        version: linuxVersion,
      });
      expect(readFileSync(join(result.output, "latest.json"), "utf8")).toBe(manifest(linuxVersion));
    }
  },
);

const complete = completeRelease(linuxVersion);
const completeChecksums = expectDefined(complete.checksums, "checksums");
it.each<[string, Partial<Release>]>([
  ["missing-deb", { assets: complete.assets.slice(0, 1) }],
  ["missing-checksums", { checksums: undefined }],
  ["missing-manifest", { manifest: undefined }],
  ["old-manifest", { manifest: manifest("2026.9.3") }],
  ["wrong-digest", { digests: { ...complete.digests, [appImage]: `sha256:${"3".repeat(64)}` } }],
  ["missing-digest", { digests: { [deb]: expectDefined(complete.digests?.[deb], "deb digest") } }],
  ["wrong-checksum-name", { checksums: completeChecksums.replace("amd64.deb", "other.deb") }],
  [
    "duplicate-checksum",
    {
      checksums:
        completeChecksums + completeChecksums.slice(0, completeChecksums.indexOf("\n") + 1),
    },
  ],
])("refuses to request another build over %s publication state", (_kind, overrides) => {
  const remote = fixture({}, (state) => {
    state.releases[sourceTag] = { ...structuredClone(complete), ...overrides };
  });
  expectOutcome(remote, remote.run("status", sourceTag), "failed", 1);
});

it.each(["absent", "complete", "partial", "propagation"])(
  "dispatches through the publisher only when native publication is absent (%s)",
  (kind) => {
    const remote = fixture({}, (state) => {
      state.releases[sourceTag] =
        kind === "complete" || kind === "propagation"
          ? completeRelease(linuxVersion)
          : release(linuxVersion, {
              assets: kind === "partial" ? [appImage] : [],
              manifest: manifest("2026.9.3"),
            });
      if (kind === "propagation") {
        state.latest = "v2026.9.5";
        state.releases["v2026.9.5"] = release("2026.9.5", { manifest: manifest("2026.9.3") });
      }
    });
    const result = remote.dispatch();
    expectOutcome(
      remote,
      result,
      kind === "partial" ? "dispatch-unconfirmed" : "request-dispatched",
      kind === "partial" ? 1 : 0,
    );
    expect(remote.read().requests ?? []).toEqual(
      kind !== "partial"
        ? [
            {
              ref: "main",
              inputs: { tag: sourceTag, "desktop-test-bundles": "false" },
            },
          ]
        : [],
    );
  },
);

function pendingLinuxFixture(initial: Partial<Remote> = {}) {
  return fixture({
    releases: { [sourceTag]: release(linuxVersion, { assets: [], manifest: undefined }) },
    ...initial,
  });
}

function linuxRequest(overrides: Partial<ActionRun> = {}): ActionRun {
  return actionRun({
    id: 455,
    head_sha: "c".repeat(40),
    path: requestWorkflow,
    status: "completed",
    conclusion: "success",
    display_title: "Linux App Release Request [v2026.9.4] desktop=false",
    ...overrides,
  });
}

it.each([
  { status: "queued", desktop: false, preceding: 0 },
  { status: "completed", desktop: false, preceding: 0 },
  { status: "completed", desktop: true, preceding: 100 },
])(
  "reuses a $status same-tag request (desktop=$desktop, preceding=$preceding)",
  ({ status, desktop, preceding }) => {
    const remote = pendingLinuxFixture({
      requestRuns: [
        ...Array.from({ length: preceding }, () =>
          linuxRequest({ display_title: "Linux App Release Request [v2026.9.3] desktop=false" }),
        ),
        linuxRequest({
          status,
          conclusion: status === "completed" ? "success" : null,
          display_title: `Linux App Release Request [v2026.9.4] desktop=${desktop}`,
        }),
      ],
    });
    const result = remote.dispatch();
    expect(result.status, result.stderr).toBe(0);
    expect(result.evidence).toMatchObject({
      state: "request-reused",
      requestRunId: "455",
      workflowSha: "c".repeat(40),
    });
    expect(remote.read().requests ?? []).toEqual([]);
  },
);

it.each([
  { reason: "failed", overrides: { conclusion: "failure" } },
  { reason: "another branch", overrides: { head_branch: "feature" } },
  { reason: "another event", overrides: { event: "push" } },
  {
    reason: "another tag",
    overrides: { display_title: "Linux App Release Request [v2026.9.3] desktop=false" },
  },
])("does not reuse a Linux request that is $reason", ({ overrides }) => {
  const remote = pendingLinuxFixture({ requestRuns: [linuxRequest(overrides)] });
  const result = remote.dispatch();
  expectOutcome(remote, result, "request-dispatched");
  expect(remote.read().requests).toHaveLength(1);
});

it.each(["dispatchRejected", "requestReadRejected", "movedTag", "missingDispatchId"])(
  "does not confirm or repeat a Linux request after %s",
  (failure) => {
    const remote = pendingLinuxFixture({
      dispatchRejected: failure === "dispatchRejected",
      requestReadRejected: failure === "requestReadRejected",
      missingDispatchId: failure === "missingDispatchId",
    });
    const result = remote.dispatch(failure === "movedTag" ? "c".repeat(40) : sourceSha);
    expectOutcome(remote, result, "dispatch-unconfirmed", 1);
    if (failure === "requestReadRejected") {
      expect(result.stderr).toContain("request history unavailable");
    }
    if (failure === "movedTag") {
      expect(result.stderr).toContain("Release tag v2026.9.4 moved");
    }
    const state = remote.read();
    if (failure === "missingDispatchId") {
      expect(state.requests).toHaveLength(1);
      expect(state.calls.filter((args) => args[0] === "run")).toEqual([]);
    } else {
      expect(state.requests ?? []).toEqual([]);
    }
    expect(
      state.calls.filter((args) => args.some((arg) => arg.endsWith("/dispatches"))),
    ).toHaveLength(failure === "dispatchRejected" || failure === "missingDispatchId" ? 1 : 0);
  },
);
