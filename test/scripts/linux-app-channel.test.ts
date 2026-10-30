import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Script } from "node:vm";
import { expect, it } from "vitest";
import { runLinuxAppChannel } from "../../scripts/linux-app-channel.mjs";
import { withEnv } from "../../src/test-utils/env.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const tag = "v2026.9.3";
const nextTag = "v2026.9.4";
const channel = "linux-stable";
const publicKey = Buffer.from("fixture public key\n").toString("base64");
const signature = Buffer.from("fixture signature\n").toString("base64");
const toolingSha = "b".repeat(40);
const toolingRef = `release-publish/${toolingSha.slice(0, 12)}-42`;
const mutationActions = new Set(["upload", "DELETE", "PATCH", "create", "edit"]);
const appimageName = "OpenClaw-2026.9.3-amd64.AppImage";
const linuxName = (releaseTag: string) => `OpenClaw-${releaseTag.slice(1)}-linux.json`;
const isBundle = (entry: { name?: string }) => !entry.name?.endsWith(".json");

function writeChecksums(directory: string) {
  writeFileSync(
    join(directory, "SHA256SUMS.linux-app.txt"),
    readdirSync(directory)
      .filter((name) => !name.endsWith(".json") && !name.endsWith(".txt"))
      .map((name) => `${hash(readFileSync(join(directory, name)))}  ./${name}`)
      .join("\n"),
  );
}

type Asset = {
  id: number;
  name: string;
  size: number;
  state: string;
  digest?: string;
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
  delay?: number;
};
type Transition = {
  kind: "replace-release" | "move-tag" | "select-latest";
  tag: string;
};
type Fault = {
  point: "upload-before" | "upload-after" | "upload-readback";
  tag: string;
  name: string;
};
type AuthorityChange =
  | "cancel-parent"
  | "new-parent-attempt"
  | "revoke-tooling"
  | "move-tooling"
  | "new-request-attempt"
  | "cancel-writer";
