import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { observeSettlement } from "../../infra/sqlite-readonly.test-support.js";
import {
  environment,
  workspaceActions,
  workspaceCommandResult,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { emptyJournal } from "./workspace-manifest-fixtures.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const identity = { environmentId: "environment-1", ownerEpoch: 2, sessionId: "session-1" };

async function workspaceFixture(beforeDownload?: () => Promise<void>) {
  const localPath = tempDirs.make("node-workspace-authority-");
  await fs.writeFile(path.join(localPath, "input.txt"), "workspace input\n");
  const transfer = createNodeWorkspaceTransferService({
    getOwner: () => ({ environment: environment(), credential: identity }),
    temporaryRoot: tempDirs.make("node-workspace-transfer-"),
  });
  const owner = new AbortController();
  const turn = new AbortController();
  const downloadAuthority = (token: string, manifestRef: string) =>
    transfer.authorize({
      token,
      route: {
        kind: "manifest",
        direction: "download",
        environmentId: identity.environmentId,
        manifestRef,
      },
    });
  const actions = workspaceActions({
    ...identity,
    ownerSignal: owner.signal,
    isOwnerCurrent: () => !owner.signal.aborted,
    workspaceTransfer: transfer,
    runWorkspaceCommand: async (command) => {
      // The real node command defaults to 60 seconds if its caller drops this budget.
      expect(command.timeoutMs).toBe(600_000);
      command.assertCurrent?.();
      if (!command.transfer || command.transfer.direction !== "download") {
        throw new Error("Expected a workspace download");
      }
      await beforeDownload?.();
      const authorization = downloadAuthority(command.transfer.token, command.transfer.manifestRef);
      if (!authorization || !transfer.snapshot(authorization)) {
        throw new Error("Workspace download authority closed");
      }
      return workspaceCommandResult("/node/workspace", { stdout: command.transfer.manifestRef });
    },
  });
  return {
    actions,
    transfer,
    localPath,
    downloadAuthority,
    closeTurn: () => turn.abort(new Error("Initiating dispatch turn closed")),
    transferRequest: { ...identity, localPath, isAuthorized: () => true },
    sync: (authorize = () => turn.signal.throwIfAborted()) =>
      actions.syncWorkspace({
        source: { kind: "local" as const, path: localPath, projectKey: "a".repeat(64) },
        sessionId: "session-1",
        generation: 1,
        authorize,
      }),
    [Symbol.asyncDispose]: async () => {
      owner.abort();
      await transfer.closeAll();
    },
  };
}

it.each(
  (["local", "repository"] as const).flatMap((source) =>
    (["turn", "owner", "signal"] as const).map((boundary) => ({ source, boundary })),
  ),
)(
  "rejects a queued $source sync with closed $boundary authority without replacing its predecessor",
  async ({ source, boundary }) => {
    await using fixture = await workspaceFixture();
    const preparing = createDeferred();
    const releasePreparation = createDeferred();
    const originalRealpath = fs.realpath.bind(fs);
    let blocked = false;
    const realpath = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      if (!blocked && args[0] === fixture.localPath) {
        blocked = true;
        preparing.resolve();
        await releasePreparation.promise;
      }
      return await originalRealpath(...args);
    });
    const signal = new AbortController();
    try {
      const first = fixture.transfer.prepareSync(fixture.transferRequest);
      await preparing.promise;
      const pending = {
        ...fixture.transferRequest,
        signal: boundary === "signal" ? signal.signal : undefined,
        isAuthorized: () => boundary !== "owner" || !signal.signal.aborted,
        authorize: boundary === "turn" ? () => signal.signal.throwIfAborted() : undefined,
      };
      const second =
        source === "local"
          ? fixture.transfer.prepareSync(pending)
          : fixture.transfer.prepareRepository({
              ...pending,
              baseCommit: "a".repeat(40),
              baseManifestRef: `sha256:${"b".repeat(64)}`,
            });
      const rejected = expect(second).rejects.toThrow();
      signal.abort(new Error("Initiating dispatch turn closed"));
      releasePreparation.resolve();
      const prepared = await first;
      await rejected;
      expect(
        fixture.downloadAuthority(prepared.token, prepared.snapshot.manifestRef),
      ).toBeDefined();
    } finally {
      releasePreparation.resolve();
      realpath.mockRestore();
    }
  },
);

