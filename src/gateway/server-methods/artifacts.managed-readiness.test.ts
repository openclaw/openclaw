import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as combinedStore from "../../config/sessions/combined-store-gateway-read.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-accessor.sqlite-active-events.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry-replace.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "../../config/sessions/session-accessor.sqlite-lifecycle.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { isOpenClawAgentDatabaseRegistryChange } from "../../state/openclaw-agent-db-registry-listing.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { clearArtifactDownloads } from "../artifact-download-grants.js";
import { captureGatewayAuthPolicy } from "../auth-policy.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { handleManagedOutgoingMediaHttpRequest } from "../managed-image-attachments.js";
import { createFixture } from "../managed-image-attachments.test-support.js";
import { createRequestGate } from "../server-methods.request-gate.test-support.js";
import { SharedGatewaySessionGenerationState } from "../server-shared-auth-generation.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import * as transcriptReaders from "../session-transcript-readers.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";

afterEach(() => vi.restoreAllMocks());

it.for(["unchanged", "same-id reset", "relocated same-id session", "visibility revoked"] as const)(
  "prepares the original managed download after a registry publication: %s",
  async (change, { signal }) => {
    await withOpenClawTestState(
      { scenario: "minimal", prepareProfileCatalog: true },
      async (state) => {
        const storePath = state.statePath("current.sqlite");
        const otherPath = state.statePath("late-source.sqlite");
        let cfg: OpenClawConfig = {
          agents: { entries: { main: {} } },
          session: { store: storePath },
          gateway: {
            roles: {
              default: "reader",
              definitions: {
                reader: {
                  agents: "*",
                  sessions: { others: "view" },
                  scopes: ["operator.sessions.read"],
                },
              },
            },
          },
        };
        setRuntimeConfigSnapshot(cfg);
        const owner = ensureProfileForEmail("media-readiness-owner@example.test");
        const viewer = ensureProfileForEmail("media-readiness-viewer@example.test");
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:managed-readiness",
          sessionId: "managed-readiness",
          storePath,
        };
        const entry = {
          sessionId: scope.sessionId,
          lifecycleRevision: "original",
          updatedAt: 1,
          visibility: "shared" as const,
          createdActor: { type: "human" as const, source: "profile" as const, id: owner.id },
        };
        replaceSessionEntrySync(scope, entry);
        const bytes = createSolidPngBuffer(4, 2, { r: 17, g: 34, b: 51 });
        const messageId = "managed-readiness-message";
        const fixture = await createFixture(state.stateDir, {
          sessionKey: scope.sessionKey,
          agentId: scope.agentId,
          messageId,
          body: bytes,
        });
        const mediaUrl = `/api/chat/media/outgoing/${encodeURIComponent(scope.sessionKey)}/${fixture.attachmentId}/full`;
        const transcript = [
          { type: "session", version: 3, id: scope.sessionId },
          {
            type: "message",
            id: messageId,
            parentId: null,
            message: {
              role: "assistant",
              content: [{ type: "image", url: mediaUrl, openUrl: mediaUrl }],
            },
          },
        ];
        await replaceTranscriptEvents(scope, transcript);
        await waitForSessionTranscriptProjection(scope);
        const context = await createHistoryReadContext({
          getRuntimeConfig: () => cfg,
          getCommittedRuntimeConfig: () => cfg,
        });
        const projection = expectDefined(getSessionRowProjection(context), "managed projection");
        const query = { agentId: scope.agentId, key: scope.sessionKey };
        const generation = new SharedGatewaySessionGenerationState({
          current: undefined,
          required: null,
        });
        const harness = createDispatchTestHarness({
          buildRequestContext: () => context,
          getRequiredSharedGatewaySessionGeneration: generation.reader,
        });
        const connection = new AbortController();
        const client = createOperatorWsClient({
          connId: "managed-readiness-viewer",
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
        const httpWork: Promise<unknown>[] = [];
        const listener = await reserveTestPortListener({
          offsets: [0],
          createListener: () =>
            createServer((req, res) => {
              httpWork.push(
                handleManagedOutgoingMediaHttpRequest(req, res, {
                  auth: {
                    mode: "token",
                    token: "synthetic-unused-readiness-token",
                    allowTailscale: false,
                  },
                  stateDir: state.stateDir,
                  clients: harness.clients,
                })
                  .then((handled) => {
                    if (!handled) {
                      res.statusCode = 404;
                      res.end("not found");
                    }
                  })
                  .catch(() => {
                    res.statusCode = 404;
                    res.end("not found");
                  }),
              );
            }),
        });
        using media = createRequestGate();
        using topology = createRequestGate();
        let mediaHeld = false;
        const readMessages = transcriptReaders.readSessionMessagesMatchingIdAsync;
        vi.spyOn(transcriptReaders, "readSessionMessagesMatchingIdAsync").mockImplementation(
          async (...args) => {
            const messages = await readMessages(...args);
            if (!mediaHeld && args[0].sessionKey === scope.sessionKey && args[1] === messageId) {
              mediaHeld = true;
              await media.pause();
            }
            return messages;
          },
        );
        const requestId = "managed-first-grant";
        const artifactId = `artifact_managed_image_${fixture.attachmentId}`;
        const dispatch = harness.dispatcher.dispatch(
          {
            type: "req",
            id: requestId,
            method: "artifacts.download",
            params: { sessionKey: scope.sessionKey, artifactId },
          },
          client,
        );
        const dispatched = Promise.allSettled([dispatch]);
        const response = dispatch.then(() => harness.awaitResponseFrame(requestId));
        // Retain a rejection observer even if an earlier setup assertion aborts this case.
        void response.catch(() => {});
        let stopPublication = () => {};
        try {
          await withinTest(
            awaitGateBeforeSettlement(media.entered, response, "Managed read bypassed its worker"),
            signal,
          );
          const preparationEntered = createDeferredCore();
          const prepareMembership = projection.prepareMembership.bind(projection);
          vi.spyOn(projection, "prepareMembership").mockImplementation(async () => {
            preparationEntered.resolve();
            return prepareMembership();
          });
          let topologyHeld = false;
          const prepareTopology = combinedStore.prepareCombinedSessionStoreForGatewayAsync;
          vi.spyOn(combinedStore, "prepareCombinedSessionStoreForGatewayAsync").mockImplementation(
            async (...args) => {
              const prepared = await prepareTopology(...args);
              if (!topologyHeld) {
                topologyHeld = true;
                await topology.pause();
              }
              return prepared;
            },
          );
          let registered = false;
          stopPublication = sessionChanges.subscribeFacts((publication) => {
            registered ||= isOpenClawAgentDatabaseRegistryChange(publication);
          });
          // A normal opener publishes an actual new source, not a fabricated receipt or status.
          openOpenClawAgentDatabase({ agentId: scope.agentId, path: otherPath, env: state.env });
          expect(registered).toBe(true);
          await withinTest(
            awaitGateBeforeSettlement(
              topology.entered,
              response,
              "Registry publication did not reach topology preparation",
            ),
            signal,
          );
          expect(projection.sharingTargetState(query)).toEqual({ status: "pending" });
          media.release();
          // Keep the real topology result held until this same request joins its owner.
          // Removing post-read preparation makes the original RPC settle UNAVAILABLE first.
          await withinTest(
            awaitGateBeforeSettlement(
              preparationEntered.promise,
              response,
              "Managed download settled before preparing its original read",
            ),
            signal,
          );
          if (change === "same-id reset") {
            await replaceSessionEntry(scope, { ...entry, lifecycleRevision: "replacement" });
          } else if (change === "visibility revoked") {
            await replaceSessionEntry(scope, { ...entry, visibility: "draft" });
          } else if (change === "relocated same-id session") {
            expect(
              await deleteSessionEntryLifecycle({
                agentId: scope.agentId,
                storePath,
                target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
                expectedSessionId: scope.sessionId,
                expectedLifecycleRevision: entry.lifecycleRevision,
                archiveTranscript: false,
              }),
            ).toMatchObject({ deleted: true });
            const replacement = { ...scope, storePath: otherPath };
            replaceSessionEntrySync(replacement, entry);
            await replaceTranscriptEvents(replacement, transcript);
            await waitForSessionTranscriptProjection(replacement);
            cfg = { ...cfg, session: { ...cfg.session, store: otherPath } };
            setRuntimeConfigSnapshot(cfg);
          }
          topology.release();
          const result = await withinTest(response, signal);
          expect(harness.send).toHaveBeenCalledOnce();
          if (change === "relocated same-id session") {
            expect(projection.sharingTargetState(query)).toMatchObject({
              status: "ready",
              target: {
                storePath: otherPath,
                entry: { sessionId: scope.sessionId, lifecycleRevision: entry.lifecycleRevision },
              },
            });
          }
          if (change !== "unchanged") {
            expect(result).toMatchObject({
              ok: false,
              error: { code: "UNAVAILABLE", retryable: true },
            });
            expect(result.payload).toBeUndefined();
            expect(httpWork).toEqual([]);
            return;
          }
          expect(result.ok).toBe(true);
          const payload = result.payload as { artifact: { id: string }; url: string };
          expect(payload.artifact.id).toBe(artifactId);
          expect(payload.url).toContain(`${mediaUrl}?mediaTicket=`);
          const downloaded = await fetch(`http://127.0.0.1:${listener.claim.port}${payload.url}`, {
            signal,
          });
          expect(downloaded.status).toBe(200);
          expect(downloaded.headers.get("content-type")).toBe("image/png");
          expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
        } finally {
          media.release();
          topology.release();
          stopPublication();
          await dispatched;
          try {
            await projection.ensureMaterialized();
          } finally {
            try {
              connection.abort();
              harness.clients.delete(client);
              clearArtifactDownloads();
              listener.listener.closeAllConnections();
              await Promise.allSettled(httpWork);
            } finally {
              try {
                await listener.releaseListener();
              } finally {
                await listener.claim.release();
              }
            }
            expect([...harness.clients.authorityClients]).toEqual([]);
          }
        }
      },
    );
  },
);
