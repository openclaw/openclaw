import { deepStrictEqual } from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import type { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http, { createServer as createHttpServer, type RequestOptions } from "node:http";
import https, { createServer as createHttpsServer } from "node:https";
import { connect as connectNet, type Socket } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { installGlobalProxy } from "@openclaw/proxyline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { captureWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest-worker.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
} from "../gateway/worker-environments/workspace-manifest.js";
import {
  closeServer,
  digest,
  fileEntry,
  manifestFixture,
  readUpload,
  transferFixture,
  transferHandler,
  workspaceTransferHandler,
} from "./node-worker-transfer-client.fixture.test-support.js";
import { runNodeWorkerWorkspaceTransfer } from "./node-worker-transfer-client.js";
import { listen } from "./node-worker-transfer-client.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(name: string) {
  const root = tempDirs.make(`node-worker-transfer-${name}-`);
  return { root, ...transferFixture(root, `environment-${name}`) };
}

type DrainProbe = {
  emitter: EventEmitter;
  drains: number;
  maxErrorListeners: number;
};

function observeDrainListeners(emitter: EventEmitter): DrainProbe {
  const probe = { emitter, drains: 0, maxErrorListeners: 0 };
  emitter.on("newListener", (event) => {
    if (event === "error") {
      probe.maxErrorListeners = Math.max(
        probe.maxErrorListeners,
        emitter.listenerCount("error") + 1,
      );
    }
  });
  emitter.on("drain", () => {
    probe.drains += 1;
  });
  return probe;
}

