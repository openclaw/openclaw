import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import * as fsSafe from "../../infra/fs-safe.js";
import { ensureStagedInputDirectory, stagedInputDirectory } from "../../media/staged-inputs.js";
import { runNodeWorkerWorkspaceTransfer } from "../../node-host/node-worker-transfer-client.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { nodeWorkspaceTransferReconcilePath } from "../../worker/node-workspace-transfer-protocol.js";
import { hashWorkerCredential } from "./credential.js";
import { workspaceFiles } from "./node-workspace-transfer-fixtures.test-support.js";
import {
  createNodeWorkspaceTransferHttpCallback,
  handleNodeWorkspaceTransferHttpRequest,
} from "./node-workspace-transfer-http.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { transferOwner } from "./node-workspace-transfer.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { workerCredential } from "./store.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function listen(server: Server) {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP fixture did not bind");
  }
  return `127.0.0.1:${address.port}`;
}

async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

const makeService = (root: string) =>
  createNodeWorkspaceTransferService({
    temporaryRoot: path.join(root, "transfers"),
    getOwner: () => transferOwner("session"),
  });
const prepareSync = (
  service: ReturnType<typeof makeService>,
  localPath: string,
  authority: { isAuthorized: () => boolean; signal?: AbortSignal } = { isAuthorized: () => true },
) =>
  service.prepareSync({
    environmentId: "environment",
    ownerEpoch: 1,
    sessionId: "session",
    localPath,
    ...authority,
  });

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  callback: Parameters<typeof handleNodeWorkspaceTransferHttpRequest>[0]["callback"],
) {
  return handleNodeWorkspaceTransferHttpRequest({
    req,
    res,
    clientIp: "127.0.0.1",
    callback,
  }).catch((error: unknown) =>
    res.destroy(error instanceof Error ? error : new Error(String(error))),
  );
}

