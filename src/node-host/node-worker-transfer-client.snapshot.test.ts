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
    let beganUpload = false;
    const request = http.request.bind(http);
    const requestSpy = vi.spyOn(http, "request").mockImplementation(((
      url: string | URL,
      options: RequestOptions,
    ) => {
      if (options.method === "POST") {
        beganUpload = true;
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
        const result = await operation;
        expect(result).toBe(uploaded?.currentRef);
      }
      expect(beganUpload).toBe(true);
      expect(uploaded).toBeDefined();
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

it.each([false, true])("uploads an empty workspace but not a missing one (%s)", async (missing) => {
  const root = tempDirs.make("worker-upload-empty-");
  const f = transferFixture(root, "environment-upload-empty");
  if (!missing) {
    await fs.mkdir(f.workspaceDir);
  }
  const { rawManifest, manifestRef } = manifestFixture();
  await writeManifest(root, rawManifest);
  let received = false;
  await using gateway = await serveTransfer(
    createServer(
      transferHandler(async (request, response) => {
        const upload = await readUpload(request);
        received = true;
        expect(upload.body.byteLength).toBe(upload.fileHeader);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ manifestRef: upload.currentRef }));
      }),
    ),
  );
  const operation = f.upload(gateway.gatewayUrl, manifestRef);
  if (missing) {
    await expect(operation).rejects.toMatchObject({ operation: "upload", stage: "capture" });
  } else {
    await expect(operation).resolves.toBe(manifestRef);
  }
  expect(received).toBe(!missing);
});

it("does not begin uploading a cancelled snapshot", async () => {
  const root = tempDirs.make("worker-upload-cancelled-");
  const f = transferFixture(root, "environment-upload-cancelled");
  await fs.mkdir(f.workspaceDir);
  const source = path.join(f.workspaceDir, "source.bin");
  await fs.writeFile(source, content);
  const { rawManifest, manifestRef } = manifestFixture();
  await writeManifest(root, rawManifest);
  const controller = new AbortController();
  controller.abort(new Error("upload cancelled"));
  const request = vi.fn((_request: http.IncomingMessage, response: http.ServerResponse) =>
    response.end(),
  );
  await using gateway = await serveTransfer(createServer(request));
  await expect(
    f.upload(gateway.gatewayUrl, manifestRef, { signal: controller.signal }),
  ).rejects.toThrow("workspace-transfer-failed");
  expect(request).not.toHaveBeenCalled();
  await expect(fs.readFile(source)).resolves.toEqual(content);
});
