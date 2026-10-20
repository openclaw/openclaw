import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { clearArtifactDownloads } from "../artifact-download-grants.js";
import { captureGatewayAuthPolicy } from "../auth-policy.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { handleManagedOutgoingMediaHttpRequest } from "../managed-image-attachments.js";
import * as managedMedia from "../managed-image-attachments.js";
import { createFixture } from "../managed-image-attachments.test-support.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { SharedGatewaySessionGenerationState } from "../server-shared-auth-generation.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import { invalidateGatewayPolicyClient } from "../server/ws-policy-close.js";
import * as preparation from "../session-sharing-preparation.js";
import * as artifactReads from "../session-transcript-readers.js";
import { artifactsHandlers } from "./artifacts.js";
import {
  artifactSession,
  invokeArtifact,
  writeArtifactTranscript,
} from "./artifacts.test-support.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { fetchSessionFileDownload } from "./sessions-files.test-support.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("admits session-only artifact readers with current session visibility and prepared facts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const { scope, entry } = artifactSession("prepared-artifacts");
    await replaceSessionEntry(scope, entry);
    const data = Buffer.alloc(912, "x").toString("base64");
    await writeArtifactTranscript(scope, [{ type: "file", title: "result.txt", data }]);
    const context = await createHistoryReadContext();
    let client = identifiedClient("viewer");
    client.connect.scopes = ["operator.sessions.read"];
    const controller = new AbortController();
    client.connId = "session-artifact-reader";
    client.connectionSignal = controller.signal;
    using _ = { [Symbol.dispose]: () => controller.abort() };
    const request = async (
      method: "artifacts.list" | "artifacts.get" | "artifacts.download",
      params: Record<string, unknown> = {},
      throughDispatcher = true,
    ) => {
      const respond = await invokeArtifact(
        method,
        { sessionKey: scope.sessionKey, ...params },
        {
          context,
          client,
          id: "prepared-artifacts",
          dispatch: throughDispatcher
            ? (options) => handleGatewayRequest({ ...options, extraHandlers: artifactsHandlers })
            : artifactsHandlers[method]!,
        },
      );
      return respond.mock.calls[0]!;
    };
    const listed = await request("artifacts.list");
    expect(listed[0]).toBe(true);
    const payload = listed[1] as { artifacts: { id: string; sizeBytes: number }[] };
    expect(payload.artifacts).toEqual([expect.objectContaining({ sizeBytes: 912 })]);
    const artifactId = payload.artifacts[0]!.id;
    const granted = await request("artifacts.download", { artifactId, transport: "http" });
    expect(granted[0]).toBe(true);
    const download = granted[1] as { url: string };
    expect(download.url).toMatch(/^\/api\/artifacts\/download\//);
    const fetched = await fetchSessionFileDownload(client, download.url);
    expect(fetched.response.statusCode).toBe(200);
    expect(fetched.body).toEqual(new Uint8Array(Buffer.from(data, "base64")));
    for (const method of ["artifacts.get", "artifacts.download"] as const) {
      const missing = await request(method, { artifactId: "artifact_missing" });
      expect(missing[0]).toBe(false);
      expect(missing[2]).toMatchObject({ details: { type: "artifact_not_found" } });
      const unknown = await request(method, {
        sessionKey: "agent:main:unknown-artifacts",
        artifactId,
      });
      expect(unknown.slice(0, 2)).toEqual([false, undefined]);
    }
    const { scope: otherScope } = artifactSession("other-artifacts");
    await replaceSessionEntry(otherScope, { ...entry, sessionId: otherScope.sessionId });
    for (const method of ["artifacts.get", "artifacts.download"] as const) {
      const unrelated = await request(method, { sessionKey: otherScope.sessionKey, artifactId });
      expect(unrelated[0]).toBe(false);
      expect(unrelated[2]).toMatchObject({ details: { type: "artifact_not_found" } });
    }
    const prepare = vi.spyOn(preparation, "prepareSessionMutationFacts");
    for (const method of ["artifacts.list", "artifacts.get", "artifacts.download"] as const) {
      const result = await request(
        method,
        method === "artifacts.list" ? {} : { artifactId },
        false,
      );
      expect(result[0]).toBe(true);
      if (method !== "artifacts.list") {
        expect(result[1]).toMatchObject({ artifact: { id: artifactId, sizeBytes: 912 } });
      }
      if (method === "artifacts.download") {
        expect(result[1]).toMatchObject({ data, encoding: "base64" });
      }
    }
    expect(prepare).not.toHaveBeenCalled();
    const readArtifacts = artifactReads.readSessionArtifacts;
    vi.spyOn(artifactReads, "readSessionArtifacts").mockImplementationOnce(async (...args) => {
      const result = await readArtifacts(...args);
      await replaceSessionEntry(scope, { ...entry, visibility: "draft", updatedAt: 2 });
      return result;
    });
    const revoked = await request("artifacts.download", { artifactId });
    expect(revoked[0]).toBe(false);
    expect(revoked[2]).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    const revokedDownload = await fetchSessionFileDownload(client, download.url);
    expect(revokedDownload.response.statusCode).toBe(404);
    expect(revokedDownload.body).toEqual(new Uint8Array(Buffer.from("Not Found")));
    for (const method of ["artifacts.list", "artifacts.get", "artifacts.download"] as const) {
      const result = await request(method, method === "artifacts.list" ? {} : { artifactId });
      expect(result.slice(0, 2)).toEqual([false, undefined]);
      expect(result[2]).toMatchObject({ code: "INVALID_REQUEST" });
    }
    client = identifiedClient("owner");
    client.connect.scopes = ["operator.sessions.read"];
    for (const method of ["artifacts.list", "artifacts.get", "artifacts.download"] as const) {
      const owned = await request(method, method === "artifacts.list" ? {} : { artifactId });
      expect(owned[0]).toBe(true);
    }
  });
});