it.each([
  { boundary: "before handler", cancellation: "none" },
  { boundary: "before handler", cancellation: "owner" },
  { boundary: "before handler", cancellation: "discard" },
  { boundary: "before handler", cancellation: "revoke" },
  { boundary: "after body", cancellation: "none" },
  { boundary: "after body", cancellation: "owner" },
  { boundary: "after body", cancellation: "discard" },
  { boundary: "after body", cancellation: "revoke" },
  { boundary: "after body", cancellation: "discard-and-close" },
  { boundary: "after body", cancellation: "discard-and-fail" },
] as const)("upload settles $boundary with $cancellation", async ({ boundary, cancellation }) => {
  const root = tempDirs.make("workspace-upload-cancellation-");
  const localPath = path.join(root, "source");
  await fs.mkdir(localPath);
  const owner = new AbortController();
  const service = makeService(root);
  const { snapshot } = await prepareSync(service, localPath, {
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
  let activeAuthorization: ReturnType<typeof service.authorize>;
  const authorize = service.authorize.bind(service);
  vi.spyOn(service, "authorize").mockImplementation((request) => {
    activeAuthorization = authorize(request);
    return activeAuthorization;
  });
  const callback = createNodeWorkspaceTransferHttpCallback(service);
  const server = createServer((req, res) => {
    incoming = req;
    void handleRequest(req, res, async (request) => {
      const authorized = await callback(request);
      if (boundary === "before handler") {
        reached.resolve();
        await release.promise;
      }
      return authorized;
    }).finally(() => finished.resolve());
  });
  const address = await listen(server);
  const raw = Buffer.from(snapshot.rawManifest);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(raw.length);
  const request = fetch(
    `http://${address}${nodeWorkspaceTransferReconcilePath("environment", snapshot.manifestRef)}`,
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
      expect(incoming).toMatchObject({ readableEnded: true, destroyed: true });
    }
    if (cancellation === "owner") {
      owner.abort(new Error("Workspace transfer owner closed"));
    }
    if (cancellation.startsWith("discard") || cancellation === "revoke") {
      const discard =
        cancellation === "revoke"
          ? service.revoke.bind(service)
          : service.discardUpload.bind(service);
      cleanup = Promise.all([
        discard("environment", token),
        discard("environment", token),
        ...(cancellation === "discard-and-close" ? [service.close("environment")] : []),
      ]).then(() => {
        cleanupSettled = true;
      });
      void cleanup.catch(() => undefined);
      expect(activeAuthorization).toBeDefined();
      expect(service.isAuthorizationCurrent(activeAuthorization!)).toBe(false);
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
    if (
      cancellation === "discard" ||
      cancellation === "discard-and-fail" ||
      cancellation === "revoke"
    ) {
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
    await closeServer(server);
    await service.closeAll().catch((error: unknown) => {
      if (error !== expectedDisposalError) {
        throw error;
      }
    });
  }
});

it.each([
  { boundary: "blob-admitted", revoke: false },
  { boundary: "blob-admitted", revoke: true },
  { boundary: "source-open", revoke: false },
  { boundary: "source-open", revoke: true },
  { boundary: "before-stage-open", revoke: false },
  { boundary: "before-stage-open", revoke: true },
  { boundary: "private-stage-created", revoke: false },
  { boundary: "private-stage-created", revoke: true },
  { boundary: "after-publish", revoke: false },
  { boundary: "after-publish", revoke: true },
  { boundary: "after-final-publish", revoke: false },
  { boundary: "after-final-publish", revoke: true },
  { boundary: "after-publish-replaced", revoke: true },
] as const)("attachment $boundary revoked=$revoke", async ({ boundary, revoke }) => {
  const root = await fs.realpath(tempDirs.make("attachment-revocation-"));
  const workspaceDir = path.join(root, "workspace");
  const files = workspaceFiles(workspaceDir);
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
    getOwner: () => transferOwner("session", 1, Date.now() + 60_000),
    temporaryRoot: path.join(root, "transfer-tmp"),
  });
  await prepareSync(service, workspaceDir);
  const prepared = await service.prepareAttachments({
    environmentId: "environment",
    localPath: source,
    isAuthorized: () => getAdmittedRunDelegatedAuthority(admitted) !== undefined,
    signal: controller.signal,
  });
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
    void handleRequest(req, res, callback);
  });
  const sourceAccessAfterRevocation: string[] = [];
  const observeSourceAccess = (file: string) => {
    if (file.includes(".workspace.workspace-transfer-") && reached && revoke) {
      sourceAccessAfterRevocation.push(file);
    }
  };
  const originalReadFile = fs.readFile.bind(fs);
  vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
    observeSourceAccess(typeof args[0] === "string" ? args[0] : "");
    return await originalReadFile(...args);
  });
  const stageBoundary = ["before-stage-open", "private-stage-created"].includes(boundary);
  const publishedBoundary = [
    "after-publish",
    "after-final-publish",
    "after-publish-replaced",
  ].includes(boundary);
  const originalRoot = fsSafe.root;
  vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
    const guarded = await originalRoot(...args);
    if (path.basename(guarded.rootReal).startsWith(".workspace.workspace-transfer-")) {
      const open = guarded.open.bind(guarded);
      vi.spyOn(guarded, "open").mockImplementation(async (...openArgs) => {
        const file = path.resolve(guarded.rootReal, openArgs[0]);
        observeSourceAccess(file);
        const opened = await open(...openArgs);
        const read = opened.handle.read.bind(opened.handle);
        vi.spyOn(opened.handle, "read").mockImplementation(async (...readArgs) => {
          observeSourceAccess(file);
          return await read(...readArgs);
        });
        if (file.endsWith(path.normalize(fresh)) && boundary === "source-open") {
          crossBoundary();
        }
        return opened;
      });
    }
    if (guarded.rootReal === workspaceDir) {
      const copyIn = guarded.copyIn.bind(guarded);
      vi.spyOn(guarded, "copyIn").mockImplementation(async (relativePath, input, options) => {
        await copyIn(relativePath, input, {
          ...options,
          assertBeforeMutation: () => {
            options?.assertBeforeMutation?.();
            if (reached || relativePath !== fresh || !stageBoundary) {
              return;
            }
            // Native copying may fill the stage before this mutation fence observes it.
            const stageExists = fsSync
              .readdirSync(path.join(workspaceDir, directory))
              .some((name) => name.startsWith(".fs-safe-"));
            if (stageExists === (boundary === "private-stage-created")) {
              crossBoundary();
            }
          },
          onDestinationPublished: (receipt) => {
            options?.onDestinationPublished?.(receipt);
            const publishedInput = boundary === "after-final-publish" ? subsequent : fresh;
            if (receipt.path === path.join(workspaceDir, publishedInput) && publishedBoundary) {
              if (boundary === "after-publish-replaced") {
                fsSync.unlinkSync(receipt.path);
                fsSync.writeFileSync(receipt.path, "later user replacement", { mode: 0o600 });
              }
              crossBoundary();
            }
          },
        });
      });
    }
    return guarded;
  });
  const address = await listen(server);
  try {
    const result = await runNodeWorkerWorkspaceTransfer({
      gatewayUrl: `ws://${address}`,
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
    await files.expect(existing, "prior worker edit");
    await files.expect("project.txt", "unrelated project");
    for (const [parent, prefix] of [
      [root, ".workspace.workspace-transfer-"],
      [path.join(workspaceDir, directory), ".fs-safe-"],
    ] as const) {
      expect((await fs.readdir(parent)).filter((name) => name.startsWith(prefix))).toEqual([]);
    }
    if (revoke) {
      expect.soft(result).toBe("rejected");
      expect.soft(sourceAccessAfterRevocation).toEqual([]);
    } else {
      expect(result).toBe("completed");
    }
    const expectedInputs = [
      [
        fresh,
        !revoke || publishedBoundary,
        boundary === "after-publish-replaced" ? "later user replacement" : "private new input",
      ],
      [subsequent, !revoke || boundary === "after-final-publish", "subsequent private input"],
    ] as const;
    for (const [input, published, contents] of expectedInputs) {
      if (published) {
        await files.expect(input, contents);
      } else {
        await files.missing(input);
      }
    }
  } finally {
    admission.close();
    await closeServer(server);
    await service.closeAll();
  }
});

