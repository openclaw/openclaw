import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitWorker from "../../infra/git-worker.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import * as publicationSnapshot from "../github-repository-publication-snapshot.js";
import type { GitHubRepositoryPublicationSnapshot } from "../github-repository-publication-snapshot.js";
import {
  captureWorkspaceSnapshot,
  prepareWorkspaceStageInput,
} from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { workspaceResultGitCommand } from "./workspace-result-git.js";
import { buildWorkspaceStageInput } from "./workspace-result-preparation.runtime.js";
import {
  readStagedWorkerWorkspaceResult,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const baseCommit = "a".repeat(40);
const currentManifestRef = "sha256:" + "b".repeat(64);
const candidate = (name: string) => "refs/openclaw/worker-result-candidates/" + name;
const digest = (content: string | Uint8Array) =>
  "sha256:" + createHash("sha256").update(content).digest("hex");
const blobId = (content: Buffer) =>
  createHash("sha1")
    .update("blob " + content.byteLength + "\0")
    .update(content)
    .digest("hex");
const emptyManifestRaw = serializeWorkerWorkspaceManifest({
  version: 1,
  baseCommit: null,
  entries: [],
});
type PublicationEntry = GitHubRepositoryPublicationSnapshot["entries"][number];
const binding = (publication: { currentManifestRef: string; publicationDigest: string }) =>
  JSON.stringify({
    currentManifestRef: publication.currentManifestRef,
    publicationDigest: publication.publicationDigest,
  });
const write = (root: string, name: string, bytes: string | Buffer) =>
  fs.writeFile(path.join(root, name), bytes, { mode: 0o600 });
const blobPath = (root: string, sha: string) => path.join(root, "blobs", sha);
const changedBlob = "blob changed after checkpoint capture";
type InvalidPublicationCase = {
  fault: string;
  blob?: "missing" | "substituted" | "symlink" | "hardlink";
  error?: string | RegExp;
  code?: string;
  metadata?: string;
  baseCommit?: string;
  entry?: { path?: string; mode?: string };
  duplicate?: boolean;
};

async function fixture(kind: "metadata-only" | "mixed" = "mixed") {
  const stagingRoot = temporary.make("workspace-publication-source-");
  const blobs = new Map<string, Buffer>();
  const entries: PublicationEntry[] = [];
  const add = (pathname: string, mode: PublicationEntry["mode"], content: Buffer) => {
    const sha = blobId(content);
    blobs.set(sha, content);
    entries.push({ path: pathname, mode, sha });
  };
  if (kind === "mixed") {
    add("run.sh", "100755", Buffer.from("#!/bin/sh\nprintf hello\n"));
    add("copy.sh", "100644", Buffer.from("#!/bin/sh\nprintf hello\n"));
    add("link", "120000", Buffer.from("run.sh"));
    add("empty", "100644", Buffer.alloc(0));
    add("binary", "100644", Buffer.from([0, 255, 128, 13, 10, 0]));
    add("文書/é.txt", "100644", Buffer.from("雪だるま ☃\r\nemoji 🦞\n"));
  }
  entries.push(
    { path: "deleted.txt", mode: "100644", sha: null },
    { path: "submodule", mode: "160000", sha: "c".repeat(40) },
  );
  // Deliberately noncanonical JSON: preservation must not depend on parser key order.
  const metadata =
    " \n" +
    JSON.stringify(
      { entries, workspaceTree: "d".repeat(40), version: 1, baseTree: "e".repeat(40), baseCommit },
      null,
      2,
    ) +
    "\n\t";
  const publication = {
    metadata,
    publicationDigest: digest(metadata),
    currentManifestRef,
    baseCommit,
  };
  await fs.mkdir(path.join(stagingRoot, "blobs"), { mode: 0o700 });
  await write(stagingRoot, "snapshot.json", metadata);
  for (const [sha, bytes] of blobs) {
    await write(stagingRoot, "blobs/" + sha, bytes);
  }
  const contents = new Map<string, Buffer>([
    ["snapshot.json", Buffer.from(metadata)],
    ["binding.json", Buffer.from(binding(publication))],
    ...[...blobs].map(([sha, bytes]): [string, Buffer] => ["blobs/" + sha, bytes]),
  ]);
  return { stagingRoot, publication, blobs, contents };
}

async function legacyPayload(f: Awaited<ReturnType<typeof fixture>>) {
  const root = temporary.make("workspace-publication-legacy-");
  // Fixture-owned bytes keep the legacy oracle independent of publication readers.
  await fs.mkdir(path.join(root, "blobs"), { mode: 0o700 });
  for (const [pathname, bytes] of f.contents) {
    await write(root, pathname, bytes);
  }
  const captured = await captureWorkspaceSnapshot({ root, baseCommit: null });
  return {
    stagingRoot: root,
    baseManifestRaw: emptyManifestRaw,
    baseManifestRef: digest(emptyManifestRaw),
    currentManifestRaw: captured.rawManifest,
    currentManifestRef: captured.manifestRef,
  };
}

async function sourceInventory(root: string) {
  const entries = [];
  for (const relative of ["", ...(await fs.readdir(root, { recursive: true })).toSorted()]) {
    const absolute = path.join(root, relative);
    const stat = await fs.lstat(absolute, { bigint: true });
    entries.push({
      relative,
      mode: stat.mode,
      ino: stat.ino,
      nlink: stat.nlink,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      bytes: stat.isFile() ? await fs.readFile(absolute) : undefined,
    });
  }
  return entries;
}

async function gitRaw(root: string, args: string[]) {
  const result = await runUtf8CommandWithTimeout(workspaceResultGitCommand(root, args), {
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
  });
  expect(result, result.stderr).toMatchObject({ termination: "exit", code: 0 });
  return result.stdout;
}

async function stagedContents(
  snapshot: Awaited<ReturnType<typeof readStagedWorkerWorkspaceResult>>,
) {
  const contents = new Map<string, Buffer>();
  for await (const { entry, content } of snapshot.readEntries()) {
    expect(entry).toMatchObject({ type: "file", mode: 0o644 });
    expect(content).toBeDefined();
    contents.set(entry.path, Buffer.from(content!));
  }
  return contents;
}

it.each(["metadata-only", "mixed"] as const)(
  "imports the exact legacy companion artifact across the real worker boundary (%s)",
  async (kind) => {
    const f = await fixture(kind);
    if (kind === "mixed") {
      const orphan = Buffer.from("unlisted blob must not enter the companion");
      await fs.writeFile(blobPath(f.stagingRoot, blobId(orphan)), orphan);
      await fs.writeFile(path.join(f.stagingRoot, "binding.json"), "untrusted unlisted binding");
      await fs.mkdir(path.join(f.stagingRoot, "unlisted"));
      await fs.writeFile(path.join(f.stagingRoot, "unlisted", "extra"), "do not copy");
    } else {
      expect(await fs.readdir(path.join(f.stagingRoot, "blobs"))).toEqual([]);
    }
    const sourceBefore = await sourceInventory(f.stagingRoot);
    const legacy = await legacyPayload(f);
    const root = temporary.make("workspace-publication-result-");
    const oldRef = candidate("legacy");
    const newRef = candidate("direct");
    const assertCurrent = vi.fn(() => {});
    // Call-through only: no worker-context bypass or fake Git input/import.
    const operations = vi.spyOn(gitWorker, "runGitWorkerOperation");
    const oldOid = await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
      root,
      ...legacy,
      stagedResultRef: oldRef,
      assertCurrent,
    });
    const newOid = await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
      root,
      stagingRoot: f.stagingRoot,
      stagedResultRef: newRef,
      publication: f.publication,
      assertCurrent,
    });
    expect(newOid).toBe(oldOid);
    expect(assertCurrent).toHaveBeenCalled();
    const stageInputs = operations.mock.calls.flatMap(([command]) =>
      command.type === "workspace.manifest.stage-input" ? [command.input] : [],
    );
    expect(stageInputs).toHaveLength(2);
    for (const input of stageInputs) {
      expect(input).not.toHaveProperty("assertCurrent");
      expect(input).not.toHaveProperty("root");
      if ("publication" in input) {
        expect(input.publication.metadata).toBeInstanceOf(Uint8Array);
        expect(input.publication.metadata.byteLength).toBe(0);
      } else {
        expect(input).toMatchObject({
          baseManifestRaw: { byteLength: 0 },
          currentManifestRaw: { byteLength: 0 },
        });
      }
    }
    const newResult = await readStagedWorkerWorkspaceResult(root, newRef);
    const { stagingRoot: _stagingRoot, ...manifests } = legacy;
    expect(newResult).toMatchObject({ ...manifests, current: { directories: ["blobs"] } });
    expect(newResult.base).toEqual({
      version: 1,
      baseCommit: null,
      directories: [],
      entries: [],
    });
    // The reader verifies tree modes against these manifest entries before exposing bytes.
    expect(await stagedContents(newResult)).toEqual(f.contents);
    const commit = await gitRaw(root, ["cat-file", "commit", newRef]);
    const separator = commit.indexOf("\n\n");
    expect(commit.slice(0, separator)).toMatch(
      /^tree [a-f0-9]{40}\nauthor OpenClaw <openclaw@localhost> 0 \+0000\ncommitter OpenClaw <openclaw@localhost> 0 \+0000$/u,
    );
    expect(commit.slice(separator + 2)).toBe(
      [
        "OpenClaw worker workspace result",
        "version 2",
        `base-ref ${legacy.baseManifestRef}`,
        `current-ref ${legacy.currentManifestRef}`,
        `base-bytes ${Buffer.byteLength(legacy.baseManifestRaw)}`,
        `current-bytes ${Buffer.byteLength(legacy.currentManifestRaw)}`,
        "",
        legacy.baseManifestRaw + legacy.currentManifestRaw,
      ].join("\n"),
    );
    expect(await gitRaw(root, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(
      newRef + " " + newOid + "\n" + oldRef + " " + oldOid + "\n",
    );
    expect(await sourceInventory(f.stagingRoot)).toEqual(sourceBefore);
  },
);

