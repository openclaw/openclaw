import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../../infra/node-commands.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { ensureStagedInputDirectory, stagedInputDirectory } from "../../media/staged-inputs.js";
import { invokeNodeWorkerSupervisorCommand } from "../../node-host/node-worker-supervisor-commands.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { workspaceFiles } from "./node-workspace-transfer-fixtures.test-support.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import {
  startNodeWorkspaceTransferTestServer,
  transferOwner,
} from "./node-workspace-transfer.test-support.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { workspaceProcessTestEntrypoints } from "./workspace-process-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
});

async function transferFixture(
  name: string,
  getOwner: Parameters<typeof createNodeWorkspaceTransferService>[0]["getOwner"] = () =>
    transferOwner(`session-${name}`, 1, Date.now() + 60_000),
  now?: () => number,
) {
  const root = tempDirs.make(`node-workspace-transfer-${name}-`);
  const localPath = path.join(root, "workspace");
  const temporaryRoot = path.join(root, "transfer-tmp");
  await fs.mkdir(localPath);
  const service = createNodeWorkspaceTransferService({ getOwner, temporaryRoot, now });
  const request = {
    environmentId: `environment-${name}`,
    ownerEpoch: 1,
    sessionId: `session-${name}`,
    localPath,
    isAuthorized: () => true,
  };
  return { root, localPath, temporaryRoot, service, request };
}

function injectUploadWriteFaults() {
  const originalOpen = fs.open.bind(fs);
  let beforeRetry: (() => Promise<void>) | undefined;
  let nextWriteError: Error | undefined;
  let stagingRoot: string | undefined;
  let observedShortWrite = false;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (
      typeof args[0] !== "string" ||
      !args[0].includes(`${path.sep}upload-`) ||
      path.basename(args[0]) !== "result.txt" ||
      args[1] !== "wx"
    ) {
      return handle;
    }

    stagingRoot = path.dirname(args[0]);
    let injectShortWrite = true;
    const injectedHandle = Object.create(handle) as typeof handle;
    injectedHandle.close = handle.close.bind(handle);
    injectedHandle.write = (async (
      buffer: Buffer,
      offset = 0,
      length = buffer.byteLength - offset,
      position?: number | null,
    ) => {
      if (nextWriteError) {
        const error = nextWriteError;
        nextWriteError = undefined;
        throw error;
      }
      if (injectShortWrite) {
        injectShortWrite = false;
        const writeLength = Math.max(1, Math.floor(length / 2));
        observedShortWrite ||= writeLength < length;
        return await handle.write(buffer, offset, writeLength, position);
      }
      const retryHook = beforeRetry;
      beforeRetry = undefined;
      await retryHook?.();
      return await handle.write(buffer, offset, length, position);
    }) as typeof handle.write;
    return injectedHandle;
  });

  return {
    blockNextRetry() {
      const started = createDeferred();
      const released = createDeferred();
      beforeRetry = async () => {
        started.resolve();
        await released.promise;
      };
      return { started: started.promise, release: released.resolve };
    },
    failNextWrite(error: Error) {
      nextWriteError = error;
    },
    lastStagingRoot: () => stagingRoot,
    shortWriteObserved: () => observedShortWrite,
  };
}

function retryOrUploadStatus(retryStarted: Promise<void>, upload: Promise<unknown>) {
  return Promise.race([
    retryStarted.then(() => "retrying" as const),
    upload.then(
      () => "completed" as const,
      () => "failed" as const,
    ),
  ]);
}

