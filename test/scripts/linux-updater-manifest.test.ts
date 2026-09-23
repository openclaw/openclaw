import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repository = "fixture/openclaw";
const toolingSha = "a".repeat(40);
const sourceSha = "b".repeat(40);

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
  dispatchResponse?: "missing-id" | "null-id";
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

function fixture(initial: Partial<Remote> = {}) {
  const root = tempDirs.make("linux-updater-manifest-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const statePath = join(root, "github.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      latest: "v2026.9.4",
      releases: {
        "v2026.9.3": release("2026.9.3"),
        "v2026.9.4": release("2026.9.4", { manifest: manifest("2026.9.3") }),
        "v2026.9.5": release("2026.9.5", { isDraft: true, assets: [], manifest: undefined }),
      },
      calls: [],
      uploads: 0,
      ...initial,
    } satisfies Remote),
  );
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
    result({...(state.dispatchResponse === 'missing-id' ? {} :
      {workflow_run_id: state.dispatchResponse === 'null-id' ? null : 456}),
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
  const prepareRun = (prepared: boolean) => {
    update((state) => {
      state.currentRun = {
        id: 200,
        run_attempt: 1,
        repository: { full_name: repository },
        head_sha: toolingSha,
        head_branch: "main",
        status: "in_progress",
        conclusion: null,
        event: "workflow_dispatch",
        path: `${
          prepared
            ? ".github/workflows/openclaw-release-promote.yml"
            : ".github/workflows/openclaw-release-publish.yml"
        }@refs/heads/main`,
        ...state.currentRunOverrides,
      };
    });
  };
  return {
    read,
    update,
    identity(writerArguments: string[]) {
      prepareRun(true);
      return spawnSync(
        process.execPath,
        [
          resolve("scripts/release-tooling-identity.mjs"),
          "verify",
          "--repository",
          repository,
          "--workflow-full-ref",
          "refs/heads/main",
          "--workflow-ref",
          "main",
          "--workflow-sha",
          toolingSha,
          "--release-publish-run-id",
          "123",
          "--release-publish-run-attempt",
          "1",
          "--release-publish-ref",
          "main",
          "--release-publish-full-ref",
          "refs/heads/main",
          "--release-publish-parent-state-policy",
          "active-or-success",
          ...writerArguments,
        ],
        { encoding: "utf8", timeout: 20_000, env },
      );
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
      const result = spawnSync(
        process.execPath,
        [
          resolve("scripts/linux-updater-manifest.mjs"),
          command,
          "--tag",
          tag,
          "--repository",
          repository,
          "--output",
          output,
          "--source-sha",
          sourceSha,
          ...(prepared ? ["--publication-request", requestPath] : []),
        ],
        {
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...env,
            GITHUB_RUN_ID: "200",
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_EVENT_PATH: eventPath,
          },
        },
      );
      const evidence = JSON.parse(readFileSync(join(output, "evidence.json"), "utf8"));
      return { ...result, evidence, output };
    },
    dispatch(targetSha = sourceSha) {
      const output = join(root, `dispatch-${++runNumber}`);
      mkdirSync(output);
      const result = spawnSync(
        "bash",
        [
          "-c",
          'source scripts/lib/release-publish-children.sh; result=0; dispatch_linux_release_assets || result=$?; exit "$result"',
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
            RELEASE_TAG: "v2026.9.4",
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

it.each(["2026.9.3", "2026.9.4", "2026.9.5"])(
  "preserves an equal or newer valid target manifest byte-for-byte (%s)",
  (version) => {
    const remote = fixture();
    remote.update((state) => {
      fixtureRelease(state, "v2026.9.5").manifest = manifest(version);
      if (version === "2026.9.5") {
        fixtureRelease(state, "v2026.9.5").assets = ["OpenClaw-2026.9.5-amd64.AppImage"];
      }
    });
    const result = remote.run("carry");
    expect(result.status, result.stderr).toBe(0);
    expect(result.evidence.state).toBe("unchanged");
    expect(remote.read().uploads).toBe(0);
    expect(fixtureRelease(remote.read(), "v2026.9.5").manifest).toBe(manifest(version));
  },
);

it.each(["missing-manifest", "missing-release"])(
  "records %s as pending without a write",
  (kind) => {
    const remote = fixture();
    remote.update((state) => {
      if (kind === "missing-release") {
        state.latest = null;
      } else {
        delete fixtureRelease(state, "v2026.9.4").manifest;
      }
    });
    const result = remote.run("carry");
    expect(result.status, result.stderr).toBe(0);
    expect(result.evidence.state).toBe("pending");
    expect(remote.read().uploads).toBe(0);
  },
);

it.each([
  "cross-repository",
  "wrong-version-url",
  "empty-signature",
  "invalid-base64",
  "invalid-json",
  "missing-AppImage",
  "empty-AppImage",
  "uploading-AppImage",
  "draft-original",
  "prerelease-original",
  "extended-stable-manifest",
])("rejects a %s carrier without changing the next release", (kind) => {
  const remote = fixture();
  remote.update((state) => {
    const value = JSON.parse(manifest("2026.9.3"));
    const platform = value.platforms["linux-x86_64"];
    if (kind === "cross-repository") {
      platform.url = platform.url.replace(repository, "foreign/repository");
    }
    if (kind === "wrong-version-url") {
      platform.url = platform.url.replaceAll("2026.9.3", "2026.9.2");
    }
    if (kind === "empty-signature") {
      platform.signature = "";
    }
    if (kind === "invalid-base64") {
      platform.signature = "invalid signature!";
    }
    if (kind === "missing-AppImage") {
      fixtureRelease(state, "v2026.9.3").assets = [];
    }
    if (kind === "empty-AppImage") {
      fixtureRelease(state, "v2026.9.3").assetSize = 0;
    }
    if (kind === "uploading-AppImage") {
      fixtureRelease(state, "v2026.9.3").assetState = "starter";
    }
    if (kind === "draft-original") {
      fixtureRelease(state, "v2026.9.3").isDraft = true;
    }
    if (kind === "prerelease-original") {
      fixtureRelease(state, "v2026.9.3").isPrerelease = true;
    }
    fixtureRelease(state, "v2026.9.4").manifest =
      kind === "invalid-json"
        ? "{"
        : kind === "extended-stable-manifest"
          ? manifest("2026.8.33")
          : JSON.stringify(value);
  });
  const result = remote.run("carry");
  expect(result.status).toBe(1);
  expect(result.evidence.state).toBe("failed");
  expect(remote.read().uploads).toBe(0);
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
    const remote = fixture({ uploadBehavior: behavior });
    remote.update((state) => {
      state.releases["v2026.9.2"] = release("2026.9.2");
      fixtureRelease(state, "v2026.9.5").manifest = manifest("2026.9.2");
    });
    const result = remote.run("carry");
    expect(result.status, result.stderr).toBe(exit);
    expect(result.evidence.state).toBe(outcome);
    expect(remote.read().uploads).toBe(1);
    expect(readFileSync(join(result.output, "latest.json"), "utf8")).toBe(manifest("2026.9.3"));
    expect(readFileSync(join(result.output, "previous.json"), "utf8")).toBe(manifest("2026.9.2"));
    expect(fixtureRelease(remote.read(), "v2026.9.5").manifest).toBe(
      behavior === "deleted-error"
        ? undefined
        : manifest(behavior === "accepted-error" ? "2026.9.3" : "2026.9.2"),
    );
  },
);

it.each(["tooling", "prepared-parent"])("revalidates %s authority before an upload", (kind) => {
  const remote = fixture(kind === "tooling" ? { toolingStatus: "behind" } : { parentAttempt: 2 });
  const result = remote.run("carry", "v2026.9.5", kind === "prepared-parent");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(kind === "tooling" ? "not reachable" : "runAttempt");
  expect(remote.read().uploads).toBe(0);
});

it("carries a manifest under the prepared publisher's still-valid authority", () => {
  const remote = fixture();
  const result = remote.run("carry", "v2026.9.5", true);
  expect(result.status, result.stderr).toBe(0);
  expect(result.evidence.state).toBe("uploaded");
  expect(remote.read().uploads).toBe(1);
});

const writerCliFields = [
  ["--writer-run-id", "200"],
  ["--writer-run-attempt", "1"],
  ["--writer-workflow-path", ".github/workflows/openclaw-release-promote.yml"],
  ["--writer-workflow-event", "workflow_dispatch"],
] as const;

it("returns unchanged identity CLI output only after verifying the active writer last", () => {
  const remote = fixture();
  const result = remote.identity(writerCliFields.flat());
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    fullRef: "refs/heads/main",
    ref: "main",
    route: "main",
    sha: toolingSha,
  });
  expect(
    remote.read().calls.some((args) => args[1] === `repos/${repository}/actions/runs/123`),
  ).toBe(true);
  expect(remote.read().calls.at(-1)?.[1]).toBe(`repos/${repository}/actions/runs/200`);
});

it("does not let a successful parent authorize a cancelled writer through the identity CLI", () => {
  const remote = fixture({ currentRunOverrides: { status: "completed", conclusion: "cancelled" } });
  const result = remote.identity(writerCliFields.flat());
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("release workflow run");
  expect(remote.read().calls.at(-1)?.[1]).toBe(`repos/${repository}/actions/runs/200`);
});

it("preserves identity CLI behavior when no writer tuple is requested", () => {
  const remote = fixture({ currentRunOverrides: { status: "completed", conclusion: "cancelled" } });
  const result = remote.identity([]);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    fullRef: "refs/heads/main",
    ref: "main",
    route: "main",
    sha: toolingSha,
  });
  expect(
    remote.read().calls.some((args) => args[1] === `repos/${repository}/actions/runs/200`),
  ).toBe(false);
});

it.each([
  ...writerCliFields.map(([name, value]) => ({ name, arguments: [name, value] })),
  { name: "missing writer value", arguments: ["--writer-run-id"] },
])("refuses partial identity CLI writer arguments: $name", (scenario) => {
  const remote = fixture();
  const result = remote.identity(scenario.arguments);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("must be provided together");
  expect(remote.read().calls).toEqual([]);
});

it.each([
  { reason: "stale attempt", currentRunOverrides: { run_attempt: 2 } },
  { reason: "wrong path", currentRunOverrides: { path: ".github/workflows/other.yml" } },
  { reason: "wrong source SHA", currentRunOverrides: { head_sha: "c".repeat(40) } },
  {
    reason: "cancelled run",
    currentRunOverrides: { status: "completed", conclusion: "cancelled" },
  },
])("refuses a manifest upload from a writer with $reason", ({ currentRunOverrides }) => {
  const remote = fixture({ currentRunOverrides });
  const result = remote.run("carry");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("release workflow run");
  expect(result.evidence.state).toBe("failed");
  expect(remote.read().uploads).toBe(0);
});

it.each([
  { reason: "another tag", eventInputOverrides: { tag: "v2026.9.4" } },
  { reason: "another channel", eventInputOverrides: { npm_dist_tag: "beta" } },
])("refuses legacy carry when the Actions source names $reason", ({ eventInputOverrides }) => {
  const remote = fixture({ eventInputOverrides });
  const result = remote.run("carry");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Actions release inputs differ");
  expect(remote.read().uploads).toBe(0);
});

it("reuses complete same-tag Linux assets after matching checksums to GitHub digests", () => {
  const remote = fixture();
  remote.update((state) => {
    state.releases["v2026.9.4"] = completeRelease("2026.9.4");
  });
  const result = remote.run("status", "v2026.9.4");
  expect(result.status, result.stderr).toBe(0);
  expect(result.evidence.state).toBe("published");
  expect(result.evidence.assetsComplete).toBe(true);
  expect(result.evidence.needsChannelPublication).toBe(true);
  expect(result.evidence.version).toBe("2026.9.4");
  expect(result.evidence.needsUpdaterPublication).toBe(false);
  expect(remote.read().uploads).toBe(0);
  expect(readFileSync(join(result.output, "latest.json"), "utf8")).toBe(manifest("2026.9.4"));
});

it.each(["current", "missing", "older", "replaced-release", "replaced-asset"])(
  "checks the actual same-tag legacy selector and REST identities (%s)",
  (kind) => {
    const remote = fixture();
    remote.update((state) => {
      const source = completeRelease("2026.9.4");
      const checksumBytes = expectDefined(source.checksums, "checksums");
      const proof = {
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
        ],
      };
      source.immutable = manifest("2026.9.4", { linuxPublication: proof });
      source.manifest =
        kind === "missing" ? undefined : kind === "older" ? manifest("2026.9.3") : source.immutable;
      if (kind === "replaced-release") {
        source.restId = 43;
      }
      if (kind === "replaced-asset") {
        source.assetIds = { "OpenClaw-2026.9.4-amd64.AppImage": 99 };
      }
      state.releases["v2026.9.4"] = source;
      state.releases["linux-stable"] = {
        isDraft: false,
        isPrerelease: true,
        assets: [],
        manifest: source.immutable,
      };
    });
    const result = remote.run("status", "v2026.9.4");
    if (kind === "replaced-release" || kind === "replaced-asset") {
      expect(result.status).toBe(1);
      expect(result.evidence.state).toBe("failed");
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

it.each(["missing", "older", "newer"])(
  "reports whether complete Linux assets need propagation into a %s latest manifest",
  (kind) => {
    const remote = fixture({ latest: "v2026.9.5" });
    remote.update((state) => {
      state.releases["v2026.9.4"] = completeRelease("2026.9.4");
      state.releases["v2026.9.5"] = release("2026.9.5", {
        manifest:
          kind === "missing" ? undefined : manifest(kind === "older" ? "2026.9.3" : "2026.9.5"),
      });
    });
    const result = remote.run("status", "v2026.9.4");
    expect(result.status, result.stderr).toBe(0);
    expect(result.evidence.state).toBe("published");
    expect(result.evidence.needsUpdaterPublication).toBe(kind !== "newer");
    expect(remote.read().uploads).toBe(0);
  },
);

it.each([false, true])("permits a fresh Linux build with older carried manifest=%s", (carried) => {
  const remote = fixture();
  remote.update((state) => {
    state.releases["v2026.9.4"] = release("2026.9.4", {
      assets: [],
      manifest: carried ? manifest("2026.9.3") : undefined,
    });
  });
  const result = remote.run("status", "v2026.9.4");
  expect(result.status, result.stderr).toBe(0);
  expect(result.evidence.state).toBe("pending");
  expect(remote.read().uploads).toBe(0);
});

it.each([
  "missing-deb",
  "missing-checksums",
  "missing-manifest",
  "old-manifest",
  "wrong-digest",
  "missing-digest",
  "wrong-checksum-name",
  "duplicate-checksum",
])("refuses to request another build over %s publication state", (kind) => {
  const remote = fixture();
  remote.update((state) => {
    const source = completeRelease("2026.9.4");
    const digests = expectDefined(source.digests, "complete fixture bundle digests");
    const checksums = expectDefined(source.checksums, "complete fixture checksums");
    if (kind === "missing-deb") {
      source.assets = source.assets.slice(0, 1);
    }
    if (kind === "missing-checksums") {
      delete source.checksums;
    }
    if (kind === "missing-manifest") {
      delete source.manifest;
    }
    if (kind === "old-manifest") {
      source.manifest = manifest("2026.9.3");
    }
    if (kind === "wrong-digest") {
      digests["OpenClaw-2026.9.4-amd64.AppImage"] = `sha256:${"3".repeat(64)}`;
    }
    if (kind === "missing-digest") {
      delete digests["OpenClaw-2026.9.4-amd64.AppImage"];
    }
    if (kind === "wrong-checksum-name") {
      source.checksums = checksums.replace("amd64.deb", "other.deb");
    }
    if (kind === "duplicate-checksum") {
      source.checksums = checksums + checksums.slice(0, checksums.indexOf("\n") + 1);
    }
    state.releases["v2026.9.4"] = source;
  });
  const result = remote.run("status", "v2026.9.4");
  expect(result.status).toBe(1);
  expect(result.evidence.state).toBe("failed");
  expect(remote.read().uploads).toBe(0);
});

it.each(["absent", "complete", "partial", "propagation"])(
  "dispatches through the publisher only when native publication is absent (%s)",
  (kind) => {
    const remote = fixture();
    remote.update((state) => {
      state.releases["v2026.9.4"] =
        kind === "complete" || kind === "propagation"
          ? completeRelease("2026.9.4")
          : release("2026.9.4", {
              assets: kind === "partial" ? ["OpenClaw-2026.9.4-amd64.AppImage"] : [],
              manifest: manifest("2026.9.3"),
            });
      if (kind === "propagation") {
        state.latest = "v2026.9.5";
        state.releases["v2026.9.5"] = release("2026.9.5", { manifest: manifest("2026.9.3") });
      }
    });
    const result = remote.dispatch();
    expect(result.status, result.stderr).toBe(kind === "partial" ? 1 : 0);
    expect(result.evidence.state).toBe(
      kind === "absent" || kind === "propagation" || kind === "complete"
        ? "request-dispatched"
        : "dispatch-unconfirmed",
    );
    expect(remote.read().requests ?? []).toEqual(
      kind === "absent" || kind === "propagation" || kind === "complete"
        ? [
            {
              ref: "main",
              inputs: { tag: "v2026.9.4", "desktop-test-bundles": "false" },
            },
          ]
        : [],
    );
    expect(remote.read().uploads).toBe(0);
  },
);

it("reports a refused Linux workflow dispatch without a success receipt or retry", () => {
  const remote = fixture({ dispatchRejected: true });
  remote.update((state) => {
    state.releases["v2026.9.4"] = release("2026.9.4", { assets: [], manifest: undefined });
  });
  const result = remote.dispatch();
  expect(result.status).toBe(1);
  expect(result.evidence.state).toBe("dispatch-unconfirmed");
  expect(remote.read().requests ?? []).toEqual([]);
  expect(
    remote.read().calls.filter((args) => args.some((arg) => arg.endsWith("/dispatches"))),
  ).toHaveLength(1);
});

function pendingLinuxFixture(initial: Partial<Remote> = {}) {
  return fixture({
    releases: { "v2026.9.4": release("2026.9.4", { assets: [], manifest: undefined }) },
    ...initial,
  });
}

function linuxRequest(overrides: Partial<ActionRun> = {}): ActionRun {
  return {
    id: 455,
    run_attempt: 1,
    repository: { full_name: repository },
    head_sha: "c".repeat(40),
    head_branch: "main",
    path: ".github/workflows/linux-app-release-request.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    display_title: "Linux App Release Request [v2026.9.4] desktop=false",
    ...overrides,
  };
}

it.each(["requested", "waiting", "pending", "queued", "in_progress", "completed"])(
  "reuses a manual same-tag Linux request in %s state without another build request",
  (status) => {
    const remote = pendingLinuxFixture({
      requestRuns: [
        linuxRequest({ status, conclusion: status === "completed" ? "success" : null }),
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

it("reuses its earlier request when a parent resumes before Linux assets arrive", () => {
  const remote = pendingLinuxFixture();
  const first = remote.dispatch();
  expect(first.status, first.stderr).toBe(0);
  expect(first.evidence.state).toBe("request-dispatched");
  const resumed = remote.dispatch();
  expect(resumed.status, resumed.stderr).toBe(0);
  expect(resumed.evidence).toMatchObject({ state: "request-reused", requestRunId: "456" });
  expect(remote.read().requests).toHaveLength(1);
});

it("finds a desktop-inclusive Linux request beyond the first history page", () => {
  const remote = pendingLinuxFixture({
    requestRuns: [
      ...Array.from({ length: 100 }, () =>
        linuxRequest({ display_title: "Linux App Release Request [v2026.9.3] desktop=false" }),
      ),
      linuxRequest({ display_title: "Linux App Release Request [v2026.9.4] desktop=true" }),
    ],
  });
  const result = remote.dispatch();
  expect(result.status, result.stderr).toBe(0);
  expect(result.evidence).toMatchObject({ state: "request-reused", requestRunId: "455" });
  expect(remote.read().requests ?? []).toEqual([]);
});

it.each([
  { reason: "failed", overrides: { conclusion: "failure" } },
  { reason: "cancelled", overrides: { conclusion: "cancelled" } },
  { reason: "another branch", overrides: { head_branch: "feature" } },
  { reason: "another event", overrides: { event: "push" } },
  {
    reason: "another tag",
    overrides: { display_title: "Linux App Release Request [v2026.9.3] desktop=false" },
  },
])("does not reuse a Linux request that is $reason", ({ overrides }) => {
  const remote = pendingLinuxFixture({ requestRuns: [linuxRequest(overrides)] });
  const result = remote.dispatch();
  expect(result.status, result.stderr).toBe(0);
  expect(result.evidence.state).toBe("request-dispatched");
  expect(remote.read().requests).toHaveLength(1);
});

it("refuses another Linux request when request history cannot be read", () => {
  const remote = pendingLinuxFixture({ requestReadRejected: true });
  const result = remote.dispatch();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("request history unavailable");
  expect(result.evidence.state).toBe("dispatch-unconfirmed");
  expect(remote.read().requests ?? []).toEqual([]);
});

it("refuses a moved tag even when the dispatch caller suppresses shell errexit", () => {
  const remote = fixture();
  remote.update((state) => {
    state.releases["v2026.9.4"] = release("2026.9.4", { assets: [], manifest: undefined });
  });
  const result = remote.dispatch("c".repeat(40));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Release tag v2026.9.4 moved");
  expect(result.evidence.state).toBe("dispatch-unconfirmed");
  expect(remote.read().requests ?? []).toEqual([]);
  expect(
    remote.read().calls.filter((args) => args.some((arg) => arg.endsWith("/dispatches"))),
  ).toEqual([]);
});

it.each(["missing-id", "null-id"] as const)(
  "does not confirm or repeat an accepted workflow dispatch with %s",
  (dispatchResponse) => {
    const remote = fixture({ dispatchResponse });
    remote.update((state) => {
      state.releases["v2026.9.4"] = release("2026.9.4", { assets: [], manifest: undefined });
    });
    const result = remote.dispatch();
    expect(result.status).toBe(1);
    expect(result.evidence.state).toBe("dispatch-unconfirmed");
    expect(remote.read().requests).toHaveLength(1);
    expect(remote.read().calls.filter((args) => args[0] === "run")).toEqual([]);
    expect(
      remote.read().calls.filter((args) => args.some((arg) => arg.endsWith("/dispatches"))),
    ).toHaveLength(1);
  },
);