type StaleDownload = {
  tag: string;
  name: string;
  bytes: string;
  remaining: number;
  skip?: number;
  legacy?: boolean;
};
type State = {
  releases: Release[];
  latest: string | null;
  nextId: number;
  calls: Call[];
  verifierExit: number;
  verifierRejectSuffix?: string;
  publicDownloadCache?: Record<string, string>;
  staleAfterUpload?: StaleDownload;
  staleDownloads?: StaleDownload[];
  wrongUpload?: { tag: string; name: string };
  fault?: Fault;
  corruptDownload?: { tag: string; name: string };
  replaceReleaseAfterDownload?: { tag: string; name: string };
  latestAfterDelete?: string;
  latestAfterUpload?: string;
  afterSourceRead?: { tag: string; change: Transition };
  afterPatch?: Transition;
  releaseResponseTag?: { tag: string; value: string };
  authority: ReturnType<typeof makeAuthority>;
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

const bundleSuffix = {
  "linux-x86_64": "amd64.AppImage",
  "windows-x86_64": "windows-x86_64.exe",
  "darwin-aarch64": "darwin-aarch64.app.tar.gz",
};
function legacyManifest(
  releaseTag = tag,
  notes = "Fixture release notes",
  platforms: (keyof typeof bundleSuffix)[] = ["linux-x86_64"],
) {
  return Buffer.from(
    JSON.stringify({
      version: releaseTag.slice(1),
      notes,
      pub_date: "2026-09-03T12:00:00Z",
      platforms: Object.fromEntries(
        platforms.map((platform) => [
          platform,
          {
            signature,
            url: downloadUrl(
              releaseTag,
              `OpenClaw-${releaseTag.slice(1)}-${bundleSuffix[platform]}`,
            ),
          },
        ]),
      ),
    }),
  );
}

function patchCall(release: Release, makeLatest = true): Call {
  return {
    tool: "gh",
    action: "PATCH",
    url: `releases/${release.id}`,
    tag: release.tag_name,
    releaseId: release.id,
    makeLatest,
  };
}

function staleFeed(releaseTag: string, overrides: Partial<StaleDownload> = {}): StaleDownload {
  return {
    tag: releaseTag,
    name: "latest.json",
    remaining: 2,
    bytes: legacyManifest("v2026.9.2").toString("base64"),
    ...overrides,
  };
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
const tool = path.basename(binary);
let output = "";
const fail = (message, status = 1) => {
  throw Object.assign(new Error(message), { status, stderr: message, stdout: output });
};
const answer = (value) => {
  if (value !== undefined) output = JSON.stringify(value);
};
const findRelease = (matches) => {
  const owner = state.releases.find(matches);
  if (!owner) fail("HTTP 404: release not found");
  return owner;
};
const release = (tag) => findRelease((entry) => entry.tag_name === tag);
const releaseById = (id) => findRelease((entry) => entry.id === Number(id));
const publicAsset = ({ bytes, ...entry }) => entry;
const publicRelease = ({ source, assets, ...entry }) => entry;
const releaseResponse = (owner) => {
  const response = publicRelease(owner);
  if (state.releaseResponseTag?.tag === owner.tag_name) response.tag_name = state.releaseResponseTag.value;
  return response;
};
const workflowRun = (id, prefix, fields) => ({
  id, run_attempt: state.authority[prefix + "Attempt"],
  repository: { full_name: "openclaw/openclaw" }, head_sha: "b".repeat(40),
  status: state.authority[prefix + "Status"], conclusion: state.authority[prefix + "Conclusion"],
  ...fields,
});
const flag = (name) => args[args.indexOf(name) + 1];
const take = (key, apply, match = {}) => {
  const value = state[key];
  if (value && Object.entries(match).every(([field, expected]) => value[field] === expected)) {
    delete state[key];
    return apply(value);
  }
};
const fault = (point, tag, name) => take("fault", () => true, { point, tag, name }) ?? false;
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
  } else if (change === "revoke-tooling") state.authority.toolingPresent = false;
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
      const owner = releaseById(match[1]);
      const makeLatest = latest === "make_latest=true";
      if (makeLatest && owner.prerelease) fail("HTTP 422: prerelease cannot be latest");
      Object.assign(state.calls.at(-1), { tag: owner.tag_name, releaseId: owner.id, makeLatest });
      owner.draft = false;
      if (makeLatest) state.latest = owner.tag_name;
      const response = publicRelease(owner);
      take("afterPatch", transition);
      answer(response);
    } else if (method === "DELETE") {
      const match = /^releases\/assets\/(\d+)$/.exec(route);
      assert(match, "Unsupported mutation");
      const owner = state.releases.find((entry) => entry.assets.some((asset) => asset.id === Number(match[1])));
      assert(owner, "Missing deleted asset");
      const entry = owner.assets.find((asset) => asset.id === Number(match[1]));
      Object.assign(state.calls.at(-1), { tag: owner.tag_name, name: entry.name });
      owner.assets = owner.assets.filter((asset) => asset.id !== entry.id);
      take("latestAfterDelete", (tag) => { state.latest = tag; });
      take("authorityAfterDelete", changeAuthority);
      if (owner.tag_name === "desktop-test") take("authorityAfterDesktopDelete", changeAuthority);
    } else if (route.startsWith("compare/") && route.endsWith("...main")) {
      assert.equal(route, "compare/" + "b".repeat(40) + "...main");
      answer({ status: "identical" });
    } else if (route === "actions/runs/42") {
      answer(workflowRun(42, "parent", {
        event: "workflow_dispatch", head_branch: state.authority.toolingRef,
        path: ".github/workflows/openclaw-release-publish.yml@" + state.authority.toolingFullRef,
      }));
    } else if (route.startsWith("git/ref/heads/")) {
      if (!state.authority.toolingPresent) fail("HTTP 404: tooling branch not found");
      answer({ ref: state.authority.toolingFullRef, object: { type: "commit", sha: state.authority.toolingSha } });
    } else if (route === "actions/runs/43") {
      answer(workflowRun(43, "request", {
        event: "workflow_dispatch", head_branch: "main",
        path: ".github/workflows/linux-app-release-request.yml",
        display_title: "Linux App Release Request [" + state.authority.requestTag + "] desktop=" + state.authority.desktop,
        status: "completed", conclusion: "success",
      }));
    } else if (route === "actions/runs/44") {
      answer(workflowRun(44, "writer", {
        event: state.authority.writerEvent, head_branch: state.authority.writerRef,
        path: state.authority.writerPath + "@" + state.authority.writerFullRef,
      }));
    } else if (route === "releases/latest") {
      if (!state.latest) fail("HTTP 404: latest not found");
      answer(publicRelease(release(state.latest)));
    } else if (route.startsWith("releases/tags/")) {
      const tag = decodeURIComponent(route.slice("releases/tags/".length));
      const owner = release(tag);
      if (owner.draft) fail("HTTP 404: release by tag is not published");
      answer(releaseResponse(owner));
    } else if (route.startsWith("git/ref/tags/")) {
      const tag = decodeURIComponent(route.slice("git/ref/tags/".length));
      if (tag.startsWith("release-publish/")) {
        if (!state.authority.toolingPresent) fail("HTTP 404: tooling tag not found");
        answer({ ref: "refs/tags/" + tag, object: { type: "commit", sha: state.authority.toolingSha } });
        return output;
      }
      const owner = release(tag);
      const response = { object: { type: "commit", sha: owner.source } };
      take("afterSourceRead", ({ change }) => transition(change), { tag });
      take("authorityAfterSourceRead", ({ change }) => changeAuthority(change), { tag });
      answer(response);
    } else if (/^releases\/assets\/\d+$/.test(route)) {
      const id = Number(route.split("/").at(-1));
      const entry = state.releases.flatMap((owner) => owner.assets).find((entry) => entry.id === id);
      if (!entry) fail("HTTP 404: asset not found");
      answer(publicAsset(entry));
    } else if (/^releases\/\d+$/.test(route)) {
      answer(releaseResponse(releaseById(route.slice("releases/".length))));
    } else {
      const match = /^releases\/(\d+)\/assets\?per_page=100&page=(\d+)$/.exec(route);
      assert(match, "Unsupported fixture API");
      const owner = releaseById(match[1]);
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
      assert(!args.includes("--jq"), "Unsupported release view projection");
      answer(Object.fromEntries(selected.map((name) => [name, fields[name]])));
    } else if (action === "create") {
      assert(!state.releases.some((entry) => entry.tag_name === tag), "Release already exists");
      assert(args.includes("--prerelease") && args.includes("--latest=false"));
      state.calls.push({ tool, action, tag });
      state.releases.push({
        id: state.nextId++, tag_name: tag, source: flag("--target"),
        draft: false, prerelease: true, body: flag("--notes"),
        published_at: "2026-09-03T12:00:00Z", assets: [],
      });
    } else if (action === "edit") {
      assert(args.includes("--prerelease") && args.includes("--latest=false"));
      state.calls.push({ tool, action, tag });
      release(tag).body = fs.readFileSync(flag("--notes-file"), "utf8");
    } else {
      assert.equal(action, "upload", "Unsupported fixture release command");
      assert(!args.includes("--clobber"), "Fixture refuses implicit asset replacement");
      const file = args.at(-1);
      assert(!file.includes("#"), "Unsupported fixture upload label");
      const name = path.basename(file);
      state.calls.push({ tool, action, tag, name });
      if (fault("upload-before", tag, name)) fail("fixture upload refused");
      const owner = release(tag);
      if (owner.assets.some((entry) => entry.name === name)) fail("HTTP 422: asset already exists");
      const bytes = state.wrongUpload?.tag === tag && state.wrongUpload.name === name
        ? Buffer.alloc(fs.readFileSync(file).length, 120) : fs.readFileSync(file);
      putAsset(state, tag, name, bytes);
      take("staleAfterUpload", (entry) => (state.staleDownloads ??= []).push(entry), { tag, name });
      take("latestAfterUpload", (tag) => { state.latest = tag; });
      if (fault("upload-readback", tag, name)) state.corruptDownload = { tag, name };
      if (fault("upload-after", tag, name)) fail("fixture lost upload acknowledgement");
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
    if (owner.draft || !entry) fail("HTTP 404: public asset unavailable");
    let bytes = Buffer.from(entry.bytes, "base64");
    if (state.publicDownloadCache) {
      const revalidate = args.includes("--header") && flag("--header") === "Cache-Control: no-cache";
      const cached = state.publicDownloadCache[url];
      if (cached && !revalidate) bytes = Buffer.from(cached, "base64");
      state.publicDownloadCache[url] = bytes.toString("base64");
    }
    take("corruptDownload", () => { bytes = Buffer.alloc(bytes.length, 120); }, { tag, name });
    const stale = state.staleDownloads?.find((entry) => entry.tag === tag && entry.name === name && Boolean(entry.legacy) === legacy && entry.remaining > 0);
    if (stale?.skip) stale.skip--;
    else if (stale) { bytes = Buffer.from(stale.bytes, "base64"); stale.remaining--; }
    assert(bytes.length <= Number(flag("--max-filesize")), "Fixture download exceeds limit");
    fs.writeFileSync(flag("--output"), bytes);
    take("replaceReleaseAfterDownload", () => transition({ kind: "replace-release", tag }), { tag, name });
    take("authorityAfterDownload", ({ change }) => changeAuthority(change), { tag, name });
  } else if (tool === "sleep") {
    assert(args.length === 1 && /^[1-9][0-9]*$/u.test(args[0]) && Number(args[0]) <= 60);
    state.calls.push({ tool, action: "wait", delay: Number(args[0]) });
  } else if (tool === "minisign") {
    state.calls.push({ tool, action: "verify" });
    for (const option of ["-Vm", "-x", "-p"]) {
      assert(args.includes(option) && fs.readFileSync(flag(option)).length > 0);
    }
    if (state.verifierExit || (state.verifierRejectSuffix && flag("-Vm").endsWith(state.verifierRejectSuffix))) fail("fixture signature verification refused", state.verifierExit || 1);
  } else {
    fail("Unsupported fixture command");
  }
} catch (error) {
  fail("Fixture contract failure: " + error.message);
}
return output;
`;

const fixtureRequire = createRequire(import.meta.url);
// Keep the external command contract without emulating a second CLI/process layer.
const compiledCommandFixture = new Script(
  `(function (require, binary, args, state, putAsset) {${commandFixture}\n})`,
).runInThisContext();

function makeAuthority(workflowRef: string, desktop: boolean, conclusion: string | null = null) {
  const fullRef = `${workflowRef.startsWith("release-publish/") ? "refs/tags" : "refs/heads"}/${workflowRef}`;
  return {
    toolingSha,
    toolingPresent: true,
    toolingRef: workflowRef,
    toolingFullRef: fullRef,
    parentAttempt: 1,
    parentStatus: "in_progress",
    parentConclusion: conclusion,
    requestTag: tag,
    requestAttempt: 1,
    desktop,
    writerAttempt: 1,
    writerStatus: "in_progress",
    writerConclusion: conclusion,
    writerRef: workflowRef,
    writerFullRef: fullRef,
    writerPath: ".github/workflows/linux-app-mirror.yml",
    writerEvent: "workflow_dispatch",
  };
}

function fixture(
  overrides: Partial<State> = {},
  workflowRef = toolingRef,
  desktop = false,
  windows = false,
) {
  const authority = makeAuthority(workflowRef, desktop);
  const workflowFullRef = authority.toolingFullRef;
  const root = createTempDir("linux-channel-");
  const current: State = {
    releases: [],
    latest: tag,
    nextId: 1,
    calls: [],
    verifierExit: 0,
    authority,
    ...overrides,
  };
  const config = join(root, "tauri.conf.json");
  writeFileSync(config, JSON.stringify({ plugins: { updater: { pubkey: publicKey } } }));
  const signaturePath = join(root, "appimage.sig");
  writeFileSync(signaturePath, signature);
  const directories = new Map<string, string>();
  // Callers retain independent before/after snapshots; command effects mutate the owned state.
  const state = (): State => structuredClone(current);
  const update = (change: Partial<State> | ((value: State) => void)) => {
    if (typeof change === "function") {
      change(current);
    } else {
      Object.assign(current, change);
    }
  };
  const addRelease = (releaseTag: string, latest = false, fields: Partial<Release> = {}) => {
    const release: Release = {
      id: current.nextId++,
      tag_name: releaseTag,
      source: sourceSha(releaseTag),
      draft: false,
      prerelease: false,
      body: "Fixture release notes",
      published_at: "2026-09-03T12:00:00Z",
      assets: [],
      ...fields,
    };
    current.releases.push(release);
    if (latest) {
      current.latest = releaseTag;
    }
    return structuredClone(release);
  };
  addRelease(tag);
  const addDraft = (releaseTag = nextTag, prerelease = false) =>
    addRelease(releaseTag, false, { draft: true, prerelease });
  const inputs = (releaseTag: string) => {
    const existing = directories.get(releaseTag);
    if (existing) {
      return existing;
    }
    const directory = join(root, releaseTag);
    mkdirSync(directory);
    const version = releaseTag.slice(1);
    const names = [
      "amd64.AppImage",
      "amd64.deb",
      ...(windows && !desktop ? ["windows-x86_64.exe"] : []),
      ...(desktop ? ["darwin-aarch64.dmg", "darwin-aarch64.app.tar.gz", "windows-x86_64.exe"] : []),
    ].map((suffix) => `OpenClaw-${version}-${suffix}`);
    for (const name of names) {
      const bytes = Buffer.from(`fixture bytes: ${name}\n`);
      writeFileSync(join(directory, name), bytes);
    }
    writeChecksums(directory);
    for (const [enabled, name, notes, platforms] of [
      [windows, "latest-windows.json", "Fixture Windows release", ["windows-x86_64"]],
      [
        desktop,
        "latest-desktop-test.json",
        "Fixture desktop test bundles",
        ["darwin-aarch64", "windows-x86_64"],
      ],
    ] satisfies [boolean, string, string, (keyof typeof bundleSuffix)[]][]) {
      if (enabled) {
        writeFileSync(join(directory, name), legacyManifest(releaseTag, notes, platforms));
      }
    }
    directories.set(releaseTag, directory);
    return directory;
  };
  const seedLegacy = (releaseTag = tag) => {
    const directory = inputs(releaseTag);
    const bytes = legacyManifest(releaseTag);
    for (const name of readdirSync(directory)) {
      replaceAsset(current, releaseTag, name, readFileSync(join(directory, name)));
    }
    replaceAsset(current, releaseTag, "latest.json", bytes);
    return bytes;
  };
  const run = (
    mode: "publish" | "mirror" | "finalize-core",
    releaseTag = tag,
    latest?: string,
    publicOnly = false,
  ): unknown => {
    const args = [mode, "--tag", releaseTag, "--source-sha", sourceSha(releaseTag)];
    const flags = (values: Record<string, string>) =>
      args.push(...Object.entries(values).flatMap(([key, value]) => [`--${key}`, value]));
    const publishing = mode === "publish";
    const ref = publishing ? "main" : workflowRef;
    const fullRef = publishing ? "refs/heads/main" : workflowFullRef;
    const workflowName = {
      publish: "linux-app-release",
      mirror: "linux-app-mirror",
      "finalize-core": "openclaw-release-publish",
    }[mode];
    Object.assign(current.authority, {
      writerRef: ref,
      writerFullRef: fullRef,
      writerPath: `.github/workflows/${workflowName}.yml`,
      writerEvent: publishing ? "workflow_run" : "workflow_dispatch",
    });
    if (publishing) {
      current.authority.requestTag = releaseTag;
    }
    flags({
      "tooling-sha": toolingSha,
      "workflow-ref": ref,
      "workflow-full-ref": fullRef,
      ...(publishing
        ? { "request-run-id": "43", "request-run-attempt": "1" }
        : {
            "release-publish-run-id": "42",
            "release-publish-run-attempt": "1",
            "release-publish-ref": workflowRef,
            "release-publish-full-ref": workflowFullRef,
          }),
    });
    if (mode === "finalize-core") {
      if (latest !== undefined) {
        args.push("--latest", latest);
      }
    } else {
      args.push("--public-key-config", config);
    }
    if (mode === "publish") {
      args.push("--desktop-test", String(desktop), "--windows", String(windows));
      if (!publicOnly) {
        args.push("--assets", inputs(releaseTag), "--signature", signaturePath);
      }
    }
    return withEnv(
      {
        GITHUB_RUN_ID: "44",
        GITHUB_RUN_ATTEMPT: "1",
      },
      () =>
        runLinuxAppChannel(args, {
          runCommand: (binary: string, commandArgs: string[]): string =>
            compiledCommandFixture(fixtureRequire, binary, commandArgs, current, replaceAsset),
          report: () => {},
        }),
    );
  };
  const release = (releaseTag = tag) => releaseFrom(state(), releaseTag);
  const asset = (releaseTag: string, name: string) =>
    release(releaseTag).assets.find((entry) => entry.name === name);
  const bytes = (releaseTag: string, name = "latest.json") => {
    const entry = asset(releaseTag, name);
    assert.ok(entry, `Missing fixture asset ${releaseTag}/${name}`);
    return Buffer.from(entry.bytes, "base64");
  };
  const calls = (tool: string, filter: Partial<Call> = {}) =>
    state().calls.filter(
      (call) =>
        call.tool === tool &&
        Object.entries(filter).every(([key, value]) => Reflect.get(call, key) === value),
    );
  const mutations = (filter: Partial<Call> = {}) =>
    calls("gh", filter).filter((call) => mutationActions.has(call.action));
  const actionsSince = (index: number) =>
    mutations()
      .slice(index)
      .map((call) => call.action);
  const replace = (releaseTag: string, name: string, value: Buffer) =>
    replaceAsset(current, releaseTag, name, value);
  return {
    state,
    update,
    addRelease,
    addDraft,
    inputs,
    seedLegacy,
    run,
    bytes,
    mutations,
    actionsSince,
    release,
    calls,
    asset,
    replace,
  };
}

function published({
  desktop = false,
  windows = false,
  advance = false,
  ...overrides
}: Partial<State> & { desktop?: boolean; windows?: boolean; advance?: boolean } = {}) {
  const f = fixture({}, toolingRef, desktop, windows);
  f.run("publish");
  if (advance) {
    f.addRelease(nextTag, true);
  }
  if (Object.keys(overrides).length) {
    f.update(overrides);
  }
  return f;
}

function failed(run: () => unknown, message?: string) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof Error);
    if (message !== undefined) {
      expect(error.message).toContain(message);
    }
    return error;
  }
  throw new Error("Expected publication to fail");
}

it("reuses complete public Linux assets without local build inputs", () => {
  const f = fixture({ publicDownloadCache: {} });
  const original = f.seedLegacy();
  const assetIds = new Set(f.release().assets.map((entry) => entry.id));
  expect(f.run("publish", tag, undefined, true)).toMatchObject({ state: "published" });
  const manifest = JSON.parse(f.bytes(tag, linuxName(tag)).toString());
  expect(manifest).toMatchObject(JSON.parse(original.toString()));
  expect(f.release().assets.filter((entry) => assetIds.has(entry.id))).toHaveLength(3);
  expect(
    f
      .mutations({ action: "upload" })
      .filter((entry) => [appimageName, "OpenClaw-2026.9.3-amd64.deb"].includes(entry.name ?? "")),
  ).toEqual([]);
  expect(f.calls("minisign")).not.toEqual([]);
  f.addRelease(nextTag, true);
  f.run("publish", nextTag);
  const advanced = f.bytes(nextTag, linuxName(nextTag));
  expect(f.bytes(channel)).toEqual(advanced);
  expect(f.bytes(nextTag)).toEqual(advanced);
});

it("retains partial canonical replacement when the executing writer is cancelled after deletion", () => {
  const f = published({ advance: true, calls: [], authorityAfterDelete: "cancel-writer" });
  failed(() => f.run("publish", nextTag), "release workflow run status");
  expect(f.asset(channel, "latest.json")).toBeUndefined();
  const mutations = f.mutations();
  expect(mutations.at(-1)).toMatchObject({ action: "DELETE", tag: channel, name: "latest.json" });
});

it.each<AuthorityChange>(["new-parent-attempt", "revoke-tooling", "move-tooling"])(
  "refuses the next mirror write when authority changes during a public read: %s",
  (change) => {
    const f = published({
      advance: true,
      authorityAfterDownload: { tag: channel, name: "latest.json", change },
    });
    const before = f.mutations().length;
    failed(() => f.run("mirror", nextTag));
    expect(f.state().calls.some((call) => call.action === change)).toBe(true);
    expect(f.mutations()).toHaveLength(before);
  },
);

it("retains a partial legacy replacement when the parent is cancelled after DELETE", () => {
  const f = published({ advance: true });
  const old = f.bytes(channel);
  f.run("publish", nextTag);
  const core = "v2026.9.5";
  f.addRelease(core, true);
  f.update((state) => {
    replaceAsset(state, core, "latest.json", old);
    state.authorityAfterDelete = "cancel-parent";
  });
  const before = f.mutations().length;
  failed(() => f.run("mirror", core));
  expect(f.actionsSince(before)).toEqual(["DELETE"]);
  expect(f.release(core).assets).toEqual([]);
  expect(f.bytes(channel)).not.toEqual(old);
});

it("refuses channel note edits after authority changes in upload readback", () => {
  const f = published({ advance: true });
  f.update((state) => {
    releaseFrom(state, channel).body = "Previous channel notes";
    state.authorityAfterDownload = { tag: nextTag, name: "latest.json", change: "cancel-parent" };
  });
  const before = f.mutations().length;
  failed(() => f.run("mirror", nextTag));
  expect(f.actionsSince(before)).toEqual(["upload"]);
  expect(f.release(channel).body).toBe("Previous channel notes");
});

it.each([
  [false, appimageName, channel],
  [true, "latest.json", "desktop-test"],
] satisfies [boolean, string, string][])(
  "stops publication after request revocation at %s/%s before creating %s",
  (desktop, name, absentChannel) => {
    const f = fixture(
      { authorityAfterDownload: { tag, name, change: "new-request-attempt" } },
      toolingRef,
      desktop,
    );
    failed(() => f.run("publish"));
    const calls = f.state().calls;
    const revoked = calls.findIndex((call) => call.action === "new-request-attempt");
    expect(revoked).toBeGreaterThan(-1);
    expect(calls.slice(revoked + 1).filter((call) => mutationActions.has(call.action))).toEqual([]);
    expect(f.mutations({ tag: absentChannel })).toEqual([]);
    expect(f.state().releases.some((release) => release.tag_name === absentChannel)).toBe(false);
  },
);

it("refuses finalizer PATCH after publisher authority changes during source reads", () => {
  const f = fixture({ authorityAfterSourceRead: { tag: nextTag, change: "cancel-parent" } });
  f.addDraft(nextTag);
  failed(() => f.run("finalize-core", nextTag, "true"));
  expect(f.state().calls.some((call) => call.action === "cancel-parent")).toBe(true);
  expect(f.mutations()).toEqual([]);
  expect(f.release(nextTag).draft).toBe(true);
});

it.each(["v2026.9.4-alpha.1", nextTag])(
  "rejects a retired alpha workflow when finalizing %s before writes",
  (releaseTag) => {
    const f = fixture({}, "tideclaw/alpha/2026-09-13-0400Z");
    f.addDraft(releaseTag, releaseTag.includes("-alpha."));
    failed(() => f.run("finalize-core", releaseTag, "false"), "Alpha releases are retired;");
    expect(f.mutations()).toEqual([]);
  },
);

it("publishes Windows with regular Linux bundles and reuses its immutable bytes", () => {
  const f = published({ windows: true });
  expect(f.bytes("windows-stable", "latest-windows.json")).toEqual(
    f.bytes(tag, "latest-windows.json"),
  );
  const metadata = JSON.parse(f.bytes("windows-stable", "latest-windows.json").toString());
  expect(Object.keys(metadata.platforms)).toEqual(["windows-x86_64"]);
  expect(metadata.platforms["windows-x86_64"].url).toBe(
    `https://github.com/openclaw/openclaw/releases/download/${tag}/OpenClaw-${tag.slice(1)}-windows-x86_64.exe`,
  );
  expect(f.state().releases.some((release) => release.tag_name === "desktop-test")).toBe(false);
  const writes = f.mutations().length;
  f.run("publish", tag, undefined, true);
  expect(f.mutations()).toHaveLength(writes);
});