it("keeps a plain workspace transferable after durable result staging initializes Git", async () => {
  const { root, localPath, service, request } = await transferFixture("unborn");
  await fs.writeFile(path.join(localPath, "input.txt"), "gateway input\n");
  const git = async (...args: string[]) => {
    const result = await runCommandWithTimeout(["git", "-C", localPath, ...args], {
      timeoutMs: 10_000,
    });
    expect(result.code).toBe(0);
    return result.stdout.trim();
  };
  try {
    const plain = await service.prepareSync(request);
    expect(plain.snapshot.manifest.baseCommit).toBeNull();

    if (process.platform !== "win32") {
      const nodeRoot = path.join(root, "node-workspaces");
      const input = {
        gatewayNamespace: "gateway-umask",
        environmentId: request.environmentId,
        sessionId: request.sessionId,
        generation: 1,
        argv: ["node", "-e", ""],
      };
      const server = await startNodeWorkspaceTransferTestServer(service);
      const workspaceUrl = resolveRuntimeWorkerUrl(workspaceProcessTestEntrypoints.nodeWorkspace);
      try {
        const created = await runCommandWithTimeout(
          [
            "/bin/sh",
            "-c",
            'umask 0002; exec "$@"',
            "workspace-transfer-umask",
            process.execPath,
            ...resolveRuntimeWorkerArgv(workspaceUrl).slice(0, -1),
            "--input-type=module",
            "--eval",
            `
              import assert from "node:assert/strict";
              import fs from "node:fs/promises";
              import path from "node:path";
              const { NodeWorkerWorkspaceRuntime } = await import(process.argv[1]);
              const { root, input } = JSON.parse(process.argv[2]);
              const runtime = new NodeWorkerWorkspaceRuntime({ root });
              const initial = await runtime.exec(input);
              for (let dir = initial.workspaceDir; dir !== path.dirname(root); dir = path.dirname(dir)) {
                assert.equal((await fs.stat(dir)).mode & 0o777, 0o700, dir);
                await fs.chmod(dir, 0o775);
              }
            `,
            workspaceUrl.href,
            JSON.stringify({ root: nodeRoot, input }),
          ],
          { timeoutMs: 30_000 },
        );
        expect(created).toMatchObject({ code: 0, stderr: "" });
        const reopened = new NodeWorkerWorkspaceRuntime({ root: nodeRoot });
        const downloaded = await reopened.exec(
          {
            ...input,
            transfer: {
              direction: "download",
              token: plain.token,
              manifestRef: plain.snapshot.manifestRef,
            },
          },
          undefined,
          { url: server.gatewayUrl },
        );
        expect(await fs.readFile(path.join(downloaded.workspaceDir, "input.txt"), "utf8")).toBe(
          "gateway input\n",
        );
        for (let dir = downloaded.workspaceDir; dir !== root; dir = path.dirname(dir)) {
          expect((await fs.stat(dir)).mode & 0o777, dir).toBe(0o700);
        }
      } finally {
        await server.close();
      }
    }

    await git("init", "--quiet", "--object-format=sha1");

    const staged = await service.prepareSync(request);
    expect(staged.snapshot).toMatchObject({
      manifestRef: plain.snapshot.manifestRef,
      manifest: {
        baseCommit: null,
        entries: expect.arrayContaining([
          expect.objectContaining({ path: "input.txt", type: "file" }),
        ]),
      },
    });

    await git("add", "input.txt");
    await git(
      "-c",
      "user.name=Worker Transfer Test",
      "-c",
      "user.email=worker-transfer@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "tracked workspace",
    );
    const committed = await service.prepareSync(request);
    expect(committed.snapshot.manifest.baseCommit).toBe(await git("rev-parse", "HEAD"));

    await fs.writeFile(path.join(localPath, ".git", "HEAD"), "invalid HEAD\n");
    await expect(service.prepareSync(request)).rejects.toThrow("Worker workspace sync failed");
  } finally {
    await service.closeAll();
  }
});

