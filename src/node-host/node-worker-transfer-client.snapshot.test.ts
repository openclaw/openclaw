import fsSync from "node:fs";
import fs from "node:fs/promises";
import http, { createServer, type RequestOptions } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { parseWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import {
  digest,
  manifestFixture,
  readUpload,
  serveTransfer,
  transferFixture,
  transferHandler,
  writeManifest,
} from "./node-worker-transfer-client.fixture.test-support.js";
import { runNodeWorkerWorkspaceTransfer } from "./node-worker-transfer-client.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const content = Buffer.from("captured workspace bytes");

it.each([false, true])(
  "uploads frozen literal paths through aliased parents and hardlinks (rejected: %s)",
  async (rejected) => {
    const root = tempDirs.make("worker-upload-snapshot-");
    const realParent = path.join(root, "real");
    const alias = path.join(root, "alias");
    const workspaceDir = path.join(realParent, "workspace");
    const sharedFile = path.join(realParent, "shared.bin");
    await fs.mkdir(path.join(workspaceDir, "~"), { recursive: true });
    await fs.writeFile(sharedFile, content);
    await fs.link(sharedFile, path.join(workspaceDir, "~/source.bin"));
    await fs.symlink(realParent, alias, "junction");
    const { rawManifest, manifestRef } = manifestFixture();
    await writeManifest(root, rawManifest);
    let uploaded: Awaited<ReturnType<typeof readUpload>> | undefined;
    await using gateway = await serveTransfer(
      createServer(
        transferHandler(async (request, response) => {
          uploaded = await readUpload(request);
          response.writeHead(rejected ? 500 : 200, { "content-type": "application/json" });
          response.end(JSON.stringify({ manifestRef: uploaded.currentRef }));
        }),
      ),
    );
    const request = http.request.bind(http);
    const requestSpy = vi.spyOn(http, "request").mockImplementation(((
      url: string | URL,
      options: RequestOptions,
    ) => {
      if (options.method === "POST") {
        if (!rejected) {
          fsSync.writeFileSync(sharedFile, "later workspace edit");
        }
      }
      return request(url, options);
    }) as typeof http.request);
    try {
      const operation = runNodeWorkerWorkspaceTransfer({
        gatewayUrl: gateway.gatewayUrl,
        environmentId: "environment-upload-snapshot",
        workspaceDir: path.join(alias, "workspace"),
        manifestHome: root,
        transfer: {
          direction: "upload",
          token: "test-token",
          baseManifestRef: manifestRef,
          referenceManifestRef: manifestRef,
        },
      });
      if (rejected) {
        await expect(operation).rejects.toThrow("workspace-transfer-failed: gateway returned 500");
      } else {
        expect(await operation).toBe(uploaded?.currentRef);
      }
      if (!uploaded) {
        throw new Error("Gateway received no upload snapshot");
      }
      const { body, fileHeader, currentRaw, currentRef } = uploaded;
      expect(parseWorkerWorkspaceManifest(currentRaw, currentRef).entries).toEqual([
        expect.objectContaining({
          path: "~/source.bin",
          type: "file",
          size: content.byteLength,
          sha256: digest(content),
        }),
      ]);
      expect(body.readBigUInt64BE(fileHeader)).toBe(BigInt(content.byteLength));
      expect(body.subarray(fileHeader + 8)).toEqual(content);
      await expect(fs.readFile(sharedFile)).resolves.toEqual(
        rejected ? content : Buffer.from("later workspace edit"),
      );
    } finally {
      requestSpy.mockRestore();
    }
  },
);

it.each(["empty", "missing", "cancelled"])("handles a %s upload source", async (state) => {
  const root = tempDirs.make("worker-upload-source-");
  const f = transferFixture(root, "environment-upload-source");
  const source = path.join(f.workspaceDir, "source.bin");
  const controller = new AbortController();
  if (state !== "missing") {
    await fs.mkdir(f.workspaceDir);
  }
  if (state === "cancelled") {
    await fs.writeFile(source, content);
    controller.abort(new Error("upload cancelled"));
  }
  const { rawManifest, manifestRef } = manifestFixture();
  await writeManifest(root, rawManifest);
  let received = false;
  await using gateway = await serveTransfer(
    createServer(
      transferHandler(async (request, response) => {
        received = true;
        const upload = await readUpload(request);
        expect(upload.body.byteLength).toBe(upload.fileHeader);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ manifestRef: upload.currentRef }));
      }),
    ),
  );
  const operation = f.upload(gateway.gatewayUrl, manifestRef, { signal: controller.signal });
  if (state === "missing") {
    await expect(operation).rejects.toMatchObject({ operation: "upload", stage: "capture" });
  } else if (state === "cancelled") {
    await expect(operation).rejects.toThrow("workspace-transfer-failed");
    await expect(fs.readFile(source)).resolves.toEqual(content);
  } else {
    await expect(operation).resolves.toBe(manifestRef);
  }
  expect(received).toBe(state === "empty");
});
