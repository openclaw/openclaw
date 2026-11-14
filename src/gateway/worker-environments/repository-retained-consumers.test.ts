import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { resolveRepositoryWorkspaceAccess } from "../server-methods/session-repository-workspace-access.js";
import { respondSessionFileDownload } from "../server-methods/sessions-file-download.js";
import { createSessionFileDownloadClient } from "../server-methods/sessions-files.test-support.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import { openDiskCleanupTransport } from "./placement-disk-cleanup.test-support.js";
import { writePlacementEnvironmentFixture } from "./placement-test-fixtures.js";
import { createRepositoryWorkspaceMutationService } from "./repository-workspace-mutation.js";
import { captureRepositoryDiskCheckpoint } from "./repository-workspace-snapshot.js";
import { openRepositoryCaptureTransport } from "./repository-workspace-snapshot.test-support.js";
import { withSessionRepositoryCheckpoint } from "./session-repository-checkpoints.js";
import {
  database,
  ENVIRONMENT_ID,
  placements,
  sessionTarget,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { useRepositoryWorkspaceResultFixture } from "./workspace-result-repository.test-support.js";
import { workerWorkspaceResultRef } from "./workspace-result-staging.js";

// mock-isolation: Local Git origin, synthetic provider/pairing/build admission; no cloud or model.
vi.mock("./repository-github-identity.js", () => ({
  prepareRepositoryGitHubIdentity: async (_agentId: string, assertCurrent: () => void) => ({
    token: undefined,
    assertSelected: assertCurrent,
    start: async (start: () => Promise<unknown>) => await start(),
  }),
}));
useRepositoryWorkspaceResultFixture();
let wire: Awaited<ReturnType<typeof openDiskCleanupTransport>>;
beforeAll(async () => {
  wire = await openDiskCleanupTransport({
    resolveCurrentPairingState: async () => ({
      identity: "disk-cleanup-pairing",
      generation: "disk-cleanup-generation",
    }),
  });
});
afterAll(async () => {
  await wire.close();
});

it.for([
  { operation: "get", fault: "none" },
  { operation: "set", fault: "none" },
  { operation: "capture", fault: "none" },
  { operation: "download", fault: "request" },
  { operation: "capture", fault: "disk" },
  { operation: "set", fault: "session" },
] as const)(
  "prepares paused $operation with $fault authority at node/bundle admission",
  async ({ operation, fault }, { signal }) => {
    const f = await openRepositoryCaptureTransport(wire, true);
    const nodeEntered = createDeferred();
    const nodeReady = createDeferred();
    const bundleEntered = createDeferred();
    const bundleReady = createDeferred();
    const unblock = () => {
      nodeReady.resolve();
      bundleReady.resolve();
    };
    signal.addEventListener("abort", unblock, { once: true });
    let pending: Promise<unknown> | undefined;
    let requestCurrent = true;
    const assertRequest = () => {
      if (!requestCurrent) {
        throw new Error("download reader revoked");
      }
    };
    try {
      await fs.writeFile(path.join(f.remote, "file.txt"), "before\n");
      await f.pause();
      wire.commands.length = 0;
      f.events.length = 0;
      if (operation === "set") {
        f.preparation.build = { ...f.preparation.build, bundleHash: "c".repeat(64) };
      }
      f.preparation.beforeNode = async () => {
        nodeEntered.resolve();
        await nodeReady.promise;
      };
      f.preparation.beforeBundle = async () => {
        bundleEntered.resolve();
        await bundleReady.promise;
      };
      const wake = vi.spyOn(f.environments, "ensureRetainedRunning");
      const context = createGatewayRequestContext(makeContextParams());
      context.workerEnvironmentService = f.environments;
      context.workerSessionPlacementService = placements;
      context.workerRepositoryWorkspaceMutationService = createRepositoryWorkspaceMutationService({
        placements,
        environments: f.environments,
        workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
        resolveWorkspace: async () => ({ kind: "repository", repository: f.repository }),
      });
      using access = await resolveRepositoryWorkspaceAccess(
        await loadGatewaySessionEntryReadOnlyInWorker({
          cfg: context.getRuntimeConfig(),
          key: sessionTarget.sessionKey,
          agentId: sessionTarget.agentId,
        }),
        context,
        () => {},
      );
      assert(access?.kind === "active");
      using download = createSessionFileDownloadClient();
      const capture = () =>
        captureRepositoryDiskCheckpoint(
          {
            identity: sessionTarget,
            repository: f.repository,
            checkpointRef: workerWorkspaceResultRef("retained-capture"),
            purpose: "publication",
            placements,
            environments: f.environments,
            assertCurrent() {},
          },
          async (snapshot) => {
            await withSessionRepositoryCheckpoint(
              { workspaceId: f.repository.workspaceId, checkpointRef: snapshot.checkpointRef },
              async (payload) => {
                expect(await fs.readFile(path.join(payload.stagingRoot, "file.txt"), "utf8")).toBe(
                  "before\n",
                );
              },
            );
          },
        );
      pending =
        operation === "download"
          ? respondSessionFileDownload({
              options: {
                req: { type: "req", id: "download", method: "sessions.files.download" },
                params: {},
                context,
                client: download.client,
                isWebchatConnect: () => false,
                respond: () => {
                  throw new Error("revoked download disclosed a grant");
                },
              },
              path: "file.txt",
              loaded: { files: [] },
              repository: access,
              hostRead: {
                assertCurrent: assertRequest,
                authorizeHostRead: async () => false,
                hasHostRead: () => false,
                withCurrent: async (consume) => consume(),
                release() {},
              },
              assertSessionCurrent() {},
              release() {},
              onGrantCreated() {},
            })
          : operation === "capture"
            ? capture()
            : operation === "get"
              ? access.inspect("get", { path: "file.txt", files: [] })
              : access.inspect("set", {
                  path: "file.txt",
                  content: "after\n",
                  expectedHash: createHash("sha256").update("before\n").digest("hex"),
                });
      void pending.catch(() => {});
      await withinTest(
        awaitGateBeforeSettlement(
          nodeEntered.promise,
          pending,
          "consumer refused before retained wake",
        ),
        signal,
      );
      // Replaying pause may drain the old native owner; no file operation is admitted.
      expect(f.events.some((event) => /workspace-command|quiescence|upload/.test(event))).toBe(
        false,
      );
      expect(f.environments.get(ENVIRONMENT_ID)?.retention?.runtimeReady).toBe(false);
      nodeReady.resolve();
      await withinTest(
        awaitGateBeforeSettlement(
          bundleEntered.promise,
          pending,
          "consumer escaped before bundle admission",
        ),
        signal,
      );
      expect(f.events.some((event) => /workspace-command|quiescence|upload/.test(event))).toBe(
        false,
      );
      if (fault === "request") {
        requestCurrent = false;
      }
      if (fault === "disk" || fault === "session") {
        const current = f.records.get(ENVIRONMENT_ID)!;
        writePlacementEnvironmentFixture(database, {
          ...current,
          ...(fault === "disk"
            ? {
                resourceReceipt: {
                  ...current.resourceReceipt!,
                  identity: { diskId: "replacement" },
                },
              }
            : { attachedSessionIds: ["replacement-session"] }),
        });
      }
      bundleReady.resolve();
      if (fault !== "none") {
        await expect(withinTest(pending, signal)).rejects.toThrow(
          fault === "request"
            ? "download reader revoked"
            : fault === "disk"
              ? "disk is missing or changed"
              : "Repository workspace edit lost its exact session placement owner",
        );
        expect(f.events.some((event) => /workspace-command|quiescence|upload/.test(event))).toBe(
          false,
        );
        expect(await fs.readFile(path.join(f.remote, "file.txt"), "utf8")).toBe("before\n");
        return;
      }
      const result = await withinTest(pending, signal);
      if (operation === "get") {
        expect(result).toMatchObject({ file: { content: "before\n" } });
      }
      if (operation === "set") {
        expect(result).toMatchObject({ status: "updated" });
      }
      expect(await fs.readFile(path.join(f.remote, "file.txt"), "utf8")).toBe(
        operation === "set" ? "after\n" : "before\n",
      );
      expect(f.environments.get(ENVIRONMENT_ID)?.retention?.runtimeReady).toBe(true);
      expect(wire.errors).toEqual([]);
      expect(await f.store.get(f.repository.workspaceId)).toEqual(f.repository);
      expect(wake).toHaveBeenCalledOnce();
      if (operation === "capture") {
        await f.pause();
        await fs.writeFile(path.join(f.remote, "file.txt"), "later disk edit\n");
        wire.commands.length = 0;
        await capture();
        expect(wake).toHaveBeenCalledOnce();
        expect(wire.commands).toEqual([]);
      } else {
        await access.inspect("get", { path: "file.txt", files: [] });
        expect(wake).toHaveBeenCalledOnce();
      }
    } finally {
      unblock();
      signal.removeEventListener("abort", unblock);
      await pending?.catch(() => {});
      await f.close();
    }
  },
);
