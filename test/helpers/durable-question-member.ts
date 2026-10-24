import { X509Certificate } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import type {
  QuestionGetResult,
  QuestionRecord,
} from "../../packages/gateway-protocol/src/index.js";
import { readConfigFileSnapshot } from "../../src/config/io.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../src/config/sessions/session-accessor.js";
import { executeSessionQuestionOperation } from "../../src/config/sessions/session-questions.js";
import { addSessionMember } from "../../src/config/sessions/session-sharing-store.js";
import {
  connectGatewayClient,
  startGatewayWithClient,
} from "../../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../../src/infra/device-identity.js";
import { setUserProfileRole } from "../../src/state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../src/state/user-profiles.js";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../src/utils/message-channel.js";
import { createDurableQuestionGateway } from "./durable-question-gateway.js";
import { createDeferred, withinTest } from "./promise.js";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "./tls-fixture.js";

export async function runDurableQuestionMemberProof(
  membership: "allow" | "revoked",
  signal: AbortSignal,
): Promise<void> {
  const fixture = await createDurableQuestionGateway(signal, { continuationToolEffect: true });
  const state = fixture.instance.state;
  await runQaGatewayFixture(
    () => {
      state.applyEnv();
      return withEnvAsync(
        {
          ...state.envVars,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN: undefined,
          OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_SKIP_CHANNELS: "1",
        },
        async () => {
          const snapshot = await readConfigFileSnapshot();
          if (!snapshot.valid) {
            throw new Error("Native member proof requires a valid isolated Gateway config");
          }
          const cfg = snapshot.config;
          const memberEmail = "question-member@example.test";
          const ownerEmail = "question-owner@example.test";
          const member = ensureProfileForEmail(memberEmail);
          const owner = ensureProfileForEmail(ownerEmail);
          setUserProfileRole(member.id, "member");
          setUserProfileRole(owner.id, "administrator");
          const scopes = ["operator.read", "operator.write", "operator.questions"] as const;
          cfg.gateway = {
            ...cfg.gateway,
            trustedProxies: ["127.0.0.1"],
            auth: {
              mode: "trusted-proxy",
              trustedProxy: {
                userHeader: "x-forwarded-user",
                requiredHeaders: ["x-forwarded-proto"],
                allowLoopback: true,
                deviceAutoApprove: { enabled: true, scopes: [...scopes, "operator.admin"] },
              },
            },
            roles: {
              default: "member",
              definitions: {
                member: { scopes: [...scopes], agents: "*", sessions: { others: "view" } },
                administrator: {
                  scopes: ["operator.admin"],
                  agents: "*",
                  sessions: { others: "write" },
                },
              },
            },
            controlUi: { allowedOrigins: ["https://question.example.test"] },
            tls: {
              enabled: true,
              autoGenerate: false,
              certPath: await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM),
              keyPath: await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM),
            },
          };
          const sessionKey = "agent:main:original-member-question";
          // Retired explicit stores remain captured custody, not simultaneous catalog roots.
          const originalStore = state.statePath("original", "catalog.sqlite");
          cfg.session = { ...cfg.session, store: originalStore };
          const configuredStore = state.statePath("configured", "catalog.sqlite");
          const originalScope = { agentId: "main", storePath: originalStore, sessionKey };
          // The original sender relies on uninterrupted membership, not creator/admin bypass.
          await upsertSessionEntryCore(originalScope, {
            sessionId: "original-member-session",
            lifecycleRevision: "original-member-revision",
            permissionMode: "full",
            updatedAt: Date.now(),
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: owner.id },
          });
          await addSessionMember(originalScope, { identityId: member.id, addedBy: owner.id });
          const requested = createDeferred<QuestionRecord>();
          const finalRunIds: string[] = [];
          const onEvent = ({ event, payload }: { event?: string; payload?: unknown }) => {
            if (!isRecord(payload)) {
              return;
            }
            if (event === "question.requested") {
              requested.resolve(payload as QuestionRecord);
            }
            if (
              event === "chat" &&
              payload.state === "final" &&
              typeof payload.runId === "string"
            ) {
              finalRunIds.push(payload.runId);
            }
          };
          const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
          const headers = (email: string) => ({
            "x-forwarded-for": "203.0.113.50",
            "x-forwarded-proto": "https",
            "x-forwarded-user": email,
          });
          let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
          let admin: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
          let memberClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
          const memberDevice = loadOrCreateDeviceIdentity({
            env: { OPENCLAW_STATE_DIR: state.path("member-device") },
          });
          let stage = "TLS member Gateway startup";
          const start = async () => {
            gateway = await startGatewayWithClient({
              cfg,
              configPath: state.configPath,
              auth: cfg.gateway?.auth,
              secure: true,
              tlsFingerprint: fingerprint,
              edgeAuthHeaders: headers(ownerEmail),
              clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
              origin: "https://question.example.test",
              scopes: ["operator.admin", ...scopes],
              onEvent,
            });
            admin = gateway.client;
            let memberScopes: string[] | undefined;
            memberClient = await connectGatewayClient({
              url: `wss://127.0.0.1:${gateway.port}`,
              tlsFingerprint: fingerprint,
              edgeAuthHeaders: headers(memberEmail),
              clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
              origin: "https://question.example.test",
              scopes: [...scopes],
              deviceIdentity: memberDevice,
              onHelloOk: (hello) => {
                memberScopes = hello.auth.scopes;
              },
              signal,
            });
            expect(memberScopes).toEqual(expect.arrayContaining([...scopes]));
            expect(memberScopes).not.toContain("operator.admin");
            await admin.request("sessions.subscribe", { agentId: "main" });
            expect(await memberClient.request("users.self", {})).toMatchObject({
              profile: { id: member.id, role: "member" },
            });
            expect(
              await memberClient.request("sessions.describe", { key: sessionKey }),
            ).toMatchObject({
              session: { sessionId: "original-member-session", sharingRole: "member" },
            });
            expect(await admin.request("session.members.list", { sessionKey })).toMatchObject({
              owner: { id: owner.id },
              members: expect.arrayContaining([expect.objectContaining({ identityId: member.id })]),
            });
          };
          const stop = async () => {
            await runQaGatewayFixture(
              async () => {
                await memberClient?.stopAndWait();
              },
              () => admin?.stopAndWait(),
              () => gateway?.server.close(),
            );
            memberClient = undefined;
            admin = undefined;
            gateway = undefined;
          };
          await runQaGatewayFixture(
            async () => {
              try {
                await start();
                if (!gateway || !memberClient) {
                  throw new Error("Member Gateway did not start");
                }
                stage = "member asking turn";
                const asking = await memberClient.request<{ runId: string }>(
                  "chat.send",
                  {
                    sessionKey,
                    message:
                      "DURABLE_ASK_PROOF: ask which environment and continue after the answer",
                    idempotencyKey: "original-member-question",
                    deliver: false,
                  },
                  { expectFinal: false },
                );
                const question = await withinTest(
                  Promise.race([requested.promise, fixture.failed]),
                  signal,
                );
                expect(question.sessionKey).toBe(sessionKey);
                expect(
                  (
                    await memberClient.request<QuestionGetResult>("question.get", {
                      id: question.id,
                      includeContinuation: true,
                    })
                  ).continuation,
                ).toMatchObject({ status: "pending" });
                expect(
                  await memberClient.request("agent.wait", {
                    runId: asking.runId,
                    timeoutMs: 30_000,
                  }),
                ).toMatchObject({ status: "ok" });
                stage = "stopped-store divergence preparation";
                await stop();
                await upsertSessionEntryCore(
                  { ...originalScope, storePath: configuredStore },
                  {
                    sessionId: "configured-successor-session",
                    lifecycleRevision: "configured-successor-revision",
                    permissionMode: "full",
                    updatedAt: Date.now(),
                    visibility: "shared",
                    createdActor: { type: "human", source: "profile", id: owner.id },
                  },
                );
                // The newly configured store has the opposite grant: consulting it would
                // reject the allowed original member or resurrect the revoked member.
                if (membership === "revoked") {
                  await addSessionMember(
                    { ...originalScope, storePath: configuredStore },
                    {
                      identityId: member.id,
                      addedBy: owner.id,
                    },
                  );
                }
                stage = "recovered original-store custody";
                await start();
                if (!gateway || !admin || !memberClient) {
                  throw new Error("Recovered member Gateway did not start");
                }
                await memberClient.request("question.list", { includeContinuation: true });
                expect(
                  (
                    await memberClient.request<QuestionGetResult>("question.get", {
                      id: question.id,
                      includeContinuation: true,
                    })
                  ).continuation,
                ).toMatchObject({ status: "pending" });
                stage = "original-store busy provider admission";
                await admin.request(
                  "chat.send",
                  {
                    sessionKey,
                    message: "DURABLE_BUSY_PROOF: keep the original session busy",
                    idempotencyKey: "member-proof-blocker",
                    deliver: false,
                  },
                  { expectFinal: false },
                );
                await withinTest(Promise.race([fixture.busyStarted, fixture.failed]), signal);
                const answers = { answers: { choice: ["Staging"] } };
                expect(
                  await memberClient.request("question.resolve", {
                    id: question.id,
                    answers,
                    resolutionId: "original-member-answer",
                  }),
                ).toEqual({ status: "answered", answers });
                let continuationRunId: string | undefined;
                stage = "claimed original continuation before release";
                await vi.waitFor(
                  async () => {
                    const current = await admin!.request<QuestionGetResult>("question.get", {
                      id: question.id,
                      includeContinuation: true,
                    });
                    expect(current.continuation).toMatchObject({ status: "claimed" });
                    continuationRunId = current.continuation?.runId;
                    expect(continuationRunId).toEqual(expect.any(String));
                  },
                  { timeout: 30_000 },
                );
                if (membership === "revoked") {
                  expect(
                    await admin.request("session.members.remove", {
                      sessionKey,
                      identityId: member.id,
                    }),
                  ).toMatchObject({ ok: true, identityId: member.id });
                  const originalMembers = await admin.request<{
                    members: { identityId: string }[];
                  }>("session.members.list", { sessionKey });
                  expect(
                    originalMembers.members.some((entry) => entry.identityId === member.id),
                  ).toBe(false);
                  expect(
                    await memberClient.request("sessions.describe", { key: sessionKey }),
                  ).toMatchObject({
                    session: { sessionId: "original-member-session", sharingRole: "viewer" },
                  });
                }
                stage = "live configured-store config.get";
                process.stderr.write(`[durable-question:member:${membership}] ${stage}\n`);
                const config = await admin.request<{ hash: string }>("config.get", {});
                stage = "live configured-store config.patch";
                process.stderr.write(`[durable-question:member:${membership}] ${stage}\n`);
                const patched = await admin.request<{ ok: boolean; restart?: unknown }>(
                  "config.patch",
                  {
                    baseHash: config.hash,
                    raw: JSON.stringify({ session: { store: configuredStore } }),
                  },
                );
                expect(patched.ok).toBe(true);
                expect(patched.restart).toBeUndefined();
                stage = "configured-store membership read";
                process.stderr.write(`[durable-question:member:${membership}] ${stage}\n`);
                const configured = await admin.request<{
                  owner: { id: string };
                  members: { identityId: string }[];
                }>("session.members.list", { sessionKey });
                expect(configured.owner.id).toBe(owner.id);
                expect(configured.members.some((entry) => entry.identityId === member.id)).toBe(
                  membership === "revoked",
                );
                const effect = path.join(
                  state.workspaceDir,
                  "durable-question-continuation-effect",
                );
                expect(fixture.continuationCount).toBe(0);
                expect(finalRunIds).not.toContain(continuationRunId);
                await expect(access(effect)).rejects.toMatchObject({ code: "ENOENT" });
                stage = "original authority validation before provider and tool effects";
                fixture.releaseBusy();
                let observedStatus: string | undefined;
                try {
                  await vi.waitFor(
                    async () => {
                      const current = await admin!.request<QuestionGetResult>("question.get", {
                        id: question.id,
                        includeContinuation: true,
                      });
                      observedStatus = current.continuation?.status;
                      expect(current.question.answers).toEqual(answers);
                      expect(current.continuation).toMatchObject({
                        status: membership === "revoked" ? "interrupted" : "settled",
                      });
                    },
                    { timeout: 30_000 },
                  );
                } finally {
                  let toolMarker: "present" | "absent" | "unreadable" = "present";
                  try {
                    await access(effect);
                  } catch (error) {
                    toolMarker =
                      isRecord(error) && error.code === "ENOENT" ? "absent" : "unreadable";
                  }
                  process.stderr.write(
                    `[durable-question:member-effect] ${JSON.stringify({
                      membership,
                      receipt: observedStatus,
                      providerRequests: fixture.continuationCount,
                      toolMarker,
                      finalSocketEvents: finalRunIds.filter((id) => id === continuationRunId)
                        .length,
                    })}\n`,
                  );
                }
                expect(
                  await admin.request("agent.wait", {
                    runId: continuationRunId,
                    timeoutMs: 30_000,
                  }),
                ).toMatchObject({ status: membership === "revoked" ? "error" : "ok" });
                if (membership === "revoked") {
                  expect(fixture.continuationCount).toBe(0);
                  expect(finalRunIds).not.toContain(continuationRunId);
                  await expect(access(effect)).rejects.toMatchObject({ code: "ENOENT" });
                } else {
                  expect(fixture.continuationCount).toBe(2);
                  expect((await readFile(effect, "utf8")).trim()).toBe("completed");
                  await vi.waitFor(
                    () =>
                      expect(finalRunIds.filter((id) => id === continuationRunId)).toHaveLength(1),
                    { timeout: 30_000 },
                  );
                }
                stage = "canonical stopped-store and transcript witness";
                await stop();
                const canonical = await executeSessionQuestionOperation(
                  { ...originalScope, assertCurrent() {} },
                  { kind: "get", id: question.id },
                );
                expect(canonical).toMatchObject({
                  sessionId: "original-member-session",
                  record: { status: "answered", answers },
                });
                expect(
                  await executeSessionQuestionOperation(
                    { ...originalScope, storePath: configuredStore, assertCurrent() {} },
                    { kind: "get", id: question.id },
                  ),
                ).toBeUndefined();
                const originalTranscript = await loadTranscriptEvents({
                  ...originalScope,
                  sessionId: "original-member-session",
                });
                const configuredTranscript = await loadTranscriptEvents({
                  ...originalScope,
                  storePath: configuredStore,
                  sessionId: "configured-successor-session",
                });
                expect(
                  JSON.stringify(originalTranscript).includes("DURABLE_CONTINUATION_USED_STAGING"),
                ).toBe(membership === "allow");
                expect(JSON.stringify(configuredTranscript)).not.toContain(
                  "DURABLE_CONTINUATION_USED_STAGING",
                );
              } catch (error) {
                throw new Error(
                  `Native divergent-store member proof failed during ${stage}. ${fixture.diagnostics()}`,
                  { cause: error },
                );
              }
            },
            () => fixture.releaseBusy(),
            stop,
          );
        },
      );
    },
    () => fixture.cleanup(),
  );
}
