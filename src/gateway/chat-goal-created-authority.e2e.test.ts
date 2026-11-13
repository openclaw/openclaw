import assert from "node:assert/strict";
import { randomUUID, X509Certificate } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
// Prepare real agent/Gateway declarations during collection, outside the proof deadline.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { subscribeSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { getSubagentRunByRunId } from "../agents/subagents/registry/subagent-registry.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { readTranscriptStorageRows } from "../config/sessions/session-accessor.sqlite-read.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  assistantText,
  transcriptContent,
  createGoalAuthorityScenarios,
  createGoalAuthorityProvider,
  createGoalAuthorityEvidence,
} from "./chat-goal-created-authority.test-support.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import { productModelConfig } from "./server.chat-product.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

function canonicalTranscriptBytes(sessionKey: string) {
  const entry = loadSessionEntry({ agentId: "main", sessionKey });
  assert(entry, "The created session must have a canonical row");
  // Preserve stored event JSON verbatim, including whitespace and row metadata.
  const rows = readTranscriptStorageRows(
    openOpenClawAgentDatabase({ agentId: "main" }),
    entry.sessionId,
  );
  return Buffer.from(JSON.stringify(rows), "utf8");
}

// Fixed provider decisions; real identified operators, tools, authority and persisted effects.
for (const mode of ["role ceiling", "confidential audience"] as const) {
  it(
    "preserves restricted Goal returns and cancels revoked returns before further effects (" +
      mode +
      ")",
    { timeout: 120_000 },
    async ({ signal }) => {
      const confidential = mode === "confidential audience";
      const { alias, digest, instrument, trace, assertEvidenceComplete } =
        createGoalAuthorityEvidence(mode);
      const state = await createOpenClawTestState({
        label: "goal-created-authority",
        prepareProfileCatalog: true,
        env: {
          ...KERNEL_TEST_ENV,
          VITEST: process.env.VITEST,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      });
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(assertEvidenceComplete);
      cleanup.defer(() => state.cleanup());
      const adminProfile = ensureProfileForEmail("admin@goal-authority.example.test");
      setUserProfileRole(adminProfile.id, "administrator");
      const privateActors = confidential
        ? {
            creator: ensureProfileForEmail("creator@goal-authority.example.test"),
            excluded: ensureProfileForEmail("excluded@goal-authority.example.test"),
          }
        : undefined;
      if (privateActors) {
        setUserProfileRole(privateActors.excluded.id, "viewer");
        alias(privateActors.creator.id, "creator-profile");
        alias(privateActors.excluded.id, "excluded-viewer-profile");
      }
      const scenarios = createGoalAuthorityScenarios(alias);
      cleanup.defer(() => {
        for (const scenario of scenarios) {
          scenario.releaseChild.resolve();
          scenario.releaseSettlement.resolve();
        }
      });
      const failed = createDeferredCore<never>();
      void failed.promise.catch(() => {});
      const wait = <T>(work: Promise<T>) =>
        withinTest(Promise.race([work, failed.promise]), signal);
      const errors: unknown[] = [];
      const provider = createGoalAuthorityProvider(
        errors,
        scenarios,
        confidential,
        wait,
        (error) => failed.reject(error),
        trace,
      );
      cleanup.defer(() => closeProvider(provider));
      const model = buildMockOpenAiResponsesProvider(
        await listenProvider(provider),
        "goal-authority-fixture",
      );
      const { defaults, models } = productModelConfig(state.workspaceDir, model);
      const scopes: OperatorScope[] = ["operator.read", "operator.write"];
      const origin = "https://control.example.test";
      const auth: GatewayAuthConfig = {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowUsers: (privateActors
            ? ["admin", "creator", "excluded", "current", "revoke"]
            : ["admin", "current", "revoke"]
          ).map((name) => `${name}@goal-authority.example.test`),
          allowLoopback: true,
          deviceAutoApprove: { enabled: true, scopes },
        },
        identityScopes: { "admin@goal-authority.example.test": ["operator.admin"] },
      };
      const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
      const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, sibling: {} }, defaults },
        models,
        plugins: { enabled: false, slots: { memory: "none" } },
        tools: {
          allow: [
            "create_goal",
            "update_goal",
            "sessions_spawn",
            "sessions_yield",
            "sessions_create",
          ],
          toolSearch: false,
          codeMode: { enabled: false },
        },
        messages: { queue: { mode: "followup", debounceMsByChannel: { webchat: 0 } } },
        gateway: {
          auth,
          trustedProxies: ["127.0.0.1", "::1"],
          controlUi: { allowedOrigins: [origin] },
          tls: { enabled: true, autoGenerate: false, certPath, keyPath },
          roles: {
            default: "member",
            definitions: {
              administrator: {
                agents: "*",
                sessions: { others: "write" },
                scopes: ["operator.admin"],
              },
              member: { agents: ["main"], sessions: { others: "write" }, scopes },
              revoked: { agents: [], sessions: { others: "none" }, scopes: ["operator.read"] },
              ...(privateActors
                ? {
                    viewer: {
                      agents: ["main"],
                      sessions: { others: "view" },
                      scopes: ["operator.read"],
                    },
                  }
                : {}),
            },
          },
        },
      };
      const headers = (name: string) => ({
        "x-forwarded-user": `${name}@goal-authority.example.test`,
        "x-forwarded-proto": "https",
        "x-forwarded-for": "203.0.113.50",
      });
      const connection = {
        clientName: "openclaw-control-ui" as const,
        mode: "webchat" as const,
        origin,
        tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
      };
      const publicationText = `POST_REVOCATION_${randomUUID()}`;
      const authorizedEvents: Array<{ event?: string; payload?: unknown }> = [];
      const authorizedPublication = createDeferredCore();
      const gateway = await startGatewayWithClient({
        ...connection,
        cfg,
        configPath: state.configPath,
        auth,
        secure: true,
        scopes: ["operator.admin"],
        edgeAuthHeaders: headers("admin"),
        onEvent: (event) => {
          trace({ kind: "websocket.event", actor: "administrator", event });
          authorizedEvents.push(event);
          const payload = asOptionalRecord(event.payload);
          if (
            event.event === "session.message" &&
            assistantText(payload?.message) === publicationText
          ) {
            authorizedPublication.resolve();
          }
        },
      });
      cleanup.defer(async () => {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "Goal authority proof complete" });
      });
      await gateway.server.startupSettled;
      const admin = instrument(gateway.client, "administrator");
      const connectActor = async (name: string, actorScopes: OperatorScope[]) => {
        const actor = instrument(
          await connectGatewayClient({
            ...connection,
            url: "wss://127.0.0.1:" + gateway.port,
            scopes: actorScopes,
            edgeAuthHeaders: headers(name),
            deviceIdentity: loadOrCreateDeviceIdentity({
              path: state.path(name, "client", "credentials.sqlite"),
            }),
            onEvent: (event) => trace({ kind: "websocket.event", actor: name, event }),
          }),
          name,
        );
        cleanup.defer(() => disconnectGatewayClient(actor));
        return actor;
      };
      const audienceClients = privateActors
        ? {
            creator: await connectActor("creator", scopes),
            excluded: await connectActor("excluded", ["operator.read"]),
            creatorId: privateActors.creator.id,
            excludedId: privateActors.excluded.id,
          }
        : undefined;
      if (audienceClients) {
        expect(await audienceClients.creator.request("users.self", {})).toMatchObject({
          profile: { id: audienceClients.creatorId },
        });
        expect(await audienceClients.excluded.request("users.self", {})).toMatchObject({
          profile: { id: audienceClients.excludedId },
        });
      }
      trace({
        kind: "proof.scope",
        scope:
          "Real isolated source Gateway; synthetic identified operators and fixed external provider I/O; not product build or binary upgrade",
        audienceConfigured: confidential,
        rolesUnchangedDuringRevocation: confidential,
      });
      for (const scenario of scenarios) {
        const events: Array<{ event?: string; payload?: unknown }> = [];
        const member = await connectGatewayClient({
          ...connection,
          url: `wss://127.0.0.1:${gateway.port}`,
          scopes,
          edgeAuthHeaders: headers(scenario.name),
          deviceIdentity: loadOrCreateDeviceIdentity({
            path: state.path(scenario.name, "client", "credentials.sqlite"),
          }),
          onEvent: (event) => {
            trace({ kind: "websocket.event", actor: scenario.name, event });
            events.push(event);
            const payload = asOptionalRecord(event.payload);
            if (
              event.event === "session.message" &&
              payload?.sessionKey === scenario.sessionKey &&
              assistantText(payload.message) === scenario.finalText
            ) {
              scenario.finalReceived.resolve();
            }
          },
        });
        instrument(member, scenario.name);
        cleanup.defer(() => disconnectGatewayClient(member));
        expect(await member.request("users.self", {})).toMatchObject({
          profile: { id: scenario.profile.id },
        });
        const created = await (audienceClients?.creator ?? member).request<{ key: string }>(
          "sessions.create",
          {
            agentId: "main",
            label: `Goal ${scenario.name}`,
            ...(audienceClients
              ? {
                  visibility: "shared",
                  access: { mode: "audience", profileIds: [scenario.profile.id] },
                }
              : {}),
          },
        );
        scenario.sessionKey = created.key;
        alias(created.key, "session-" + scenario.name);
        if (audienceClients) {
          expect(loadSessionEntry({ agentId: "main", sessionKey: created.key })).toMatchObject({
            visibility: "shared",
            createdActor: { id: audienceClients.creatorId },
            access: { mode: "audience", profileIds: [scenario.profile.id] },
          });
          await audienceClients.creator.request("chat.history", {
            sessionKey: created.key,
            limit: 100,
          });
          await member.request("chat.history", { sessionKey: created.key, limit: 100 });
          await expect(
            audienceClients.excluded.request("chat.history", {
              sessionKey: created.key,
              limit: 100,
            }),
          ).rejects.toThrow(/not found|unavailable/i);
          await expect(
            audienceClients.excluded.request("sessions.messages.subscribe", { key: created.key }),
          ).rejects.toThrow(/not found|unavailable/i);
          const excludedList = await audienceClients.excluded.request<{
            sessions: Array<{ key: string }>;
          }>("sessions.list", { agentId: "main" });
          expect(excludedList.sessions.some((row) => row.key === created.key)).toBe(false);
          await audienceClients.creator.request("sessions.messages.subscribe", {
            key: created.key,
          });
        }
        expect(
          await member.request("sessions.messages.subscribe", { key: scenario.sessionKey }),
        ).toMatchObject({ subscribed: true });
        const unsubscribe = subscribeSubagentRunChanges("persistence", () => {
          const child = scenario.childRunId && getSubagentRunByRunId(scenario.childRunId);
          if (
            child &&
            child.requesterSettleWake?.requesterYieldBatch &&
            !child.requesterTurnRunId
          ) {
            scenario.yielded.resolve();
          }
        });
        try {
          await member.request("chat.send", {
            sessionKey: scenario.sessionKey,
            message: `Please create this Goal, delegate the first item, then attempt an independent sibling-agent session and finish the remaining item: ${scenario.prompt}`,
            idempotencyKey: randomUUID(),
          });
          await wait(Promise.all([scenario.childStarted.promise, scenario.yielded.promise]));
          expect(scenario.parentCalls).toBe(3);
          scenario.releaseChild.resolve();
          await wait(scenario.settlementEntered.promise);
          const beforeRevocation = {
            parent: scenario.parentCalls,
            child: scenario.childCalls,
            events: events.length,
          };
          const beforeHistory = scenario.revoke
            ? await admin.request<{ messages: unknown[] }>("chat.history", {
                sessionKey: scenario.sessionKey,
                limit: 100,
              })
            : undefined;
          const beforeTranscriptBytes =
            scenario.revoke && audienceClients
              ? canonicalTranscriptBytes(scenario.sessionKey)
              : undefined;
          let revokedEventBoundary = events.length;
          if (scenario.revoke) {
            expect(
              events.some(
                (event) =>
                  event.event === "session.message" &&
                  asOptionalRecord(event.payload)?.sessionKey === scenario.sessionKey,
              ),
            ).toBe(true);
            if (audienceClients) {
              const roleBefore = await member.request("users.self", {});
              await audienceClients.creator.request("sessions.patch", {
                key: scenario.sessionKey,
                expectedSessionId: loadSessionEntry({
                  agentId: "main",
                  sessionKey: scenario.sessionKey,
                })!.sessionId,
                access: { mode: "creator" },
              });
              expect(
                loadSessionEntry({ agentId: "main", sessionKey: scenario.sessionKey })?.access,
              ).toEqual({ mode: "creator" });
              expect(await member.request("users.self", {})).toEqual(roleBefore);
              await expect(
                member.request("chat.history", { sessionKey: scenario.sessionKey, limit: 100 }),
              ).rejects.toThrow(/not found|unavailable/i);
              trace({
                kind: "audience.revocation.committed",
                scenario: scenario.name,
                expected: "selected excluded; roles and agent ceilings unchanged",
                access: loadSessionEntry({ agentId: "main", sessionKey: scenario.sessionKey })
                  ?.access,
              });
            } else {
              await admin.request("users.setRole", {
                profileId: scenario.profile.id,
                role: "revoked",
              });
            }
            revokedEventBoundary = events.length;
            if (!audienceClients) {
              await wait(scenario.providerCancelled.promise);
            }
            // Release actual provider output after the committed audience mutation.
            // A socket need not cancel eagerly; final-effect authority must reject it.
            trace({
              kind: "provider.release.after-audience-revoke",
              scenario: scenario.name,
              expected: "final provider output must not reach transcript or revoked audience",
            });
            scenario.releaseSettlement.resolve();
          }
          const drained = await wait(waitForGatewayActiveWork(30_000));
          expect(drained.drained, JSON.stringify(drained.snapshot.blockers)).toBe(true);
          const sibling = await admin.request<{ sessions: unknown[] }>("sessions.list", {
            agentId: "sibling",
          });
          expect(sibling.sessions).toEqual([]);
          expect(scenario.childCalls).toBe(1);
          expect(
            loadSessionEntry({ agentId: "main", sessionKey: scenario.sessionKey })?.goal,
          ).toMatchObject(
            scenario.revoke
              ? { status: "paused", continuationTurns: 0 }
              : { status: "complete", continuationTurns: 1 },
          );
          if (!scenario.revoke) {
            await wait(scenario.finalReceived.promise);
          }
          const history = await (scenario.revoke ? admin : member).request<{ messages: unknown[] }>(
            "chat.history",
            { sessionKey: scenario.sessionKey, limit: 100 },
          );
          const afterTranscriptBytes =
            scenario.revoke && audienceClients
              ? canonicalTranscriptBytes(scenario.sessionKey)
              : undefined;
          const finals = events.filter(
            (event) =>
              event.event === "session.message" &&
              asOptionalRecord(event.payload)?.sessionKey === scenario.sessionKey &&
              assistantText(asOptionalRecord(event.payload)?.message) === scenario.finalText,
          );
          expect(finals).toHaveLength(scenario.revoke ? 0 : 1);
          expect(
            history.messages.filter((message) => assistantText(message) === scenario.finalText),
          ).toHaveLength(scenario.revoke ? 0 : 1);
          if (scenario.revoke) {
            // The administrator may still inspect the canonical history; only the
            // revoked requester's publication stream is required to be silent.
            // Role changes refresh projected avatar URLs, not durable message identity/content.
            trace({
              kind: "effect.transcript",
              scenario: scenario.name,
              beforeSHA256: digest(transcriptContent(beforeHistory?.messages)),
              afterSHA256: digest(transcriptContent(history.messages)),
              beforeCount: beforeHistory?.messages.length,
              afterCount: history.messages.length,
              expected: "unchanged after retained provider released",
            });
            // Preserve revoked event checks before the separately authorized publication.
            expect(
              events.slice(beforeRevocation.events).filter((event) => {
                const payload = asOptionalRecord(event.payload);
                return (
                  event.event === "chat" &&
                  payload?.sessionKey === scenario.sessionKey &&
                  ((payload.state === "final" && payload.message !== undefined) ||
                    (payload.state === "delta" &&
                      (payload.message !== undefined || payload.deltaText !== undefined)))
                );
              }),
            ).toEqual([]);
            if (audienceClients) {
              assert(
                beforeTranscriptBytes && afterTranscriptBytes,
                "Canonical snapshots are required",
              );
              trace({
                kind: "effect.canonical-transcript",
                scenario: scenario.name,
                beforeSHA256: digest(beforeTranscriptBytes),
                afterSHA256: digest(afterTranscriptBytes),
                beforeBytes: beforeTranscriptBytes.byteLength,
                afterBytes: afterTranscriptBytes.byteLength,
                observedByteChange: afterTranscriptBytes.equals(beforeTranscriptBytes) ? 0 : 1,
                expected: 0,
              });
              expect(afterTranscriptBytes.equals(beforeTranscriptBytes)).toBe(true);
            }
            // Role changes retire the old subscription; the client may reconnect read-only.
            // Assert disclosure after a real publication, not transient transport state.
            expect(
              await admin.request("sessions.messages.subscribe", { key: scenario.sessionKey }),
            ).toMatchObject({ subscribed: true });
            expect(
              await admin.request("chat.inject", {
                sessionKey: scenario.sessionKey,
                message: publicationText,
              }),
            ).toMatchObject({ ok: true });
            await wait(authorizedPublication.promise);
            const publicationDrained = await wait(waitForGatewayActiveWork(30_000));
            expect(publicationDrained.drained).toBe(true);
            const afterPublication = await admin.request<{ messages: unknown[] }>("chat.history", {
              sessionKey: scenario.sessionKey,
              limit: 100,
            });
            expect(
              authorizedEvents.filter(
                (event) =>
                  event.event === "session.message" &&
                  asOptionalRecord(event.payload)?.sessionKey === scenario.sessionKey &&
                  assistantText(asOptionalRecord(event.payload)?.message) === publicationText,
              ),
            ).toHaveLength(1);
            expect(afterPublication.messages).toHaveLength(history.messages.length + 1);
            expect(transcriptContent(afterPublication.messages.slice(0, -1))).toEqual(
              transcriptContent(history.messages),
            );
            expect(assistantText(afterPublication.messages.at(-1))).toBe(publicationText);
            expect(
              events.slice(revokedEventBoundary).filter((event) => {
                const payload = asOptionalRecord(event.payload);
                return (
                  payload?.sessionKey === scenario.sessionKey &&
                  (event.event === "session.message" ||
                    (event.event === "chat" &&
                      (payload.message !== undefined || payload.deltaText !== undefined)))
                );
              }),
            ).toEqual([]);
            expect(scenario.parentCalls).toBe(beforeRevocation.parent);
            expect(scenario.childCalls).toBe(beforeRevocation.child);
            trace({
              kind: "effect.events",
              scenario: scenario.name,
              expected: "no revoked recipient content after authorized publication",
              observedRevokedDisclosureCount: events.slice(revokedEventBoundary).filter((event) => {
                const p = asOptionalRecord(event.payload);
                return (
                  p?.sessionKey === scenario.sessionKey &&
                  (event.event === "session.message" ||
                    (event.event === "chat" &&
                      (p.message !== undefined || p.deltaText !== undefined)))
                );
              }).length,
              authorizedPublicationCount: 1,
            });
            if (audienceClients) {
              await audienceClients.creator.request("sessions.patch", {
                key: scenario.sessionKey,
                expectedSessionId: loadSessionEntry({
                  agentId: "main",
                  sessionKey: scenario.sessionKey,
                })!.sessionId,
                access: { mode: "audience", profileIds: [scenario.profile.id] },
              });
              const restored = await member.request<{ messages: unknown[] }>("chat.history", {
                sessionKey: scenario.sessionKey,
                limit: 100,
              });
              expect(transcriptContent(restored.messages)).toEqual(
                transcriptContent(afterPublication.messages),
              );
              expect(scenario.parentCalls).toBe(beforeRevocation.parent);
              trace({
                kind: "audience.restored",
                expected: "fresh read allowed; retained provider not revived",
                parentCalls: scenario.parentCalls,
                finalTextOccurrences: restored.messages.filter(
                  (message) => assistantText(message) === scenario.finalText,
                ).length,
              });
            }
          } else {
            expect(scenario.parentCalls).toBe(7);
            trace({
              kind: "effect.authorized",
              scenario: scenario.name,
              expected: "authorized final transcript and event exactly once",
              observedTranscriptFinals: history.messages.filter(
                (message) => assistantText(message) === scenario.finalText,
              ).length,
              observedEventFinals: finals.length,
            });
          }
          if (scenario.revoke) {
            trace({
              kind: "strict.no-transcript-mutation",
              expected: 0,
              observedAddedMessages:
                history.messages.length - (beforeHistory?.messages.length ?? 0),
            });
            expect(transcriptContent(history.messages)).toEqual(
              transcriptContent(beforeHistory?.messages),
            );
          }
          expect(errors).toEqual([]);
          if (!scenario.revoke && audienceClients) {
            const target = {
              agentId: "main",
              sessionKey: scenario.sessionKey,
              sessionId: loadSessionEntry({ agentId: "main", sessionKey: scenario.sessionKey })!
                .sessionId,
            };
            const notices = async () =>
              (await loadTranscriptEvents(target)).filter(
                (row) => asOptionalRecord(row)?.customType === "run-failed-before-reply",
              ).length;
            const beforeNotices = await notices();
            scenario.failRequest = true;
            await member.request("chat.send", {
              sessionKey: scenario.sessionKey,
              message: "Synthetic authorized provider failure",
              idempotencyKey: randomUUID(),
            });
            expect((await wait(waitForGatewayActiveWork(30_000))).drained).toBe(true);
            expect(scenario.failureCalls).toBeGreaterThan(0);
            expect(await notices()).toBe(beforeNotices + 1);
            trace({
              kind: "effect.authorized",
              scenario: scenario.name,
              observedFailureNotices: (await notices()) - beforeNotices,
            });
          }
        } finally {
          scenario.releaseChild.resolve();
          scenario.releaseSettlement.resolve();
          unsubscribe();
        }
      }
    },
  );
}