it.each(["withdrawn", "replaced", "linux-missing"] as const)(
  "advances past a previous publication whose Windows companion was %s",
  (change) => {
    const f = published({ windows: true });
    const exe = "OpenClaw-2026.9.3-windows-x86_64.exe";
    f.update((state) => {
      const release = releaseFrom(state, tag);
      if (change === "withdrawn") {
        release.assets = release.assets.filter((entry) => entry.name !== exe);
      } else if (change === "replaced") {
        replaceAsset(state, tag, exe, Buffer.from("other bytes\n"));
      } else {
        release.assets = release.assets.filter(
          (entry) => entry.name !== "OpenClaw-2026.9.3-amd64.deb",
        );
      }
      state.calls = [];
    });
    f.addRelease(nextTag, true);
    const previousChannel = f.bytes(channel);
    const run = () => f.run("publish", nextTag);
    if (change === "withdrawn") {
      run();
      expect(f.bytes(channel)).toEqual(f.bytes(nextTag, linuxName(nextTag)));
    } else {
      failed(run, "Published Linux asset changed");
      expect(f.bytes(channel)).toEqual(previousChannel);
    }
  },
);

it("completes an interrupted Windows publication only from matching signed local inputs", () => {
  const f = published({ windows: true, advance: true });
  // Canonical readback lag stops the publisher after the bundles and canonical
  // manifest land, before the Windows manifest and legacy mirror are written.
  f.update({
    staleAfterUpload: staleFeed(channel, {
      bytes: f.bytes(channel).toString("base64"),
      remaining: 100,
    }),
  });
  failed(() => f.run("publish", nextTag), "Public asset digest mismatch");
  f.update((state) => {
    delete state.staleDownloads;
    state.calls = [];
  });
  const bundles = f.release(nextTag).assets;
  expect(bundles.map((entry) => entry.name)).not.toContain("latest-windows.json");
  failed(
    () => f.run("publish", nextTag, undefined, true),
    "Public Windows updater manifest is missing",
  );

  const exe = join(f.inputs(nextTag), "OpenClaw-2026.9.4-windows-x86_64.exe");
  const signed = readFileSync(exe);
  writeFileSync(exe, "rebuilt bytes\n");
  failed(() => f.run("publish", nextTag), "Bundle checksum inventory mismatch");
  writeChecksums(f.inputs(nextTag));
  failed(() => f.run("publish", nextTag), "Immutable asset conflict");
  expect(f.mutations()).toEqual([]);

  writeFileSync(exe, signed);
  writeFileSync(
    join(f.inputs(nextTag), "SHA256SUMS.linux-app.txt"),
    f.bytes(nextTag, "SHA256SUMS.linux-app.txt"),
  );
  f.run("publish", nextTag);
  expect(f.mutations({ action: "upload" }).filter(isBundle)).toEqual([]);
  expect(f.release(nextTag).assets).toEqual(expect.arrayContaining(bundles));
  expect(f.bytes(nextTag, "latest-windows.json")).toEqual(
    readFileSync(join(f.inputs(nextTag), "latest-windows.json")),
  );
  expect(f.bytes("windows-stable", "latest-windows.json")).toEqual(
    f.bytes(nextTag, "latest-windows.json"),
  );
  expect(f.bytes(nextTag)).toEqual(f.bytes(channel));
});

