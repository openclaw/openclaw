import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { MAX_WORKSPACE_MANIFEST_BYTES } from "../gateway/worker-environments/workspace-inventory-limits.js";
import {
  closeServer,
  manifestFixture,
  transferFixture as workspaceFixture,
} from "./node-worker-transfer-client.fixture.test-support.js";
import { listen } from "./node-worker-transfer-client.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { rawManifest, manifestRef } = manifestFixture();
const overflow = () => Buffer.alloc(MAX_WORKSPACE_MANIFEST_BYTES + 1);

function oversizedGzipHeader() {
  const compressed = gzipSync(rawManifest);
  // A valid optional filename can exhaust the wire cap without expanding the body.
  compressed[3] = 8;
  return Buffer.concat([
    compressed.subarray(0, 10),
    Buffer.alloc(MAX_WORKSPACE_MANIFEST_BYTES, 65),
    Buffer.from([0]),
    compressed.subarray(10),
  ]);
}

async function transferFixture(send: (res: ServerResponse) => void, signal?: AbortSignal) {
  const root = tempDirs.make("node-worker-transfer-encoding-");
  const fixture = workspaceFixture(root, "environment");
  const { workspaceDir } = fixture;
  await fs.mkdir(workspaceDir);
  await fs.writeFile(path.join(workspaceDir, "sentinel.txt"), "existing workspace");
  let acceptEncoding: string | undefined;
  const server = createServer((req, res) => {
    acceptEncoding = req.headers["accept-encoding"];
    send(res);
  });
  const gatewayUrl = await listen(server);
  return {
    [Symbol.asyncDispose]: () => closeServer(server),
    workspaceDir,
    acceptEncoding: () => acceptEncoding,
    run: () => fixture.download(gatewayUrl, manifestRef, { signal }),
  };
}

describe("workspace manifest HTTP encoding", () => {
  it("downloads gzip manifests and verifies decoded content", async () => {
    await using fixture = await transferFixture((res) => {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(gzipSync(rawManifest));
    });
    await expect(fixture.run()).resolves.toBe(manifestRef);
    expect(fixture.acceptEncoding()).toBe("gzip");
    expect(await fs.readdir(fixture.workspaceDir)).not.toContain("sentinel.txt");
  });

  it.each<[string, string, () => Buffer, RegExp]>([
    ["unknown encoding", "br", () => Buffer.from(rawManifest), /encoding/],
    ["decoded digest mismatch", "gzip", () => gzipSync(`${rawManifest} `), /digest/],
    ["decoded overflow", "gzip", () => gzipSync(overflow()), /byte limit/],
    ["encoded gzip overflow", "gzip", oversizedGzipHeader, /byte limit/],
    ["identity overflow", "identity", overflow, /byte limit/],
  ])("rejects %s before changing the workspace", async (_name, encoding, body, reason) => {
    const payload = body();
    await using fixture = await transferFixture((res) =>
      res.writeHead(200, { "content-encoding": encoding }).end(payload),
    );
    await expect(fixture.run()).rejects.toMatchObject({
      cause: { message: expect.stringMatching(reason) },
    });
    expect(await fs.readFile(path.join(fixture.workspaceDir, "sentinel.txt"), "utf8")).toBe(
      "existing workspace",
    );
    expect(await fs.readdir(path.dirname(fixture.workspaceDir))).toEqual(["workspace"]);
  });

  it("cancels an unfinished gzip response and closes the transport without changing the workspace", async () => {
    const controller = new AbortController();
    const sent = createDeferred();
    const closed = createDeferred();
    await using fixture = await transferFixture((res) => {
      res.on("close", () => closed.resolve());
      res.writeHead(200, { "content-encoding": "gzip" });
      res.write(gzipSync(rawManifest).subarray(0, 12), () => sent.resolve());
    }, controller.signal);
    try {
      const result = expect(fixture.run()).rejects.toMatchObject({ cause: { name: "AbortError" } });
      await sent.promise;
      controller.abort();
      await result;
      await closed.promise;
      expect(await fs.readFile(path.join(fixture.workspaceDir, "sentinel.txt"), "utf8")).toBe(
        "existing workspace",
      );
    } finally {
      controller.abort();
    }
  });
});