describe("node worker transfer client", () => {
  it.skipIf(process.platform === "win32")(
    "reports unsafe ancestry without mutating the workspace",
    async () => {
      const root = tempDirs.make("node-worker-transfer-permissions-");
      const workspaceDir = path.join(root, "workspace");
      await fs.mkdir(workspaceDir, { mode: 0o700 });
      await fs.writeFile(path.join(workspaceDir, "sentinel.txt"), "keep me");
      const rawManifest = serializeWorkerWorkspaceManifest({
        version: 1,
        baseCommit: null,
        entries: [],
      });
      const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
      const server = createHttpServer((_req, res) => res.writeHead(200).end(rawManifest));
      const gatewayUrl = await listen(server);
      await fs.chmod(root, 0o770);
      const canonicalRoot = await fs.realpath(root);
      try {
        await expect(
          runNodeWorkerWorkspaceTransfer({
            gatewayUrl,
            environmentId: "environment-permissions",
            workspaceDir,
            manifestHome: root,
            transfer: { direction: "download", token: "test-token", manifestRef },
          }),
        ).rejects.toMatchObject({
          operation: "download",
          stage: "materialize",
          cause: {
            message: expect.stringContaining(
              `State directory ${canonicalRoot} is group-writable without sticky protection; run chmod go-w`,
            ),
          },
        });
        expect(await fs.readFile(path.join(workspaceDir, "sentinel.txt"), "utf8")).toBe("keep me");
        expect((await fs.stat(root)).mode & 0o777).toBe(0o770);
      } finally {
        await fs.chmod(root, 0o700);
        await closeServer(server);
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "preserves foreign executable modes through Windows workspace downloads and uploads",
    async () => {
      const { root, workspaceDir, download, upload } = fixture("windows-executable");
      const original = Buffer.from("#!/bin/sh\necho before\n");
      const sha256 = digest(original);
      const { rawManifest, manifestRef } = manifestFixture([
        fileEntry("script.sh", original, 0o755),
      ]);
      let uploadedRaw: string | undefined;
      const server = createHttpServer(
        transferHandler(async (req, res) => {
          if (req.url?.endsWith("/manifest")) {
            res.writeHead(200).end(rawManifest);
            return;
          }
          if (req.url?.endsWith(`/blobs/${sha256}`)) {
            res.writeHead(200).end(original);
            return;
          }
          if (req.method === "POST" && req.url?.includes("/reconciliations/")) {
            const { currentRaw, currentRef } = await readUpload(req);
            uploadedRaw = currentRaw;
            res.writeHead(200).end(JSON.stringify({ manifestRef: currentRef }));
            return;
          }
          res.writeHead(404).end();
        }),
      );
      const gatewayUrl = await listen(server);
      try {
        await expect(download(gatewayUrl, manifestRef)).resolves.toBe(manifestRef);
        await expect(
          fs.readFile(
            path.join(
              root,
              ".openclaw-worker",
              "manifests",
              `${manifestRef.slice("sha256:".length)}.json`,
            ),
            "utf8",
          ),
        ).resolves.toBe(rawManifest);

        await fs.writeFile(path.join(workspaceDir, "script.sh"), "#!/bin/sh\necho changed\n");
        await fs.writeFile(path.join(workspaceDir, "new.txt"), "new\n");
        const currentRef = await upload(gatewayUrl, manifestRef);
        expect(currentRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
        expect(JSON.parse(uploadedRaw!)).toMatchObject({
          entries: [
            expect.objectContaining({ path: "new.txt", mode: 0o644 }),
            expect.objectContaining({ path: "script.sh", mode: 0o755 }),
          ],
        });
      } finally {
        await closeServer(server);
      }
    },
  );

  it.each(["cut pack", "interrupted replacement"])(
    "preserves the prior workspace after %s",
    async (mode) => {
      const { root, workspaceDir, download, read } = fixture("recovery");
      const recovering = mode === "interrupted replacement";
      const backup = `${workspaceDir}.previous-crash`;
      const staleStaging = path.join(root, ".workspace.workspace-transfer-crash");
      const sentinel = recovering ? "restored\n" : "keep me\n";
      await fs.mkdir(recovering ? backup : workspaceDir);
      await fs.writeFile(path.join(recovering ? backup : workspaceDir, "sentinel.txt"), sentinel);
      if (recovering) {
        await fs.mkdir(staleStaging);
      }
      const { rawManifest, manifestRef } = manifestFixture([], { baseCommit: "a".repeat(40) });
      const server = createHttpServer((req, res) => {
        if (req.url?.endsWith("/manifest")) {
          res.writeHead(200, { "content-length": String(Buffer.byteLength(rawManifest)) });
          res.end(rawManifest);
          return;
        }
        if (!recovering && req.url?.endsWith("/pack")) {
          res.writeHead(200, { "content-length": "1024" });
          res.write("truncated");
          res.destroy();
          return;
        }
        res.writeHead(recovering ? 500 : 404).end();
      });
      const gatewayUrl = await listen(server);
      try {
        await expect(download(gatewayUrl, manifestRef)).rejects.toThrow(
          "workspace-transfer-failed",
        );
        await expect(read("sentinel.txt")).resolves.toBe(sentinel);
        expect(
          (await fs.readdir(root)).filter((entry) =>
            entry.startsWith(".workspace.workspace-transfer-"),
          ),
        ).toEqual([]);
        if (recovering) {
          await expect(fs.access(staleStaging)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        await closeServer(server);
      }
    },
  );

  it.each(["download", "next entry cleanup"] as const)(
    "keeps mutations inside staging after parent replacement during %s",
    async (replacement) => {
      const { root, workspaceDir, download, read } = fixture("parent-swap");
      const outside = path.join(root, "outside");
      await fs.mkdir(workspaceDir);
      await fs.writeFile(path.join(workspaceDir, "sentinel.txt"), "keep me\n");
      await fs.mkdir(outside);
      const outsideFile = path.join(outside, "result.txt");
      if (replacement === "next entry cleanup") {
        await fs.writeFile(outsideFile, "outside sentinel\n");
      }
      const body = Buffer.from("downloaded workspace content\n");
      const entry = fileEntry("nested/result.txt", body);
      const { sha256 } = entry;
      const { rawManifest, manifestRef } = manifestFixture(
        [
          ...(replacement === "next entry cleanup" ? [{ ...entry, path: "a-trigger.bin" }] : []),
          entry,
        ],
        { directories: ["nested"] },
      );
      let substituted = false;
      const server = createHttpServer(
        transferHandler(async (req, res) => {
          if (req.url?.endsWith("/manifest")) {
            res.writeHead(200).end(rawManifest);
            return;
          }
          if (req.url?.endsWith(`/blobs/${sha256}`)) {
            if (!substituted) {
              const staging = (await fs.readdir(root)).find((name) =>
                name.startsWith(".workspace.workspace-transfer-"),
              );
              if (!staging) {
                throw new Error("test transfer has no staging directory");
              }
              const nested = path.join(root, staging, "nested");
              await fs.rmdir(nested);
              await fs.symlink(outside, nested, "junction");
              substituted = true;
            }
            res.writeHead(200).end(body);
            return;
          }
          res.writeHead(404).end();
        }),
      );
      const gatewayUrl = await listen(server);
      try {
        await expect(download(gatewayUrl, manifestRef)).rejects.toThrow(
          "workspace-transfer-failed",
        );
        expect(substituted).toBe(true);
        if (replacement === "next entry cleanup") {
          expect(await fs.readFile(outsideFile, "utf8")).toBe("outside sentinel\n");
        } else {
          expect(await fs.readdir(outside)).toEqual([]);
        }
        expect(await read("sentinel.txt")).toBe("keep me\n");
        expect(
          (await fs.readdir(root)).filter((name) =>
            name.startsWith(".workspace.workspace-transfer-"),
          ),
        ).toEqual([]);
      } finally {
        await closeServer(server);
      }
    },
  );

  it("reuses the validated TLS pin for a pooled socket and downloads literal tilde paths", async () => {
    const { workspaceDir, download, upload, read } = fixture("tls");
    const body = Buffer.from("pinned transfer\n");
    const sha256 = digest(body);
    const { rawManifest, manifestRef } = manifestFixture([fileEntry("~/result.txt", body)], {
      directories: ["~"],
    });
    let requestCount = 0;
    let connectionCount = 0;
    let uploadManifestRef: string | undefined;
    const server = createHttpsServer(
      { cert: TEST_TLS_CERT_PEM, key: TEST_TLS_KEY_PEM },
      workspaceTransferHandler(
        rawManifest,
        new Map([[sha256, body]]),
        () => uploadManifestRef,
        true,
      ),
    );
    server.on("request", () => {
      requestCount += 1;
    });
    server.on("secureConnection", () => {
      connectionCount += 1;
    });
    const gatewayUrl = (await listen(server)).replace(/^ws/u, "wss");
    const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
    const gatewayPort = Number(new URL(gatewayUrl).port);
    let hidPeerCertificate = false;
    const pinnedAgent = https.globalAgent;
    const hidePeerCertificate = (socket: Socket) => {
      if (socket.remotePort !== gatewayPort || hidPeerCertificate) {
        return;
      }
      hidPeerCertificate = true;
      (socket as TLSSocket).getPeerCertificate = (() => ({})) as TLSSocket["getPeerCertificate"];
    };
    pinnedAgent.on("free", hidePeerCertificate);
    try {
      await expect(
        download(gatewayUrl, manifestRef, { gatewayTlsFingerprint: fingerprint }),
      ).resolves.toBe(manifestRef);
      await expect(read("~/result.txt")).resolves.toBe("pinned transfer\n");
      expect(requestCount).toBe(2);
      expect(connectionCount).toBe(1);
      expect(hidPeerCertificate).toBe(true);

      await fs.writeFile(path.join(workspaceDir, "changed.txt"), "changed on node\n");
      uploadManifestRef = (await captureWorkspaceManifest({ root: workspaceDir, baseCommit: null }))
        .manifestRef;
      await expect(
        upload(gatewayUrl, manifestRef, { gatewayTlsFingerprint: fingerprint }),
      ).resolves.toBe(uploadManifestRef);
      expect(requestCount).toBe(3);
      expect(connectionCount).toBe(1);
    } finally {
      pinnedAgent.off("free", hidePeerCertificate);
      await closeServer(server);
    }
  });

  it("performs a full pinned handshake on a replacement socket", async () => {
    const { download } = fixture("tls-resumed");
    const body = Buffer.from("resumed pinned transfer\n");
    const sha256 = digest(body);
    const { rawManifest, manifestRef } = manifestFixture([fileEntry("result.txt", body)]);
    const sessionReuse: boolean[] = [];
    const server = createHttpsServer(
      {
        cert: TEST_TLS_CERT_PEM,
        key: TEST_TLS_KEY_PEM,
        maxVersion: "TLSv1.2",
      },
      (req, res) => {
        if (req.url?.endsWith("/manifest")) {
          res.writeHead(200, {
            connection: "close",
            "content-length": String(Buffer.byteLength(rawManifest)),
          });
          res.end(rawManifest);
          return;
        }
        if (req.url?.endsWith(`/blobs/${sha256}`)) {
          res.writeHead(200, {
            connection: "close",
            "content-length": String(body.byteLength),
          });
          res.end(body);
          return;
        }
        res.writeHead(404, { connection: "close" }).end();
      },
    );
    let secureConnections = 0;
    server.on("secureConnection", (socket) => {
      secureConnections += 1;
      if (typeof socket.isSessionReused === "function") {
        sessionReuse.push(socket.isSessionReused());
      }
    });
    const gatewayUrl = (await listen(server)).replace(/^ws/u, "wss");
    const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
    try {
      await expect(
        download(gatewayUrl, manifestRef, { gatewayTlsFingerprint: fingerprint }),
      ).resolves.toBe(manifestRef);
      expect(secureConnections).toBe(2);
      expect(sessionReuse.every((reused) => !reused)).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("preserves managed proxy routing for pinned transfers", async () => {
    const { download } = fixture("tls-proxy");
    const { rawManifest, manifestRef } = manifestFixture();
    const target = createHttpsServer(
      { cert: TEST_TLS_CERT_PEM, key: TEST_TLS_KEY_PEM },
      (_req, res) => {
        res.writeHead(200, { "content-length": String(Buffer.byteLength(rawManifest)) });
        res.end(rawManifest);
      },
    );
    const gatewayUrl = (await listen(target)).replace(/^ws/u, "wss");
    const proxyTunnels = new Set<{ client: Duplex; upstream: Duplex }>();
    let connectCount = 0;
    const proxy = createHttpServer();
    proxy.on("connect", (req, clientSocket, head) => {
      connectCount += 1;
      const destination = new URL(`http://${req.url}`);
      const upstream = connectNet(Number(destination.port), destination.hostname, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.byteLength > 0) {
          upstream.write(head);
        }
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      const tunnel = { client: clientSocket, upstream };
      proxyTunnels.add(tunnel);
      // A CONNECT tunnel owns both socket halves. Once either half closes or
      // errors, retire the pair so teardown cannot reset an unowned peer.
      const closeTunnel = () => {
        proxyTunnels.delete(tunnel);
        clientSocket.destroy();
        upstream.destroy();
      };
      clientSocket.once("close", closeTunnel);
      clientSocket.once("error", closeTunnel);
      upstream.once("close", closeTunnel);
      upstream.once("error", closeTunnel);
    });
    const proxyUrl = (await listen(proxy)).replace(/^ws/u, "http");
    const proxyHandle = installGlobalProxy({ mode: "managed", proxyUrl });
    const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
    try {
      await expect(
        download(gatewayUrl, manifestRef, { gatewayTlsFingerprint: fingerprint }),
      ).resolves.toBe(manifestRef);
      expect(connectCount).toBe(1);
    } finally {
      const tunnelClosures = [...proxyTunnels].flatMap((tunnel) =>
        [tunnel.client, tunnel.upstream].map(
          (socket) =>
            new Promise<void>((resolve) => {
              if (socket.destroyed) {
                resolve();
                return;
              }
              socket.once("close", resolve);
            }),
        ),
      );
      proxyHandle.stop();
      for (const tunnel of proxyTunnels) {
        tunnel.client.destroy();
        tunnel.upstream.destroy();
      }
      await Promise.all(tunnelClosures);
      await Promise.all([closeServer(proxy), closeServer(target)]);
    }
  });

  it("rejects a wrong TLS pin on a new socket", async () => {
    const { download } = fixture("wrong-pin");
    const { rawManifest, manifestRef } = manifestFixture();
    let requestCount = 0;
    const server = createHttpsServer(
      { cert: TEST_TLS_CERT_PEM, key: TEST_TLS_KEY_PEM },
      (_req, res) => {
        requestCount += 1;
        res.writeHead(200).end(rawManifest);
      },
    );
    const gatewayUrl = (await listen(server)).replace(/^ws/u, "wss");
    try {
      await expect(
        download(gatewayUrl, manifestRef, { gatewayTlsFingerprint: "00".repeat(32) }),
      ).rejects.toThrow("gateway TLS fingerprint mismatch");
      expect(requestCount).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it.each([
    {
      reason: "file_digest",
      expected:
        /^workspace-transfer-invalid: gateway rejected workspace transfer payload \(file_digest\)$/u,
    },
    {
      reason: "private gateway detail",
      expected: /^workspace-transfer-failed: gateway returned 400$/u,
    },
  ])(
    "preserves only safe gateway upload rejection reasons ($reason)",
    async ({ reason, expected }) => {
      const { download } = fixture("reason");
      const manifestRef = `sha256:${"a".repeat(64)}`;
      const server = createHttpServer((_req, res) => {
        const body = Buffer.from(JSON.stringify({ error: "workspace_transfer_invalid", reason }));
        res.writeHead(400, {
          "content-type": "application/json",
          "content-length": String(body.byteLength),
        });
        res.end(body);
      });
      const gatewayUrl = await listen(server);
      try {
        await expect(download(gatewayUrl, manifestRef)).rejects.toThrow(expected);
      } finally {
        await closeServer(server);
      }
    },
  );

  it("uploads the captured snapshot when the live workspace changes before transmission", async () => {
    const { workspaceDir, download, upload } = fixture("snapshot");
    const workspaceFile = path.join(workspaceDir, "result.txt");
    const baseBody = Buffer.from("base\n");
    const baseSha256 = digest(baseBody);
    const { rawManifest: baseRaw, manifestRef: baseRef } = manifestFixture([
      fileEntry("result.txt", baseBody),
    ]);
    const server = createHttpServer(
      transferHandler(async (req, res) => {
        if (req.url?.endsWith("/manifest")) {
          res.writeHead(200, { "content-length": String(Buffer.byteLength(baseRaw)) });
          res.end(baseRaw);
          return;
        }
        if (req.url?.endsWith(`/blobs/${baseSha256}`)) {
          res.writeHead(200, { "content-length": String(baseBody.byteLength) });
          res.end(baseBody);
          return;
        }
        if (req.method === "POST" && req.url?.includes("/reconciliations/")) {
          const { body, fileHeader, currentRaw, currentRef } = await readUpload(req);
          const current = parseWorkerWorkspaceManifest(currentRaw, currentRef);
          const entry = current.entries.find(
            (candidate) => candidate.path === "result.txt" && candidate.type === "file",
          );
          const declaredSize = body.readBigUInt64BE(fileHeader);
          const uploaded = body.subarray(fileHeader + 8);
          const valid =
            entry?.type === "file" &&
            declaredSize === BigInt(entry.size) &&
            uploaded.byteLength === entry.size &&
            digest(uploaded) === entry.sha256;
          if (!valid) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "workspace_transfer_invalid", reason: "file_digest" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ manifestRef: currentRef }));
          return;
        }
        res.writeHead(404).end();
      }),
    );
    const gatewayUrl = await listen(server);
    const request = http.request.bind(http);
    let mutated = false;
    const requestSpy = vi.spyOn(http, "request").mockImplementation(((
      url: string | URL,
      options: RequestOptions,
    ) => {
      if (options.method === "POST") {
        fsSync.writeFileSync(workspaceFile, "mutated!\n");
        mutated = true;
      }
      return request(url, options);
    }) as typeof http.request);
    try {
      await expect(download(gatewayUrl, baseRef)).resolves.toBe(baseRef);
      await fs.writeFile(
        workspaceFile,
        Buffer.concat([
          Buffer.alloc(512 * 1024, "a"),
          Buffer.alloc(512 * 1024, "b"),
          Buffer.from("captured tail\n"),
        ]),
      );
      const currentRef = (await captureWorkspaceManifest({ root: workspaceDir, baseCommit: null }))
        .manifestRef;
      await expect(upload(gatewayUrl, baseRef)).resolves.toBe(currentRef);
      expect(mutated).toBe(true);
      await expect(fs.readFile(workspaceFile, "utf8")).resolves.toBe("mutated!\n");
    } finally {
      requestSpy.mockRestore();
      await closeServer(server);
    }
  });

  it("downloads complete files and cleans up upload backpressure listeners", async () => {
    const { workspaceDir, download, upload } = fixture("backpressure");
    const body = Buffer.alloc(2 * 1024 * 1024, "a");
    const sha256 = digest(body);
    const { rawManifest, manifestRef } = manifestFixture([fileEntry("large.bin", body)]);
    let uploadManifestRef: string | undefined;
    const server = createHttpServer(
      workspaceTransferHandler(
        rawManifest,
        new Map([[sha256, body]]),
        () => uploadManifestRef,
        true,
      ),
    );
    const requestProbes: DrainProbe[] = [];
    const request = http.request.bind(http);
    const requestSpy = vi.spyOn(http, "request").mockImplementation(((
      url: URL,
      options: RequestOptions,
    ) => {
      const clientRequest = request(url, options);
      requestProbes.push(observeDrainListeners(clientRequest));
      return clientRequest;
    }) as typeof http.request);
    const gatewayUrl = await listen(server);
    try {
      await expect(download(gatewayUrl, manifestRef)).resolves.toBe(manifestRef);
      deepStrictEqual(await fs.readFile(path.join(workspaceDir, "large.bin")), body);

      await fs.writeFile(path.join(workspaceDir, "large.bin"), Buffer.alloc(body.byteLength, "b"));
      uploadManifestRef = (await captureWorkspaceManifest({ root: workspaceDir, baseCommit: null }))
        .manifestRef;
      await expect(upload(gatewayUrl, manifestRef)).resolves.toBe(uploadManifestRef);

      const requestProbe = requestProbes.find((probe) => probe.drains > 10);
      if (!process.versions.bun) {
        expect(requestProbe).toBeDefined();
      }
      if (requestProbe) {
        expect(requestProbe.drains).toBeGreaterThan(10);
        expect(requestProbe.maxErrorListeners).toBeLessThanOrEqual(2);
      }
      expect(requestProbes.every((probe) => probe.emitter.listenerCount("error") === 0)).toBe(true);
    } finally {
      requestSpy.mockRestore();
      await closeServer(server);
    }
  });
});
