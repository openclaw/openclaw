import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const cli = resolve("scripts/linux-app-channel.mjs");
const tag = "v2026.9.3";
const nextTag = "v2026.9.4";
const channel = "linux-stable";
const publicKey = Buffer.from("fixture public key\n").toString("base64");
const signature = Buffer.from("fixture signature\n").toString("base64");
const toolingSha = "b".repeat(40);
const toolingRef = `release-publish/${toolingSha.slice(0, 12)}-42`;

type Asset = {
  id: number;
  name: string;
  label?: string;
  size: number;
  state: string;
  digest: string;
  browser_download_url: string;
  bytes: string;
};
type Release = {
  id: number;
  tag_name: string;
  source: string;
  draft: boolean;
  prerelease: boolean;
  body: string;
  published_at: string;
  assets: Asset[];
};
type Call = {
  tool: string;
  action: string;
  tag?: string;
  name?: string;
  url?: string;
  releaseId?: number;
  makeLatest?: boolean;
};
type Transition = {
  kind: "replace-release" | "move-tag" | "select-latest";
  tag: string;
};
type Fault = {
  point: "download" | "upload-before" | "upload-after" | "upload-readback" | "legacy-readback";
  tag: string;
  name: string;
};
type AuthorityChange =
  | "cancel-parent"
  | "new-parent-attempt"
  | "revoke-tooling"
  | "move-tooling"
  | "new-request-attempt"
  | "cancel-writer"
  | "new-writer-attempt";
type State = {
  releases: Release[];
  latest: string | null;
  nextId: number;
  calls: Call[];
  verifierExit: number;
  fault?: Fault;
  corruptDownload?: { tag: string; name: string };
  replaceReleaseAfterDownload?: { tag: string; name: string };
  latestAfterDelete?: string;
  latestAfterUpload?: string;
  afterSourceRead?: { tag: string; change: Transition };
  afterPatch?: Transition;
  releaseResponseTag?: { tag: string; value: string };
  authority: {
    toolingSha: string;
    toolingPresent: boolean;
    toolingRef: string;
    toolingFullRef: string;
    parentAttempt: number;
    parentStatus: string;
    parentConclusion: string | null;
    requestTag: string;
    requestAttempt: number;
    desktop: boolean;
    writerAttempt: number;
    writerStatus: string;
    writerConclusion: string | null;
    writerRef: string;
    writerFullRef: string;
    writerPath: string;
    writerEvent: string;
  };
  authorityAfterDownload?: { tag: string; name: string; change: AuthorityChange };
  authorityAfterDelete?: AuthorityChange;
  authorityAfterDesktopDelete?: AuthorityChange;
  authorityAfterSourceRead?: { tag: string; change: AuthorityChange };
};

