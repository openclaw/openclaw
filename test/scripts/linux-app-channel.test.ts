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
      answer();
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
      const owner = release(tag);
      const response = { object: { type: "commit", sha: owner.source } };
      if (state.afterSourceRead?.tag === tag) {
        const change = state.afterSourceRead.change;
        delete state.afterSourceRead;
        transition(change);
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

function fixture() {
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
    const names = [`OpenClaw-${version}-amd64.AppImage`, `OpenClaw-${version}-amd64.deb`];
    const checksums = names.map((name) => {
      const bytes = Buffer.from(`fixture bytes: ${name}\n`);
      writeFileSync(join(directory, name), bytes);
      return `${hash(bytes)}  ./${name}`;
    });
    writeFileSync(join(directory, "SHA256SUMS.linux-app.txt"), `${checksums.join("\n")}\n`);
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
  const run = (mode: "publish" | "mirror" | "finalize-core", releaseTag = tag, latest?: string) => {
    const args = [cli, mode, "--tag", releaseTag, "--source-sha", sourceSha(releaseTag)];
    if (mode === "finalize-core") {
      if (latest !== undefined) {
        args.push("--latest", latest);
      }
    } else {
      args.push("--public-key-config", config);
    }
    if (mode === "publish") {
      args.push(
        "--assets",
        inputs(releaseTag),
        "--signature",
        signaturePath,
        "--tooling-sha",
        "b".repeat(40),
        "--desktop-test",
        "false",
      );
    }
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${dirname(process.execPath)}`,
        HOME: root,
        TMPDIR: root,
        CHANNEL_FIXTURE_STATE: statePath,
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

it.each(["Linux first", "core first"])("converges when publishing %s", (order) => {
  const f = fixture();
  succeeded(f.run("publish"));
  f.addRelease(nextTag);
  if (order === "Linux first") {
    succeeded(f.run("publish", nextTag));
    f.update((state) => {
      state.latest = nextTag;
    });
    succeeded(f.run("mirror", nextTag));
  } else {
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
