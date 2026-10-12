import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { runNodeWorkerWorkspaceTransfer } from "../../node-host/node-worker-transfer-client.js";
import * as workspaceCommands from "../../node-host/node-worker-workspace-commands.js";
import { runCommandBuffered, runCommandWithTimeout } from "../../process/exec.js";
import { workspaceTransfer } from "./node-worker-tunnel.test-support.js";
import {
  createNodeWorkspaceTransferService,
  type NodeWorkspaceTransferService,
} from "./node-workspace-transfer-service.js";
import type { NodeWorkspaceTransferSnapshot } from "./node-workspace-transfer-snapshot.js";
import {
  startNodeWorkspaceTransferTestServer,
  transferOwner,
} from "./node-workspace-transfer.test-support.js";
import { MAX_WORKSPACE_MANIFEST_BYTES } from "./workspace-inventory-limits.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

/** Redacted transfer request/response trace for ClawSweeper real-behavior proof. */
function logTransferProof(params: {
  scenario: string;
  request: Record<string, string | number | boolean>;
  response: Record<string, string | number | boolean | undefined>;
}): void {
  const format = (entries: Record<string, string | number | boolean | undefined>) =>
    Object.entries(entries)
      .map(([key, value]) => `${key}=${value === undefined ? "<undefined>" : String(value)}`)
      .join(" ");
  // Keep tokens and host addresses out of durable proof text.
  console.log(
    [
      `[workspace-transfer-proof] scenario=${params.scenario}`,
      `  request: ${format(params.request)}`,
      `  response: ${format(params.response)}`,
    ].join("\n"),
  );
}

/** Serves one prebuilt Git pack/manifest through the shipped Gateway transfer HTTP path. */
function createPackBackedTransferService(params: {
  environmentId: string;
  token: string;
  snapshot: NodeWorkspaceTransferSnapshot;
  packPath: string;
}): NodeWorkspaceTransferService {
  const signal = AbortSignal.timeout(10 * 60_000);
  const authorization = {
    context: {
      environmentId: params.environmentId,
      signal,
    },
    capability: {
      direction: "download" as const,
      token: params.token,
      manifestRef: params.snapshot.manifestRef,
      expiresAtMs: Date.now() + 10 * 60_000,
      isAuthorized: () => true,
    },
    route: {
      kind: "manifest" as const,
      direction: "download" as const,
      environmentId: params.environmentId,
      manifestRef: params.snapshot.manifestRef,
    },
  };
  // Download-only facade: unused service methods stay stubbed via workspaceTransfer.
  return workspaceTransfer({
    authorize: (({ route, token }) => {
      if (
        token !== params.token ||
        route.environmentId !== params.environmentId ||
        (route.kind !== "manifest" && route.kind !== "pack") ||
        route.manifestRef !== params.snapshot.manifestRef
      ) {
        return undefined;
      }
      return { ...authorization, route };
    }) as NodeWorkspaceTransferService["authorize"],
    isAuthorizationCurrent: () => true,
    authorizationSignal: () => signal,
    snapshot: () => params.snapshot,
    pack: async () => params.packPath,
  });
}

async function createGitTransfer() {
  const root = await fs.realpath(tempDirs.make("node-workspace-lazy-pack-"));
  const localPath = path.join(root, "workspace");
  const temporaryRoot = path.join(root, "transfers");
  await fs.mkdir(localPath);
  await fs.writeFile(path.join(localPath, "input.txt"), "captured base\n");
  await requireGit(localPath, ["init", "--quiet"]);
  await requireGit(localPath, ["config", "user.name", "Workspace Test"]);
  await requireGit(localPath, ["config", "user.email", "workspace@example.invalid"]);
  await requireGit(localPath, ["add", "."]);
  await requireGit(localPath, ["commit", "--quiet", "-m", "captured base"]);
  const service = createNodeWorkspaceTransferService({
    temporaryRoot,
    getOwner: () => transferOwner("session"),
  });
  const prepared = await service.prepareSync({
    environmentId: "environment",
    ownerEpoch: 1,
    sessionId: "session",
    localPath,
    isAuthorized: () => true,
  });
  const server = await startNodeWorkspaceTransferTestServer(service);
  const fetchPack = (token = prepared.token, manifestRef = prepared.snapshot.manifestRef) =>
    fetch(
      `${server.gatewayUrl.replace(/^ws/u, "http")}/__openclaw__/worker-transfer/v1/environments/environment/snapshots/${manifestRef.slice(7)}/pack`,
      { headers: { authorization: `Bearer ${token}` } },
    );
  return {
    root,
    localPath,
    temporaryRoot,
    service,
    prepared,
    gatewayUrl: server.gatewayUrl,
    fetchPack,
    packs: async () =>
      (await fs.readdir(temporaryRoot, { recursive: true })).filter((name) =>
        name.endsWith(".pack"),
      ),
    close: async () => {
      await service.closeAll();
      await server.close();
    },
  };
}