it("keeps disconnected managed reads current for session visibility and profile role changes", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} } },
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: {
                agents: "*" as const,
                sessions: { others: "view" as const },
                scopes: ["operator.sessions.read"],
              },
              denied: { agents: "*" as const, sessions: { others: "none" as const }, scopes: [] },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const owner = ensureProfileForEmail("managed-owner@example.test");
      const viewer = ensureProfileForEmail("managed-viewer@example.test");
      const { scope, entry } = artifactSession("managed-authority", owner.id);
      await replaceSessionEntry(scope, entry);
      const bytes = createSolidPngBuffer(4, 2, { r: 17, g: 34, b: 51 });
      const fixture = await createFixture(state.stateDir, {
        sessionKey: scope.sessionKey,
        agentId: "main",
        messageId: "managed-message",
        body: bytes,
      });
      const originalUrl = `/api/chat/media/outgoing/${encodeURIComponent(scope.sessionKey)}/${fixture.attachmentId}/full`;
      await writeArtifactTranscript(
        scope,
        [{ type: "image", url: originalUrl, openUrl: originalUrl }],
        "managed-message",
      );
      const context = await createHistoryReadContext({
        getRuntimeConfig: () => cfg,
        getCommittedRuntimeConfig: () => cfg,
      });
      const generation = new SharedGatewaySessionGenerationState({
        current: undefined,
        required: null,
      });
      const harness = createDispatchTestHarness({
        buildRequestContext: () => context,
        getRequiredSharedGatewaySessionGeneration: generation.reader,
      });
      const profileContext = createGatewayRequestContext(
        makeContextParams({ clients: harness.clients }),
      );
      const connections: AbortController[] = [];
      let requestNumber = 0;
      const request = async (
        client: ReturnType<typeof createOperatorWsClient>,
        method: "artifacts.list" | "artifacts.download",
        artifactId?: string,
      ) => {
        const id = `managed-request-${++requestNumber}`;
        await harness.dispatcher.dispatch(
          {
            type: "req",
            id,
            method,
            params: { sessionKey: scope.sessionKey, ...(artifactId ? { artifactId } : {}) },
          },
          client,
        );
        const response = await harness.awaitResponseFrame(id);
        expect(response.ok).toBe(true);
        return response.payload;
      };
      const responses: Promise<unknown>[] = [];
      const listener = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          createServer((req, res) => {
            responses.push(
              handleManagedOutgoingMediaHttpRequest(req, res, {
                auth: {
                  mode: "token",
                  token: "synthetic-unused-owner-token",
                  allowTailscale: false,
                },
                stateDir: state.stateDir,
                clients: harness.clients,
              }).catch(() => {
                res.statusCode = 404;
                res.end("not found");
              }),
            );
          }),
      });
      const read = (url: string) => fetch(`http://127.0.0.1:${listener.claim.port}${url}`);
      try {
        for (const change of ["visibility", "profile role"] as const) {
          await replaceSessionEntry(scope, { ...entry, updatedAt: 2 });
          const connection = new AbortController();
          connections.push(connection);
          const client = createOperatorWsClient({
            connId: `managed-${change}`,
            scopes: ["operator.sessions.read"],
            socket: { close: vi.fn() },
          });
          client.connectionSignal = connection.signal;
          client.authenticatedUserProfile = {
            profileId: viewer.id,
            displayName: "Managed reader",
            hasAvatar: false,
            avatarRevision: "none",
            updatedAt: 1,
          };
          client.internal = { operatorRoleActor: { kind: "operator", profileId: viewer.id } };
          client.authPolicy = captureGatewayAuthPolicy(cfg, null);
          prepareGatewayRecipientProfile(client);
          harness.clients.add(client);
          const listed = (await request(client, "artifacts.list")) as {
            artifacts: { id: string }[];
          };
          expect(listed.artifacts).toHaveLength(1);
          const legacyId = listed.artifacts[0]!.id;
          expect(legacyId).not.toMatch(/^artifact_managed_/);
          const urls: string[] = [];
          for (const artifactId of [`artifact_managed_image_${fixture.attachmentId}`, legacyId]) {
            const download = (await request(client, "artifacts.download", artifactId)) as {
              url: string;
            };
            urls.push(download.url, download.url.replace("/full?", "/thumbnail?"));
          }
          for (const [index, url] of urls.entries()) {
            const response = await read(url);
            expect(response.status).toBe(200);
            expect(response.headers.get("cache-control")).toBe("private, no-store");
            const body = Buffer.from(await response.arrayBuffer());
            if (index % 2 === 0) {
              expect(body).toEqual(bytes);
            } else {
              expect(response.headers.get("content-type")).toBe("image/webp");
              expect(body.byteLength).toBeGreaterThan(0);
            }
          }
          invalidateGatewayPolicyClient(client, {
            reason: "transport-closed",
            code: 1001,
            message: "transport closed",
            revokeSource: false,
          });
          connection.abort();
          harness.clients.delete(client);
          for (const url of urls) {
            const disconnected = await read(url);
            expect(disconnected.status).toBe(200);
            expect((await disconnected.arrayBuffer()).byteLength).toBeGreaterThan(0);
          }
          if (change === "visibility") {
            await replaceSessionEntry(scope, { ...entry, visibility: "draft", updatedAt: 3 });
            const readers = [
              vi.spyOn(artifactReads, "readSessionArtifacts"),
              vi.spyOn(managedMedia, "resolveManagedOutgoingMediaArtifactDownload"),
              vi.spyOn(managedMedia, "resolveManagedOutgoingMediaUrlDownload"),
            ];
            const denied = await invokeArtifact(
              "artifacts.download",
              {
                sessionKey: scope.sessionKey,
                artifactId: `artifact_managed_image_${fixture.attachmentId}`,
              },
              {
                context,
                client: identifiedClient(viewer.id),
                dispatch: artifactsHandlers["artifacts.download"]!,
              },
            );
            expect(denied.mock.calls).toEqual([
              [
                false,
                undefined,
                {
                  code: "INVALID_REQUEST",
                  message: "no session found for artifact query",
                  details: { type: "artifact_scope_not_found" },
                },
              ],
            ]);
            for (const reader of readers) {
              expect(reader).not.toHaveBeenCalled();
              reader.mockRestore();
            }
          } else {
            await setCanonicalUserProfileRole(viewer.id, "denied", {
              onCommitted: (profileId) => {
                invalidateOperatorRolePolicy(profileId);
                profileContext.disconnectClientsForUserProfile?.(profileId);
              },
            });
          }
          for (const url of urls) {
            const revoked = await read(url);
            expect(revoked.status, change).toBe(404);
            expect(await revoked.text()).toBe("not found");
          }
        }
      } finally {
        connections.forEach((connection) => connection.abort());
        listener.listener.closeAllConnections();
        await Promise.all(responses);
        clearArtifactDownloads();
        expect([...harness.clients.authorityClients]).toEqual([]);
        await listener.releaseListener();
        await listener.claim.release();
      }
    },
  );
});
