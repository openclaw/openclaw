import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitWorker from "../../infra/git-worker.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import * as publicationSnapshot from "../github-repository-publication-snapshot.js";
import type { GitHubRepositoryPublicationSnapshot } from "../github-repository-publication-snapshot.js";
import {
  captureWorkspaceSnapshot,
  parseWorkspaceManifestPair,
  prepareWorkspaceStageInput,
} from "./workspace-manifest-worker.js";
import {
  MAX_RECONCILIATION_FILE_BYTES,
  MAX_RECONCILIATION_TOTAL_BYTES,
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
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

async function fixture(kind: "empty" | "metadata-only" | "mixed" = "mixed") {
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
  if (kind !== "empty") {
    entries.push(
      { path: "deleted.txt", mode: "100644", sha: null },
      { path: "submodule", mode: "160000", sha: "c".repeat(40) },
    );
  }
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
  await fs.writeFile(path.join(stagingRoot, "snapshot.json"), metadata, { mode: 0o600 });
  for (const [sha, bytes] of blobs) {
    await fs.writeFile(path.join(stagingRoot, "blobs", sha), bytes, { mode: 0o600 });
  }
  return { stagingRoot, publication, blobs };
}

async function legacyPayload(f: Awaited<ReturnType<typeof fixture>>) {
  const { raw, snapshot } = await publicationSnapshot.readGitHubRepositoryPublicationMetadata(
    f.stagingRoot,
    f.publication.publicationDigest,
  );
  const root = temporary.make("workspace-publication-legacy-");
  // This is the removed private-copy algorithm, confined to the golden oracle.
  // Capturing a real tree (including its empty directory) precedes ordinary staging.
  await fs.mkdir(path.join(root, "blobs"), { mode: 0o700 });
  await fs.writeFile(path.join(root, "snapshot.json"), raw, { mode: 0o600 });
  await fs.writeFile(
    path.join(root, "binding.json"),
    JSON.stringify({
      currentManifestRef: f.publication.currentManifestRef,
      publicationDigest: f.publication.publicationDigest,
    }),
    { mode: 0o600 },
  );
  const shas = new Set(
    snapshot.entries
      .filter((entry) => entry.sha !== null && entry.mode !== "160000")
      .map((entry) => entry.sha!),
  );
  for (const sha of shas) {
    const bytes = await publicationSnapshot.readGitHubRepositoryPublicationBlob(f.stagingRoot, sha);
    await fs.writeFile(path.join(root, "blobs", sha), bytes, { mode: 0o600 });
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
  expect(result.termination, result.stderr).toBe("exit");
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}

async function stagedContents(
  snapshot: Awaited<ReturnType<typeof readStagedWorkerWorkspaceResult>>,
) {
  const contents = new Map<string, Buffer>();
  for await (const { entry, content } of snapshot.readEntries()) {
    expect(entry.type).toBe("file");
    expect(entry.mode).toBe(0o644);
    expect(content).toBeDefined();
    contents.set(entry.path, Buffer.from(content!));
  }
  return contents;
}

describe("publication stage input", () => {
  it.each(["empty", "metadata-only", "mixed"] as const)(
    "imports the exact legacy companion artifact across the real worker boundary (%s)",
    async (kind) => {
      const f = await fixture(kind);
      if (kind === "mixed") {
        const orphan = Buffer.from("unlisted blob must not enter the companion");
        await fs.writeFile(path.join(f.stagingRoot, "blobs", blobId(orphan)), orphan);
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
      const stageCalls = operations.mock.calls.filter(
        ([command]) => command.type === "workspace.manifest.stage-input",
      );
      expect(stageCalls).toHaveLength(2);
      for (const [command, options] of stageCalls) {
        if (command.type !== "workspace.manifest.stage-input") {
          throw new Error("Expected the real stage-input transport");
        }
        expect(command.input).not.toHaveProperty("assertCurrent");
        expect(command.input).not.toHaveProperty("root");
        if ("publication" in command.input) {
          expect(options?.inputBytes).toBe(
            256 +
              Buffer.byteLength(f.publication.metadata) +
              (f.publication.publicationDigest.length +
                f.publication.currentManifestRef.length +
                f.publication.baseCommit.length) *
                2,
          );
          expect(command.input.publication.metadata).toBeInstanceOf(Uint8Array);
          expect(command.input.publication.metadata.byteLength).toBe(0);
        } else {
          expect(options?.inputBytes).toBe(
            256 +
              Buffer.byteLength(legacy.baseManifestRaw) +
              Buffer.byteLength(legacy.currentManifestRaw),
          );
          expect(command.input.baseManifestRaw.byteLength).toBe(0);
          expect(command.input.currentManifestRaw.byteLength).toBe(0);
        }
      }
      // Encoded worker-owned buffers transfer; caller-owned strings remain reusable.
      expect(digest(f.publication.metadata)).toBe(f.publication.publicationDigest);
      expect(digest(legacy.currentManifestRaw)).toBe(legacy.currentManifestRef);
      const oldResult = await readStagedWorkerWorkspaceResult(root, oldRef);
      const newResult = await readStagedWorkerWorkspaceResult(root, newRef);
      expect(newResult.baseManifestRaw).toBe(legacy.baseManifestRaw);
      expect(newResult.currentManifestRaw).toBe(legacy.currentManifestRaw);
      expect(newResult.baseManifestRef).toBe(legacy.baseManifestRef);
      expect(newResult.currentManifestRef).toBe(legacy.currentManifestRef);
      expect(newResult.current.directories).toEqual(["blobs"]);
      expect(newResult.base).toEqual({
        version: 1,
        baseCommit: null,
        directories: [],
        entries: [],
      });
      expect(newResult.current).toEqual(oldResult.current);
      expect(newResult.changedEntries).toHaveLength(f.blobs.size + 2);
      const expected = new Map<string, Buffer>([
        ["snapshot.json", Buffer.from(f.publication.metadata)],
        [
          "binding.json",
          Buffer.from(
            JSON.stringify({
              currentManifestRef,
              publicationDigest: f.publication.publicationDigest,
            }),
          ),
        ],
        ...[...f.blobs].map(([sha, bytes]): [string, Buffer] => ["blobs/" + sha, bytes]),
      ]);
      expect(await stagedContents(oldResult)).toEqual(expected);
      expect(await stagedContents(newResult)).toEqual(expected);
      const oldTree = await gitRaw(root, ["ls-tree", "-r", "-z", "--full-tree", oldRef]);
      expect(await gitRaw(root, ["ls-tree", "-r", "-z", "--full-tree", newRef])).toBe(oldTree);
      expect(
        oldTree
          .split("\0")
          .filter(Boolean)
          .every((entry) => entry.startsWith("100644 blob ")),
      ).toBe(true);
      const oldCommit = await gitRaw(root, ["cat-file", "commit", oldRef]);
      expect(await gitRaw(root, ["cat-file", "commit", newRef])).toBe(oldCommit);
      const separator = oldCommit.indexOf("\n\n");
      expect(oldCommit.slice(0, separator)).toMatch(
        /^tree [a-f0-9]{40}\nauthor OpenClaw <openclaw@localhost> 0 \+0000\ncommitter OpenClaw <openclaw@localhost> 0 \+0000$/u,
      );
      expect(oldCommit.slice(separator + 2)).toBe(
        "OpenClaw worker workspace result\nversion 2\n" +
          "base-ref " +
          legacy.baseManifestRef +
          "\ncurrent-ref " +
          legacy.currentManifestRef +
          "\n" +
          "base-bytes " +
          Buffer.byteLength(legacy.baseManifestRaw) +
          "\ncurrent-bytes " +
          Buffer.byteLength(legacy.currentManifestRaw) +
          "\n\n" +
          legacy.baseManifestRaw +
          legacy.currentManifestRaw,
      );
      expect(await gitRaw(root, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(
        newRef + " " + newOid + "\n" + oldRef + " " + oldOid + "\n",
      );
      expect(await sourceInventory(f.stagingRoot)).toEqual(sourceBefore);
    },
  );

  it.each(["digest", "json", "base", "path", "mode", "duplicate-path"] as const)(
    "rejects invalid publication %s before creating a Git input",
    async (fault) => {
      const f = await fixture("metadata-only");
      const publication = { ...f.publication };
      const snapshot: GitHubRepositoryPublicationSnapshot = JSON.parse(publication.metadata);
      if (fault === "json") {
        publication.metadata = "{invalid JSON";
      } else if (fault === "base") {
        publication.baseCommit = "f".repeat(40);
      } else if (fault === "path" || fault === "mode" || fault === "duplicate-path") {
        const entry = snapshot.entries[0]!;
        publication.metadata = JSON.stringify({
          ...snapshot,
          entries:
            fault === "duplicate-path"
              ? [entry, entry]
              : [
                  {
                    ...entry,
                    ...(fault === "path" ? { path: "../escape" } : { mode: "100600" }),
                  },
                ],
        });
      }
      publication.publicationDigest =
        fault === "digest" ? "sha256:" + "0".repeat(64) : digest(publication.metadata);
      const output = temporary.make("workspace-publication-invalid-");
      await expect(
        prepareWorkspaceStageInput({
          stagingRoot: f.stagingRoot,
          inputPath: path.join(output, "input"),
          stagedResultRef: candidate("invalid"),
          publication,
        }),
      ).rejects.toThrow(
        fault === "json"
          ? undefined
          : fault === "digest"
            ? /digest/i
            : fault === "base"
              ? /base/i
              : /entry/i,
      );
      expect(await fs.readdir(output)).toEqual([]);
    },
  );

  it.for(["missing", "substituted", "symlink", "hardlink"] as const)(
    "rejects a %s publication blob through the real worker reader",
    async (fault, context) => {
      // Match fs-safe.test.ts link cases: Windows link privileges/identity differ.
      if (process.platform === "win32" && (fault === "symlink" || fault === "hardlink")) {
        context.skip();
        return;
      }
      const f = await fixture("mixed");
      const [sha, bytes] = [...f.blobs][0]!;
      const target = path.join(f.stagingRoot, "blobs", sha);
      const output = temporary.make("workspace-publication-invalid-blob-");
      const outside = temporary.make("workspace-publication-alias-");
      const alias = path.join(outside, "original");
      await fs.writeFile(alias, bytes);
      await fs.rm(target);
      if (fault === "substituted") {
        await fs.writeFile(target, Buffer.alloc(bytes.length, 0x78));
      } else if (fault === "symlink") {
        await fs.symlink(alias, target);
      } else if (fault === "hardlink") {
        await fs.link(alias, target);
      }
      const staging = prepareWorkspaceStageInput({
        stagingRoot: f.stagingRoot,
        inputPath: path.join(output, "input"),
        stagedResultRef: candidate("invalid-blob"),
        publication: f.publication,
      });
      if (fault === "substituted") {
        await expect(staging).rejects.toThrow("blob changed after checkpoint capture");
      } else {
        await expect(staging).rejects.toMatchObject({
          code: fault === "missing" ? "not-found" : fault,
        });
      }
      expect(await fs.readdir(output)).toEqual([]);
      expect(await fs.readFile(alias)).toEqual(bytes);
    },
  );

  it.each(["same-size", "different-size", "removed"] as const)(
    "rejects %s blob changes between inspection and streaming without a partial input",
    async (fault) => {
      const f = await fixture("mixed");
      const [sha, bytes] = [...f.blobs][0]!;
      const target = path.join(f.stagingRoot, "blobs", sha);
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
              await fs.writeFile(
                target,
                Buffer.alloc(bytes.length + (fault === "different-size" ? 1 : 0), 0x78),
              );
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

  it("retains the reconciliation byte boundary including binding, not the larger inventory budget", async () => {
    const f = await fixture("empty");
    const binding = JSON.stringify({
      currentManifestRef,
      publicationDigest: f.publication.publicationDigest,
    });
    const file = (pathname: string, size: number): WorkerWorkspaceManifestEntry => ({
      path: pathname,
      type: "file",
      mode: 0o644,
      size,
      sha256: "a".repeat(64),
    });
    const inlineBytes = Buffer.byteLength(binding) + Buffer.byteLength(f.publication.metadata);
    const entries = [
      file("binding.json", Buffer.byteLength(binding)),
      file("snapshot.json", Buffer.byteLength(f.publication.metadata)),
      ...Array.from({ length: 12 }, (_, index) =>
        file(
          "blobs/" + index.toString(16).padStart(40, "0"),
          MAX_RECONCILIATION_FILE_BYTES - (index === 11 ? inlineBytes : 0),
        ),
      ),
    ];
    // Declared metadata exercises the canonical parser/comparator without allocating 768 MiB.
    const compare = async (values: WorkerWorkspaceManifestEntry[]) => {
      const raw = serializeWorkerWorkspaceManifest({
        version: 1,
        baseCommit: null,
        directories: ["blobs"],
        entries: values,
      });
      return await parseWorkspaceManifestPair({
        baseRaw: emptyManifestRaw,
        baseRef: digest(emptyManifestRaw),
        currentRaw: raw,
        currentRef: digest(raw),
      });
    };
    const exact = await compare(entries);
    expect(
      exact.entries.reduce((total, entry) => total + (entry.type === "file" ? entry.size : 0), 0),
    ).toBe(MAX_RECONCILIATION_TOTAL_BYTES);
    const over = entries.slice();
    const last = over.pop();
    if (last?.type !== "file") {
      throw new Error("Expected the final budget entry to be a file");
    }
    over.push({ ...last, size: last.size + 1 });
    await expect(compare(over)).rejects.toThrow("byte limit");
    // Omitting binding would incorrectly admit that one-byte-over companion.
    await expect(
      compare(over.filter((entry) => entry.path !== "binding.json")),
    ).resolves.toMatchObject({ changed: true });
  });
});