it("fenceEnvironment aborts capability signals and denies new admissions", async () => {
  const root = tempDirs.make("workspace-transfer-fence-");
  const localPath = path.join(root, "source");
  await fs.mkdir(localPath);
  const service = makeService(root);
  await service.initialize();
  try {
    const { snapshot, token } = await prepareSync(service, localPath);
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

it("a permanent store revocation fences an in-flight blob response end to end", async () => {
  const root = tempDirs.make("workspace-transfer-store-fence-");
  const localPath = path.join(root, "source");
  await fs.mkdir(localPath);
  const payload = Buffer.alloc(8 * 1024 * 1024, 0x53);
  await fs.writeFile(path.join(localPath, "secret.txt"), payload);

  const database = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
  });
  const store = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
  const environmentId = "worker-store-fence";
  const sessionId = "session-store-fence";
  await store.createIntent({
    environmentId,
    providerId: "fake-provider",
    profileId: "test-profile",
    profileSnapshot: { settings: {} },
    provisionOperationId: `provision:${environmentId}`,
  });
  await store.transition({ environmentId, from: "requested", to: "provisioning" });
  const bootstrapping = await store.transition({
    environmentId,
    from: "provisioning",
    to: "bootstrapping",
    patch: {
      leaseId: "lease-store-fence",
      sshEndpoint: {
        host: "worker.example.test",
        port: 2222,
        user: "openclaw",
        hostKey: ["ssh-ed25519", "AAAA"].join(" "),
        keyRef: { source: "file", provider: "worker-keys", id: "/static-development-key" },
      },
    },
  });
  await store.transition({
    environmentId,
    from: bootstrapping.state,
    to: "ready",
    patch: {
      bootstrapReceipt: {
        bundleHash: "a".repeat(64),
        openclawVersion: "2026.7.1",
        protocolFeatures: [],
      },
      credential: {
        ...workerCredential(hashWorkerCredential("worker-store-fence-bootstrap")),
        expiresAtMs: 11_000,
      },
    },
  });
  const attached = await store.transition({
    environmentId,
    from: "ready",
    to: "attached",
    patch: {
      attachedSessionIds: [sessionId],
      credential: {
        ...workerCredential(hashWorkerCredential(`worker-store-fence-${sessionId}`), sessionId),
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
  const unsubscribe = store.onCredentialRevoked((id) => {
    service.fenceEnvironment(id);
  });

  const { snapshot, token } = await service.prepareSync({
    environmentId,
    ownerEpoch,
    sessionId,
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
    void handleRequest(req, res, callback);
  });
  const address = await listen(server);
  const controller = new AbortController();
  try {
    const response = await fetch(
      `http://${address}/__openclaw__/worker-transfer/v1/environments/${environmentId}/blobs/${entry.sha256}`,
      { headers: { authorization: `Bearer ${token}` }, signal: controller.signal },
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("blob response has no body");
    }
    const first = await reader.read();
    let bytes = first.value?.byteLength ?? 0;

    await store.revokeEnvironmentCredential(environmentId, { fenceWorkspaceTransfers: true });

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        bytes += value.byteLength;
      }
    } catch {
      // The fenced response is destroyed mid-body; the client read may reject.
    }
    expect(bytes).toBeLessThan(payload.byteLength);
    expect(service.isAuthorizationCurrent(authorization!)).toBe(false);
    expect(service.authorize({ route, token })).toBeUndefined();
  } finally {
    unsubscribe();
    controller.abort();
    await closeServer(server);
    await service.closeAll().catch(() => undefined);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  }
});
