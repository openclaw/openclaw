import "./store-publication.test-support.js";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../../test/helpers/gateway-integration-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { hashWorkerCredential } from "./credential.js";
import {
  interceptUploadFile,
  transferFixture as createTransferFixture,
} from "./node-workspace-transfer-fixtures.test-support.js";
import {
  createNodeWorkspaceTransferHttpCallback,
  handleNodeWorkspaceTransferHttpRequest,
} from "./node-workspace-transfer-http.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import * as support from "./service.test-support.js";

const { delivery } = await import("./store-publication.test-support.js");

async function transferFixture(name: string, filename: string, payload: string | Buffer) {
  const { store, root } = support.testState;
  const ready = await support.seedReadyNodeDesktop(name);
  const sessionId = `session-${name}`;
  const record = await store.transition({
    environmentId: ready.environmentId,
    from: ready.state,
    to: "attached",
    patch: support.attachedPatch(ready.environmentId, sessionId),
  });
  const { service, request, files } = await createTransferFixture(root, {
    environmentId: record.environmentId,
    ownerEpoch: record.ownerEpoch,
    sessionId,
    getOwner: (id) => store.getTransferOwner(id),
    now: () => support.testState.nowMs,
    temporaryRoot: path.join(root, "transfer-tmp"),
  });
  await files.write(filename, payload);
  const input = { ...request, signal: new AbortController().signal };
  return { service, record, input };
}