it.for<InvalidPublicationCase>([
  { fault: "digest", error: /digest/i },
  { fault: "json", metadata: "{invalid JSON" },
  { fault: "base", baseCommit: "f".repeat(40), error: /base/i },
  { fault: "path", entry: { path: "../escape" }, error: /entry/i },
  { fault: "mode", entry: { mode: "100600" }, error: /entry/i },
  { fault: "duplicate-path", duplicate: true, error: /entry/i },
  { fault: "missing", blob: "missing", code: "not-found" },
  { fault: "substituted", blob: "substituted", error: changedBlob },
  { fault: "symlink", blob: "symlink", code: "symlink" },
  { fault: "hardlink", blob: "hardlink", code: "hardlink" },
])("rejects invalid publication input: $fault", async (test, context) => {
  const { fault, blob, code, error } = test;
  // Windows link privileges and identity differ; retain the existing platform boundary.
  if (process.platform === "win32" && (fault === "symlink" || fault === "hardlink")) {
    context.skip();
    return;
  }
  const f = await fixture(blob ? "mixed" : "metadata-only");
  const publication = { ...f.publication };
  const output = temporary.make("workspace-publication-invalid-");
  let alias: { path: string; bytes: Buffer } | undefined;
  if (blob) {
    const [sha, bytes] = [...f.blobs][0]!;
    const target = blobPath(f.stagingRoot, sha);
    alias = {
      path: path.join(temporary.make("workspace-publication-alias-"), "original"),
      bytes,
    };
    await fs.writeFile(alias.path, bytes);
    await fs.rm(target);
    if (blob === "substituted") {
      await fs.writeFile(target, Buffer.alloc(bytes.length, 0x78));
    } else if (blob === "symlink") {
      await fs.symlink(alias.path, target);
    } else if (blob === "hardlink") {
      await fs.link(alias.path, target);
    }
  } else {
    const snapshot: GitHubRepositoryPublicationSnapshot = JSON.parse(publication.metadata);
    if (test.entry || test.duplicate) {
      const entry = { ...snapshot.entries[0], ...test.entry };
      publication.metadata = JSON.stringify({
        ...snapshot,
        entries: test.duplicate ? [entry, entry] : [entry],
      });
    }
    publication.metadata = test.metadata ?? publication.metadata;
    publication.baseCommit = test.baseCommit ?? publication.baseCommit;
    publication.publicationDigest =
      fault === "digest" ? "sha256:" + "0".repeat(64) : digest(publication.metadata);
  }
  const staging = prepareWorkspaceStageInput({
    stagingRoot: f.stagingRoot,
    inputPath: path.join(output, "input"),
    stagedResultRef: candidate("invalid"),
    publication,
  });
  if (code) {
    await expect(staging).rejects.toMatchObject({ code });
  } else {
    await expect(staging).rejects.toThrow(error);
  }
  expect(await fs.readdir(output)).toEqual([]);
  if (alias) {
    await expect(fs.readFile(alias.path)).resolves.toEqual(alias.bytes);
  }
});