it.each([
  [false, { verifierExit: 1 }],
  [true, { verifierRejectSuffix: ".exe" }],
] satisfies [boolean, Partial<State>][])(
  "requires signature verification before publication (Windows=%s)",
  (windows, rejection) => {
    const f = fixture(rejection, toolingRef, false, windows);
    failed(() => f.run("publish"), "fixture signature verification refused");
    if (!windows) {
      expect(f.calls("minisign")).toHaveLength(1);
    }
    expect(f.mutations()).toEqual([]);
  },
);

it("publishes opt-in desktop metadata only after successful Linux and legacy readback", () => {
  const f = published({ desktop: true });
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
  expect(f.release("desktop-test").source).toBe(sourceSha(tag));
});

it.each(["newer channel", "revoked before delete", "revoked after delete"])(
  "preserves desktop channel identity and next-write authority: %s",
  (scenario) => {
    const f = fixture({}, toolingRef, true);
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
    const revoked = scenario.startsWith("revoked");
    if (revoked) {
      failed(() => f.run("publish"));
    } else {
      f.run("publish");
    }
    const writes = f.mutations({ tag: "desktop-test" });
    if (revoked) {
      expect(f.state().calls.some((call) => call.action === "new-request-attempt")).toBe(true);
    }
    if (scenario === "revoked after delete") {
      expect(writes).toEqual([expect.objectContaining({ action: "DELETE" })]);
      expect(f.release("desktop-test").assets).toEqual([]);
    } else {
      expect(writes).toEqual([]);
      expect(f.bytes("desktop-test", "latest-desktop-test.json").toString()).toBe(previous);
    }
    expect(f.release("desktop-test").source).toBe("d".repeat(40));
  },
);