function hash(bytes: string | Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceSha(value: string) {
  return hash(value).slice(0, 40);
}

function downloadUrl(releaseTag: string, name: string) {
  return `https://github.com/openclaw/openclaw/releases/download/${releaseTag}/${name}`;
}

function legacyManifest(releaseTag = tag, notes = "Fixture release notes") {
  return Buffer.from(
    JSON.stringify({
      version: releaseTag.slice(1),
      notes,
      pub_date: "2026-09-03T12:00:00Z",
      platforms: {
        "linux-x86_64": {
          signature,
          url: downloadUrl(releaseTag, `OpenClaw-${releaseTag.slice(1)}-amd64.AppImage`),
        },
      },
    }),
  );
}

function releaseFrom(state: State, releaseTag: string) {
  const release = state.releases.find((entry) => entry.tag_name === releaseTag);
  assert.ok(release, `Missing fixture release ${releaseTag}`);
  return release;
}

function replaceAsset(state: State, releaseTag: string, name: string, bytes: Buffer) {
  const release = releaseFrom(state, releaseTag);
  release.assets = release.assets.filter((entry) => entry.name !== name);
  const asset: Asset = {
    id: state.nextId++,
    name,
    size: bytes.length,
    state: "uploaded",
    digest: `sha256:${hash(bytes)}`,
    browser_download_url: downloadUrl(releaseTag, name),
    bytes: bytes.toString("base64"),
  };
  release.assets.push(asset);
  return asset;
}

// This models external CRUD and command contracts, not the channel promotion policy.
// minisign is a controllable process boundary here, not cryptographic verification.
const commandFixture = String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const statePath = process.env.CHANNEL_FIXTURE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const fail = (message, status = 1) => {
  save();
  console.error(message);
  process.exit(status);
};
const answer = (value) => {
  save();
  if (value !== undefined) process.stdout.write(JSON.stringify(value));
};
const release = (tag) => {
  const value = state.releases.find((entry) => entry.tag_name === tag);
  if (!value) fail("HTTP 404: release not found");
  return value;
};
const publicAsset = ({ bytes, ...entry }) => entry;
const publicRelease = ({ source, assets, ...entry }) => entry;
const flag = (name) => args[args.indexOf(name) + 1];
const fault = (point, tag, name) => {
  if (state.fault?.point !== point || state.fault.tag !== tag || state.fault.name !== name) return false;
  delete state.fault;
  return true;
};
const transition = (change) => {
  if (change.kind === "select-latest") state.latest = change.tag;
  else if (change.kind === "replace-release") {
    const owner = release(change.tag);
    owner.id = state.nextId++;
    owner.assets = [];
  } else if (change.kind === "move-tag") release(change.tag).source = "c".repeat(40);
  else assert.fail("Unsupported fixture transition");
  state.calls.push({ tool: "fixture", action: change.kind, tag: change.tag });
};
const changeAuthority = (change) => {
  if (change === "cancel-parent") {
    state.authority.parentStatus = "completed";
    state.authority.parentConclusion = "cancelled";
  } else if (change === "new-parent-attempt") state.authority.parentAttempt++;
  else if (change === "new-request-attempt") state.authority.requestAttempt++;
  else if (change === "cancel-writer") {
    state.authority.writerStatus = "completed";
    state.authority.writerConclusion = "cancelled";
  } else if (change === "new-writer-attempt") state.authority.writerAttempt++;
  else if (change === "revoke-tooling") state.authority.toolingPresent = false;
  else if (change === "move-tooling") state.authority.toolingSha = "c".repeat(40);
  else assert.fail("Unsupported authority transition");
  state.calls.push({ tool: "fixture", action: change });
};
try {
  if (tool === "gh" && args[0] === "api") {
    const prefix = "repos/openclaw/openclaw/";
    const endpoint = args.find((argument) => argument.startsWith(prefix));
    assert(endpoint, "Unexpected fixture repository");
    const route = endpoint.slice(prefix.length);
    const method = args.includes("--method") ? flag("--method") : "GET";
    assert(["GET", "PATCH", "DELETE"].includes(method), "Unsupported fixture method");
    state.calls.push({ tool, action: method, url: route });
    if (method === "PATCH") {
      const match = /^releases\/(\d+)$/.exec(route);
      assert(match, "Unsupported patch endpoint");
      assert.equal(flag("--field"), "draft=false");
      const latest = flag("--raw-field");
      assert(["make_latest=true", "make_latest=false"].includes(latest));
      const owner = state.releases.find((entry) => entry.id === Number(match[1]));
      if (!owner) fail("HTTP 404: release not found");
      const makeLatest = latest === "make_latest=true";
      if (makeLatest && owner.prerelease) fail("HTTP 422: prerelease cannot be latest");
      Object.assign(state.calls.at(-1), { tag: owner.tag_name, releaseId: owner.id, makeLatest });
      owner.draft = false;
      if (makeLatest) state.latest = owner.tag_name;
      const response = publicRelease(owner);
      if (state.afterPatch) {
        const change = state.afterPatch;
        delete state.afterPatch;
        transition(change);
      }
      answer(response);
    } else if (method === "DELETE") {
      const match = /^releases\/assets\/(\d+)$/.exec(route);
      assert(match, "Unsupported mutation");
      const owner = state.releases.find((entry) => entry.assets.some((asset) => asset.id === Number(match[1])));
      assert(owner, "Missing deleted asset");
      const entry = owner.assets.find((asset) => asset.id === Number(match[1]));
      Object.assign(state.calls.at(-1), { tag: owner.tag_name, name: entry.name });
      owner.assets = owner.assets.filter((asset) => asset.id !== entry.id);
      if (state.latestAfterDelete) {
        state.latest = state.latestAfterDelete;
        delete state.latestAfterDelete;
      }
      if (state.authorityAfterDelete) {
        const change = state.authorityAfterDelete;
        delete state.authorityAfterDelete;
        changeAuthority(change);
      }
      if (owner.tag_name === "desktop-test" && state.authorityAfterDesktopDelete) {
        const change = state.authorityAfterDesktopDelete;
        delete state.authorityAfterDesktopDelete;
        changeAuthority(change);
      }
      answer();
    } else if (route.startsWith("compare/") && route.endsWith("...main")) {
      assert.equal(route, "compare/" + "b".repeat(40) + "...main");
      answer({ status: "identical" });
    } else if (route === "actions/runs/42") {
      answer({
        id: 42, run_attempt: state.authority.parentAttempt,
        repository: { full_name: "openclaw/openclaw" }, event: "workflow_dispatch",
        head_branch: state.authority.toolingRef, head_sha: "b".repeat(40),
        path: ".github/workflows/openclaw-release-publish.yml@" + state.authority.toolingFullRef,
        status: state.authority.parentStatus, conclusion: state.authority.parentConclusion,
      });
    } else if (route.startsWith("git/ref/heads/")) {
      if (!state.authority.toolingPresent) fail("HTTP 404: tooling branch not found");
      answer({ ref: state.authority.toolingFullRef, object: { type: "commit", sha: state.authority.toolingSha } });
    } else if (route === "actions/runs/43") {
      answer({
        id: 43, run_attempt: state.authority.requestAttempt,
        repository: { full_name: "openclaw/openclaw" }, event: "workflow_dispatch",
        head_branch: "main", head_sha: "b".repeat(40),
        path: ".github/workflows/linux-app-release-request.yml",
        display_title: "Linux App Release Request [" + state.authority.requestTag + "] desktop=" + state.authority.desktop,
        status: "completed", conclusion: "success",
      });
    } else if (route === "actions/runs/44") {
      answer({
        id: 44, run_attempt: state.authority.writerAttempt,
        repository: { full_name: "openclaw/openclaw" },
        event: state.authority.writerEvent,
        head_branch: state.authority.writerRef, head_sha: "b".repeat(40),
        path: state.authority.writerPath + "@" + state.authority.writerFullRef,
        status: state.authority.writerStatus, conclusion: state.authority.writerConclusion,
      });
    } else if (route === "releases/latest") {
      if (!state.latest) fail("HTTP 404: latest not found");
      answer(publicRelease(release(state.latest)));
    } else if (route.startsWith("releases/tags/")) {
      const tag = decodeURIComponent(route.slice("releases/tags/".length));
      const owner = release(tag);
      if (owner.draft) fail("HTTP 404: release by tag is not published");
      const response = publicRelease(owner);
      if (state.releaseResponseTag?.tag === tag) response.tag_name = state.releaseResponseTag.value;
      answer(response);
    } else if (route.startsWith("git/ref/tags/")) {
      const tag = decodeURIComponent(route.slice("git/ref/tags/".length));
      if (tag.startsWith("release-publish/")) {
        if (!state.authority.toolingPresent) fail("HTTP 404: tooling tag not found");
        answer({ ref: "refs/tags/" + tag, object: { type: "commit", sha: state.authority.toolingSha } });
        process.exitCode = 0;
        return;
      }
      const owner = release(tag);
      const response = { object: { type: "commit", sha: owner.source } };
      if (state.afterSourceRead?.tag === tag) {
        const change = state.afterSourceRead.change;
        delete state.afterSourceRead;
        transition(change);
      }
      if (state.authorityAfterSourceRead?.tag === tag) {
        const change = state.authorityAfterSourceRead.change;
        delete state.authorityAfterSourceRead;
        changeAuthority(change);
      }
      answer(response);
    } else if (/^releases\/\d+$/.test(route)) {
      const owner = state.releases.find((entry) => entry.id === Number(route.slice("releases/".length)));
      if (!owner) fail("HTTP 404: release not found");
      const response = publicRelease(owner);
      if (state.releaseResponseTag?.tag === owner.tag_name) response.tag_name = state.releaseResponseTag.value;
      answer(response);
    } else {
      const match = /^releases\/(\d+)\/assets\?per_page=100&page=(\d+)$/.exec(route);
      assert(match, "Unsupported fixture API");
      const owner = state.releases.find((entry) => entry.id === Number(match[1]));
      assert(owner, "Missing asset owner");
      const start = (Number(match[2]) - 1) * 100;
      answer(owner.assets.slice(start, start + 100).map(publicAsset));
    }
  } else if (tool === "gh" && args[0] === "release") {
    assert.equal(flag("--repo"), "openclaw/openclaw");
    const action = args[1];
    const tag = args[2];
    if (action === "view") {
      state.calls.push({ tool, action, tag });
      const owner = release(tag);
      const fields = {
        databaseId: owner.id,
        tagName: state.releaseResponseTag?.tag === tag ? state.releaseResponseTag.value : owner.tag_name,
        isDraft: owner.draft,
        isPrerelease: owner.prerelease,
      };
      const selected = flag("--json").split(",");
      assert(selected.every((name) => Object.hasOwn(fields, name)), "Unsupported release view field");
      if (args.includes("--jq")) {
        assert.equal(flag("--jq"), ".databaseId");
        assert(selected.includes("databaseId"));
        answer(owner.id);
      } else {
        answer(Object.fromEntries(selected.map((name) => [name, fields[name]])));
      }
    } else if (action === "create") {
      assert(!state.releases.some((entry) => entry.tag_name === tag), "Release already exists");
      assert(args.includes("--prerelease") && args.includes("--latest=false"));
      state.calls.push({ tool, action, tag });
      state.releases.push({
        id: state.nextId++, tag_name: tag, source: flag("--target"),
        draft: false, prerelease: true, body: flag("--notes"),
        published_at: "2026-09-03T12:00:00Z", assets: [],
      });
      answer();
    } else if (action === "edit") {
      assert(args.includes("--prerelease") && args.includes("--latest=false"));
      state.calls.push({ tool, action, tag });
      release(tag).body = fs.readFileSync(flag("--notes-file"), "utf8");
      answer();
    } else {
      assert.equal(action, "upload", "Unsupported fixture release command");
      assert(!args.includes("--clobber"), "Fixture refuses implicit asset replacement");
      const spec = args.at(-1);
      const separator = spec.indexOf("#");
      const file = separator < 0 ? spec : spec.slice(0, separator);
      const label = separator < 0 ? undefined : spec.slice(separator + 1);
      // gh's #suffix is a display label; the asset name is the file basename.
      const name = path.basename(file);
      state.calls.push({ tool, action, tag, name });
      if (fault("upload-before", tag, name)) fail("fixture upload refused");
      const owner = release(tag);
      if (owner.assets.some((entry) => entry.name === name)) fail("HTTP 422: asset already exists");
      const bytes = fs.readFileSync(file);
      owner.assets.push({
        id: state.nextId++, name, label, size: bytes.length, state: "uploaded",
        digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
        browser_download_url: "https://github.com/openclaw/openclaw/releases/download/" + tag + "/" + name,
        bytes: bytes.toString("base64"),
      });
      if (state.latestAfterUpload) {
        state.latest = state.latestAfterUpload;
        delete state.latestAfterUpload;
      }
      if (fault("upload-readback", tag, name)) state.corruptDownload = { tag, name };
      if (fault("upload-after", tag, name)) fail("fixture lost upload acknowledgement");
      answer();
    }
  } else if (tool === "curl") {
    const url = args.at(-1);
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://github.com");
    const legacy = parsed.pathname === "/openclaw/openclaw/releases/latest/download/latest.json";
    const match = /^\/openclaw\/openclaw\/releases\/download\/([^/]+)\/([^/]+)$/.exec(parsed.pathname);
    assert(legacy || match, "Unexpected public download");
    const tag = legacy ? state.latest : decodeURIComponent(match[1]);
    const name = legacy ? "latest.json" : decodeURIComponent(match[2]);
    state.calls.push({ tool, action: "download", tag, name, url });
    const owner = release(tag);
    const entry = owner.assets.find((asset) => asset.name === name);
    if (owner.draft || !entry || fault("download", tag, name)) fail("HTTP 404: public asset unavailable");
    let bytes = Buffer.from(entry.bytes, "base64");
    if ((state.corruptDownload?.tag === tag && state.corruptDownload.name === name) ||
        (legacy && fault("legacy-readback", tag, name))) {
      delete state.corruptDownload;
      bytes = Buffer.alloc(bytes.length, 120);
    }
    assert(bytes.length <= Number(flag("--max-filesize")), "Fixture download exceeds limit");
    fs.writeFileSync(flag("--output"), bytes);
    if (state.replaceReleaseAfterDownload?.tag === tag &&
        state.replaceReleaseAfterDownload.name === name) {
      delete state.replaceReleaseAfterDownload;
      owner.id = state.nextId++;
      owner.assets = [];
      state.calls.push({ tool: "fixture", action: "replace-release", tag });
    }
    if (state.authorityAfterDownload?.tag === tag && state.authorityAfterDownload.name === name) {
      const change = state.authorityAfterDownload.change;
      delete state.authorityAfterDownload;
      changeAuthority(change);
    }
    answer();
  } else if (tool === "minisign") {
    state.calls.push({ tool, action: "verify" });
    for (const option of ["-Vm", "-x", "-p"]) {
      assert(args.includes(option) && fs.readFileSync(flag(option)).length > 0);
    }
    if (state.verifierExit) fail("fixture signature verification refused", state.verifierExit);
    answer();
  } else {
    fail("Unsupported fixture command");
  }
} catch (error) {
  fail("Fixture contract failure: " + error.message);
}
`;

function fixture(workflowRef = toolingRef, desktop = false) {
  const workflowFullRef = `${workflowRef.startsWith("release-publish/") ? "refs/tags" : "refs/heads"}/${workflowRef}`;
  const root = createTempDir("linux-channel-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const name of ["gh", "curl", "minisign"]) {
    const file = join(bin, name);
    writeFileSync(file, `#!${process.execPath}\n${commandFixture}`);
    chmodSync(file, 0o755);
  }
  const statePath = join(root, "state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      releases: [],
      latest: tag,
      nextId: 1,
      calls: [],
      verifierExit: 0,
      authority: {
        toolingSha,
        toolingPresent: true,
        toolingRef: workflowRef,
        toolingFullRef: workflowFullRef,
        parentAttempt: 1,
        parentStatus: "in_progress",
        parentConclusion: null,
        requestTag: tag,
        requestAttempt: 1,
        desktop,
        writerAttempt: 1,
        writerStatus: "in_progress",
        writerConclusion: null,
        writerRef: workflowRef,
        writerFullRef: workflowFullRef,
        writerPath: ".github/workflows/linux-app-release.yml",
        writerEvent: "workflow_dispatch",
      },
    } satisfies State),
  );
  const config = join(root, "tauri.conf.json");
  writeFileSync(config, JSON.stringify({ plugins: { updater: { pubkey: publicKey } } }));
  const signaturePath = join(root, "appimage.sig");
  writeFileSync(signaturePath, signature);
  const directories = new Map<string, string>();
  const state = (): State => JSON.parse(readFileSync(statePath, "utf8"));
  const update = (change: (value: State) => void) => {
    const value = state();
    change(value);
    writeFileSync(statePath, JSON.stringify(value));
  };
  const addRelease = (releaseTag: string, latest = false) =>
    update((value) => {
      value.releases.push({
        id: value.nextId++,
        tag_name: releaseTag,
        source: sourceSha(releaseTag),
        draft: false,
        prerelease: false,
        body: "Fixture release notes",
        published_at: "2026-09-03T12:00:00Z",
        assets: [],
      });
      if (latest) {
        value.latest = releaseTag;
      }
    });
  addRelease(tag);
  const addDraft = (releaseTag = nextTag, prerelease = false) => {
    addRelease(releaseTag);
    update((value) => {
      Object.assign(releaseFrom(value, releaseTag), { draft: true, prerelease });
    });
    return releaseFrom(state(), releaseTag);
  };
  const inputs = (releaseTag: string) => {
    const existing = directories.get(releaseTag);
    if (existing) {
      return existing;
    }
    const directory = join(root, releaseTag);
    mkdirSync(directory);
    const version = releaseTag.slice(1);
    const names = [
      `OpenClaw-${version}-amd64.AppImage`,
      `OpenClaw-${version}-amd64.deb`,
      ...(desktop
        ? [
            `OpenClaw-${version}-darwin-aarch64.dmg`,
            `OpenClaw-${version}-darwin-aarch64.app.tar.gz`,
            `OpenClaw-${version}-windows-x86_64.exe`,
          ]
        : []),
    ];
    const checksums = names.map((name) => {
      const bytes = Buffer.from(`fixture bytes: ${name}\n`);
      writeFileSync(join(directory, name), bytes);
      return `${hash(bytes)}  ./${name}`;
    });
    writeFileSync(join(directory, "SHA256SUMS.linux-app.txt"), `${checksums.join("\n")}\n`);
    if (desktop) {
      writeFileSync(
        join(directory, "latest-desktop-test.json"),
        JSON.stringify({
          version,
          notes: "Fixture desktop test bundles",
          pub_date: "2026-09-03T12:00:00Z",
          platforms: {
            "darwin-aarch64": {
              signature,
              url: `https://github.com/openclaw/openclaw/releases/download/${releaseTag}/OpenClaw-${version}-darwin-aarch64.app.tar.gz`,
            },
            "windows-x86_64": {
              signature,
              url: `https://github.com/openclaw/openclaw/releases/download/${releaseTag}/OpenClaw-${version}-windows-x86_64.exe`,
            },
          },
        }),
      );
    }
    directories.set(releaseTag, directory);
    return directory;
  };
  const seedLegacy = (releaseTag = tag) => {
    const directory = inputs(releaseTag);
    const bytes = legacyManifest(releaseTag);
    update((value) => {
      for (const name of readdirSync(directory)) {
        replaceAsset(value, releaseTag, name, readFileSync(join(directory, name)));
      }
      replaceAsset(value, releaseTag, "latest.json", bytes);
    });
    return bytes;
  };
  const run = (
    mode: "publish" | "mirror" | "finalize-core",
    releaseTag = tag,
    latest?: string,
    publicOnly = false,
  ) => {
    const args = [cli, mode, "--tag", releaseTag, "--source-sha", sourceSha(releaseTag)];
    args.push("--tooling-sha", toolingSha);
    update((value) => {
      value.authority.writerRef = mode === "publish" ? "main" : workflowRef;
      value.authority.writerFullRef = mode === "publish" ? "refs/heads/main" : workflowFullRef;
      value.authority.writerPath =
        mode === "finalize-core"
          ? ".github/workflows/openclaw-release-publish.yml"
          : ".github/workflows/linux-app-release.yml";
      value.authority.writerEvent = mode === "publish" ? "workflow_run" : "workflow_dispatch";
    });
    if (mode === "publish") {
      update((value) => {
        value.authority.requestTag = releaseTag;
      });
      args.push(
        "--workflow-ref",
        "main",
        "--workflow-full-ref",
        "refs/heads/main",
        "--request-run-id",
        "43",
        "--request-run-attempt",
        "1",
      );
    } else {
      args.push(
        "--workflow-ref",
        workflowRef,
        "--workflow-full-ref",
        workflowFullRef,
        "--release-publish-run-id",
        "42",
        "--release-publish-run-attempt",
        "1",
        "--release-publish-ref",
        workflowRef,
        "--release-publish-full-ref",
        workflowFullRef,
      );
    }
    if (mode === "finalize-core") {
      if (latest !== undefined) {
        args.push("--latest", latest);
      }
    } else {
      args.push("--public-key-config", config);
    }
    if (mode === "publish") {
      args.push("--desktop-test", String(desktop));
      if (!publicOnly) {
        args.push("--assets", inputs(releaseTag), "--signature", signaturePath);
      }
    }
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${dirname(process.execPath)}`,
        HOME: root,
        TMPDIR: root,
        CHANNEL_FIXTURE_STATE: statePath,
        GITHUB_RUN_ID: "44",
        GITHUB_RUN_ATTEMPT: "1",
      },
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 2 * 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    return result;
  };
  const bytes = (releaseTag: string, name: string) => {
    const entry = releaseFrom(state(), releaseTag).assets.find((asset) => asset.name === name);
    assert.ok(entry, `Missing fixture asset ${releaseTag}/${name}`);
    return Buffer.from(entry.bytes, "base64");
  };
  const mutations = () =>
    state().calls.filter(
      (call) =>
        call.tool === "gh" && ["upload", "DELETE", "PATCH", "create", "edit"].includes(call.action),
    );
  return { state, update, addRelease, addDraft, inputs, seedLegacy, run, bytes, mutations };
}

function succeeded(result: ReturnType<ReturnType<typeof fixture>["run"]>) {
  expect(result.status, result.stderr).toBe(0);
  const output: unknown = JSON.parse(result.stdout);
  return output;
}

function failed(result: ReturnType<ReturnType<typeof fixture>["run"]>, message: string) {
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.stdout.trim()).toBe("");
}

it("reuses complete public Linux assets without local build inputs", () => {
  const f = fixture();
  const original = f.seedLegacy();
  const assetIds = new Set(releaseFrom(f.state(), tag).assets.map((entry) => entry.id));
  expect(succeeded(f.run("publish", tag, undefined, true))).toMatchObject({ state: "published" });
  const published = JSON.parse(f.bytes(tag, "OpenClaw-2026.9.3-linux.json").toString());
  expect(published).toMatchObject(JSON.parse(original.toString()));
  expect(releaseFrom(f.state(), tag).assets.filter((entry) => assetIds.has(entry.id))).toHaveLength(
    3,
  );
  expect(
    f
      .mutations()
      .filter(
        (entry) =>
          entry.action === "upload" &&
          ["OpenClaw-2026.9.3-amd64.AppImage", "OpenClaw-2026.9.3-amd64.deb"].includes(
            entry.name ?? "",
          ),
      ),
  ).toEqual([]);
  expect(f.state().calls.some((entry) => entry.tool === "minisign")).toBe(true);
});

it("reuses immutable publication bytes without local build inputs on replay", () => {
  const f = fixture();
  succeeded(f.run("publish"));
  const original = f.bytes(tag, "OpenClaw-2026.9.3-linux.json");
  f.update((state) => {
    state.calls = [];
  });
  succeeded(f.run("publish", tag, undefined, true));
  expect(f.bytes(channel, "latest.json")).toEqual(original);
  expect(f.bytes(tag, "OpenClaw-2026.9.3-linux.json")).toEqual(original);
  expect(f.mutations()).toEqual([]);
});

it("stops the next publication write when the executing writer is cancelled during a read", () => {
  const f = fixture();
  f.seedLegacy();
  f.update((state) => {
    state.authorityAfterDownload = {
      tag,
      name: "OpenClaw-2026.9.3-amd64.deb",
      change: "cancel-writer",
    };
  });
  failed(f.run("publish"), "release workflow run status");
  expect(f.mutations()).toEqual([]);
});

it("retains partial canonical replacement when the executing writer is cancelled after deletion", () => {
  const f = fixture();
  succeeded(f.run("publish"));
  f.addRelease(nextTag, true);
  f.update((state) => {
    state.calls = [];
    state.authorityAfterDelete = "cancel-writer";
  });
  failed(f.run("publish", nextTag), "release workflow run status");
  expect(releaseFrom(f.state(), channel).assets.some((entry) => entry.name === "latest.json")).toBe(
    false,
  );
  const mutations = f.mutations();
  expect(mutations.at(-1)).toMatchObject({ action: "DELETE", tag: channel, name: "latest.json" });
});

it("publishes immutable named assets and an exact canonical and legacy manifest", () => {
  const f = fixture();
  expect(succeeded(f.run("publish"))).toMatchObject({ state: "published", version: "2026.9.3" });
  const manifest = f.bytes(tag, "OpenClaw-2026.9.3-linux.json");
  expect(f.bytes(channel, "latest.json")).toEqual(manifest);
  expect(f.bytes(tag, "latest.json")).toEqual(manifest);
  expect(
    releaseFrom(f.state(), tag)
      .assets.map((asset) => asset.name)
      .toSorted(),
  ).toEqual(
    [
      "OpenClaw-2026.9.3-amd64.AppImage",
      "OpenClaw-2026.9.3-amd64.deb",
      "OpenClaw-2026.9.3-linux.json",
      "SHA256SUMS.linux-app.txt",
      "latest.json",
    ].toSorted(),
  );
  expect(releaseFrom(f.state(), channel)).toMatchObject({ draft: false, prerelease: true });
  expect(f.state().latest).toBe(tag);
});

it("initializes from the original legacy schema without changing its publication fields", () => {
  const f = fixture();
  const original = f.seedLegacy();
  f.update((state) => {
    Object.assign(releaseFrom(state, tag), {
      published_at: "2026-09-04T12:00:00Z",
      body: "Later core release notes",
    });
  });
  succeeded(f.run("publish"));
  const manifest = f.bytes(channel, "latest.json");
  expect(JSON.parse(manifest.toString())).toMatchObject(JSON.parse(original.toString()));
  expect(manifest).not.toEqual(original);
  expect(f.bytes(tag, "latest.json")).toEqual(manifest);
  expect(f.bytes(tag, "OpenClaw-2026.9.3-linux.json")).toEqual(manifest);
});

it("mirrors a new core latest without a new Linux build or bundle download", () => {
  const f = fixture();
  succeeded(f.run("publish"));
  const canonical = f.bytes(channel, "latest.json");
  const originalAssets = releaseFrom(f.state(), tag).assets;
  f.addRelease(nextTag, true);
  f.update((state) => {
    state.calls = [];
  });
  expect(succeeded(f.run("mirror", nextTag))).toMatchObject({
    state: "mirrored",
    tag: nextTag,
    version: "2026.9.3",
    manifestSha256: hash(canonical),
  });
  expect(f.bytes(nextTag, "latest.json")).toEqual(canonical);
  expect(f.bytes(channel, "latest.json")).toEqual(canonical);
  expect(releaseFrom(f.state(), tag).assets).toEqual(originalAssets);
  expect(f.mutations()).toEqual([
    { tool: "gh", action: "upload", tag: nextTag, name: "latest.json" },
  ]);
  expect(f.state().calls.some((call) => call.tool === "minisign")).toBe(false);
  expect(
    f
      .state()
      .calls.filter((call) => call.tool === "curl")
      .every((call) => call.name?.endsWith(".json")),
  ).toBe(true);
});

it.each<AuthorityChange>(["cancel-parent", "new-parent-attempt", "revoke-tooling", "move-tooling"])(
  "refuses the next mirror write when authority changes during a public read: %s",
  (change) => {
    const f = fixture();
    succeeded(f.run("publish"));
    f.addRelease(nextTag, true);
    f.update((state) => {
      state.authorityAfterDownload = { tag: channel, name: "latest.json", change };
    });
    const before = f.mutations().length;
    const result = f.run("mirror", nextTag);
    expect(result.status, result.stderr).toBe(1);
    expect(f.state().calls.some((call) => call.action === change)).toBe(true);
    expect(f.mutations()).toHaveLength(before);
    expect(result.stdout.trim()).toBe("");
  },
);

it("retains a partial legacy replacement when the parent is cancelled after DELETE", () => {
  const f = fixture();
  succeeded(f.run("publish"));
  const old = f.bytes(channel, "latest.json");
  f.addRelease(nextTag, true);
  succeeded(f.run("publish", nextTag));
  const core = "v2026.9.5";
  f.addRelease(core, true);
  f.update((state) => {
    replaceAsset(state, core, "latest.json", old);
    state.authorityAfterDelete = "cancel-parent";
  });
  const before = f.mutations().length;
  const result = f.run("mirror", core);
  expect(result.status, result.stderr).toBe(1);
  expect(
    f
      .mutations()
      .slice(before)
      .map((call) => call.action),
  ).toEqual(["DELETE"]);
  expect(releaseFrom(f.state(), core).assets).toEqual([]);
  expect(f.bytes(channel, "latest.json")).not.toEqual(old);
});

it("refuses channel note edits after authority changes in upload readback", () => {
  const f = fixture();
  succeeded(f.run("publish"));
  f.addRelease(nextTag, true);
  f.update((state) => {
    releaseFrom(state, channel).body = "Previous channel notes";
    state.authorityAfterDownload = { tag: nextTag, name: "latest.json", change: "cancel-parent" };
  });
  const before = f.mutations().length;
  const result = f.run("mirror", nextTag);
  expect(result.status, result.stderr).toBe(1);
  expect(
    f
      .mutations()
      .slice(before)
      .map((call) => call.action),
  ).toEqual(["upload"]);
  expect(releaseFrom(f.state(), channel).body).toBe("Previous channel notes");
});

it("stops native publication after its admitted request attempt changes", () => {
  const f = fixture();
  f.update((state) => {
    state.authorityAfterDownload = {
      tag,
      name: `OpenClaw-${tag.slice(1)}-amd64.AppImage`,
      change: "new-request-attempt",
    };
  });
  const result = f.run("publish");
  expect(result.status, result.stderr).toBe(1);
  const calls = f.state().calls;
  const revoked = calls.findIndex((call) => call.action === "new-request-attempt");
  expect(revoked).toBeGreaterThan(-1);
  expect(
    calls
      .slice(revoked + 1)
      .filter((call) => ["upload", "DELETE", "PATCH", "create", "edit"].includes(call.action)),
  ).toEqual([]);
  expect(f.state().releases.some((release) => release.tag_name === channel)).toBe(false);
});

it("refuses finalizer PATCH after publisher authority changes during source reads", () => {
  const f = fixture();
  f.addDraft(nextTag);
  f.update((state) => {
    state.authorityAfterSourceRead = { tag: nextTag, change: "cancel-parent" };
  });
  const result = f.run("finalize-core", nextTag, "true");
  expect(result.status, result.stderr).toBe(1);
  expect(f.state().calls.some((call) => call.action === "cancel-parent")).toBe(true);
  expect(f.mutations()).toEqual([]);
  expect(releaseFrom(f.state(), nextTag).draft).toBe(true);
});

it("accepts a successful completed publisher for finalization without a Linux channel", () => {
  const f = fixture();
  f.addDraft(nextTag);
  f.update((state) => {
    state.authority.parentStatus = "completed";
    state.authority.parentConclusion = "success";
  });
  expect(succeeded(f.run("finalize-core", nextTag, "true"))).toMatchObject({
    state: "finalized",
    tag: nextTag,
  });
  expect(f.mutations()).toHaveLength(1);
  expect(f.mutations()[0]).toMatchObject({ action: "PATCH", tag: nextTag, makeLatest: true });
  expect(releaseFrom(f.state(), nextTag).draft).toBe(false);
  expect(f.state().releases.some((release) => release.tag_name === channel)).toBe(false);
});

it.each([null, "move-tooling", "cancel-parent"] as const)(
  "fences Tideclaw alpha finalization at the live write boundary: %s",
  (change) => {
    const f = fixture("tideclaw/alpha/2026-09-13-0400Z");
    const alphaTag = "v2026.9.4-alpha.1";
    f.addDraft(alphaTag, true);
    if (change) {
      f.update((state) => {
        state.authorityAfterSourceRead = { tag: alphaTag, change };
      });
    }
    const result = f.run("finalize-core", alphaTag, "false");
    if (change) {
      expect(result.status, result.stderr).toBe(1);
      expect(f.state().calls.some((call) => call.action === change)).toBe(true);
      expect(f.mutations()).toEqual([]);
    } else {
      expect(succeeded(result)).toMatchObject({ state: "finalized", madeLatest: false });
      expect(f.mutations()).toEqual([
        expect.objectContaining({ action: "PATCH", tag: alphaTag, makeLatest: false }),
      ]);
    }
  },
);

it.each([
  { ref: "unreviewed/branch", tag: "v2026.9.4-alpha.1", latest: "false" },
  { ref: "tideclaw/alpha/2026-09-13-0400Z", tag: nextTag, latest: "false" },
  { ref: "tideclaw/alpha/2026-09-13-0400Z", tag: "v2026.9.4-alpha.1", latest: "true" },
])(
  "rejects unapproved branch finalization $ref/$tag/$latest",
  ({ ref, tag: selectedTag, latest }) => {
    const f = fixture(ref);
    f.addDraft(selectedTag, selectedTag.includes("-alpha."));
    expect(f.run("finalize-core", selectedTag, latest).status).toBe(1);
    expect(f.mutations()).toEqual([]);
  },
);

it("publishes opt-in desktop metadata only after successful Linux and legacy readback", () => {
  const f = fixture(toolingRef, true);
  succeeded(f.run("publish"));
  expect(f.bytes("desktop-test", "latest-desktop-test.json")).toEqual(
    f.bytes(tag, "latest-desktop-test.json"),
  );
  const calls = f.state().calls;
  const create = calls.findIndex((call) => call.action === "create" && call.tag === "desktop-test");
  const legacy = calls.findIndex(
    (call) =>
      call.url === "https://github.com/openclaw/openclaw/releases/latest/download/latest.json",
  );
  expect(legacy).toBeGreaterThanOrEqual(0);
  expect(create).toBeGreaterThan(legacy);
  expect(releaseFrom(f.state(), "desktop-test").source).toBe(sourceSha(tag));
});

it.each(["historical tag", "newer channel", "revoked before delete", "revoked after delete"])(
  "preserves desktop channel identity and next-write authority: %s",
  (scenario) => {
    const f = fixture(toolingRef, true);
    f.addRelease("desktop-test");
    const previous = JSON.stringify({
      version: scenario === "newer channel" ? "2026.10.1" : "2026.9.2",
    });
    f.update((state) => {
      Object.assign(releaseFrom(state, "desktop-test"), {
        source: "d".repeat(40),
        prerelease: true,
      });
      replaceAsset(state, "desktop-test", "latest-desktop-test.json", Buffer.from(previous));
      if (scenario === "revoked before delete") {
        state.authorityAfterDownload = {
          tag: "desktop-test",
          name: "latest-desktop-test.json",
          change: "new-request-attempt",
        };
      }
      if (scenario === "revoked after delete") {
        state.authorityAfterDesktopDelete = "new-request-attempt";
      }
    });
    const result = f.run("publish");
    const writes = f.mutations().filter((call) => call.tag === "desktop-test");
    if (scenario.startsWith("revoked")) {
      expect(result.status, result.stderr).toBe(1);
      expect(f.state().calls.some((call) => call.action === "new-request-attempt")).toBe(true);
      if (scenario === "revoked after delete") {
        expect(writes).toEqual([expect.objectContaining({ action: "DELETE" })]);
        expect(releaseFrom(f.state(), "desktop-test").assets).toEqual([]);
      } else {
        expect(writes).toEqual([]);
        expect(f.bytes("desktop-test", "latest-desktop-test.json").toString()).toBe(previous);
      }
    } else {
      succeeded(result);
      if (scenario === "newer channel") {
        expect(writes).toEqual([]);
        expect(f.bytes("desktop-test", "latest-desktop-test.json").toString()).toBe(previous);
      } else {
        expect(writes.map((call) => call.action)).toEqual(["DELETE", "upload"]);
        expect(f.bytes("desktop-test", "latest-desktop-test.json")).toEqual(
          f.bytes(tag, "latest-desktop-test.json"),
        );
      }
    }
    expect(releaseFrom(f.state(), "desktop-test").source).toBe("d".repeat(40));
  },
);

it("refuses desktop channel creation after request revocation at the Linux readback", () => {
  const f = fixture(toolingRef, true);
  f.update((state) => {
    state.authorityAfterDownload = {
      tag,
      name: "latest.json",
      change: "new-request-attempt",
    };
  });
  expect(f.run("publish").status).toBe(1);
  expect(f.state().calls.some((call) => call.action === "new-request-attempt")).toBe(true);
  expect(f.mutations().filter((call) => call.tag === "desktop-test")).toEqual([]);
  expect(f.state().releases.some((release) => release.tag_name === "desktop-test")).toBe(false);
});

it.each(["Linux first", "core first"])("converges when publishing %s", (order) => {
  const f = fixture();
  succeeded(f.run("publish"));
  if (order === "Linux first") {
    const previousAssets = releaseFrom(f.state(), tag).assets;
    f.addDraft(nextTag);
    expect(succeeded(f.run("finalize-core", nextTag, "false"))).toMatchObject({
      madeLatest: false,
      latestTag: tag,
    });
    const result = f.run("publish", nextTag);
    expect(releaseFrom(f.state(), tag).assets).toEqual(previousAssets);
    failed(result, "Canonical Linux version is newer than core latest");
    const immutable = f.bytes(nextTag, "OpenClaw-2026.9.4-linux.json");
    expect(f.bytes(channel, "latest.json")).toEqual(immutable);
    expect(f.state().latest).toBe(tag);

    for (const keepLegacy of [true, false]) {
      f.update((state) => {
        if (!keepLegacy) {
          const previous = releaseFrom(state, tag);
          previous.assets = previous.assets.filter((asset) => asset.name !== "latest.json");
        }
        state.calls = [];
      });
      const beforeMirror = f.state().releases;
      failed(f.run("mirror"), "Canonical Linux version is newer than core latest");
      expect(f.mutations()).toEqual([]);
      expect(f.state().releases).toEqual(beforeMirror);
    }

    const nativeAssets = releaseFrom(f.state(), nextTag).assets;
    expect(succeeded(f.run("finalize-core", nextTag, "true"))).toMatchObject({
      madeLatest: true,
      latestTag: nextTag,
    });
    f.update((state) => {
      state.calls = [];
    });
    succeeded(f.run("mirror", nextTag));
    expect(
      releaseFrom(f.state(), nextTag).assets.filter((asset) => asset.name !== "latest.json"),
    ).toEqual(nativeAssets);
    expect(f.bytes(channel, "latest.json")).toEqual(immutable);
    expect(f.state().calls.some((call) => call.tool === "minisign")).toBe(false);
    expect(
      f
        .state()
        .calls.filter((call) => call.tool === "curl")
        .every((call) => call.name?.endsWith(".json")),
    ).toBe(true);
  } else {
    f.addRelease(nextTag);
    f.update((state) => {
      state.latest = nextTag;
    });
    succeeded(f.run("mirror", nextTag));
    expect(JSON.parse(f.bytes(nextTag, "latest.json").toString())).toMatchObject({
      version: "2026.9.3",
    });
    succeeded(f.run("publish", nextTag));
  }
  const manifest = f.bytes(nextTag, "OpenClaw-2026.9.4-linux.json");
  expect(f.bytes(channel, "latest.json")).toEqual(manifest);
  expect(f.bytes(nextTag, "latest.json")).toEqual(manifest);
});

it("reuses exact publication bytes and asset identities on replay", () => {
  const f = fixture();
  succeeded(f.run("publish"));
  const manifest = f.bytes(channel, "latest.json");
  const assets = releaseFrom(f.state(), tag).assets;
  f.update((state) => {
    Object.assign(releaseFrom(state, tag), {
      published_at: "2026-09-04T12:00:00Z",
      body: "Later release notes",
    });
    state.calls = [];
  });
  succeeded(f.run("publish"));
  expect(f.bytes(channel, "latest.json")).toEqual(manifest);
  expect(releaseFrom(f.state(), tag).assets).toEqual(assets);
  expect(f.mutations().filter((call) => call.action !== "edit")).toEqual([]);
});

it("rejects an immutable bundle conflict before uploading missing assets", () => {
  const f = fixture();
  f.update((state) => {
    replaceAsset(state, tag, "OpenClaw-2026.9.3-amd64.deb", Buffer.from("different bundle"));
  });
  failed(f.run("publish"), "Immutable asset conflict");
  expect(f.mutations()).toEqual([]);
});

it("rejects same-version canonical bytes that differ from the immutable publication", () => {
  const f = fixture();
  succeeded(f.run("publish"));
  const changed = Buffer.concat([f.bytes(channel, "latest.json"), Buffer.from("\n")]);
  f.update((state) => {
    replaceAsset(state, channel, "latest.json", changed);
    state.calls = [];
  });
  failed(f.run("publish"), "Canonical bytes differ from the immutable Linux publication");
  expect(f.mutations()).toEqual([]);
});

it("keeps a newer canonical version when replaying an older Linux publication", () => {
  const f = fixture();
  succeeded(f.run("publish"));
  f.addRelease(nextTag, true);
  succeeded(f.run("publish", nextTag));
  const newer = f.bytes(channel, "latest.json");
  expect(succeeded(f.run("publish"))).toMatchObject({ state: "kept-newer-channel" });
  expect(f.bytes(channel, "latest.json")).toEqual(newer);
  expect(f.bytes(nextTag, "latest.json")).toEqual(newer);
});

it("requires the external signature verifier before any publication mutation", () => {
  const f = fixture();
  f.update((state) => {
    state.verifierExit = 1;
  });
  failed(f.run("publish"), "fixture signature verification refused");
  expect(f.state().calls.filter((call) => call.tool === "minisign")).toHaveLength(1);
  expect(f.mutations()).toEqual([]);
});

it("rejects an authenticated asset inventory whose bundle is not publicly downloadable", () => {
  const f = fixture();
  const name = "OpenClaw-2026.9.3-amd64.AppImage";
  const bytes = readFileSync(join(f.inputs(tag), name));
  f.update((state) => {
    replaceAsset(state, tag, name, bytes);
    state.fault = { point: "download", tag, name };
  });
  failed(f.run("publish"), "HTTP 404: public asset unavailable");
  expect(f.mutations()).toEqual([]);
});

it("rejects corrupted public bundle readback before publishing channel metadata", () => {
  const f = fixture();
  f.update((state) => {
    state.fault = { point: "upload-readback", tag, name: "OpenClaw-2026.9.3-amd64.AppImage" };
  });
  failed(f.run("publish"), "Public asset digest mismatch");
  expect(f.state().releases.some((release) => release.tag_name === channel)).toBe(false);
});

it("does not adopt a replacement release ID between immutable bundle uploads", () => {
  const f = fixture();
  const originalId = releaseFrom(f.state(), tag).id;
  const name = "OpenClaw-2026.9.3-amd64.AppImage";
  f.update((state) => {
    state.replaceReleaseAfterDownload = { tag, name };
  });
  failed(f.run("publish"), "Release identity changed before write");
  expect(f.state().calls).toContainEqual({ tool: "fixture", action: "replace-release", tag });
  expect(releaseFrom(f.state(), tag).id).not.toBe(originalId);
  expect(releaseFrom(f.state(), tag).assets).toEqual([]);
  expect(f.mutations()).toEqual([{ tool: "gh", action: "upload", tag, name }]);
});

it("refuses retry after versioned-only ACK loss leaves the canonical manifest missing", () => {
  const f = fixture();
  const name = "OpenClaw-2026.9.3-linux.json";
  f.update((state) => {
    state.fault = { point: "upload-after", tag, name };
  });
  failed(f.run("publish"), "fixture lost upload acknowledgement");
  const retained = releaseFrom(f.state(), tag).assets.find((asset) => asset.name === name);
  assert.ok(retained);
  const writes = f.mutations();
  expect(releaseFrom(f.state(), channel).assets).toEqual([]);
  failed(f.run("publish"), "Missing channel metadata is not a new channel");
  expect(releaseFrom(f.state(), tag).assets.find((asset) => asset.name === name)).toEqual(retained);
  expect(releaseFrom(f.state(), channel).assets).toEqual([]);
  expect(f.mutations()).toEqual(writes);
});

it("reconciles a committed canonical upload with a lost acknowledgement", () => {
  const f = fixture();
  const owner = channel;
  const name = "latest.json";
  f.update((state) => {
    state.fault = { point: "upload-after", tag: owner, name };
  });
  failed(f.run("publish"), "fixture lost upload acknowledgement");
  const retained = releaseFrom(f.state(), owner).assets.find((asset) => asset.name === name);
  assert.ok(retained);
  succeeded(f.run("publish"));
  expect(releaseFrom(f.state(), owner).assets.find((asset) => asset.name === name)).toEqual(
    retained,
  );
  expect(f.bytes(tag, "latest.json")).toEqual(f.bytes(channel, "latest.json"));
  expect(
    f
      .state()
      .calls.filter((call) => call.action === "upload" && call.tag === owner && call.name === name),
  ).toHaveLength(1);
});

it("reports an interrupted legacy replacement and reconciles it without rebuilding", () => {
  const f = fixture();
  succeeded(f.run("publish"));
  const canonical = f.bytes(channel, "latest.json");
  f.addRelease(nextTag, true);
  f.update((state) => {
    const original = legacyManifest();
    replaceAsset(state, tag, "latest.json", original);
    replaceAsset(state, nextTag, "latest.json", original);
    state.fault = { point: "upload-before", tag: nextTag, name: "latest.json" };
    state.calls = [];
  });
  failed(f.run("mirror", nextTag), "fixture upload refused");
  expect(releaseFrom(f.state(), nextTag).assets).toEqual([]);
  expect(f.bytes(channel, "latest.json")).toEqual(canonical);
  expect(succeeded(f.run("mirror", nextTag))).toMatchObject({ state: "mirrored" });
  expect(f.bytes(nextTag, "latest.json")).toEqual(canonical);
  expect(f.state().calls.some((call) => call.tool === "minisign")).toBe(false);
});

it("keeps normal publish and mirror fail-closed after canonical deletion interrupts promotion", () => {
  const f = fixture();
  succeeded(f.run("publish"));
  const previous = f.bytes(channel, "latest.json");
  f.addRelease(nextTag, true);
  f.update((state) => {
    state.fault = { point: "upload-before", tag: channel, name: "latest.json" };
    state.calls = [];
  });
  failed(f.run("publish", nextTag), "fixture upload refused");
  const retained = f.bytes(nextTag, "OpenClaw-2026.9.4-linux.json");
  expect(f.mutations()).toContainEqual({
    tool: "gh",
    action: "DELETE",
    tag: channel,
    name: "latest.json",
    url: expect.stringMatching(/^releases\/assets\/\d+$/),
  });
  expect(releaseFrom(f.state(), channel).assets).toEqual([]);
  expect(f.bytes(tag, "latest.json")).toEqual(previous);
  f.update((state) => {
    state.calls = [];
  });
  for (const [mode, message] of [
    ["publish", "Missing channel metadata is not a new channel"],
    ["mirror", "Linux channel manifest is missing"],
  ] as const) {
    failed(f.run(mode, nextTag), message);
    expect(f.mutations()).toEqual([]);
    expect(releaseFrom(f.state(), channel).assets).toEqual([]);
    expect(f.bytes(nextTag, "OpenClaw-2026.9.4-linux.json")).toEqual(retained);
  }
});

it.each([
  { kind: "arbitrary JSON", message: "Unrecognized legacy Linux manifest" },
  {
    kind: "newer legacy version",
    message: "Legacy endpoint already carries a newer Linux manifest",
  },
  {
    kind: "same-version legacy conflict",
    message: "Same-version legacy bootstrap changed original manifest fields",
  },
  {
    kind: "same-version canonical conflict",
    message: "Canonical bytes differ from the immutable Linux publication",
  },
])("does not replace existing latest metadata containing $kind", ({ kind, message }) => {
  const f = fixture();
  succeeded(f.run("publish"));
  const canonical = f.bytes(channel, "latest.json");
  f.addRelease(nextTag, true);
  let previous = Buffer.from(JSON.stringify({ version: "2026.9.3", unrelated: true }));
  if (kind === "newer legacy version") {
    previous = f.seedLegacy(nextTag);
  } else if (kind === "same-version legacy conflict") {
    previous = legacyManifest(tag, "Conflicting Linux publication notes");
    f.update((state) => {
      replaceAsset(state, tag, "latest.json", previous);
    });
  } else if (kind === "same-version canonical conflict") {
    previous = Buffer.concat([canonical, Buffer.from("\n")]);
  }
  f.update((state) => {
    replaceAsset(state, nextTag, "latest.json", previous);
    state.calls = [];
  });
  failed(f.run("mirror", nextTag), message);
  expect(f.mutations()).toEqual([]);
  expect(f.bytes(nextTag, "latest.json")).toEqual(previous);
  expect(f.bytes(channel, "latest.json")).toEqual(canonical);
});

it("does not report mirror success when the public latest endpoint readback differs", () => {
  const f = fixture();
  succeeded(f.run("publish"));
  f.addRelease(nextTag, true);
  f.update((state) => {
    state.fault = { point: "legacy-readback", tag: nextTag, name: "latest.json" };
  });
  failed(f.run("mirror", nextTag), "Legacy endpoint readback failed");
  expect(succeeded(f.run("mirror", nextTag))).toMatchObject({ state: "mirrored" });
});

it("stops a replacement if the latest selector changes after deletion", () => {
  const f = fixture();
  succeeded(f.run("publish"));
  f.addRelease(nextTag, true);
  f.update((state) => {
    const original = legacyManifest();
    replaceAsset(state, tag, "latest.json", original);
    replaceAsset(state, nextTag, "latest.json", original);
    state.latestAfterDelete = tag;
    state.calls = [];
  });
  failed(f.run("mirror", nextTag), "Core latest changed before mirror");
  expect(f.state().calls.filter((call) => call.action === "upload")).toEqual([]);
  expect(f.state().latest).toBe(tag);
});

it("rejects a latest-selector change after upload instead of claiming a fresh mirror", () => {
  const f = fixture();
  succeeded(f.run("publish"));
  f.addRelease(nextTag, true);
  f.update((state) => {
    state.latestAfterUpload = tag;
  });
  failed(f.run("mirror", nextTag), "Core latest changed after mirror");
  expect(f.state().latest).toBe(tag);
});

it("does not mutate a selected core release that is no longer latest", () => {
  const f = fixture();
  succeeded(f.run("publish"));
  f.addRelease(nextTag, true);
  f.update((state) => {
    state.calls = [];
  });
  expect(succeeded(f.run("mirror"))).toEqual({ state: "skipped-not-latest", tag });
  expect(f.mutations()).toEqual([]);
});

it("refuses mirroring before canonical initialization without creating a release", () => {
  const f = fixture();
  failed(f.run("mirror"), "HTTP 404: release not found");
  expect(f.mutations()).toEqual([]);
});

it.each(["v2026.9.3-alpha.1", "v2026.9.3-beta.1", "v2026.6.33"])(
  "rejects non-regular target %s before touching GitHub",
  (releaseTag) => {
    const f = fixture();
    failed(f.run("mirror", releaseTag), "Not a canonical regular Linux release");
    expect(f.state().calls).toEqual([]);
  },
);

it.each(["asset replaced", "source changed", "draft release"])(
  "rejects publisher identity drift: %s",
  (change) => {
    const f = fixture();
    succeeded(f.run("publish"));
    const appimage = f.bytes(tag, "OpenClaw-2026.9.3-amd64.AppImage");
    f.update((state) => {
      if (change === "asset replaced") {
        replaceAsset(state, tag, "OpenClaw-2026.9.3-amd64.AppImage", appimage);
      } else if (change === "source changed") {
        releaseFrom(state, tag).source = "c".repeat(40);
      } else {
        releaseFrom(state, tag).draft = true;
      }
      state.calls = [];
    });
    const message =
      change === "asset replaced"
        ? "Published Linux asset changed"
        : change === "source changed"
          ? "Selected core tag moved"
          : "HTTP 404: release by tag is not published";
    failed(f.run("mirror"), message);
    expect(f.mutations()).toEqual([]);
  },
);

it.each([null, tag])(
  "finalizes a draft by ID with prior latest %s and no Linux channel",
  (latest) => {
    const f = fixture();
    const draft = f.addDraft();
    f.update((state) => {
      state.latest = latest;
    });
    expect(succeeded(f.run("finalize-core", nextTag, "true"))).toEqual({
      state: "finalized",
      tag: nextTag,
      releaseId: draft.id,
      sourceSha: draft.source,
      madeLatest: true,
      latestReleaseId: draft.id,
      latestTag: nextTag,
    });
    expect(f.mutations()).toEqual([
      {
        tool: "gh",
        action: "PATCH",
        url: `releases/${draft.id}`,
        tag: nextTag,
        releaseId: draft.id,
        makeLatest: true,
      },
    ]);
    expect(releaseFrom(f.state(), nextTag)).toMatchObject({ draft: false, prerelease: false });
    expect(f.state().calls.every((call) => call.tool === "gh")).toBe(true);
    expect(f.state().releases.some((entry) => entry.tag_name === channel)).toBe(false);
  },
);

it.each([
  { releaseTag: nextTag, prerelease: false },
  { releaseTag: "v2026.9.4-alpha.1", prerelease: true },
  { releaseTag: "v2026.9.4-beta.1", prerelease: true },
])("honors explicit non-latest finalization of $releaseTag", ({ releaseTag, prerelease }) => {
  const f = fixture();
  const previous = releaseFrom(f.state(), tag);
  const draft = f.addDraft(releaseTag, prerelease);
  expect(succeeded(f.run("finalize-core", releaseTag, "false"))).toEqual({
    state: "finalized",
    tag: releaseTag,
    releaseId: draft.id,
    sourceSha: draft.source,
    madeLatest: false,
    latestReleaseId: previous.id,
    latestTag: tag,
  });
  expect(releaseFrom(f.state(), releaseTag)).toMatchObject({ draft: false, prerelease });
  expect(f.state().latest).toBe(tag);
  expect(f.mutations()).toEqual([
    {
      tool: "gh",
      action: "PATCH",
      url: `releases/${draft.id}`,
      tag: releaseTag,
      releaseId: draft.id,
      makeLatest: false,
    },
  ]);
});

it("finalizes an older release without taking latest back from a newer publication", () => {
  const f = fixture();
  f.addRelease(nextTag, true);
  const previous = releaseFrom(f.state(), nextTag);
  expect(succeeded(f.run("finalize-core", tag, "true"))).toMatchObject({
    state: "finalized",
    tag,
    madeLatest: false,
    latestReleaseId: previous.id,
    latestTag: nextTag,
  });
  expect(f.mutations()).toHaveLength(1);
  expect(f.mutations()[0]).toMatchObject({ action: "PATCH", tag, makeLatest: false });
  expect(f.state().latest).toBe(nextTag);
});

it("can resume the current public latest by its retained release ID", () => {
  const f = fixture();
  const original = releaseFrom(f.state(), tag);
  expect(succeeded(f.run("finalize-core", tag, "true"))).toEqual({
    state: "finalized",
    tag,
    releaseId: original.id,
    sourceSha: original.source,
    madeLatest: true,
    latestReleaseId: original.id,
    latestTag: tag,
  });
  expect(releaseFrom(f.state(), tag)).toEqual(original);
});

it("refuses non-latest finalization that would demote the current latest", () => {
  const f = fixture();
  failed(f.run("finalize-core", tag, "false"), "Non-latest finalization must not demote");
  expect(f.mutations()).toEqual([]);
  expect(f.state().latest).toBe(tag);
});

it.each([
  {
    releaseTag: "v2026.6.33",
    latest: "false",
    message: "Unsupported core GitHub release train",
  },
  {
    releaseTag: "v2026.9.04",
    latest: "true",
    message: "Unsupported core GitHub release train",
  },
  {
    releaseTag: nextTag,
    latest: undefined,
    message: "Expected explicit core latest intent",
  },
  {
    releaseTag: nextTag,
    latest: "legacy",
    message: "Expected explicit core latest intent",
  },
  {
    releaseTag: "v2026.9.4-beta.1",
    latest: "true",
    message: "Prereleases cannot become core latest",
  },
])("rejects finalization admission $releaseTag/$latest", ({ releaseTag, latest, message }) => {
  const f = fixture();
  failed(f.run("finalize-core", releaseTag, latest), message);
  expect(f.state().calls).toEqual([]);
});

it.each([
  { kind: "source", message: "Selected core tag moved" },
  { kind: "tag", message: "Selected core release identity is invalid" },
  { kind: "prerelease", message: "Selected core prerelease classification changed" },
])("rejects an unapproved draft $kind before finalization", ({ kind, message }) => {
  const f = fixture();
  f.addDraft();
  f.update((state) => {
    if (kind === "source") {
      releaseFrom(state, nextTag).source = "c".repeat(40);
    } else if (kind === "prerelease") {
      releaseFrom(state, nextTag).prerelease = true;
    } else {
      state.releaseResponseTag = { tag: nextTag, value: "v2026.9.5" };
    }
  });
  failed(f.run("finalize-core", nextTag, "true"), message);
  expect(f.mutations()).toEqual([]);
  expect(releaseFrom(f.state(), nextTag).draft).toBe(true);
});

it.each([
  {
    kind: "selected release replaced",
    trigger: nextTag,
    change: { kind: "replace-release", tag: nextTag },
    message: "HTTP 404: release not found",
  },
  {
    kind: "selected source moved",
    trigger: nextTag,
    change: { kind: "move-tag", tag: nextTag },
    message: "Selected core tag moved",
  },
  {
    kind: "latest selector moved",
    trigger: tag,
    change: { kind: "select-latest", tag: "v2026.9.5" },
    message: "Core latest changed before finalization",
  },
  {
    kind: "latest source moved",
    trigger: tag,
    change: { kind: "move-tag", tag },
    message: "Core latest tag moved",
  },
] satisfies { kind: string; trigger: string; change: Transition; message: string }[])(
  "does not finalize after $kind between admission and mutation",
  ({ trigger, change, message }) => {
    const f = fixture();
    f.addDraft();
    f.addRelease("v2026.9.5");
    f.update((state) => {
      state.afterSourceRead = { tag: trigger, change };
    });
    failed(f.run("finalize-core", nextTag, "true"), message);
    expect(f.state().afterSourceRead).toBeUndefined();
    expect(f.state().calls).toContainEqual({
      tool: "fixture",
      action: change.kind,
      tag: change.tag,
    });
    expect(f.mutations()).toEqual([]);
  },
);

it.each([
  {
    change: { kind: "replace-release", tag: nextTag },
    message: "Finalized core release identity mismatch",
  },
  {
    change: { kind: "move-tag", tag: nextTag },
    message: "Finalized core tag moved",
  },
  {
    change: { kind: "select-latest", tag },
    message: "Core latest readback mismatch",
  },
] satisfies { change: Transition; message: string }[])(
  "does not report finalization success after readback drift: $change.kind",
  ({ change, message }) => {
    const f = fixture();
    const draft = f.addDraft();
    f.update((state) => {
      state.afterPatch = change;
    });
    failed(f.run("finalize-core", nextTag, "true"), message);
    expect(f.state().afterPatch).toBeUndefined();
    expect(f.mutations()).toEqual([
      {
        tool: "gh",
        action: "PATCH",
        url: `releases/${draft.id}`,
        tag: nextTag,
        releaseId: draft.id,
        makeLatest: true,
      },
    ]);
  },
);
