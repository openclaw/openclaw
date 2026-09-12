import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runNodeWorkerWorkspaceTransfer } from "../../node-host/node-worker-transfer-client.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { closeOpenClawStateDatabaseByPath } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { prepareNodeWorkspaceTransferSnapshot } from "./node-workspace-transfer-snapshot.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import { stageSessionRepositoryCheckpoint } from "./session-repository-checkpoints.js";
import type { WorkerWorkspaceReconcileRequest } from "./tunnel-contract.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  "completed",
  "receiving",
  "receiving-failure",
  "publication-cleanup-failure",
  "checkpoint-cleanup-failure",
] as const)(
  "preserves prepared checkpoint cleanup custody and successful retries after %s",
  async (boundary) => {
    const receivingUpload = boundary.startsWith("receiving");
    const cleanupFailure = boundary.endsWith("cleanup-failure");
    const root = tempDirs.make("node-publication-disposal-");
    const workspaceDir = path.join(root, "worker");
    const home = path.join(root, "home");
    const temporaryRoot = path.join(root, "transfers");
    await fs.mkdir(workspaceDir);
    const exec = async (argv: string[]) => {
      const result = await runCommandWithTimeout(argv, {
        cwd: workspaceDir,
        timeoutMs: 10_000,
        baseEnv: {
          PATH: process.env.PATH,
          HOME: home,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      expect(result.code, result.stderr).toBe(0);
      return { ...result, workspaceDir };
    };
    await exec(["git", "init", "--quiet"]);
    await fs.writeFile(path.join(workspaceDir, "result.txt"), "base\n");
    await exec(["git", "add", "result.txt"]);
    await exec([
      "git",
      "-c",
      "user.name=Publication Test",
      "-c",
      "user.email=publication@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "base",
    ]);
    const base = await prepareNodeWorkspaceTransferSnapshot({
      localPath: workspaceDir,
      temporaryRoot: root,
    });
    if (!base.manifest.baseCommit) {
      throw new Error("Repository fixture has no base commit");
    }
    const database = openOpenClawStateDatabase({ path: path.join(root, "openclaw.sqlite") });
    const store = createSessionRepositoryWorkspaceStore({ database });
    const created = store.create({
      agentId: "main",
      sessionKey: "agent:main:publication",
      url: "https://github.com/example/project.git",
      assertCurrent: () => {},
    });
    const repository = store.bindBase({
      workspaceId: created.workspaceId,
      expectedRevision: created.revision,
      baseCommit: base.manifest.baseCommit,
      baseManifestHash: base.manifestRef,
      assertCurrent: () => {},
    });
    const artifactRoot = store.artifactPath(repository.workspaceId);
    await fs.mkdir(artifactRoot, { recursive: true });
    await requireWorkspaceResultGit(artifactRoot, ["init", "--quiet", "--bare"]);
    const candidates = () =>
      requireWorkspaceResultGit(artifactRoot, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/openclaw/worker-result-candidates/",
      ]);
    const manifests = path.join(home, ".openclaw-worker", "manifests");
    await fs.mkdir(manifests, { recursive: true });
    await fs.writeFile(path.join(manifests, `${base.manifestRef.slice(7)}.json`), base.rawManifest);
    await fs.writeFile(path.join(workspaceDir, "result.txt"), "checkpoint edit\n");
    const owner = new AbortController();
    const service = createNodeWorkspaceTransferService({
      temporaryRoot,
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
    const server = await startNodeWorkspaceTransferTestServer(service);
    const receiving = createDeferred();
    const release = createDeferred();
    const discardStarted = createDeferred();
    const discardUpload = service.discardUpload.bind(service);
    vi.spyOn(service, "discardUpload").mockImplementation(async (...args) => {
      discardStarted.resolve();
      await discardUpload(...args);
    });
    let publicationActive = false;
    let failPublication = !cleanupFailure;
    let blocked = false;
    let cleanupRoot: string | undefined;
    const cleanupError = new Error("Taken upload staging cleanup failed");
    let failCleanup = cleanupFailure;
    const remove = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (cleanupRoot && args[0] === cleanupRoot && failCleanup) {
        failCleanup = false;
        throw cleanupError;
      }
      await remove(...args);
    });
    let uploadOutcome: Promise<"completed" | "rejected"> | undefined;
    const realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      if (
        receivingUpload &&
        publicationActive &&
        !blocked &&
        typeof args[0] === "string" &&
        path.basename(args[0]).startsWith("upload-")
      ) {
        blocked = true;
        receiving.resolve();
        await release.promise;
        if (boundary === "receiving-failure") {
          throw new Error("Publication staging validation failed during disposal");
        }
      }
      return await realpath(...args);
    });
    const actions = createNodeWorkerWorkspaceActions({
      environmentId: "environment",
      ownerEpoch: 1,
      sessionId: "session",
      ownerSignal: owner.signal,
      isOwnerCurrent: () => !owner.signal.aborted,
      restoredWorkspace: {
        source: {
          kind: "repository",
          baseCommit: base.manifest.baseCommit,
          baseManifestRef: base.manifestRef,
        },
        manifestRef: base.manifestRef,
        remoteWorkspaceDir: workspaceDir,
      },
      workspaceTransfer: service,
      runWorkspaceCommand: async (command) => {
        if (!command.transfer) {
          return await exec([...command.argv]);
        }
        const publication =
          command.transfer.direction === "upload" &&
          Boolean(command.transfer.publicationBaseCommit);
        publicationActive = publication && failPublication;
        const upload = runNodeWorkerWorkspaceTransfer({
          gatewayUrl: server.gatewayUrl,
          environmentId: "environment",
          workspaceDir,
          manifestHome: home,
          transfer: command.transfer,
        });
        if (publicationActive) {
          uploadOutcome = upload.then(
            () => "completed",
            () => "rejected",
          );
          if (receivingUpload) {
            await withTestTimeout(receiving.promise, 5_000, "publication never reached staging");
          } else {
            expect(await uploadOutcome).toBe("completed");
          }
          // The data channel can outlive a lost control-channel command result.
          return {
            workspaceDir,
            stdout: "",
            stderr: "control channel lost its result",
            code: 1,
            signal: null,
            killed: false,
            termination: "exit",
          };
        }
        return {
          workspaceDir,
          stdout: await upload,
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      },
    });
    const checkpoint: Extract<
      WorkerWorkspaceReconcileRequest["source"],
      { kind: "repository" }
    >["prepareCheckpoint"] = async (payload) => {
      expect(await fs.readFile(path.join(payload.stagingRoot, "result.txt"), "utf8")).toBe(
        "checkpoint edit\n",
      );
      const prepared = await stageSessionRepositoryCheckpoint({
        ...payload,
        store,
        workspaceId: repository.workspaceId,
        expectedRevision: store.get(repository.workspaceId)!.revision,
        assertCurrent: () => {},
      });
      if (cleanupFailure) {
        cleanupRoot =
          boundary === "publication-cleanup-failure"
            ? payload.publicationStagingRoot
            : payload.stagingRoot;
        expect(cleanupRoot).toBeDefined();
      }
      return prepared;
    };
    const reconcile = () =>
      actions.reconcileWorkspace({
        remoteWorkspaceDir: workspaceDir,
        baseManifestRef: base.manifestRef,
        source: {
          kind: "repository",
          referenceManifestRef: base.manifestRef,
          prepareCheckpoint: checkpoint,
        },
      });
    let first: ReturnType<typeof reconcile> | undefined;
    const accept = async (pending: ReturnType<typeof reconcile>) => {
      const result = await pending;
      try {
        expect(result.changed).toBe(true);
        await result.verifyLocalStable();
        await result.publishStagedResult?.();
        expect(store.get(repository.workspaceId)?.manifestHash).toBe(result.manifestRef);
      } finally {
        await result.discardPreparedStagedResult?.();
      }
      expect(await candidates()).toBe("");
    };
    try {
      await actions.validateRestoredWorkspace();
      first = reconcile();
      if (receivingUpload) {
        let settled = false;
        void first.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await withTestTimeout(discardStarted.promise, 5_000, "publication disposal did not start");
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect.soft(settled, "reconciliation must join abandoned staging work").toBe(false);
        release.resolve();
      }
      if (boundary === "receiving-failure" || cleanupFailure) {
        if (cleanupFailure) {
          await expect(first).rejects.toBe(cleanupError);
        } else {
          await expect(first).rejects.toThrow("payload did not match its staged result");
        }
        expect(store.get(repository.workspaceId)?.checkpointRef).toBeNull();
        expect(await candidates(), "failed handoff must not strand prepared checkpoint refs").toBe(
          "",
        );
      } else {
        await accept(first);
      }
      if (receivingUpload) {
        expect(await uploadOutcome).toBe("rejected");
      }
      if (cleanupFailure) {
        expect((await fs.stat(cleanupRoot!)).isDirectory()).toBe(true);
      } else {
        expect(
          (await fs.readdir(temporaryRoot, { recursive: true })).filter((entry) =>
            path.basename(entry).startsWith("upload-"),
          ),
        ).toEqual([]);
      }
      failPublication = false;
      await accept(reconcile());
    } finally {
      release.resolve();
      await first?.catch(() => undefined);
      await uploadOutcome;
      await service.closeAll();
      await server.close();
      closeOpenClawStateDatabaseByPath(database.path);
    }
    await expect(fs.stat(temporaryRoot)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