it.each(["Linux first", "core first"])("converges when publishing %s", (order) => {
  const f = published();
  if (order === "Linux first") {
    const previousAssets = f.release().assets;
    f.addDraft(nextTag);
    expect(f.run("finalize-core", nextTag, "false")).toMatchObject({
      madeLatest: false,
      latestTag: tag,
    });
    failed(() => f.run("publish", nextTag), "Canonical Linux version is newer than core latest");
    expect(f.release().assets).toEqual(previousAssets);
    const immutable = f.bytes(nextTag, linuxName(nextTag));
    expect(f.bytes(channel)).toEqual(immutable);
    expect(f.state().latest).toBe(tag);

    f.update({ calls: [] });
    const beforeMirror = f.state().releases;
    failed(() => f.run("mirror"), "Canonical Linux version is newer than core latest");
    expect(f.mutations()).toEqual([]);
    expect(f.state().releases).toEqual(beforeMirror);

    const nativeAssets = f.release(nextTag).assets;
    expect(f.run("finalize-core", nextTag, "true")).toMatchObject({
      madeLatest: true,
      latestTag: nextTag,
    });
    f.update({ calls: [] });
    f.run("mirror", nextTag);
    expect(f.release(nextTag).assets.filter((asset) => asset.name !== "latest.json")).toEqual(
      nativeAssets,
    );
    expect(f.bytes(channel)).toEqual(immutable);
    expect(f.calls("minisign")).toEqual([]);
    expect(f.calls("curl").every((call) => call.name?.endsWith(".json"))).toBe(true);
  } else {
    f.addRelease(nextTag);
    f.update({ latest: nextTag });
    f.run("mirror", nextTag);
    expect(JSON.parse(f.bytes(nextTag).toString())).toMatchObject({
      version: "2026.9.3",
    });
    f.run("publish", nextTag);
  }
  const manifest = f.bytes(nextTag, linuxName(nextTag));
  expect(f.bytes(channel)).toEqual(manifest);
  expect(f.bytes(nextTag)).toEqual(manifest);
});

