import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { listDirectoryTreeStrict } from "../../infra/directory-walk.js";
import { runNodeWorkerWorkspaceTransfer } from "../../node-host/node-worker-transfer-client.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  commitWorkspace,
  transferFixture,
} from "./node-workspace-transfer-fixtures.test-support.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";

const tempDirs = createTempDirTracker();
let closeTransfer: (() => Promise<void>) | undefined;
afterEach(async () => {
  const close = closeTransfer;
  closeTransfer = undefined;
  try {
    await close?.();
  } finally {
    try {
      tempDirs.cleanup();
    } finally {
      vi.restoreAllMocks();
    }
  }
});

const readPack = async (response: Response) => Buffer.from(await response.arrayBuffer());
async function expectResponse(pending: Promise<Response>, status = 200) {
  const response = await pending;
  expect(response.status).toBe(status);
  return readPack(response);
}
function interceptPackObjects(beforeAppend: (file: string) => Promise<void>) {
  const append = fs.appendFile.bind(fs);
  vi.spyOn(fs, "appendFile").mockImplementation(async (...args) => {
    if (typeof args[0] === "string" && args[0].endsWith(".objects")) {
      await beforeAppend(args[0]);
    }
    return await append(...args);
  });
}

async function createGitTransfer() {
  const root = await fs.realpath(tempDirs.make("node-workspace-lazy-pack-"));
  const { localPath, temporaryRoot, service, request, files } = await transferFixture(root);
  await files.write("input.txt", "captured base\n");
  await commitWorkspace(localPath, "captured base");
  const prepared = await service.prepareSync(request);
  const server = await startNodeWorkspaceTransferTestServer(service);
  closeTransfer = async () => {
    await service.closeAll();
    await server.close();
  };
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
    publish: async (baseCommit: string | null) => {
      const captured = await captureWorkspaceManifest({ root: localPath, baseCommit });
      const token = service.publishSnapshot("environment", {
        ...captured,
        root: localPath,
        rawManifest: serializeWorkerWorkspaceManifest(captured.manifest),
      });
      return fetchPack(token, captured.manifestRef);
    },
    packs: async () =>
      (await listDirectoryTreeStrict(temporaryRoot))
        .map((walkEntry) => walkEntry.relativePath)
        .filter((name) => name.endsWith(".pack")),
  };
}

describe("node workspace Git pack downloads", () => {
  it("imports and recaptures a Git workspace beyond the Windows path limit", async () => {
    const fixture = await createGitTransfer();
    const {
      token,
      snapshot: { manifestRef },
    } = fixture.prepared;
    const workspaceDir = path.join(fixture.root, "a".repeat(120), "b".repeat(120), "workspace");
    expect(workspaceDir.length).toBeGreaterThan(260);
    await fs.mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    const transfer = () =>
      runNodeWorkerWorkspaceTransfer({
        gatewayUrl: fixture.gatewayUrl,
        environmentId: "environment",
        workspaceDir,
        manifestHome: fixture.root,
        transfer: { direction: "download", token, manifestRef },
      });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await transfer()).toBe(manifestRef);
      expect(await fs.readFile(path.join(workspaceDir, "input.txt"), "utf8")).toBe(
        "captured base\n",
      );
      expect(await requireGit(workspaceDir, ["status", "--porcelain"])).toBe("");
      if (process.platform === "win32") {
        expect(await requireGit(workspaceDir, ["config", "--local", "core.longpaths"])).toBe(
          "true",
        );
      }
    }
  });

  it("defers packing until authorized download and shares the captured base across manifests", async () => {
    const fixture = await createGitTransfer();
    const { localPath, prepared } = fixture;
    expect(await fixture.packs()).toEqual([]);
    await expectResponse(fixture.fetchPack("invalid"), 404);
    expect(await fixture.packs()).toEqual([]);

    await requireGit(localPath, ["commit", "--quiet", "--allow-empty", "-m", "new HEAD"]);
    const nextCommit = await requireGit(localPath, ["rev-parse", "HEAD"]);
    const responses = await Promise.all([fixture.fetchPack(), fixture.fetchPack()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const packs = await Promise.all(responses.map(readPack));
    expect(packs[0]).toEqual(packs[1]);
    expect(await fixture.packs()).toHaveLength(1);

    const unpacked = path.join(fixture.root, "unpacked");
    await fs.mkdir(unpacked);
    await requireGit(unpacked, ["init", "--quiet"]);
    const runGit = (args: string[], input?: Buffer) =>
      runCommandWithTimeout(["git", "-C", unpacked, ...args], { input, timeoutMs: 10_000 });
    expect(await runGit(["index-pack", "--stdin"], packs[0])).toMatchObject({ code: 0 });
    expect(
      await requireGit(unpacked, ["cat-file", "-t", prepared.snapshot.manifest.baseCommit!]),
    ).toBe("commit");
    expect((await runGit(["cat-file", "-t", nextCommit])).code).not.toBe(0);

    await fs.writeFile(path.join(localPath, "result.txt"), "accepted result\n");
    expect(await expectResponse(fixture.publish(prepared.snapshot.manifest.baseCommit))).toEqual(
      packs[0],
    );
    expect(await fixture.packs()).toHaveLength(1);

    await expectResponse(fixture.publish(nextCommit), 404);
    expect(await fixture.packs()).toHaveLength(1);
  });

  it("retries an authorized download after discarding a failed pack's scratch files", async () => {
    const fixture = await createGitTransfer();
    let failOnce = true;
    interceptPackObjects(async (file) => {
      if (failOnce) {
        failOnce = false;
        expect((await fs.stat(file)).size).toBeGreaterThan(0);
        throw new Error("injected Git pack failure after object enumeration");
      }
    });
    await expectResponse(fixture.fetchPack(), 500);
    expect(failOnce).toBe(false);
    expect(await fixture.packs()).toEqual([]);

    expect((await expectResponse(fixture.fetchPack())).subarray(0, 4).toString()).toBe("PACK");
    expect(await fixture.packs()).toHaveLength(1);
  });

  it.each(["revoke", "close"] as const)(
    "fences an in-flight pack after transfer %s",
    async (retirement) => {
      const fixture = await createGitTransfer();
      const started = createDeferred();
      const release = createDeferred();
      interceptPackObjects(async () => {
        started.resolve();
        await release.promise;
      });
      const response = fixture.fetchPack().then(
        async (result) => ({ status: result.status, bytes: await readPack(result) }),
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
      }
    },
  );
});