describe("node workspace Git pack downloads", () => {
  it("imports and recaptures a Git workspace beyond the Windows path limit", async () => {
    const fixture = await createGitTransfer();
    const workspaceDir = path.join(
      fixture.root,
      "node-host",
      `gateway-${"a".repeat(32)}`,
      "workspaces",
      "b".repeat(96),
      "c".repeat(96),
      "workspace",
    );
    expect(workspaceDir.length).toBeGreaterThan(260);
    await fs.mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    try {
      const transfer = () =>
        runNodeWorkerWorkspaceTransfer({
          gatewayUrl: fixture.gatewayUrl,
          environmentId: "environment",
          workspaceDir,
          manifestHome: fixture.root,
          transfer: {
            direction: "download",
            token: fixture.prepared.token,
            manifestRef: fixture.prepared.snapshot.manifestRef,
          },
        });
      for (let attempt = 0; attempt < 2; attempt++) {
        const resolved = await transfer();
        expect(resolved).toBe(fixture.prepared.snapshot.manifestRef);
        expect(await fs.readFile(path.join(workspaceDir, "input.txt"), "utf8")).toBe(
          "captured base\n",
        );
        expect(await requireGit(workspaceDir, ["status", "--porcelain"])).toBe("");
        if (process.platform === "win32") {
          expect(await requireGit(workspaceDir, ["config", "--local", "core.longpaths"])).toBe(
            "true",
          );
        }
        if (attempt === 0) {
          logTransferProof({
            scenario: "ordinary-completion",
            request: {
              direction: "download",
              environmentId: "environment",
              gateway: "local-ephemeral-gateway",
              manifestRef: fixture.prepared.snapshot.manifestRef,
              token: "redacted",
              workspacePathBytes: workspaceDir.length,
            },
            response: {
              outcome: "ok",
              resolvedManifestRef: resolved,
              checkedOut: "input.txt",
              gitStatus: "clean",
            },
          });
        }
      }
    } finally {
      await fixture.close();
    }
  });

  it("defers packing until authorized download and shares the captured base across manifests", async () => {
    const fixture = await createGitTransfer();
    const { localPath, prepared, service } = fixture;
    try {
      // Origin/seed sync consumes this prepared manifest without downloading a pack.
      expect(await fixture.packs()).toEqual([]);
      const unauthorized = await fixture.fetchPack("invalid");
      expect(unauthorized.status).toBe(404);
      await unauthorized.arrayBuffer();
      expect(await fixture.packs()).toEqual([]);

      await requireGit(localPath, ["commit", "--quiet", "--allow-empty", "-m", "new HEAD"]);
      const nextCommit = await requireGit(localPath, ["rev-parse", "HEAD"]);
      const responses = await Promise.all([fixture.fetchPack(), fixture.fetchPack()]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const packs = await Promise.all(
        responses.map(async (response) => Buffer.from(await response.arrayBuffer())),
      );
      expect(packs[0]).toEqual(packs[1]);
      expect(await fixture.packs()).toHaveLength(1);

      const unpacked = path.join(fixture.root, "unpacked");
      await fs.mkdir(unpacked);
      await requireGit(unpacked, ["init", "--quiet"]);
      const indexed = await runCommandWithTimeout(
        ["git", "-C", unpacked, "index-pack", "--stdin"],
        {
          input: packs[0],
          timeoutMs: 10_000,
        },
      );
      expect(indexed.code).toBe(0);
      expect(
        await requireGit(unpacked, ["cat-file", "-t", prepared.snapshot.manifest.baseCommit!]),
      ).toBe("commit");
      const newer = await runCommandWithTimeout(
        ["git", "-C", unpacked, "cat-file", "-t", nextCommit],
        { timeoutMs: 10_000 },
      );
      expect(newer.code).not.toBe(0);

      await fs.writeFile(path.join(localPath, "result.txt"), "accepted result\n");
      const accepted = await captureWorkspaceManifest({
        root: localPath,
        baseCommit: prepared.snapshot.manifest.baseCommit,
      });
      const token = service.publishSnapshot("environment", {
        ...accepted,
        root: localPath,
        rawManifest: serializeWorkerWorkspaceManifest(accepted.manifest),
      });
      const response = await fixture.fetchPack(token, accepted.manifestRef);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(packs[0]);
      expect(await fixture.packs()).toHaveLength(1);

      const changedBase = await captureWorkspaceManifest({
        root: localPath,
        baseCommit: nextCommit,
      });
      const changedBaseToken = service.publishSnapshot("environment", {
        ...changedBase,
        root: localPath,
        rawManifest: serializeWorkerWorkspaceManifest(changedBase.manifest),
      });
      const mismatched = await fixture.fetchPack(changedBaseToken, changedBase.manifestRef);
      expect(mismatched.status).toBe(404);
      await mismatched.arrayBuffer();
      expect(await fixture.packs()).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("retries an authorized download after discarding a failed pack's scratch files", async () => {
    const fixture = await createGitTransfer();
    const originalAppend = fs.appendFile.bind(fs);
    let failOnce = true;
    vi.spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      if (failOnce && typeof args[0] === "string" && args[0].endsWith(".objects")) {
        failOnce = false;
        expect((await fs.stat(args[0])).size).toBeGreaterThan(0);
        throw new Error("injected Git pack failure after object enumeration");
      }
      return await originalAppend(...args);
    });
    try {
      const failed = await fixture.fetchPack();
      expect(failed.status).toBe(500);
      await failed.arrayBuffer();
      expect(failOnce).toBe(false);
      expect(await fixture.packs()).toEqual([]);

      const retried = await fixture.fetchPack();
      expect(retried.status).toBe(200);
      expect(
        Buffer.from(await retried.arrayBuffer())
          .subarray(0, 4)
          .toString(),
      ).toBe("PACK");
      expect(await fixture.packs()).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it.each(["revoke", "close"] as const)(
    "fences an in-flight pack after transfer %s",
    async (retirement) => {
      const fixture = await createGitTransfer();
      const started = createDeferred();
      const release = createDeferred();
      const originalAppend = fs.appendFile.bind(fs);
      vi.spyOn(fs, "appendFile").mockImplementation(async (...args) => {
        if (typeof args[0] === "string" && args[0].endsWith(".objects")) {
          started.resolve();
          await release.promise;
        }
        return await originalAppend(...args);
      });
      const response = fixture.fetchPack().then(
        async (result) => ({
          status: result.status,
          bytes: Buffer.from(await result.arrayBuffer()),
        }),
        () => undefined,
      );
      try {
        await Promise.race([started.promise, response]);
        expect(await fixture.packs()).toEqual([]);
        let closed = false;
        const closing =
          retirement === "close"
            ? fixture.service.close("environment").then(() => {
                closed = true;
              })
            : Promise.resolve(fixture.service.revoke("environment", fixture.prepared.token));
        await Promise.resolve();
        expect(closed).toBe(false);
        release.resolve();
        const result = await response;
        expect(result?.status).not.toBe(200);
        if (retirement === "revoke") {
          expect(result?.status).toBe(404);
        }
        await closing;
        if (retirement === "close") {
          expect(await fs.readdir(fixture.temporaryRoot)).toEqual([]);
        }
      } finally {
        release.resolve();
        await response;
        await fixture.close();
      }
    },
  );

  it("preserves the prior workspace when Gateway Git stdout is truncated during download", async () => {
    const fixture = await createGitTransfer();
    const workspaceDir = path.join(fixture.root, "node-workspace");
    await fs.mkdir(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, "previous.txt"), "preserve prior workspace\n");
    const original = workspaceCommands.runWorkspaceCommand;
    const spy = vi
      .spyOn(workspaceCommands, "runWorkspaceCommand")
      .mockImplementation(async (params) => {
        if (params.argv.includes("rev-parse") && params.argv.includes("--verify")) {
          // Real Git under an 8-byte cap: exit 0 with truncation metadata.
          return await original({ ...params, maxOutputBytes: 8 });
        }
        return await original(params);
      });
    try {
      let transferError: unknown;
      try {
        await runNodeWorkerWorkspaceTransfer({
          gatewayUrl: fixture.gatewayUrl,
          environmentId: "environment",
          workspaceDir,
          manifestHome: fixture.root,
          transfer: {
            direction: "download",
            token: fixture.prepared.token,
            manifestRef: fixture.prepared.snapshot.manifestRef,
          },
        });
      } catch (error) {
        transferError = error;
      }
      expect(transferError).toMatchObject({
        message: "workspace-transfer-failed: transfer did not complete",
        cause: expect.objectContaining({
          message: expect.stringContaining("command output was truncated"),
        }),
      });
      const prior = await fs.readFile(path.join(workspaceDir, "previous.txt"), "utf8");
      expect(prior).toBe("preserve prior workspace\n");
      await expect(fs.access(path.join(workspaceDir, "input.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const cause =
        transferError && typeof transferError === "object" && "cause" in transferError
          ? transferError.cause
          : undefined;
      const causeMessage =
        cause instanceof Error
          ? cause.message
          : cause && typeof cause === "object" && "message" in cause
            ? String(cause.message)
            : String(cause);
      logTransferProof({
        scenario: "truncated-command-rejection",
        request: {
          direction: "download",
          environmentId: "environment",
          gateway: "local-ephemeral-gateway",
          manifestRef: fixture.prepared.snapshot.manifestRef,
          token: "redacted",
          forcedRevParseMaxOutputBytes: 8,
          priorWorkspaceFile: "previous.txt",
        },
        response: {
          outcome: "rejected",
          error: "workspace-transfer-failed: transfer did not complete",
          cause: causeMessage.includes("command output was truncated")
            ? "command output was truncated"
            : causeMessage,
          priorWorkspacePreserved: prior === "preserve prior workspace\n",
          downloadedInputAbsent: true,
        },
      });
    } finally {
      spy.mockRestore();
      await fixture.close();
    }
  });

  it("completes a Gateway download when the Git index exceeds the former 64 MiB buffer cap", async () => {
    const root = await fs.realpath(tempDirs.make("node-workspace-index-over-64mib-"));
    const source = path.join(root, "source");
    const workspaceDir = path.join(root, "workspace");
    const packPath = path.join(root, "base.pack");
    await fs.mkdir(source);
    await fs.mkdir(workspaceDir);
    const content = Buffer.from("tracked from gateway\n");
    await fs.writeFile(path.join(source, "tracked.txt"), content);
    await requireGit(source, ["init", "--quiet"]);
    await requireGit(source, ["config", "user.name", "Workspace Test"]);
    await requireGit(source, ["config", "user.email", "workspace@example.invalid"]);
    await requireGit(source, ["add", "tracked.txt"]);
    const blob = (
      await runCommandWithTimeout(["git", "-C", source, "hash-object", "-w", "--stdin"], {
        input: "x\n",
        timeoutMs: 10_000,
      })
    ).stdout.trim();
    // Shared-blob index entries inflate ls-files past the former buffered
    // MAX_WORKSPACE_MANIFEST_BYTES cap without a multi-GiB pack or worktree.
    // Stay under MAX_WORKSPACE_GIT_CANDIDATES so post-transfer verify still runs.
    const indexInfoPath = path.join(root, "index-info");
    const indexInfo = await fs.open(indexInfoPath, "w");
    try {
      let chunk = "";
      for (let i = 0; i < 900_000; i += 1) {
        chunk += `100644 ${blob}\te/${String(i).padStart(6, "0")}/padding-bytes.txt\n`;
        if (chunk.length >= 8 * 1024 * 1024) {
          await indexInfo.write(chunk);
          chunk = "";
        }
      }
      if (chunk) {
        await indexInfo.write(chunk);
      }
    } finally {
      await indexInfo.close();
    }
    const indexInfoFd = await fs.open(indexInfoPath, "r");
    try {
      const indexed = await runCommandWithTimeout(
        ["git", "-C", source, "update-index", "--add", "--index-info"],
        {
          stdinFileDescriptor: indexInfoFd.fd,
          timeoutMs: 120_000,
        },
      );
      expect(indexed.code).toBe(0);
    } finally {
      await indexInfoFd.close();
    }
    await requireGit(source, ["commit", "--quiet", "-m", "index over former buffer cap"]);
    const commit = await requireGit(source, ["rev-parse", "HEAD"]);
    const listing = await runCommandBuffered(["git", "-C", source, "ls-files", "--stage", "-z"], {
      maxOutputBytes: 128 * 1024 * 1024,
    });
    expect(listing.code).toBe(0);
    expect(listing.stdout.byteLength).toBeGreaterThan(MAX_WORKSPACE_MANIFEST_BYTES);
    const packed = await runCommandBuffered(
      ["git", "-C", source, "pack-objects", "--stdout", "--revs"],
      { input: `${commit}\n`, maxOutputBytes: 16 * 1024 * 1024 },
    );
    expect(packed.code).toBe(0);
    await fs.writeFile(packPath, packed.stdout);
    const rawManifest = serializeWorkerWorkspaceManifest({
      version: 1,
      baseCommit: commit,
      entries: [
        {
          path: "tracked.txt",
          type: "file",
          mode: 0o644,
          size: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
        },
      ],
    });
    const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
    const token = "download-token";
    const environmentId = "environment-large-index";
    const server = await startNodeWorkspaceTransferTestServer(
      createPackBackedTransferService({
        environmentId,
        token,
        packPath,
        snapshot: {
          root: source,
          manifestRef,
          rawManifest,
          manifest: {
            version: 1,
            baseCommit: commit,
            entries: [
              {
                path: "tracked.txt",
                type: "file",
                mode: 0o644,
                size: content.byteLength,
                sha256: createHash("sha256").update(content).digest("hex"),
              },
            ],
          },
        },
      }),
    );
    try {
      const resolved = await runNodeWorkerWorkspaceTransfer({
        gatewayUrl: server.gatewayUrl,
        environmentId,
        workspaceDir,
        manifestHome: root,
        transfer: { direction: "download", token, manifestRef },
      });
      expect(resolved).toBe(manifestRef);
      await expect(fs.readFile(path.join(workspaceDir, "tracked.txt"))).resolves.toEqual(content);
      await expect(fs.access(path.join(workspaceDir, "e"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      logTransferProof({
        scenario: "index-over-64mib",
        request: {
          direction: "download",
          environmentId,
          gateway: "local-ephemeral-gateway",
          manifestRef,
          token: "redacted",
          indexListingBytes: listing.stdout.byteLength,
          formerBufferCapBytes: MAX_WORKSPACE_MANIFEST_BYTES,
          packBytes: packed.stdout.byteLength,
        },
        response: {
          outcome: "ok",
          resolvedManifestRef: resolved,
          checkedOut: "tracked.txt",
          paddingTreeAbsent: true,
          indexExceededFormerCap: listing.stdout.byteLength > MAX_WORKSPACE_MANIFEST_BYTES,
        },
      });
    } finally {
      await server.close();
    }
  });
});