it("rejects same-version canonical bytes that differ from the immutable publication", () => {
  const f = published();
  const changed = Buffer.concat([f.bytes(channel), Buffer.from("\n")]);
  f.replace(channel, "latest.json", changed);
  f.update({ calls: [] });
  failed(() => f.run("publish"), "Canonical bytes differ from the immutable Linux publication");
  expect(f.mutations()).toEqual([]);
});

it("keeps a newer canonical version when replaying an older Linux publication", () => {
  const f = published({ advance: true });
  f.run("publish", nextTag);
  const newer = f.bytes(channel);
  expect(f.run("publish")).toMatchObject({ state: "kept-newer-channel" });
  expect(f.bytes(channel)).toEqual(newer);
  expect(f.bytes(nextTag)).toEqual(newer);
});

it("rejects corrupted public bundle readback before publishing channel metadata", () => {
  const f = fixture({ fault: { point: "upload-readback", tag, name: appimageName } });
  failed(() => f.run("publish"), "Public asset digest mismatch");
  expect(f.state().releases.some((release) => release.tag_name === channel)).toBe(false);
  expect(f.calls("curl")).toHaveLength(1);
  expect(f.calls("sleep")).toEqual([]);
});

it("does not adopt a replacement release ID between immutable bundle uploads", () => {
  const name = appimageName;
  const f = fixture({ replaceReleaseAfterDownload: { tag, name } });
  const originalId = f.release().id;
  failed(() => f.run("publish"), "Release identity changed before write");
  expect(f.state().calls).toContainEqual({ tool: "fixture", action: "replace-release", tag });
  expect(f.release().id).not.toBe(originalId);
  expect(f.release().assets).toEqual([]);
  expect(f.mutations()).toEqual([{ tool: "gh", action: "upload", tag, name }]);
});

