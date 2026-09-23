import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { hashWorkerCredential } from "./credential.js";
import {
  createNodeWorkspaceTransferHttpCallback,
  handleNodeWorkspaceTransferHttpRequest,
} from "./node-workspace-transfer-http.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import * as support from "./service.test-support.js";

const delivery = vi.hoisted(() => ({
  command: undefined as string | undefined,
  afterCommit: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../../state/openclaw-state-worker-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../state/openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: (
      context: Parameters<typeof actual.runOpenClawStateWorkerOperation>[0],
      operation: Parameters<typeof actual.runOpenClawStateWorkerOperation>[1],
      options: Parameters<typeof actual.runOpenClawStateWorkerOperation>[2],
    ) =>
      actual.runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              const result = await scope.execute(command, executeOptions);
              if (command.type === delivery.command) {
                await delivery.afterCommit?.();
              }
              return result;
            },
          }),
        options,
      ),
  };
});

describe("node workspace credential revocation", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["diagnostic", "renewal", "revocation"] as const)(
    "revalidates HTTP blob authority after verification while %s publication is delayed",
    async (mutationKind) => {
      const { store } = support.testState;
      const ready = await support.seedReadyNodeDesktop("transfer-publication");
      const record = await store.transition({
        environmentId: ready.environmentId,
        from: ready.state,
        to: "attached",
        patch: support.attachedPatch(ready.environmentId, "session-publication"),
      });
      const localPath = path.join(support.testState.root, "publication-workspace");
      const payload = Buffer.from("verified workspace bytes during inventory publication");
      await fs.mkdir(localPath);
      await fs.writeFile(path.join(localPath, "proof.txt"), payload);
      const service = createNodeWorkspaceTransferService({
        getOwner: (environmentId) => store.getTransferOwner(environmentId),
        now: () => support.testState.nowMs,
        temporaryRoot: path.join(support.testState.root, "publication-transfer-tmp"),
      });
      const verified = createDeferred<boolean>();
      const resumeVerification = createDeferred();
      const committed = createDeferred();
      const publish = createDeferred();
      const handled = createDeferred<{ headersSent: boolean }>();
      const verifyBlob = service.verifyBlob.bind(service);
      const verification = vi.spyOn(service, "verifyBlob").mockImplementation(async (input) => {
        const valid = await verifyBlob(input);
        verified.resolve(valid);
        await resumeVerification.promise;
        return valid;
      });
      const callback = createNodeWorkspaceTransferHttpCallback(service);
      let handling: Promise<void> | undefined;
      const server = createServer((req, res) => {
        handling = handleNodeWorkspaceTransferHttpRequest({
          req,
          res,
          clientIp: "127.0.0.1",
          callback,
        })
          .catch((error: unknown) => {
            res.destroy(error instanceof Error ? error : new Error(String(error)));
          })
          .then(() => {
            handled.resolve({ headersSent: res.headersSent });
          });
      });
      const requestAbort = new AbortController();
      let request: Promise<{ status: number; body: Buffer } | { error: unknown }> | undefined;
      let mutation: Promise<unknown> | undefined;
      try {
        const prepared = await service.prepareSync({
          environmentId: record.environmentId,
          ownerEpoch: record.ownerEpoch,
          sessionId: "session-publication",
          generation: 1,
          localPath,
          isAuthorized: () => true,
        });
        const entry = prepared.snapshot.manifest.entries.find((row) => row.path === "proof.txt");
        if (entry?.type !== "file") {
          throw new Error("Missing verified blob fixture");
        }
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("HTTP blob fixture did not bind");
        }
        request = fetch(
          `http://127.0.0.1:${address.port}/__openclaw__/worker-transfer/v1/environments/${record.environmentId}/blobs/${entry.sha256}`,
          {
            headers: { authorization: `Bearer ${prepared.token}` },
            signal: requestAbort.signal,
          },
        )
          .then(async (response) => ({
            status: response.status,
            body: Buffer.from(await response.arrayBuffer()),
          }))
          .catch((error: unknown) => ({ error }));
        expect(
          await Promise.race([
            verified.promise,
            handled.promise.then(() => {
              throw new Error("HTTP request finished before blob verification");
            }),
          ]),
        ).toBe(true);
        delivery.command =
          mutationKind === "diagnostic"
            ? "workerEnvironments.recordError"
            : mutationKind === "renewal"
              ? "workerEnvironments.renewCredential"
              : "workerEnvironments.revokeEnvironmentCredential";
        delivery.afterCommit = async () => {
          committed.resolve();
          await publish.promise;
        };
        mutation =
          mutationKind === "diagnostic"
            ? store.recordError({
                environmentId: record.environmentId,
                state: record.state,
                error: "unrelated provider diagnostic",
              })
            : mutationKind === "renewal"
              ? store.renewCredential({
                  environmentId: record.environmentId,
                  expectedOwnerEpoch: record.ownerEpoch,
                  credentialHash: hashWorkerCredential("publication-renewal"),
                  sessionId: "session-publication",
                  rpcSetVersion: 1,
                  expiresAtMs: support.testState.nowMs + 60_000,
                })
              : store.revokeEnvironmentCredential(record.environmentId);
        await Promise.race([
          committed.promise,
          mutation.then(() => {
            throw new Error("Inventory mutation finished before its publication gate");
          }),
        ]);
        resumeVerification.resolve();
        const response = await handled.promise;
        if (mutationKind === "revocation") {
          expect(response.headersSent).toBe(false);
        } else {
          expect(response.headersSent).toBe(true);
          expect(await request).toEqual({ status: 200, body: payload });
        }
        expect(verification).toHaveBeenCalledOnce();
        publish.resolve();
        await mutation;
      } finally {
        resumeVerification.resolve();
        publish.resolve();
        requestAbort.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        await Promise.allSettled([mutation, request, handling]);
        delivery.command = undefined;
        delivery.afterCommit = undefined;
        verification.mockRestore();
        await service.closeAll();
      }
    },
  );

  it.each([false, true])(
    "fences the real credential deletion before tunnel stop (upload pending: %s)",
    async (pendingUpload) => {
      const ready = await support.seedReadyNodeDesktop("transfer-owner");
      const record = await support.testState.store.transition({
        environmentId: ready.environmentId,
        from: ready.state,
        to: "attached",
        patch: support.attachedPatch(ready.environmentId, "session-transfer"),
      });
      const localPath = path.join(support.testState.root, "workspace");
      await fs.mkdir(localPath);
      await fs.writeFile(path.join(localPath, "input.txt"), "gateway input");
      const ownerSignal = new AbortController();
      const service = createNodeWorkspaceTransferService({
        getOwner: (environmentId) => support.testState.store.getTransferOwner(environmentId),
        now: () => support.testState.nowMs,
        temporaryRoot: path.join(support.testState.root, "transfer-tmp"),
      });
      const server = await startNodeWorkspaceTransferTestServer(service);
      const release = createDeferred();
      let uploadFailure: Promise<void> | undefined;
      let restoreOpen: (() => void) | undefined;
      try {
        const prepared = await service.prepareSync({
          environmentId: record.environmentId,
          ownerEpoch: record.ownerEpoch,
          sessionId: "session-transfer",
          generation: 1,
          localPath,
          isAuthorized: () => true,
          signal: ownerSignal.signal,
        });
        const route = {
          kind: "manifest",
          direction: "download",
          environmentId: record.environmentId,
          manifestRef: prepared.snapshot.manifestRef,
        } as const;
        const authorization = service.authorize({ route, token: prepared.token });
        if (!authorization) {
          throw new Error("expected admitted download");
        }
        let stagingRoot: string | undefined;
        if (pendingUpload) {
          const runtime = new NodeWorkerWorkspaceRuntime({
            root: path.join(support.testState.root, "node-workspaces"),
          });
          const input = {
            gatewayNamespace: "gateway-test",
            environmentId: record.environmentId,
            sessionId: "session-transfer",
            generation: 1,
            argv: ["openclaw-internal-workspace-transfer"],
          };
          const downloaded = await runtime.exec(
            {
              ...input,
              transfer: {
                direction: "download",
                token: prepared.token,
                manifestRef: prepared.snapshot.manifestRef,
              },
            },
            undefined,
            { url: server.gatewayUrl },
          );
          await fs.writeFile(path.join(downloaded.workspaceDir, "result.txt"), "node result");
          const opened = createDeferred();
          const originalOpen = fs.open.bind(fs);
          const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await originalOpen(...args);
            if (
              typeof args[0] === "string" &&
              args[0].includes(`${path.sep}upload-`) &&
              path.basename(args[0]) === "result.txt" &&
              args[1] === "wx"
            ) {
              stagingRoot = path.dirname(args[0]);
              opened.resolve();
              await release.promise;
            }
            return handle;
          });
          restoreOpen = () => open.mockRestore();
          const token = service.prepareUpload(record.environmentId, prepared.snapshot.manifestRef);
          uploadFailure = expect(
            runtime.exec(
              {
                ...input,
                transfer: {
                  direction: "upload",
                  token,
                  baseManifestRef: prepared.snapshot.manifestRef,
                  referenceManifestRef: prepared.snapshot.manifestRef,
                },
              },
              undefined,
              { url: server.gatewayUrl },
            ),
          ).rejects.toThrow("workspace-transfer-failed");
          await opened.promise;
        }

        // Teardown deletes this row before awaiting physical tunnel stop. Keep every
        // other owner fact live so the test isolates that immediate revocation fence.
        await support.testState.store.revokeEnvironmentCredential(record.environmentId);
        expect(support.testState.store.get(record.environmentId)).toMatchObject({
          state: "attached",
          ownerEpoch: record.ownerEpoch,
          attachedSessionIds: ["session-transfer"],
          destroyRequestedAtMs: null,
        });
        expect(ownerSignal.signal.aborted).toBe(false);
        expect(service.isAuthorizationCurrent(authorization)).toBe(false);
        expect(service.snapshot(authorization)).toBeUndefined();
        const response = await fetch(
          `${server.gatewayUrl.replace(/^ws/u, "http")}/__openclaw__/worker-transfer/v1/environments/${record.environmentId}/snapshots/${prepared.snapshot.manifestRef.slice(7)}/manifest`,
          {
            headers: { authorization: `Bearer ${prepared.token}` },
          },
        );
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({ error: "not_found" });
        expect(() =>
          service.prepareUpload(record.environmentId, prepared.snapshot.manifestRef),
        ).toThrow("context is unavailable");
        expect(() => service.publishSnapshot(record.environmentId, prepared.snapshot)).toThrow(
          "context is unavailable",
        );
        await expect(
          service.prepareAttachments({
            environmentId: record.environmentId,
            localPath,
            isAuthorized: () => true,
            signal: ownerSignal.signal,
          }),
        ).rejects.toThrow("authority closed");
        release.resolve();
        if (uploadFailure) {
          await uploadFailure;
          expect(stagingRoot).toBeDefined();
          await expect(fs.stat(stagingRoot!)).rejects.toMatchObject({ code: "ENOENT" });
          expect(() =>
            service.takeUpload(record.environmentId, prepared.snapshot.manifestRef),
          ).toThrow("did not complete");
        }
      } finally {
        release.resolve();
        try {
          await uploadFailure;
        } finally {
          restoreOpen?.();
          await service.closeAll();
          await server.close();
        }
      }
    },
  );
});