it("streams workspace and changed results beyond worker credential expiry", async () => {
  let nowMs = Date.now();
  const owner = transferOwner("session-1", 3, nowMs + 60_000);
  const { environment } = owner;
  const { root, localPath, service, request } = await transferFixture(
    "1",
    () => owner,
    () => nowMs,
  );
  await fs.writeFile(path.join(localPath, "input.txt"), "gateway input\n");
  await fs.mkdir(path.join(localPath, "nested"));
  await fs.writeFile(path.join(localPath, "nested", "input.txt"), "nested input\n");
  const server = await startNodeWorkspaceTransferTestServer(service);
  const { gatewayUrl } = server;
  const runtime = new NodeWorkerWorkspaceRuntime({ root: path.join(root, "node-workspaces") });
  try {
    const prepared = await service.prepareSync({ ...request, ownerEpoch: 3 });
    const manifestRef = prepared.snapshot.manifestRef;
    const prepareUpload = () => service.prepareUpload("environment-1", manifestRef);
    const httpOrigin = gatewayUrl.replace(/^ws/u, "http");
    const manifestPath = `/__openclaw__/worker-transfer/v1/environments/environment-1/snapshots/${manifestRef.slice(7)}/manifest`;
    const fetchManifest = (token = prepared.token, environmentId = "environment-1") =>
      fetch(`${httpOrigin}${manifestPath.replace("environment-1", environmentId)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    const crossEnvironment = await fetchManifest(prepared.token, "environment-2");
    const uploadTokenForGet = prepareUpload();
    const wrongDirection = await fetchManifest(uploadTokenForGet);
    await service.revoke("environment-1", uploadTokenForGet);
    for (const response of [crossEnvironment, wrongDirection]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ error: "not_found" });
    }
    const command = {
      gatewayNamespace: "gateway-test",
      environmentId: "environment-1",
      sessionId: "session-1",
      generation: 2,
      argv: ["openclaw-internal-workspace-transfer"],
    };
    const downloadInput = {
      ...command,
      transfer: {
        direction: "download",
        token: prepared.token,
        manifestRef,
      },
    } as const;
    const invoked = await invokeNodeWorkerSupervisorCommand({
      command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
      paramsJSON: JSON.stringify(downloadInput),
      workspace: runtime,
      gatewayUrl,
    });
    if (!invoked.handled || !invoked.ok || !invoked.payload) {
      throw new Error(
        `workspace transfer invoke failed: ${invoked.handled && !invoked.ok ? invoked.message : "missing result"}`,
      );
    }
    const downloaded = invoked.payload as { workspaceDir: string };
    const files = workspaceFiles(downloaded.workspaceDir);
    await files.expect("input.txt", "gateway input\n");
    await files.expect("nested/input.txt", "nested input\n");
    nowMs += 2 * 60_000;
    const afterWorkerExpiry = await fetchManifest();
    expect(afterWorkerExpiry.status).toBe(200);
    await afterWorkerExpiry.arrayBuffer();
    nowMs += 8 * 60_000;
    const expired = await fetchManifest();
    expect(expired.status).toBe(404);
    expect(expired.headers.get("cache-control")).toBe("no-store");
    await expect(expired.json()).resolves.toEqual({ error: "not_found" });
    await fs.writeFile(path.join(downloaded.workspaceDir, "result.txt"), "node result\n");
    const attachmentsRoot = path.join(root, "attachments");
    const inputDirectory = stagedInputDirectory("a".repeat(64));
    const attachmentPath = `${inputDirectory}/input-document.txt`;
    await fs.mkdir(attachmentsRoot);
    await ensureStagedInputDirectory(attachmentsRoot, inputDirectory);
    await fs.writeFile(path.join(attachmentsRoot, attachmentPath), "new attachment");
    let attachmentTurnCurrent = true;
    const attachments = await service.prepareAttachments({
      environmentId: "environment-1",
      localPath: attachmentsRoot,
      isAuthorized: () => attachmentTurnCurrent,
      signal: new AbortController().signal,
    });
    const attachmentInput = {
      ...downloadInput,
      argv: [...downloadInput.argv],
      transfer: {
        direction: "download" as const,
        token: attachments.token,
        manifestRef: attachments.snapshot.manifestRef,
        attachments: true as const,
      },
    };
    const collision = path.join(downloaded.workspaceDir, inputDirectory);
    await fs.mkdir(collision, { recursive: true });
    await fs.writeFile(path.join(collision, "project.txt"), "existing project file");
    await expect(runtime.exec(attachmentInput, undefined, { url: gatewayUrl })).rejects.toThrow(
      "workspace-transfer-failed",
    );
    await workspaceFiles(collision).expect("project.txt", "existing project file");
    await workspaceFiles(collision).missing(".gitignore");
    await fs.rm(collision, { recursive: true });
    const staged = await invokeNodeWorkerSupervisorCommand({
      command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
      paramsJSON: JSON.stringify(attachmentInput),
      workspace: runtime,
      gatewayUrl,
    });
    expect(staged).toMatchObject({ handled: true, ok: true });
    await files.expect(attachmentPath, "new attachment");
    await files.expect("result.txt", "node result\n");
    await files.expect("input.txt", "gateway input\n");
    await fs.writeFile(
      path.join(downloaded.workspaceDir, attachmentPath),
      "worker attachment edit",
    );
    await runtime.exec(attachmentInput, undefined, { url: gatewayUrl });
    await files.expect(attachmentPath, "worker attachment edit");
    attachmentTurnCurrent = false;
    await expect(runtime.exec(attachmentInput, undefined, { url: gatewayUrl })).rejects.toThrow(
      "workspace-transfer-failed",
    );
    await service.revoke("environment-1", attachments.token);
    expect(service.getSnapshot("environment-1", manifestRef)).toBeDefined();
    const writeFaults = injectUploadWriteFaults();
    const persistenceRetry = writeFaults.blockNextRetry();
    const uploadResult = (token: string) =>
      runtime.exec(
        {
          ...command,
          transfer: {
            direction: "upload",
            token,
            baseManifestRef: manifestRef,
            referenceManifestRef: manifestRef,
          },
        },
        undefined,
        { url: gatewayUrl },
      );
    const uploadToken = prepareUpload();
    expect(() => prepareUpload()).toThrow("already active");
    const upload = uploadResult(uploadToken);
    try {
      await expect(retryOrUploadStatus(persistenceRetry.started, upload)).resolves.toBe("retrying");
      expect(writeFaults.shortWriteObserved()).toBe(true);
      expect(() => service.takeUpload("environment-1", manifestRef)).toThrow("did not complete");
    } finally {
      persistenceRetry.release();
    }
    await upload;
    const reconciliationUrl = `${httpOrigin}/__openclaw__/worker-transfer/v1/environments/environment-1/reconciliations/${manifestRef.slice(7)}`;
    const postEmptyResult = (token: string) =>
      fetch(reconciliationUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-length": "0" },
      });
    const replay = await postEmptyResult(uploadToken);
    expect(replay.status).toBe(404);
    const uploaded = service.takeUpload("environment-1", manifestRef);
    await service.revoke("environment-1", uploadToken);
    await service.discardUpload("environment-1", uploadToken);
    expect(uploaded.current.entries).toContainEqual(
      expect.objectContaining({ path: "result.txt", type: "file" }),
    );
    await workspaceFiles(uploaded.stagingRoot).expect("result.txt", "node result\n");
    const invalidUploadToken = prepareUpload();
    const invalidUpload = await postEmptyResult(invalidUploadToken);
    expect(invalidUpload.status).toBe(413);
    await expect(invalidUpload.json()).resolves.toEqual({
      error: "workspace_transfer_limit",
    });
    const replacementUploadToken = prepareUpload();
    await service.revoke("environment-1", replacementUploadToken);
    writeFaults.failNextWrite(new Error("injected terminal upload write failure"));
    const failedUploadToken = prepareUpload();
    await expect(uploadResult(failedUploadToken)).rejects.toThrow(
      "workspace-transfer-invalid: gateway rejected workspace transfer payload (staging)",
    );
    expect(writeFaults.lastStagingRoot()).toBeDefined();
    await expect(fs.stat(writeFaults.lastStagingRoot()!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const resetUploadToken = prepareUpload();
    await service.revoke("environment-1", resetUploadToken);
    const acceptedToken = service.publishSnapshot("environment-1", {
      manifest: uploaded.current,
      manifestRef: uploaded.currentManifestRef,
      rawManifest: serializeWorkerWorkspaceManifest(uploaded.current),
      root: localPath,
    });
    expect(service.getSnapshot("environment-1", manifestRef)).toBeDefined();
    await service.revoke("environment-1", prepared.token);
    expect(service.getSnapshot("environment-1", manifestRef)).toBeUndefined();
    expect(service.getSnapshot("environment-1", uploaded.currentManifestRef)).toBeDefined();
    await service.revoke("environment-1", acceptedToken);

    const authorityRetry = writeFaults.blockNextRetry();
    const retiredUploadToken = prepareUpload();
    const retiredUpload = uploadResult(retiredUploadToken);
    try {
      await expect(retryOrUploadStatus(authorityRetry.started, retiredUpload)).resolves.toBe(
        "retrying",
      );
      environment.ownerEpoch += 1;
    } finally {
      authorityRetry.release();
    }
    await expect(retiredUpload).rejects.toThrow("workspace-transfer-failed");
    expect(writeFaults.lastStagingRoot()).toBeDefined();
    await expect(fs.stat(writeFaults.lastStagingRoot()!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(() => service.takeUpload("environment-1", manifestRef)).toThrow("did not complete");
  } finally {
    await service.closeAll();
    await server.close();
  }
});

it.each(["close", "owner change"] as const)(
  "rejects retained authorization after %s",
  async (retirement) => {
    const owner = transferOwner("session-retire", 1, Date.now() + 60_000);
    const { service, request } = await transferFixture("retire", () => owner);
    const prepared = await service.prepareSync(request);
    const authorization = service.authorize({
      token: prepared.token,
      route: {
        kind: "manifest",
        direction: "download",
        environmentId: request.environmentId,
        manifestRef: prepared.snapshot.manifestRef,
      },
    });
    expect(authorization).toBeDefined();
    const signal = service.authorizationSignal(authorization!);
    if (retirement === "close") {
      await service.close(request.environmentId);
      expect(signal.aborted).toBe(true);
    } else {
      owner.environment.ownerEpoch += 1;
    }
    expect(service.isAuthorizationCurrent(authorization!)).toBe(false);
    await service.closeAll();
  },
);

it("clears crash scratch eagerly and removes the transfer root on shutdown", async () => {
  const root = tempDirs.make("node-workspace-transfer-lifecycle-");
  const temporaryRoot = path.join(root, "transfer-tmp");
  const staleRoot = path.join(temporaryRoot, "context-stale");
  await fs.mkdir(staleRoot, { recursive: true });
  await fs.writeFile(path.join(staleRoot, "base.pack"), "stale");
  const service = createNodeWorkspaceTransferService({
    getOwner: () => undefined,
    temporaryRoot,
  });

  await service.initialize();

  await expect(fs.readdir(temporaryRoot)).resolves.toEqual([]);
  await service.closeAll();
  await expect(fs.stat(temporaryRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

it("drains sibling transfer contexts and removes scratch after a cleanup failure", async () => {
  const { service, request, temporaryRoot } = await transferFixture("close-siblings", (id) =>
    transferOwner(`session-${id}`, 1, Date.now() + 60_000),
  );
  for (const environmentId of ["environment-1", "environment-2"]) {
    await service.prepareSync({
      ...request,
      environmentId,
      sessionId: `session-${environmentId}`,
    });
  }

  const cleanupError = new Error("first transfer context cleanup failed");
  const siblingCleanup = createDeferred();
  const originalRemove = fs.rm.bind(fs);
  let contextRemovals = 0;
  const remove = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
    const target = args[0];
    if (typeof target === "string" && path.dirname(target) === temporaryRoot) {
      contextRemovals += 1;
      if (contextRemovals === 1) {
        throw cleanupError;
      }
      await siblingCleanup.promise;
    }
    await originalRemove(...args);
  });
  const stopping = service.closeAll();
  const settled = vi.fn();
  void stopping.then(settled, settled);

  try {
    await vi.waitFor(() => expect(contextRemovals).toBe(2));
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalledWith(temporaryRoot, expect.anything());

    siblingCleanup.resolve();
    await expect(stopping).rejects.toBe(cleanupError);
    expect(remove).toHaveBeenCalledWith(temporaryRoot, { recursive: true, force: true });
    await expect(fs.stat(temporaryRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    siblingCleanup.resolve();
    await stopping.catch(() => undefined);
    remove.mockRestore();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

it.each([
  ["sync", "sync"],
  ["repository", "sync"],
  ["sync", "repository"],
] as const)("serializes %s → %s context replacement for one environment", async (first, second) => {
  const { localPath, temporaryRoot, service, request } = await transferFixture("serialize");
  await fs.writeFile(path.join(localPath, "input.txt"), "input\n");

  await Promise.all(
    [first, second].map((kind) => {
      return kind === "sync"
        ? service.prepareSync(request)
        : service.prepareRepository({
            ...request,
            baseCommit: "b".repeat(40),
            baseManifestRef: `sha256:${"a".repeat(64)}`,
          });
    }),
  );

  const contexts = (await fs.readdir(temporaryRoot)).filter((name) => name.startsWith("context-"));
  expect(contexts).toHaveLength(1);
  await service.closeAll();
});

it.each(["ready", "receiving"] as const)(
  "rejects a revoked source while its upload is %s and owner signal remains live",
  async (phase) => {
    const { service, request } = await transferFixture("upload-authority", () =>
      transferOwner("session-upload-authority"),
    );
    const signal = new AbortController().signal;
    let sourceCurrent = true;
    const { environmentId } = request;
    const baseManifestRef = `sha256:${"a".repeat(64)}`;
    try {
      await service.prepareRepository({
        ...request,
        baseCommit: "b".repeat(40),
        baseManifestRef,
        signal,
      });
      const token = service.prepareUpload(environmentId, baseManifestRef, () => {
        if (!sourceCurrent) {
          throw new Error("initiating source closed");
        }
      });
      const route = {
        kind: "reconcile",
        direction: "upload",
        environmentId,
        baseManifestRef,
      } as const;
      const authorization = phase === "receiving" ? service.authorize({ route, token }) : undefined;
      if (phase === "receiving") {
        expect(authorization).toBeDefined();
        expect(service.isAuthorizationCurrent(authorization!)).toBe(true);
      }
      sourceCurrent = false;
      expect(signal.aborted).toBe(false);
      if (authorization) {
        expect(service.isAuthorizationCurrent(authorization)).toBe(false);
      } else {
        expect(service.authorize({ route, token })).toBeUndefined();
      }
      await service.revoke(environmentId, token);
      // Revocation releases an already claimed upload as well as an unused token.
      expect(() => service.prepareUpload(environmentId, baseManifestRef)).not.toThrow();
    } finally {
      await service.closeAll();
    }
  },
);