it.each([
  ["versioned-only", tag, linuxName(tag)],
  ["canonical", channel, "latest.json"],
])(
  "preserves the %s upload after ACK loss and reconciles only a complete channel",
  (_, owner, name) => {
    const f = fixture({ fault: { point: "upload-after", tag: owner, name } });
    failed(() => f.run("publish"), "fixture lost upload acknowledgement");
    const retained = f.asset(owner, name);
    assert.ok(retained);
    const writes = f.mutations();
    if (owner === tag) {
      expect(f.release(channel).assets).toEqual([]);
      failed(() => f.run("publish"), "Missing channel metadata is not a new channel");
      expect(f.release(channel).assets).toEqual([]);
      expect(f.mutations()).toEqual(writes);
    } else {
      f.run("publish");
      expect(f.bytes(tag)).toEqual(f.bytes(channel));
      expect(f.calls("gh", { action: "upload", tag: owner, name })).toHaveLength(1);
    }
    expect(f.asset(owner, name)).toEqual(retained);
  },
);

it("reports an interrupted legacy replacement and reconciles it without rebuilding", () => {
  const f = published({ advance: true });
  const canonical = f.bytes(channel);
  f.update((state) => {
    const original = legacyManifest();
    replaceAsset(state, tag, "latest.json", original);
    replaceAsset(state, nextTag, "latest.json", original);
    state.fault = { point: "upload-before", tag: nextTag, name: "latest.json" };
    state.calls = [];
  });
  failed(() => f.run("mirror", nextTag), "fixture upload refused");
  expect(f.release(nextTag).assets).toEqual([]);
  expect(f.bytes(channel)).toEqual(canonical);
  expect(f.run("mirror", nextTag)).toMatchObject({ state: "mirrored" });
  expect(f.bytes(nextTag)).toEqual(canonical);
  expect(f.calls("minisign")).toEqual([]);
});

it("keeps normal publish and mirror fail-closed after canonical deletion interrupts promotion", () => {
  const f = published({ advance: true });
  const previous = f.bytes(channel);
  f.update({ fault: { point: "upload-before", tag: channel, name: "latest.json" }, calls: [] });
  failed(() => f.run("publish", nextTag), "fixture upload refused");
  const retained = f.bytes(nextTag, linuxName(nextTag));
  expect(f.mutations()).toContainEqual({
    tool: "gh",
    action: "DELETE",
    tag: channel,
    name: "latest.json",
    url: expect.stringMatching(/^releases\/assets\/\d+$/),
  });
  expect(f.release(channel).assets).toEqual([]);
  expect(f.bytes(tag)).toEqual(previous);
  f.update({ calls: [] });
  for (const [mode, message] of [
    ["publish", "Missing channel metadata is not a new channel"],
    ["mirror", "Linux channel manifest is missing"],
  ] as const) {
    failed(() => f.run(mode, nextTag), message);
    expect(f.mutations()).toEqual([]);
    expect(f.release(channel).assets).toEqual([]);
    expect(f.bytes(nextTag, linuxName(nextTag))).toEqual(retained);
  }
});

it.each(["delete", "upload"] as const)("rejects a latest-selector change after %s", (effect) => {
  const f = published({ advance: true });
  f.update((state) => {
    if (effect === "delete") {
      const original = legacyManifest();
      replaceAsset(state, tag, "latest.json", original);
      replaceAsset(state, nextTag, "latest.json", original);
      state.latestAfterDelete = tag;
      state.calls = [];
    } else {
      state.latestAfterUpload = tag;
    }
  });
  failed(
    () => f.run("mirror", nextTag),
    `Core latest changed ${effect === "delete" ? "before" : "after"} mirror`,
  );
  if (effect === "delete") {
    expect(f.state().calls.filter((call) => call.action === "upload")).toEqual([]);
  }
  expect(f.state().latest).toBe(tag);
});

it("does not mutate a selected core release that is no longer latest", () => {
  const f = published({ advance: true, calls: [] });
  expect(f.run("mirror")).toEqual({ state: "skipped-not-latest", tag });
  expect(f.mutations()).toEqual([]);
});

