import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { ensureStagedInputDirectory, stagedInputDirectory } from "../../media/staged-inputs.js";
import { runNodeWorkerWorkspaceTransfer } from "../../node-host/node-worker-transfer-client.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { nodeWorkspaceTransferReconcilePath } from "../../worker/node-workspace-transfer-protocol.js";
import { hashWorkerCredential } from "./credential.js";
import {
  createNodeWorkspaceTransferHttpCallback,
  handleNodeWorkspaceTransferHttpRequest,
} from "./node-workspace-transfer-http.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { createWorkerEnvironmentStore } from "./store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

describe("workspace upload cancellation", () => {
  it.each([
    { boundary: "before handler", cancellation: "none" },
    { boundary: "before handler", cancellation: "owner" },
    { boundary: "before handler", cancellation: "discard" },
    { boundary: "after body", cancellation: "none" },
    { boundary: "after body", cancellation: "owner" },
    { boundary: "after body", cancellation: "discard" },
    { boundary: "after body", cancellation: "discard-and-close" },
    { boundary: "after body", cancellation: "discard-and-fail" },
  ] as const)("settles $boundary with $cancellation", async ({ boundary, cancellation }) => {
    const root = tempDirs.make("workspace-upload-cancellation-");
    const localPath = path.join(root, "source");
    await fs.mkdir(localPath);
    const owner = new AbortController();
    const service = createNodeWorkspaceTransferService({
      temporaryRoot: path.join(root, "transfers"),
      getOwner: () => ({
        credential: { ownerEpoch: 1, sessionId: "session" },
        environment: {
          ownerEpoch: 1,
          attachedSessionIds: ["session"],
          destroyRequestedAtMs: null,
          state: "attached",
        },
      }),
    });
    const { snapshot } = await service.prepareSync({
      environmentId: "environment",
      ownerEpoch: 1,
      sessionId: "session",
      generation: 1,
      localPath,
      isAuthorized: () => !owner.signal.aborted,
      signal: owner.signal,
    });
    const token = service.prepareUpload("environment", snapshot.manifestRef);
    const reached = createDeferred();
    const release = createDeferred();
    const finished = createDeferred();
    if (boundary === "after body") {
      const realpath = fs.realpath.bind(fs);
      vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
        if (typeof args[0] === "string" && path.basename(args[0]).startsWith("upload-")) {
          // Staged-manifest verification happens after the reader consumes EOF.
          reached.resolve();
          await release.promise;
          if (cancellation === "discard-and-fail") {
            throw new Error("Staging validation failed while discard was waiting");
          }
        }
        return await realpath(...args);
      });
    }
    let incoming: IncomingMessage | undefined;
    const callback = createNodeWorkspaceTransferHttpCallback(service);
    const server = createServer((req, res) => {
      incoming = req;
      void handleNodeWorkspaceTransferHttpRequest({
        req,
        res,
        clientIp: "127.0.0.1",
        callback: async (request) => {
          const authorized = await callback(request);
          if (boundary === "before handler") {
            reached.resolve();
            await release.promise;
          }
          return authorized;
        },
      })
        .catch((error: unknown) =>
          res.destroy(error instanceof Error ? error : new Error(String(error))),
        )
        .finally(() => finished.resolve());
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP fixture did not bind");
    }
    const raw = Buffer.from(snapshot.rawManifest);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(raw.length);
    const request = fetch(
      `http://127.0.0.1:${address.port}${nodeWorkspaceTransferReconcilePath("environment", snapshot.manifestRef)}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: Buffer.concat([length, raw, length, raw]),
      },
    ).then(
      async (response) => ({ status: response.status, body: await response.json() }),
      () => "rejected" as const,
    );
    let cleanup: Promise<unknown> | undefined;
    let cleanupSettled = false;
    let expectedDisposalError: unknown;
    try {
      await withTestTimeout(reached.promise, 2_000, "upload did not reach cancellation boundary");
      if (boundary === "after body") {
        expect(incoming?.readableEnded).toBe(true);
        expect(incoming?.destroyed).toBe(true);
      }
      if (cancellation === "owner") {
        owner.abort(new Error("Workspace transfer owner closed"));
      }
      if (cancellation.startsWith("discard")) {
        cleanup = Promise.all([
          service.discardUpload("environment", token),
          service.discardUpload("environment", token),
          ...(cancellation === "discard-and-close" ? [service.close("environment")] : []),
        ]).then(() => {
          cleanupSettled = true;
        });
        void cleanup.catch(() => undefined);
        if (boundary === "before handler") {
          await withTestTimeout(cleanup, 2_000, "discard waited for an unstarted handler");
        } else {
          expect(() => service.prepareUpload("environment", snapshot.manifestRef)).toThrow();
        }
      }
      if (cancellation === "none" || boundary === "before handler") {
        release.resolve();
      }
      const result = await withTestTimeout(request, 2_000, "upload response remained open");
      if (cleanup && boundary === "after body") {
        expect(cleanupSettled, "cleanup must join blocked staging validation").toBe(false);
      }
      release.resolve();
      await finished.promise;
      if (cancellation === "discard-and-fail") {
        await expect(
          cleanup?.catch((error: unknown) => {
            expectedDisposalError = error;
            throw error;
          }),
        ).rejects.toThrow("payload did not match its staged result");
      } else {
        await cleanup;
      }
      if (cancellation !== "none") {
        expect(result).toBe("rejected");
        expect(() => service.takeUpload("environment", snapshot.manifestRef)).toThrow();
      } else {
        expect(result).toEqual({ status: 200, body: { manifestRef: snapshot.manifestRef } });
        expect(service.takeUpload("environment", snapshot.manifestRef).currentManifestRef).toBe(
          snapshot.manifestRef,
        );
      }
      if (cancellation === "discard" || cancellation === "discard-and-fail") {
        const replacement = service.prepareUpload("environment", snapshot.manifestRef);
        await service.discardUpload("environment", token);
        expect(() => service.prepareUpload("environment", snapshot.manifestRef)).toThrow(
          "already active",
        );
        await service.discardUpload("environment", replacement);
      }
    } finally {
      release.resolve();
      server.closeAllConnections();
      await request;
      await finished.promise;
      await cleanup?.catch(() => undefined);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await service.closeAll().catch((error: unknown) => {
        if (error !== expectedDisposalError) {
          throw error;
        }
      });
    }
  });
});

describe("attachment transfer revocation", () => {
  it.each([
    { boundary: "blob-admitted", revoke: false },
    { boundary: "blob-admitted", revoke: true },
    { boundary: "before-create-entry", revoke: false },
    { boundary: "before-create-entry", revoke: true },
    { boundary: "inside-create-before-open", revoke: false },
    { boundary: "inside-create-before-open", revoke: true },
    { boundary: "inside-create-after-open", revoke: false },
    { boundary: "inside-create-after-open", revoke: true },
    { boundary: "inside-final-create", revoke: false },
    { boundary: "inside-final-create", revoke: true },
  ] as const)("$boundary revoked=$revoke", async ({ boundary, revoke }) => {
    const root = await fs.realpath(tempDirs.make("attachment-revocation-"));
    const workspaceDir = path.join(root, "workspace");
    const source = path.join(root, "source");
    const directory = stagedInputDirectory("a".repeat(64));
    const fresh = `${directory}/input-new.txt`;
    const subsequent = `${directory}/input-subsequent.txt`;
    const existing = `${directory}/input-existing.txt`;
    await fs.mkdir(workspaceDir);
    await fs.mkdir(source);
    for (const parent of [workspaceDir, source]) {
      await ensureStagedInputDirectory(parent, directory);
    }
    await fs.writeFile(path.join(workspaceDir, "project.txt"), "unrelated project");
    await fs.writeFile(path.join(workspaceDir, existing), "prior worker edit");
    await fs.writeFile(path.join(source, existing), "original attachment");
    await fs.writeFile(path.join(source, fresh), "private new input");
    await fs.writeFile(path.join(source, subsequent), "subsequent private input");
    const controller = new AbortController();
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef("attachment-revocation"),
      facts: {
        runId: "attachment-revocation",
        agentId: "main",
        ingress: { kind: "worker", boundary: "test.attachment-transfer", state: "present" },
      },
    });
    const admitted = await admission.admit("worker");
    let reached = false;
    const crossBoundary = () => {
      reached = true;
      if (revoke) {
        admission.close();
        controller.abort(new Error("Exact turn revoked during transfer"));
      }
    };
    const service = createNodeWorkspaceTransferService({
      getOwner: () => ({
        credential: { ownerEpoch: 1, sessionId: "session", expiresAtMs: Date.now() + 60_000 },
        environment: {
          ownerEpoch: 1,
          attachedSessionIds: ["session"],
          destroyRequestedAtMs: null,
          state: "attached",
        },
      }),
      temporaryRoot: path.join(root, "transfer-tmp"),
    });
    await service.prepareSync({
      environmentId: "environment",
      ownerEpoch: 1,
      sessionId: "session",
      generation: 1,
      localPath: workspaceDir,
      isAuthorized: () => true,
    });
    const attachmentRequest = {
      environmentId: "environment",
      localPath: source,
      isAuthorized: () => getAdmittedRunDelegatedAuthority(admitted) !== undefined,
      signal: controller.signal,
    };
    const prepared = await service.prepareAttachments(attachmentRequest);
    const entry = prepared.snapshot.manifest.entries.find(
      (candidate) => candidate.path === (boundary === "blob-admitted" ? subsequent : fresh),
    );
    if (entry?.type !== "file") {
      throw new Error("Missing attachment fixture");
    }
    const callback = createNodeWorkspaceTransferHttpCallback(service);
    const server = createServer((req, res) => {
      if (boundary === "blob-admitted" && req.url?.endsWith(`/blobs/${entry.sha256}`)) {
        const writeHead = res.writeHead.bind(res);
        res.writeHead = ((...args: Parameters<typeof res.writeHead>) => {
          const result = writeHead(...args);
          if (res.statusCode === 200) {
            crossBoundary();
          }
          return result;
        }) as typeof res.writeHead;
      }
      void handleNodeWorkspaceTransferHttpRequest({
        req,
        res,
        clientIp: "127.0.0.1",
        callback,
      }).catch((error: unknown) =>
        res.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    });
    const readsAfterRevocation: string[] = [];
    const originalReadFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const file = typeof args[0] === "string" ? args[0] : "";
      const installing = file.includes(".workspace.workspace-transfer-");
      if (installing && reached && revoke) {
        readsAfterRevocation.push(file);
      }
      const data = await originalReadFile(...args);
      // The real staging read finishes before the installer calls Root.create().
      if (installing && file.endsWith(fresh) && boundary === "before-create-entry") {
        crossBoundary();
      }
      return data;
    });
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const creation =
        args[0] ===
          path.join(workspaceDir, boundary === "inside-final-create" ? subsequent : fresh) &&
        typeof args[1] === "number" &&
        (args[1] & fsSync.constants.O_CREAT) !== 0;
      if (creation && boundary === "inside-create-before-open") {
        crossBoundary();
      }
      const handle = await originalOpen(...args);
      if (
        creation &&
        (boundary === "inside-create-after-open" || boundary === "inside-final-create")
      ) {
        crossBoundary();
      }
      return handle;
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP fixture did not bind");
    }
    try {
      const result = await runNodeWorkerWorkspaceTransfer({
        gatewayUrl: `ws://127.0.0.1:${address.port}`,
        environmentId: "environment",
        workspaceDir,
        manifestHome: root,
        transfer: {
          direction: "download",
          token: prepared.token,
          manifestRef: prepared.snapshot.manifestRef,
          attachments: true,
        },
        // At blob admission only the Gateway stream receives cancellation.
        signal: boundary === "blob-admitted" ? undefined : controller.signal,
      }).then(
        () => "completed",
        () => "rejected",
      );
      expect(reached).toBe(true);
      await expect(fs.readFile(path.join(workspaceDir, existing), "utf8")).resolves.toBe(
        "prior worker edit",
      );
      await expect(fs.readFile(path.join(workspaceDir, "project.txt"), "utf8")).resolves.toBe(
        "unrelated project",
      );
      expect(
        (await fs.readdir(root)).filter((name) =>
          name.startsWith(".workspace.workspace-transfer-"),
        ),
      ).toEqual([]);
      if (revoke) {
        expect.soft(result).toBe("rejected");
        expect.soft(readsAfterRevocation).toEqual([]);
        if (boundary.startsWith("inside-")) {
          // fs-safe 0.7.0 cannot cancel or identity-roll back an entered create.
          await expect(fs.readFile(path.join(workspaceDir, fresh), "utf8")).resolves.toBe(
            "private new input",
          );
        } else {
          await expect(fs.stat(path.join(workspaceDir, fresh))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        if (boundary === "inside-final-create") {
          await expect(fs.readFile(path.join(workspaceDir, subsequent), "utf8")).resolves.toBe(
            "subsequent private input",
          );
        } else {
          await expect(fs.stat(path.join(workspaceDir, subsequent))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      } else {
        expect(result).toBe("completed");
        await expect(fs.readFile(path.join(workspaceDir, subsequent), "utf8")).resolves.toBe(
          "subsequent private input",
        );
        await expect(fs.readFile(path.join(workspaceDir, fresh), "utf8")).resolves.toBe(
          "private new input",
        );
      }
    } finally {
      admission.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await service.closeAll();
    }
  });
});

describe("durable credential revocation fencing", () => {
  const makeService = (root: string) =>
    createNodeWorkspaceTransferService({
      temporaryRoot: path.join(root, "transfers"),
      getOwner: () => ({
        credential: { ownerEpoch: 1, sessionId: "session" },
        environment: {
          ownerEpoch: 1,
          attachedSessionIds: ["session"],
          destroyRequestedAtMs: null,
          state: "attached",
        },
      }),
    });

  it("fenceEnvironment aborts capability signals and denies new admissions", async () => {
    const root = tempDirs.make("workspace-transfer-fence-");
    const localPath = path.join(root, "source");
    await fs.mkdir(localPath);
    const service = makeService(root);
    await service.initialize();
    try {
      const { snapshot, token } = await service.prepareSync({
        environmentId: "environment",
        ownerEpoch: 1,
        sessionId: "session",
        generation: 1,
        localPath,
        isAuthorized: () => true,
      });
      const route = {
        kind: "manifest",
        direction: "download",
        environmentId: "environment",
        manifestRef: snapshot.manifestRef,
      } as const;
      const authorization = service.authorize({ route, token });
      expect(authorization).toBeDefined();
      if (!authorization) {
        throw new Error("authorization missing before fence");
      }
      const signal = service.authorizationSignal(authorization);
      expect(signal.aborted).toBe(false);

      service.fenceEnvironment("environment");

      expect(signal.aborted).toBe(true);
      expect(service.isAuthorizationCurrent(authorization)).toBe(false);
      expect(service.authorize({ route, token })).toBeUndefined();
    } finally {
      await service.closeAll().catch(() => undefined);
    }
  });

  it("a fencing revocation stops an in-flight blob response", async () => {
    const root = tempDirs.make("workspace-transfer-revoke-blob-");
    const localPath = path.join(root, "source");
    await fs.mkdir(localPath);
    // Large enough that the HTTP client cannot buffer the whole body before the fence.
    const payload = Buffer.alloc(8 * 1024 * 1024, 0x53);
    await fs.writeFile(path.join(localPath, "secret.txt"), payload);
    const service = makeService(root);
    await service.initialize();
    const { snapshot, token } = await service.prepareSync({
      environmentId: "environment",
      ownerEpoch: 1,
      sessionId: "session",
      generation: 1,
      localPath,
      isAuthorized: () => true,
    });
    const entry = snapshot.manifest.entries.find((candidate) => candidate.path === "secret.txt");
    if (!entry || entry.type !== "file") {
      throw new Error("snapshot missing proof file");
    }
    const callback = createNodeWorkspaceTransferHttpCallback(service);
    const server = createServer((req, res) => {
      void handleNodeWorkspaceTransferHttpRequest({
        req,
        res,
        clientIp: "127.0.0.1",
        callback,
      }).catch((error: unknown) =>
        res.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP fixture did not bind");
    }
    const controller = new AbortController();
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/__openclaw__/worker-transfer/v1/environments/environment/blobs/${entry.sha256}`,
        { headers: { authorization: `Bearer ${token}` }, signal: controller.signal },
      );
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("blob response has no body");
      }
      let bytes = 0;
      // Confirm the stream is live, then fence while most of the body is unconsumed.
      const first = await reader.read();
      bytes += first.value?.byteLength ?? 0;
      service.fenceEnvironment("environment");
      const drained = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            return;
          }
          bytes += value.byteLength;
        }
      })();
      await Promise.allSettled([drained]);
      // The aborted response must not have delivered the whole workspace blob.
      expect(bytes).toBeLessThan(payload.byteLength);
      const route = {
        kind: "blob",
        direction: "download",
        environmentId: "environment",
        sha256: entry.sha256,
      } as const;
      expect(service.authorize({ route, token })).toBeUndefined();
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await service.closeAll().catch(() => undefined);
    }
  });
});

describe("durable credential revocation fencing through the real store", () => {
  it("a permanent store revocation fences an in-flight blob response end to end", async () => {
    const root = tempDirs.make("workspace-transfer-store-fence-");
    const localPath = path.join(root, "source");
    await fs.mkdir(localPath);
    const payload = Buffer.alloc(8 * 1024 * 1024, 0x53);
    await fs.writeFile(path.join(localPath, "secret.txt"), payload);

    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
    });
    const store = createWorkerEnvironmentStore({ database, now: () => 1_000 });
    const environmentId = "worker-store-fence";
    const sessionId = "session-store-fence";
    store.createIntent({
      environmentId,
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot: { settings: { region: "test" }, lifetime: { idleMinutes: 10 } },
      provisionOperationId: `provision:${environmentId}`,
    });
    store.transition({ environmentId, from: "requested", to: "provisioning" });
    const bootstrapping = store.transition({
      environmentId,
      from: "provisioning",
      to: "bootstrapping",
      patch: {
        leaseId: "lease-store-fence",
        sshEndpoint: {
          host: "worker.example.test",
          port: 2222,
          fallbackPorts: [22],
          user: "openclaw",
          hostKey: ["ssh-ed25519", "AAAA"].join(" "),
          keyRef: { source: "file", provider: "worker-keys", id: "/static-development-key" },
        },
      },
    });
    store.transition({
      environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: {
        bootstrapReceipt: {
          bundleHash: "a".repeat(64),
          openclawVersion: "2026.7.1",
          protocolFeatures: ["workspace-sync-v1", "model-proxy-v1"],
        },
        credential: {
          credentialHash: hashWorkerCredential(["worker", "store-fence", "bootstrap"].join("-")),
          sessionId: null,
          rpcSetVersion: 1,
          expiresAtMs: 11_000,
        },
      },
    });
    const attached = store.transition({
      environmentId,
      from: "ready",
      to: "attached",
      patch: {
        attachedSessionIds: [sessionId],
        credential: {
          credentialHash: hashWorkerCredential(["worker", "store-fence", sessionId].join("-")),
          sessionId,
          rpcSetVersion: 1,
          expiresAtMs: 11_000,
        },
      },
    });
    const ownerEpoch = attached.ownerEpoch;

    const service = createNodeWorkspaceTransferService({
      temporaryRoot: path.join(root, "transfers"),
      getOwner: (id) => store.getTransferOwner(id),
    });
    await service.initialize();
    // Real wiring, exactly as gateway startup installs it: store revocations fence the
    // transfer service; rotation-style revocations without the flag never do.
    const unsubscribe = store.onCredentialRevoked((id) => {
      service.fenceEnvironment(id);
    });

    const { snapshot, token } = await service.prepareSync({
      environmentId,
      ownerEpoch,
      sessionId,
      generation: ownerEpoch,
      localPath,
      isAuthorized: () => true,
    });
    const entry = snapshot.manifest.entries.find((candidate) => candidate.path === "secret.txt");
    if (!entry || entry.type !== "file") {
      throw new Error("snapshot missing proof file");
    }
    const route = {
      kind: "blob",
      direction: "download",
      environmentId,
      sha256: entry.sha256,
    } as const;
    const authorization = service.authorize({ route, token });
    expect(authorization).toBeDefined();

    const callback = createNodeWorkspaceTransferHttpCallback(service);
    const server = createServer((req, res) => {
      void handleNodeWorkspaceTransferHttpRequest({
        req,
        res,
        clientIp: "127.0.0.1",
        callback,
      }).catch((error: unknown) =>
        res.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP fixture did not bind");
    }
    const controller = new AbortController();
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/__openclaw__/worker-transfer/v1/environments/${environmentId}/blobs/${entry.sha256}`,
        { headers: { authorization: `Bearer ${token}` }, signal: controller.signal },
      );
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("blob response has no body");
      }
      let bytes = 0;
      const first = await reader.read();
      bytes += first.value?.byteLength ?? 0;

      // Permanent revocation through the real store drives the fence end to end.
      store.revokeEnvironmentCredential(environmentId, { fenceWorkspaceTransfers: true });

      const drained = (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              return;
            }
            bytes += value.byteLength;
          }
        } catch {
          // The fenced response is destroyed mid-body; the client read may reject.
        }
      })();
      await Promise.allSettled([drained]);
      expect(bytes).toBeLessThan(payload.byteLength);
      expect(service.isAuthorizationCurrent(authorization!)).toBe(false);
      expect(service.authorize({ route, token })).toBeUndefined();
    } finally {
      unsubscribe();
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await service.closeAll().catch(() => undefined);
      closeOpenClawStateDatabaseForTest();
    }
  });
});
