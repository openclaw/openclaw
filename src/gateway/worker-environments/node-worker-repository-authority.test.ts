import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  nodeWorkspaceTransferManifestPath,
  nodeWorkspaceTransferReconcilePath,
} from "../../worker/node-workspace-transfer-protocol.js";
import {
  environment,
  workspaceActions,
  workspaceCommandResult,
} from "./node-worker-tunnel.test-support.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const baseCommit = "a".repeat(40);
const baseManifestRaw = serializeWorkerWorkspaceManifest({ version: 1, baseCommit, entries: [] });
const baseManifestRef = `sha256:${createHash("sha256").update(baseManifestRaw).digest("hex")}`;

type ClosingBoundary = "seed" | "fetch" | "author" | "setup" | "checkpoint" | "upload";

function repositoryFixture(closeAt?: ClosingBoundary) {
  const root = tempDirs.make("node-repository-authority-");
  const record = environment();
  const transfer = createNodeWorkspaceTransferService({
    temporaryRoot: path.join(root, "transfers"),
    getOwner: () => ({
      environment: record,
      credential: { ownerEpoch: record.ownerEpoch, sessionId: "session-1" },
    }),
  });
  let authorized = true;
  let closedAtBoundary = false;
  let effectsAfterClosure = 0;
  let downloadStatus: number | undefined;
  const actions = workspaceActions({
    environmentId: record.environmentId,
    ownerEpoch: record.ownerEpoch,
    workspaceTransfer: transfer,
    runWorkspaceCommand: async (command) => {
      if (closeAt === "upload" && command.transfer?.direction === "upload") {
        await Promise.resolve();
        authorized = false;
        closedAtBoundary = true;
      }
      command.assertCurrent?.();
      if (!authorized) {
        effectsAfterClosure += 1;
      }
      // Model revocation while remote I/O is outstanding, not an aborted tunnel.
      await Promise.resolve();
      const boundary = Object.entries({
        seed: command.seed?.action === "apply",
        fetch: command.argv.includes("fetch"),
        author: command.argv.includes("config"),
        checkpoint: command.transfer?.direction === "download",
        setup: command.argv.some((arg) => arg.includes("worktree-setup.sh")),
      }).find(([, reached]) => reached)?.[0];
      if (closeAt && boundary === closeAt) {
        authorized = false;
        closedAtBoundary = true;
      }
      let stdout = command.argv.includes("rev-parse") ? baseCommit : baseManifestRef;
      if (command.seed?.action === "apply") {
        stdout = "missing";
      }
      if (command.transfer?.direction === "download") {
        const server = await startNodeWorkspaceTransferTestServer(transfer);
        try {
          const response = await fetch(
            server.gatewayUrl.replace("ws:", "http:") +
              nodeWorkspaceTransferManifestPath(record.environmentId, command.transfer.manifestRef),
            { headers: { authorization: `Bearer ${command.transfer.token}` } },
          );
          downloadStatus = response.status;
          await response.arrayBuffer();
          if (response.status !== 200) {
            throw new Error("Repository checkpoint download authority closed");
          }
        } finally {
          await server.close();
        }
        stdout = command.transfer.manifestRef;
      }
      return workspaceCommandResult("/node/workspace", { stdout });
    },
  });
  const authorize = () => {
    if (!authorized) {
      throw new Error("Initiating dispatch turn closed");
    }
  };
  const checkpointFiles = {
    stagingRoot: root,
    baseManifestRaw,
    currentManifestRaw: baseManifestRaw,
  };
  const sync = (checkpoint = false) =>
    actions.syncWorkspace({
      sessionId: "session-1",
      generation: 1,
      gitAuthor: { name: "Repository Test", email: "repository@example.invalid" },
      source: {
        kind: "repository",
        url: "https://github.com/example/repository.git",
        branch: "openclaw/session",
        baseCommit,
        runSetupScript: !checkpoint,
        ...(checkpoint ? { checkpoint: checkpointFiles } : {}),
      },
      authorize,
    });
  return {
    sync,
    temporaryRoot: path.join(root, "transfers"),
    actions,
    authorize,
    transfer,
    closeInvocation: () => {
      authorized = false;
    },
    observed: () => ({ closedAtBoundary, effectsAfterClosure, downloadStatus }),
    [Symbol.asyncDispose]: () => transfer.closeAll(),
  };
}

it.each(["seed", "fetch", "author", "setup", "checkpoint"] as const)(
  "binds repository preparation to its initiating turn until %s",
  async (boundary) => {
    await using h = repositoryFixture(boundary);
    await expect(h.sync(boundary === "checkpoint")).rejects.toThrow(
      /authority closed|turn closed/u,
    );
    expect(h.observed()).toMatchObject({ closedAtBoundary: true, effectsAfterClosure: 0 });
    if (boundary === "checkpoint") {
      expect(h.observed().downloadStatus).toBe(404);
    }
  },
);

it("fences the initial repository checkpoint when dispatch authority closes during node lookup", async () => {
  await using h = repositoryFixture("upload");
  const synced = await h.sync();
  await expect(
    h.actions.reconcileWorkspace({
      remoteWorkspaceDir: synced.remoteWorkspaceDir,
      baseManifestRef,
      source: {
        kind: "repository",
        authorize: h.authorize,
        referenceManifestRef: synced.manifestRef,
        prepareCheckpoint: async () => {
          throw new Error("Unexpected checkpoint publication");
        },
      },
    }),
  ).rejects.toThrow("Initiating dispatch turn closed");
  expect(h.observed()).toMatchObject({ closedAtBoundary: true, effectsAfterClosure: 0 });
});

it.each(["before upload", "after upload"])(
  "rejects checkpoint custody closed %s",
  async (closure) => {
    await using h = repositoryFixture();
    const server = await startNodeWorkspaceTransferTestServer(h.transfer);
    try {
      const synced = await h.sync(closure === "after upload");
      const token = h.transfer.prepareUpload("environment-1", baseManifestRef, h.authorize);
      const stale = closure === "before upload";
      if (stale) {
        h.closeInvocation();
      }
      const manifest = Buffer.from(baseManifestRaw);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(manifest.length);
      const response = await fetch(
        server.gatewayUrl.replace("ws:", "http:") +
          nodeWorkspaceTransferReconcilePath("environment-1", baseManifestRef),
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: stale ? "unread stale upload" : Buffer.concat([header, manifest, header, manifest]),
        },
      );
      await response.arrayBuffer();
      expect(response.status).toBe(stale ? 404 : 200);
      if (stale) {
        return;
      }
      expect(h.observed().downloadStatus).toBe(200);
      const staged = (await fs.readdir(h.temporaryRoot, { recursive: true })).filter((entry) =>
        path.basename(entry).startsWith("upload-"),
      );
      expect(staged).toHaveLength(1);
      h.closeInvocation();
      expect(() => h.transfer.takeUpload("environment-1", baseManifestRef)).toThrow();
      await h.transfer.revoke("environment-1", token);
      const fresh = h.transfer.prepareUpload("environment-1", baseManifestRef, () => {});
      expect(fresh).not.toBe(token);
      await expect(fs.stat(path.join(h.temporaryRoot, staged[0]!))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await h.transfer.revoke("environment-1", fresh);
      // Completed repository custody outlives its initiating turn; invocation-bound uploads do not.
      const retained = h.transfer.prepareUpload("environment-1", synced.manifestRef);
      expect(retained).toBeTruthy();
      await h.transfer.revoke("environment-1", retained);
    } finally {
      await server.close();
    }
  },
);