it.each(["asset replaced", "source changed", "draft release"])(
  "rejects publisher identity drift: %s",
  (change) => {
    const f = published();
    const appimage = f.bytes(tag, appimageName);
    f.update((state) => {
      if (change === "asset replaced") {
        replaceAsset(state, tag, appimageName, appimage);
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
    failed(() => f.run("mirror"), message);
    expect(f.mutations()).toEqual([]);
  },
);

it.each([
  [nextTag, false, "true", null, true],
  ["v2026.8.35", false, "false", tag, false],
  ["v2026.9.4-beta.1", true, "false", tag, false],
  [tag, false, "true", nextTag, false],
] satisfies [string, boolean, string, string | null, boolean][])(
  "finalizes %s (prerelease=%s latest=%s previous=%s madeLatest=%s)",
  (releaseTag, prerelease, latest, previousTag, madeLatest) => {
    const f = fixture();
    const selected = releaseTag === tag ? f.release() : f.addDraft(releaseTag, prerelease);
    if (previousTag === nextTag) {
      f.addRelease(nextTag, true);
    } else if (previousTag === null) {
      f.update({ latest: null });
    }
    const expectedLatest = previousTag && !madeLatest ? f.release(previousTag) : selected;
    expect(f.run("finalize-core", releaseTag, latest)).toEqual({
      state: "finalized",
      tag: releaseTag,
      releaseId: selected.id,
      sourceSha: selected.source,
      madeLatest,
      latestReleaseId: expectedLatest.id,
      latestTag: expectedLatest.tag_name,
    });
    expect(f.release(releaseTag)).toMatchObject({ draft: false, prerelease });
    expect(f.state().latest).toBe(expectedLatest.tag_name);
    expect(f.mutations()).toEqual([patchCall(selected, madeLatest)]);
    expect(f.state().calls.every((call) => call.tool === "gh")).toBe(true);
    expect(f.state().releases.some((entry) => entry.tag_name === channel)).toBe(false);
  },
);

it("requires explicit latest intent before finalization", () => {
  const f = fixture();
  failed(() => f.run("finalize-core", nextTag), "Expected explicit core latest intent");
  expect(f.state().calls).toEqual([]);
});

it("rejects an unapproved draft tag before finalization", () => {
  const f = fixture({ releaseResponseTag: { tag: nextTag, value: "v2026.9.5" } });
  f.addDraft();
  failed(
    () => f.run("finalize-core", nextTag, "true"),
    "Selected core release identity is invalid",
  );
  expect(f.mutations()).toEqual([]);
  expect(f.release(nextTag).draft).toBe(true);
});

it.each([
  [nextTag, { kind: "replace-release", tag: nextTag }, "HTTP 404: release not found"],
  [nextTag, { kind: "move-tag", tag: nextTag }, "Selected core tag moved"],
  [tag, { kind: "select-latest", tag: "v2026.9.5" }, "Core latest changed before finalization"],
  [tag, { kind: "move-tag", tag }, "Core latest tag moved"],
  [null, { kind: "replace-release", tag: nextTag }, "Finalized core release identity mismatch"],
  [null, { kind: "move-tag", tag: nextTag }, "Finalized core tag moved"],
  [null, { kind: "select-latest", tag }, "Core latest readback mismatch"],
] satisfies [string | null, Transition, string][])(
  "rejects finalization drift at %s: %j (%s)",
  (trigger, change, message) => {
    const f = fixture(
      trigger === null ? { afterPatch: change } : { afterSourceRead: { tag: trigger, change } },
    );
    const draft = f.addDraft();
    f.addRelease("v2026.9.5");
    failed(() => f.run("finalize-core", nextTag, "true"), message);
    expect(trigger === null ? f.state().afterPatch : f.state().afterSourceRead).toBeUndefined();
    expect(f.state().calls).toContainEqual({
      tool: "fixture",
      action: change.kind,
      tag: change.tag,
    });
    expect(f.mutations()).toEqual(trigger === null ? [patchCall(draft)] : []);
  },
);

it.each(["canonical", "canonical reread", "existing feed reread", "legacy asset", "latest alias"])(
  "waits for stale %s feed bytes without repeating publication",
  (surface) => {
    const f = published({ advance: true });
    const bundles = f.release().assets.filter(isBundle);
    const publishing = surface.startsWith("canonical") || surface === "existing feed reread";
    const target = publishing ? channel : nextTag;
    f.update((state) => {
      state.calls = [];
      const stale = staleFeed(target, {
        skip: surface.endsWith("reread") ? 1 : 0,
        legacy: surface === "latest alias",
      });
      if (surface === "latest alias" || surface === "existing feed reread") {
        state.staleDownloads = [stale];
      } else {
        state.staleAfterUpload = stale;
      }
    });
    f.run(publishing ? "publish" : "mirror", nextTag);
    expect(f.calls("sleep")).toHaveLength(2);
    expect(f.mutations({ action: "upload", tag: target, name: "latest.json" })).toHaveLength(1);
    expect(f.release().assets.filter(isBundle)).toEqual(bundles);
    expect(f.calls("minisign")).toHaveLength(publishing ? 1 : 0);
  },
);

it("recovers API-confirmed metadata readback beyond the former convergence window", () => {
  // Four stale responses exhaust the former convergence window.
  const f = published({ advance: true });
  const stale = staleFeed(nextTag, { remaining: 4 });
  f.update((state) => {
    state.calls = [];
    state.staleAfterUpload = stale;
  });
  expect(f.run("mirror", nextTag)).toMatchObject({ state: "mirrored" });
  expect(stale.remaining).toBe(0);
  const waits = f.calls("sleep").map((call) => call.delay ?? 0);
  const waited = waits.reduce((total, delay) => total + delay, 0);
  expect(waited).toBeGreaterThan(17);
  expect(waited).toBeLessThanOrEqual(120);
  expect(f.mutations({ action: "upload", tag: nextTag, name: "latest.json" })).toHaveLength(1);
});

it.each(["stale public bytes", "wrong uploaded bytes", "asset replaced"])(
  "stops feed readback on %s with no repeat upload",
  (failure) => {
    const f = published({ advance: true });
    const staleBytes = legacyManifest("v2026.9.2");
    f.update((state) => {
      state.calls = [];
      if (failure === "wrong uploaded bytes") {
        state.wrongUpload = { tag: nextTag, name: "latest.json" };
      } else {
        state.staleAfterUpload = staleFeed(nextTag, { remaining: 100 });
        if (failure === "asset replaced") {
          state.replaceReleaseAfterDownload = { tag: nextTag, name: "latest.json" };
        }
      }
    });
    const error = failed(
      () => f.run("mirror", nextTag),
      failure === "wrong uploaded bytes"
        ? "Uploaded asset digest mismatch"
        : failure === "asset replaced"
          ? "HTTP 404: asset not found"
          : "Public asset digest mismatch",
    );
    expect(f.mutations({ action: "upload" })).toEqual([
      { tool: "gh", action: "upload", tag: nextTag, name: "latest.json" },
    ]);
    expect(f.calls("minisign")).toEqual([]);
    if (failure === "stale public bytes") {
      const uploaded = f.asset(nextTag, "latest.json");
      assert.ok(uploaded);
      expect(error.message).toContain(`asset=${uploaded.id}`);
      expect(error.message).toContain(`expected=${hash(f.bytes(channel))}`);
      expect(error.message).toContain(`observed=${hash(staleBytes)}`);
      const waits = f.calls("sleep").map((call) => call.delay ?? 0);
      expect(waits.reduce((total, delay) => total + delay, 0)).toBe(120);
    } else if (failure === "wrong uploaded bytes") {
      expect(f.calls("sleep")).toEqual([]);
    }
  },
);

it("does not converge stale feed bytes without an API digest", () => {
  const f = published();
  f.update((state) => {
    const asset = releaseFrom(state, channel).assets.find((entry) => entry.name === "latest.json");
    assert.ok(asset);
    delete asset.digest;
    state.calls = [];
    state.staleDownloads = [staleFeed(channel)];
  });
  failed(() => f.run("publish"), "Public asset digest mismatch");
  expect(f.calls("sleep")).toEqual([]);
  expect(f.mutations()).toEqual([]);
});