it.each(["reconciliation", "attachments"] as const)(
  "preserves independent %s after the initiating dispatch turn closes",
  async (operation) => {
    await using fixture = await workspaceFixture();
    const synced = await fixture.sync();
    fixture.closeTurn();
    if (operation === "reconciliation") {
      const token = fixture.transfer.prepareUpload("environment-1", synced.manifestRef);
      expect(token).toBeTruthy();
      await fixture.transfer.revoke("environment-1", token);
    } else {
      assert.isDefined(fixture.actions.stageAttachments);
      await expect(
        fixture.actions.stageAttachments({
          localPath: fixture.localPath,
          isAuthorized: () => true,
          signal: new AbortController().signal,
        }),
      ).resolves.toBeUndefined();
    }
  },
);

it("rejects a download after its initiating turn closes but permits a fresh sync", async () => {
  const downloading = createDeferred();
  const releaseDownload = createDeferred();
  await using fixture = await workspaceFixture(async () => {
    downloading.resolve();
    await releaseDownload.promise;
  });
  try {
    const syncing = fixture.sync();
    const rejected = expect(syncing).rejects.toThrow(/authority closed|dispatch turn closed/u);
    await downloading.promise;
    fixture.closeTurn();
    releaseDownload.resolve();
    await rejected;

    const synced = await fixture.sync(() => {});
    const token = fixture.transfer.prepareUpload("environment-1", synced.manifestRef);
    expect(token).toBeTruthy();
    await fixture.transfer.revoke("environment-1", token);
  } finally {
    releaseDownload.resolve();
  }
});

it.for(["journal", "upload", "both", "authority"] as const)(
  "joins local recovery and remote upload before releasing a failed %s preparation",
  async (failedSide, { signal }) => {
    const journal = createDeferred<undefined>();
    const upload = createDeferred();
    const settlements = [journal, upload].map(({ promise }) => observeSettlement(promise));
    const uploadStarted = createDeferred();
    const authority = new AbortController();
    const failure = new Error(`${failedSide} failed`);
    const takeUpload = vi.fn((): never => {
      throw new Error("failed preparation must not consume staging");
    });
    const revoke = vi.fn(async () => {
      expect(settlements.map(({ settled }) => settled)).toEqual([true, true]);
    });
    const binding = {
      manifestRef: "sha256:" + "a".repeat(64),
      source: { kind: "local" as const, path: "/gateway/workspace" },
      remoteWorkspaceDir: "/worker/workspace",
    };
    const actions = workspaceActions({
      restoredWorkspace: binding,
      workspaceTransfer: workspaceTransfer({
        prepareUpload: () => "upload-token",
        takeUpload,
        revoke,
      }),
      runWorkspaceCommand: async () => {
        uploadStarted.resolve();
        await upload.promise;
        return workspaceCommandResult(binding.remoteWorkspaceDir);
      },
    });
    const operation = actions.reconcileWorkspace({
      remoteWorkspaceDir: binding.remoteWorkspaceDir,
      baseManifestRef: binding.manifestRef,
      source: {
        ...binding.source,
        assertCurrent: () => authority.signal.throwIfAborted(),
        journal: emptyJournal({ load: () => journal.promise }),
        stagedResult: { ref: "refs/openclaw/worker-results/overlap", record: () => {} },
      },
    });
    const outcome = operation.catch((error: unknown) => error);
    try {
      if (failedSide === "journal") {
        journal.reject(failure);
      } else if (failedSide === "authority") {
        journal.resolve(undefined);
      }
      await withinTest(
        awaitGateBeforeSettlement(uploadStarted.promise, operation, "upload never started"),
        signal,
      );
      if (failedSide === "authority") {
        authority.abort(failure);
      }
      if (failedSide === "upload" || failedSide === "both") {
        upload.reject(failedSide === "both" ? new Error("upload failed first") : failure);
        if (failedSide === "both") {
          journal.reject(failure);
        } else {
          journal.resolve(undefined);
        }
      } else {
        upload.resolve();
      }
      expect(await outcome).toBe(failure);
      expect(takeUpload).not.toHaveBeenCalled();
      expect(revoke).toHaveBeenCalledExactlyOnceWith("environment-1", "upload-token");
    } finally {
      journal.resolve(undefined);
      upload.resolve();
      await operation.catch(() => {});
    }
  },
);