describe("node workspace credential revocation", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["recordError", "renewCredential", "revokeEnvironmentCredential"] as const)(
    "revalidates HTTP blob authority after verification while %s publication is delayed",
    async (mutationKind) => {
      const { store } = support.testState;
      const payload = Buffer.from("verified workspace bytes during inventory publication");
      const { service, record, input } = await transferFixture("publication", "proof.txt", payload);
      const verified = createDeferred<boolean>();
      const resumeVerification = createDeferred();
      const committed = createDeferred();
      const publish = createDeferred();
      const handled = createDeferred<boolean>();
      const verifyBlob = service.verifyBlob.bind(service);
      const verification = vi.spyOn(service, "verifyBlob").mockImplementation(async (blob) => {
        const valid = await verifyBlob(blob);
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
          .then(() => handled.resolve(res.headersSent));
      });
      const requestAbort = new AbortController();
      let request: Promise<{ status: number; body: Buffer } | { error: unknown }> | undefined;
      let mutation: Promise<unknown> | undefined;
      try {
        const prepared = await service.prepareSync(input);
        const entry = prepared.snapshot.manifest.entries.find((row) => row.path === "proof.txt");
        assert(entry?.type === "file", "Missing verified blob fixture");
        const origin = await listenLoopback(server);
        request = fetch(
          `${origin}/__openclaw__/worker-transfer/v1/environments/${record.environmentId}/blobs/${entry.sha256}`,
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
          await awaitGateBeforeSettlement(
            verified.promise,
            handled.promise,
            "HTTP request finished before blob verification",
          ),
        ).toBe(true);
        delivery.command = `workerEnvironments.${mutationKind}`;
        delivery.afterCommit = async () => {
          committed.resolve();
          await publish.promise;
        };
        mutation =
          mutationKind === "recordError"
            ? store.recordError({
                environmentId: record.environmentId,
                state: record.state,
                error: "unrelated provider diagnostic",
              })
            : mutationKind === "renewCredential"
              ? store.renewCredential({
                  environmentId: record.environmentId,
                  expectedOwnerEpoch: record.ownerEpoch,
                  credentialHash: hashWorkerCredential("publication-renewal"),
                  sessionId: input.sessionId,
                  rpcSetVersion: 1,
                  expiresAtMs: support.testState.nowMs + 60_000,
                })
              : store.revokeEnvironmentCredential(record.environmentId);
        await awaitGateBeforeSettlement(
          committed.promise,
          mutation,
          "Inventory mutation finished before its publication gate",
        );
        resumeVerification.resolve();
        expect(await handled.promise).toBe(mutationKind !== "revokeEnvironmentCredential");
        if (mutationKind !== "revokeEnvironmentCredential") {
          expect(await request).toEqual({ status: 200, body: payload });
        }
        publish.resolve();
        await mutation;
      } finally {
        resumeVerification.resolve();
        publish.resolve();
        requestAbort.abort();
        await closeHttpServer(server);
        await Promise.allSettled([mutation, request, handling]);
        delivery.command = undefined;
        delivery.afterCommit = undefined;
        verification.mockRestore();
        await service.closeAll();
      }
    },
  );

  it("fences real credential deletion and a pending upload before tunnel stop", async () => {
    const fixture = await transferFixture("transfer", "input.txt", "gateway input");
    const { service, record, input: preparation } = fixture;
    const { environmentId, ownerEpoch } = record;
    const server = await startNodeWorkspaceTransferTestServer(service);
    const release = createDeferred();
    let uploadFailure: Promise<void> | undefined;
    let restoreOpen: (() => void) | undefined;
    try {
      const { snapshot, token: downloadToken } = await service.prepareSync(preparation);
      const route = {
        kind: "manifest",
        direction: "download",
        environmentId,
        manifestRef: snapshot.manifestRef,
      } as const;
      const authorization = service.authorize({ route, token: downloadToken });
      assert(authorization, "expected admitted download");
      let stagingRoot: string | undefined;
      const runtime = new NodeWorkerWorkspaceRuntime({
        root: path.join(support.testState.root, "node-workspaces"),
      });
      const input = {
        gatewayNamespace: "gateway-test",
        environmentId,
        sessionId: preparation.sessionId,
        generation: 1,
        argv: ["openclaw-internal-workspace-transfer"],
      };
      const exec = (transfer: Parameters<typeof runtime.exec>[0]["transfer"]) =>
        runtime.exec({ ...input, transfer }, undefined, { url: server.gatewayUrl });
      const downloaded = await exec({
        direction: "download",
        token: downloadToken,
        manifestRef: snapshot.manifestRef,
      });
      await fs.writeFile(path.join(downloaded.workspaceDir, "result.txt"), "node result");
      const opened = createDeferred();
      const open = interceptUploadFile("result.txt", async (_handle, file) => {
        stagingRoot = path.dirname(file);
        opened.resolve();
        await release.promise;
      });
      restoreOpen = () => open.mockRestore();
      const token = service.prepareUpload(environmentId, snapshot.manifestRef);
      uploadFailure = expect(
        exec({
          direction: "upload",
          token,
          baseManifestRef: snapshot.manifestRef,
          referenceManifestRef: snapshot.manifestRef,
        }),
      ).rejects.toThrow("workspace-transfer-failed");
      await opened.promise;

      // Credential deletion must fence transfers while every other owner fact stays live.
      await support.testState.store.revokeEnvironmentCredential(environmentId);
      expect(support.testState.store.get(environmentId)).toMatchObject({
        state: "attached",
        ownerEpoch,
        attachedSessionIds: [preparation.sessionId],
        destroyRequestedAtMs: null,
      });
      expect({
        aborted: preparation.signal.aborted,
        current: service.isAuthorizationCurrent(authorization),
        snapshot: service.snapshot(authorization),
      }).toEqual({ aborted: false, current: false, snapshot: undefined });
      const response = await fetch(
        `${server.gatewayUrl.replace(/^ws/u, "http")}/__openclaw__/worker-transfer/v1/environments/${environmentId}/snapshots/${snapshot.manifestRef.slice(7)}/manifest`,
        {
          headers: { authorization: `Bearer ${downloadToken}` },
        },
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "not_found" });
      for (const operation of [
        () => service.prepareUpload(environmentId, snapshot.manifestRef),
        () => service.publishSnapshot(environmentId, snapshot),
      ]) {
        expect(operation).toThrow("context is unavailable");
      }
      await expect(service.prepareAttachments(preparation)).rejects.toThrow("authority closed");
      release.resolve();
      await uploadFailure;
      expect(stagingRoot).toBeDefined();
      await expect(fs.stat(stagingRoot!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(() => service.takeUpload(environmentId, snapshot.manifestRef)).toThrow(
        "did not complete",
      );
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
  });
});