it.each(["same-size", "removed"] as const)(
  "rejects %s blob changes between inspection and streaming without a partial input",
  async (fault) => {
    const f = await fixture("mixed");
    const [sha, bytes] = [...f.blobs][0]!;
    const target = blobPath(f.stagingRoot, sha);
    const read = publicationSnapshot.readGitHubRepositoryPublicationBlob;
    let reads = 0;
    // Only this race uses the native helper: the spy changes real on-disk bytes,
    // while both passes still use the production fs-safe/SHA-1 verifier.
    vi.spyOn(publicationSnapshot, "readGitHubRepositoryPublicationBlob").mockImplementation(
      async (root, id) => {
        if (id === sha && ++reads === 2) {
          if (fault === "removed") {
            await fs.rm(target);
          } else {
            await fs.writeFile(target, Buffer.alloc(bytes.length, 0x78));
          }
        }
        return await read(root, id);
      },
    );
    const output = temporary.make("workspace-publication-race-");
    const staging = buildWorkspaceStageInput({
      stagingRoot: f.stagingRoot,
      inputPath: path.join(output, "input"),
      stagedResultRef: candidate("changed-blob"),
      publication: {
        ...f.publication,
        metadata: new TextEncoder().encode(f.publication.metadata),
      },
    });
    if (fault === "removed") {
      await expect(staging).rejects.toMatchObject({ code: "not-found" });
    } else {
      await expect(staging).rejects.toThrow("blob changed after checkpoint capture");
    }
    expect(reads).toBe(2);
    expect(await fs.readdir(output)).toEqual([]);
  },
);
