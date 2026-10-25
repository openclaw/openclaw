import fs from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createNodeWorkspaceTransferService } from "../gateway/worker-environments/node-workspace-transfer-service.js";
import {
  startNodeWorkspaceTransferTestServer,
  transferOwner,
} from "../gateway/worker-environments/node-workspace-transfer.test-support.js";
import { MAX_WORKSPACE_INVENTORY_TOTAL_BYTES } from "../gateway/worker-environments/workspace-inventory-limits.js";
import { captureWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import { runCommandBuffered, runExec } from "../process/exec.js";
import {
  closeServer,
  digest,
  fileEntry,
  manifestFixture,
  serveTransfer,
  transferFixture,
  transferHandler,
  workspaceTransferHandler,
} from "./node-worker-transfer-client.fixture.test-support.js";
import { runNodeWorkerWorkspaceTransfer } from "./node-worker-transfer-client.js";
import { listen } from "./node-worker-transfer-client.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function git(root: string, args: string[]): Promise<string> {
  const result = await runExec("git", ["-C", root, ...args], {
    baseEnv: {
      ...process.env,
      GIT_AUTHOR_NAME: "OpenClaw Test",
      GIT_AUTHOR_EMAIL: "test@openclaw.invalid",
      GIT_COMMITTER_NAME: "OpenClaw Test",
      GIT_COMMITTER_EMAIL: "test@openclaw.invalid",
    },
    logOutput: false,
  });
  return result.stdout.trim();
}

async function pack(root: string, commit: string) {
  const packed = await runCommandBuffered(
    ["git", "-C", root, "pack-objects", "--stdout", "--revs"],
    { input: `${commit}\n`, maxOutputBytes: 4 * 1024 * 1024 },
  );
  expect(packed, packed.stderr.toString("utf8")).toMatchObject({ termination: "exit", code: 0 });
  return packed.stdout;
}

describe("node worker Git transfers", () => {
  it.each([1, 2] as const)(
    "uploads worker commits only when result v%s was negotiated",
    async (version) => {
      const root = tempDirs.make("node-worker-result-history-", process.cwd());
      const source = path.join(root, "source");
      const { workspaceDir } = transferFixture(root, "history");
      await fs.mkdir(source);
      await git(source, ["init", "--quiet", "--object-format=sha1"]);
      await fs.writeFile(path.join(source, "tracked.txt"), "dispatch base\n");
      await git(source, ["add", "."]);
      await git(source, ["commit", "--quiet", "-m", "dispatch base"]);
      const baseCommit = await git(source, ["rev-parse", "HEAD"]);
      const service = createNodeWorkspaceTransferService({
        getOwner: () => transferOwner("session"),
        temporaryRoot: path.join(root, "transfers"),
      });
      const server = await startNodeWorkspaceTransferTestServer(service);
      try {
        const prepared = await service.prepareSync({
          environmentId: "history",
          ownerEpoch: 1,
          sessionId: "session",
          localPath: source,
          isAuthorized: () => true,
        });
        const run = (transfer: Parameters<typeof runNodeWorkerWorkspaceTransfer>[0]["transfer"]) =>
          runNodeWorkerWorkspaceTransfer({
            environmentId: "history",
            workspaceDir,
            manifestHome: root,
            gatewayUrl: server.gatewayUrl,
            transfer,
          });
        await run({
          direction: "download",
          token: prepared.token,
          manifestRef: prepared.snapshot.manifestRef,
        });
        // Download installs a shallow dispatch base; history capture must stop there.
        expect(await fs.readFile(path.join(workspaceDir, ".git", "shallow"), "utf8")).toContain(
          baseCommit,
        );
        await fs.writeFile(path.join(workspaceDir, "tracked.txt"), "worker commit\n");
        await git(workspaceDir, ["add", "."]);
        await git(workspaceDir, ["commit", "--quiet", "-m", "worker authored"]);
        const headCommit = await git(workspaceDir, ["rev-parse", "HEAD"]);
        await fs.writeFile(path.join(workspaceDir, "tracked.txt"), "uncommitted worker change\n");
        const resultVersion = version === 2 ? 2 : undefined;
        const token = service.prepareUpload(
          "history",
          prepared.snapshot.manifestRef,
          undefined,
          resultVersion,
        );
        await run({
          direction: "upload",
          token,
          baseManifestRef: prepared.snapshot.manifestRef,
          referenceManifestRef: prepared.snapshot.manifestRef,
          ...(resultVersion ? { resultVersion } : {}),
        });
        const uploaded = service.takeUpload("history", prepared.snapshot.manifestRef);
        expect(await fs.readFile(path.join(uploaded.stagingRoot, "tracked.txt"), "utf8")).toBe(
          "uncommitted worker change\n",
        );
        if (version === 1) {
          expect(uploaded.gitHistory).toBeUndefined();
          expect(uploaded.gitPackPath).toBeUndefined();
        } else {
          expect(uploaded.gitHistory).toEqual({ baseCommit, headCommit, descendsFromBase: true });
          expect(uploaded.gitPackPath).toBeDefined();
          const imported = await runCommandBuffered(
            ["git", "-C", source, "index-pack", "--stdin"],
            { input: await fs.readFile(uploaded.gitPackPath!), maxOutputBytes: 4096 },
          );
          expect(imported, imported.stderr.toString()).toMatchObject({ code: 0 });
          expect(await git(source, ["show", `${headCommit}:tracked.txt`])).toBe("worker commit");
        }
      } finally {
        await server.close();
        await service.closeAll();
      }
    },
  );
  it.runIf(process.platform === "win32")(
    "reuses foreign executable Git-base files without requesting an unavailable blob",
    async () => {
      const root = tempDirs.make("node-worker-transfer-windows-git-executable-", process.cwd());
      const source = path.join(root, "source");
      const { workspaceDir, download } = transferFixture(
        root,
        "environment-windows-git-executable",
      );
      const content = Buffer.from("#!/bin/sh\necho tracked\n");
      await fs.mkdir(source);
      await git(source, ["init", "--quiet", "--object-format=sha1"]);
      await git(source, ["config", "core.filemode", "false"]);
      await fs.writeFile(path.join(source, "script.sh"), content);
      const object = await git(source, ["hash-object", "-w", "script.sh"]);
      await git(source, ["update-index", "--add", "--cacheinfo", `100755,${object},script.sh`]);
      await git(source, ["commit", "--quiet", "-m", "POSIX executable base"]);
      const commit = await git(source, ["rev-parse", "HEAD"]);
      const { rawManifest, manifestRef } = manifestFixture(
        [fileEntry("script.sh", content, 0o755)],
        { baseCommit: commit },
      );
      const packed = await pack(source, commit);
      let requestedBlobs = 0;
      const server = createHttpServer((req, res) => {
        if (req.url?.endsWith("/manifest")) {
          res.writeHead(200).end(rawManifest);
        } else if (req.url?.endsWith("/pack")) {
          res.writeHead(200).end(packed);
        } else {
          requestedBlobs += 1;
          res.writeHead(404).end();
        }
      });
      await using gateway = await serveTransfer(server);
      await expect(download(gateway.gatewayUrl, manifestRef)).resolves.toBe(manifestRef);
      expect(requestedBlobs).toBe(0);
      await expect(fs.readFile(path.join(workspaceDir, "script.sh"))).resolves.toEqual(content);
    },
  );

  it.each([
    "replace symlink ancestor",
    "late write",
    "absent",
    "missing-base",
    "symlink",
    "oversized",
  ])("safely downloads a Git workspace with %s", async (scenario) => {
    const replaceSymlinkAncestor = scenario === "replace symlink ancestor";
    const lateWrite = scenario === "late write";
    const seedState = replaceSymlinkAncestor || lateWrite ? "unused" : scenario;
    const root = tempDirs.make("node-worker-transfer-git-", process.cwd());
    const source = path.join(root, "source");
    const { workspaceDir, read } = transferFixture(root, "environment-git");
    await fs.mkdir(source);
    await git(source, ["init", "--quiet", "--object-format=sha1"]);
    await fs.writeFile(path.join(source, "tracked.txt"), "tracked from gateway\n");
    await fs.writeFile(path.join(source, "script.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.writeFile(path.join(source, "deleted.txt"), "deleted after commit\n");
    await fs.symlink("tracked.txt", path.join(source, "tracked-link"));
    const outsideSentinel = path.join(root, "outside", "file.txt");
    if (replaceSymlinkAncestor) {
      await fs.mkdir(path.dirname(outsideSentinel));
      await fs.writeFile(outsideSentinel, "outside must stay unchanged\n");
      await fs.symlink("../outside", path.join(source, "nested"));
    }
    await git(source, ["add", "."]);
    await git(source, ["commit", "--quiet", "-m", "base"]);
    const commit = await git(source, ["rev-parse", "HEAD"]);
    const seedsRoot = path.join(root, "git-seeds");
    const gatewayNamespace = "gateway";
    const seedKey = "a".repeat(64);
    const seedDir = path.join(seedsRoot, gatewayNamespace, seedKey);
    const invalidSeed = ["missing-base", "symlink", "oversized"].includes(seedState);
    if (seedState !== "unused" && seedState !== "absent") {
      await fs.cp(source, seedDir, { recursive: true, verbatimSymlinks: true });
      const objects = path.join(seedDir, ".git", "objects");
      await fs.writeFile(
        path.join(objects, "info", "alternates"),
        path.join(root, "unrelated-objects"),
      );
      if (seedState === "missing-base") {
        await fs.unlink(path.join(objects, commit.slice(0, 2), commit.slice(2)));
      } else if (seedState === "symlink") {
        await fs.rm(objects, { recursive: true });
        await fs.symlink(path.join(source, ".git", "objects"), objects, "dir");
      } else if (seedState === "oversized") {
        const oversized = await fs.open(path.join(objects, "oversized"), "w");
        try {
          await oversized.truncate(MAX_WORKSPACE_INVENTORY_TOTAL_BYTES + 1);
        } finally {
          await oversized.close();
        }
      }
    }
    if (invalidSeed || lateWrite) {
      await fs.mkdir(workspaceDir);
      await fs.writeFile(path.join(workspaceDir, "previous.txt"), "preserve prior workspace\n");
    }
    if (lateWrite) {
      await fs.writeFile(path.join(source, "tracked.txt"), "changed on gateway\n");
      await fs.chmod(path.join(source, "tracked.txt"), 0o755);
      await fs.unlink(path.join(source, "tracked-link"));
      await fs.symlink("script.sh", path.join(source, "tracked-link"));
      await fs.unlink(path.join(source, "deleted.txt"));
      await fs.mkdir(path.join(source, "nested"));
      await fs.writeFile(path.join(source, "nested", "file.txt"), "new nested content\n");
    }
    if (replaceSymlinkAncestor) {
      await fs.unlink(path.join(source, "nested"));
      await fs.mkdir(path.join(source, "nested"));
      await fs.writeFile(path.join(source, "nested", "file.txt"), "safe nested content\n");
    }
    const snapshot = await captureWorkspaceManifest({ root: source, baseCommit: commit });
    const rawManifest = serializeWorkerWorkspaceManifest(snapshot.manifest);
    const packed = await pack(source, commit);
    const trackedSha = digest(await fs.readFile(path.join(source, "tracked.txt")));
    const downloadablePaths = new Set([
      ...(lateWrite ? ["nested/file.txt", "tracked.txt"] : []),
      ...(replaceSymlinkAncestor ? ["nested/file.txt"] : []),
    ]);
    const filesByHash = new Map(
      snapshot.manifest.entries.flatMap((entry) =>
        entry.type === "file" && downloadablePaths.has(entry.path)
          ? [[entry.sha256, path.join(source, entry.path)] as const]
          : [],
      ),
    );
    const requestedBlobs: string[] = [];
    let requestedPacks = 0;
    const server = createHttpServer(
      transferHandler(async (req, res) => {
        if (req.url?.endsWith("/manifest")) {
          res.writeHead(200, { "content-length": String(Buffer.byteLength(rawManifest)) });
          res.end(rawManifest);
          return;
        }
        if (req.url?.endsWith("/pack")) {
          requestedPacks += 1;
          res.writeHead(200, { "content-length": String(packed.byteLength) });
          res.end(packed);
          return;
        }
        const sha256 = req.url?.match(/\/blobs\/([a-f0-9]{64})$/u)?.[1];
        if (sha256) {
          requestedBlobs.push(sha256);
          const file = filesByHash.get(sha256);
          if (file) {
            if (lateWrite && sha256 === trackedSha) {
              const staging = (await fs.readdir(root)).find((name) =>
                name.startsWith(".workspace.workspace-transfer-"),
              );
              expect(staging).toBeDefined();
              const script = path.join(root, staging!, "script.sh");
              const original = await fs.stat(script);
              await fs.writeFile(script, "#!/bin/sh\nexit 1\n");
              await fs.utimes(script, original.atime, original.mtime);
            }
            const body = await fs.readFile(file);
            res.writeHead(200, { "content-length": String(body.byteLength) });
            res.end(body);
            return;
          }
        }
        res.writeHead(404).end();
      }),
    );
    const gatewayUrl = await listen(server);
    try {
      const transfer = runNodeWorkerWorkspaceTransfer({
        seedsRoot,
        gatewayNamespace,
        gatewayUrl,
        environmentId: "environment-git",
        workspaceDir,
        manifestHome: root,
        hashMemo: new Map(),
        transfer: {
          direction: "download",
          token: "test-token",
          manifestRef: snapshot.manifestRef,
          ...(seedState === "unused" ? {} : { seedKey }),
        },
      });
      if (invalidSeed || lateWrite) {
        if (invalidSeed) {
          await expect(transfer).rejects.toThrow("prepared project seed is invalid");
          expect(requestedPacks).toBe(0);
        } else {
          await expect(transfer).rejects.toMatchObject({
            cause: expect.objectContaining({
              message: expect.stringContaining("materialized a different manifest"),
            }),
          });
        }
        expect(await read("previous.txt")).toBe("preserve prior workspace\n");
        return;
      }
      await expect(transfer).resolves.toBe(snapshot.manifestRef);
      expect(requestedPacks).toBe(1);
      await expect(read("tracked.txt")).resolves.toBe("tracked from gateway\n");
      if (process.platform !== "win32") {
        // Git checkout applies the umask.
        const checkoutUmask = process.umask();
        expect((await fs.stat(path.join(workspaceDir, "tracked.txt"))).mode & 0o777).toBe(
          0o666 & ~checkoutUmask,
        );
        expect((await fs.stat(path.join(workspaceDir, "script.sh"))).mode & 0o777).toBe(
          0o777 & ~checkoutUmask,
        );
      }
      await expect(fs.readlink(path.join(workspaceDir, "tracked-link"))).resolves.toBe(
        "tracked.txt",
      );
      expect(requestedBlobs).toEqual([...filesByHash.keys()]);
      await expect(git(workspaceDir, ["rev-parse", "HEAD"])).resolves.toBe(commit);
      if (replaceSymlinkAncestor) {
        expect((await fs.lstat(path.join(workspaceDir, "nested"))).isDirectory()).toBe(true);
        await expect(read("nested/file.txt")).resolves.toBe("safe nested content\n");
      }
      if (!replaceSymlinkAncestor) {
        await expect(git(workspaceDir, ["status", "--porcelain=v1"])).resolves.toBe("");
      }
    } finally {
      await closeServer(server);
      if (replaceSymlinkAncestor) {
        await expect(fs.readFile(outsideSentinel, "utf8")).resolves.toBe(
          "outside must stay unchanged\n",
        );
      }
    }
  });
  it("downloads repeated blob content once while preserving independent files and modes", async () => {
    const root = tempDirs.make("node-worker-transfer-repeated-blob-", process.cwd());
    const { workspaceDir, download } = transferFixture(root, "environment-repeated-blob");
    const body = Buffer.from("shared workspace content\n");
    const first = fileEntry("first.txt", body);
    const { sha256 } = first;
    const { rawManifest, manifestRef } = manifestFixture([
      first,
      { ...first, path: "second.sh", mode: 0o755 },
      { ...first, path: "third.txt" },
    ]);
    let requestedBlobs = 0;
    const server = createHttpServer(
      workspaceTransferHandler(rawManifest, new Map([[sha256, body]])),
    );
    server.on("request", (req) => {
      if (req.url?.endsWith(`/blobs/${sha256}`)) {
        requestedBlobs += 1;
      }
    });
    await using gateway = await serveTransfer(server);
    await expect(download(gateway.gatewayUrl, manifestRef)).resolves.toBe(manifestRef);
    expect(requestedBlobs).toBe(1);
    for (const file of ["first.txt", "second.sh", "third.txt"]) {
      await expect(fs.readFile(path.join(workspaceDir, file))).resolves.toEqual(body);
    }
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(workspaceDir, "first.txt"))).mode & 0o777).toBe(0o644);
      expect((await fs.stat(path.join(workspaceDir, "second.sh"))).mode & 0o777).toBe(0o755);
    }
    await fs.writeFile(path.join(workspaceDir, "first.txt"), "edited independently\n");
    await expect(fs.readFile(path.join(workspaceDir, "third.txt"))).resolves.toEqual(body);
  });
});
