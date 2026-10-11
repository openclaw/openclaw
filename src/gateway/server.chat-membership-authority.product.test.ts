import { randomUUID, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { UsersSelfResult } from "../../packages/gateway-protocol/src/schema/users.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import {
  listSessionPendingInputs,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { readPersistedMediaFacts } from "../media/media-facts.js";
import { resolveInboundMediaReference } from "../media/media-reference.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { readUserProfileIdentity } from "../state/user-profile-list.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import * as sessionStoreLookup from "./session-utils-store-lookup.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

function holdSessionAuthorizationRead(sessionKey: string) {
  const readCaptured = createDeferredCore();
  const resumeRead = createDeferredCore();
  const read = sessionStoreLookup.withGatewaySessionStoreTarget;
  let held = false;
  const readWithHold: typeof read = async (params, consume) => {
    const reply = await read(params, consume);
    if (!held && params.key === sessionKey && params.includeMembership === true) {
      held = true;
      readCaptured.resolve();
      // The ordered read releases its writer FIFO before the test commits a revocation.
      await resumeRead.promise;
    }
    return reply;
  };
  const authorizationRead = vi
    .spyOn(sessionStoreLookup, "withGatewaySessionStoreTarget")
    .mockImplementation(readWithHold);
  return {
    entered: readCaptured.promise,
    resume: () => resumeRead.resolve(),
    wasHeld: () => held,
    restore: () => authorizationRead.mockRestore(),
  };
}

it(
  "carries current caller, membership and global ownership through transcript persistence and agent dispatch",
  { timeout: 90_000 },
  async () => {
    const state = await createOpenClawTestState({
      label: "chat-membership-authority",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
      },
    });
    const requests: string[] = [];
    const providerErrors: unknown[] = [];
    let providerReply = "Authorized member reply.";
    const providerHolds: Array<{
      message: string;
      entered: Deferred;
      resume: Deferred;
      claimed: boolean;
    }> = [];
    const holdProviderResponse = (message: string) => {
      const hold = {
        message,
        entered: createDeferredCore(),
        resume: createDeferredCore(),
        claimed: false,
      };
      providerHolds.push(hold);
      return hold;
    };
    const providerServer = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push(body);
        const reply = providerReply;
        const hold = providerHolds.find(
          (candidate) => !candidate.claimed && body.includes(candidate.message),
        );
        if (hold) {
          hold.claimed = true;
          hold.entered.resolve();
          await hold.resume.promise;
        }
        writeOpenAiResponsesText(response, {
          text: reply,
          messageId: `msg_${randomUUID()}`,
          responseId: `resp_${randomUUID()}`,
        });
      })().catch((error: unknown) => {
        providerErrors.push(error);
        response.writeHead(500).end("fixture provider failed");
      });
    });
    const agentExecutions: Array<{ release(): Promise<void> }> = [];
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let administrator: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    let backingClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("fixture provider did not bind");
      }
      const provider = buildMockOpenAiResponsesProvider(
        `http://127.0.0.1:${address.port}/v1`,
        "membership-authority",
      );
      const proxyUser = "membership-authority-member@example.test";
      const proxyAdministrator = "membership-authority-administrator@example.test";
      const proxyBacking = "membership-authority-backing@example.test";
      setUserProfileRole(ensureProfileForEmail(proxyAdministrator).id, "administrator");
      const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
      const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
      const trustedProxy = {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowUsers: [proxyUser, proxyAdministrator, proxyBacking],
        allowLoopback: true,
        deviceAutoApprove: {
          enabled: true,
          scopes: ["operator.read", "operator.write"],
        },
      };
      const cfg = {
        agents: {
          ownership: "explicit",
          entries: { main: {}, work: {} },
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            heartbeat: { every: "0m" },
            model: { primary: provider.modelRef },
            models: {
              [provider.modelRef]: {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
        },
        session: { scope: "global" },
        models: {
          mode: "replace",
          providers: {
            [provider.providerId]: {
              ...provider.config,
              request: { allowPrivateNetwork: true },
            },
          },
        },
        plugins: { enabled: false, slots: { memory: "none" } },
        tools: { profile: "minimal" },
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy,
            identityScopes: { [proxyAdministrator]: ["operator.admin"] },
          },
          trustedProxies: ["127.0.0.1"],
          controlUi: { allowedOrigins: ["https://control.example.com"] },
          tls: { enabled: true, autoGenerate: false, certPath, keyPath },
          roles: {
            default: "view",
            definitions: {
              administrator: {
                sessions: { others: "write" },
                agents: "*",
                scopes: ["operator.admin"],
              },
              view: {
                sessions: { others: "view" },
                agents: "*",
                scopes: ["operator.read", "operator.write"],
              },
            },
          },
        },
      } satisfies OpenClawConfig;
      const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        portClaim,
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        auth: cfg.gateway.auth,
        edgeAuthHeaders: {
          "x-forwarded-for": "203.0.113.50",
          "x-forwarded-proto": "https",
          "x-forwarded-user": proxyUser,
        },
        origin: "https://control.example.com",
        secure: true,
        tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
        scopes: ["operator.read", "operator.write"],
      });
      await gateway.server.startupSettled;
      // Keep both fixture agents resident while alternating owners; the runtime retains one idle executor.
      for (const agentId of ["main", "work"]) {
        agentExecutions.push(captureOpenClawAgentDatabaseExecution({ agentId, env: state.env }));
      }
      administrator = await connectGatewayClient({
        url: `wss://127.0.0.1:${gateway.port}`,
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        edgeAuthHeaders: {
          "x-forwarded-for": "203.0.113.51",
          "x-forwarded-proto": "https",
          "x-forwarded-user": proxyAdministrator,
        },
        origin: "https://control.example.com",
        tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
        scopes: ["operator.read", "operator.write"],
        deviceIdentity: loadOrCreateDeviceIdentity({
          path: state.statePath("test-device-identities", "administrator.sqlite"),
        }),
      });
      const self = await gateway.client.request<UsersSelfResult>("users.self", {});
      const memberProfileId = self.profile.id;
      const sessionKey = `agent:main:member-authority-${randomUUID()}`;
      const sessionId = `member-authority-${randomUUID()}`;
      const scope = { agentId: "main", sessionKey, sessionId };
      const owner = ensureProfileForEmail("membership-authority-owner@example.test");
      await replaceSessionEntry(scope, {
        sessionId,
        updatedAt: Date.now(),
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: owner.id },
      });
      await addSessionMember(scope, { identityId: memberProfileId, addedBy: owner.id });

      const allowedMessage = "Persist and dispatch this authorized member turn.";
      const accepted = await gateway.client.request<{ runId: string; status: string }>(
        "chat.send",
        {
          sessionKey,
          message: allowedMessage,
          deliver: false,
          idempotencyKey: randomUUID(),
        },
      );
      expect(accepted.status).toBe("started");
      await expect(
        gateway.client.request<{ status: string }>(
          "agent.wait",
          { runId: accepted.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        ),
      ).resolves.toMatchObject({ status: "ok" });
      const allowedTranscript = await loadTranscriptEvents(scope);
      expect(JSON.stringify(allowedTranscript)).toContain(allowedMessage);
      expect(JSON.stringify(allowedTranscript)).toContain("Authorized member reply.");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain(allowedMessage);
      expect(providerErrors).toEqual([]);

      const transcriptBeforeDeniedTurn = structuredClone(await loadTranscriptEvents(scope));
      for (const change of ["membership revoked", "session replaced"] as const) {
        await addSessionMember(scope, { identityId: memberProfileId, addedBy: owner.id });
        const heldRead = holdSessionAuthorizationRead(sessionKey);
        const denied = gateway.client.request("chat.send", {
          sessionKey,
          message: "This in-flight revoked member turn must have no effects.",
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        try {
          await Promise.race([
            heldRead.entered,
            denied.then(() => {
              throw new Error("chat.send completed before its authorization read was held");
            }),
          ]);
          expect(requests).toHaveLength(1);
          expect(await loadTranscriptEvents(scope)).toEqual(transcriptBeforeDeniedTurn);
          if (change === "membership revoked") {
            await removeSessionMember(scope, memberProfileId);
          } else {
            await replaceSessionEntry(scope, {
              sessionId: `${sessionId}-successor`,
              updatedAt: Date.now(),
              visibility: "read-only",
              createdActor: { type: "human", source: "profile", id: owner.id },
            });
          }
          heldRead.resume();
          await expect(denied).rejects.toMatchObject({ code: "INVALID_REQUEST" });
        } finally {
          heldRead.resume();
          await Promise.allSettled([denied]);
          heldRead.restore();
        }
        expect(heldRead.wasHeld()).toBe(true);
        expect(await loadTranscriptEvents(scope)).toEqual(transcriptBeforeDeniedTurn);
        if (change === "session replaced") {
          expect(
            await loadTranscriptEvents({ ...scope, sessionId: `${sessionId}-successor` }),
          ).toEqual([]);
        }
        expect(requests).toHaveLength(1);
        expect(providerErrors).toEqual([]);
      }
      await removeSessionMember(scope, memberProfileId);
      await expect(
        gateway.client.request("chat.send", {
          sessionKey,
          message: "This later revoked member turn must also have no effects.",
          deliver: false,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(await loadTranscriptEvents(scope)).toEqual(transcriptBeforeDeniedTurn);
      expect(requests).toHaveLength(1);
      expect(providerErrors).toEqual([]);

      // Reset through a separate administrator; member turns must retain their narrow scopes.
      // The public lifecycle owner clears prior turns and retains only the reset marker.
      let resetGlobalSessions = false;
      for (const [first, second] of [
        ["main", "work"],
        ["work", "main"],
      ] as const) {
        for (const withAttachment of [false, true]) {
          if (resetGlobalSessions) {
            for (const agentId of [first, second]) {
              await expect(
                administrator.request("sessions.reset", { key: "global", agentId }),
              ).resolves.toMatchObject({ ok: true });
              await expect(
                gateway.client.request("chat.history", { sessionKey: "global", agentId }),
              ).resolves.toMatchObject({
                sessionKey: "global",
                messages: [
                  {
                    role: "system",
                    content: [{ type: "text", text: "Reset" }],
                    __openclaw: { kind: "reset" },
                  },
                ],
              });
            }
          }
          resetGlobalSessions = true;
          const markers = {
            main: `GLOBAL_MAIN_${randomUUID()}`,
            work: `GLOBAL_WORK_${randomUUID()}`,
          };
          const sessionIds = new Map<string, string>();
          const attachmentRefs = new Map<string, string>();
          for (const method of ["chat.send", "agent"] as const) {
            for (const agentId of [first, second]) {
              const otherAgentId = agentId === "main" ? "work" : "main";
              const message = `${markers[agentId]}_${method}: preserve this owner's global chat.`;
              providerReply = `${markers[agentId]}_${method}_REPLY`;
              const attachmentText = `${markers[agentId]} attachment`;
              const attachments =
                withAttachment && method === "chat.send"
                  ? [
                      {
                        fileName: `${agentId}-notes.txt`,
                        mimeType: "text/plain",
                        content: Buffer.from(attachmentText).toString("base64"),
                      },
                    ]
                  : undefined;
              const requestOffset = requests.length;
              const started = await gateway.client.request<{ runId: string; status: string }>(
                method,
                {
                  sessionKey: "global",
                  agentId,
                  message,
                  deliver: false,
                  idempotencyKey: randomUUID(),
                  attachments,
                },
              );
              expect(started.status).toBe(method === "chat.send" ? "started" : "accepted");
              await expect(
                gateway.client.request<{ status: string }>(
                  "agent.wait",
                  { runId: started.runId, timeoutMs: 30_000 },
                  { timeoutMs: 35_000 },
                ),
              ).resolves.toMatchObject({ status: "ok" });
              const providerInput = requests.slice(requestOffset).join("\n");
              expect(providerInput).toContain(message);
              expect(providerInput).not.toContain(markers[otherAgentId]);
              const history = await gateway.client.request<{
                sessionKey: string;
                sessionId: string;
                messages: unknown[];
              }>("chat.history", { sessionKey: "global", agentId, limit: 20 });
              expect(history.sessionKey).toBe("global");
              expect(history.sessionId).toEqual(expect.any(String));
              if (method === "agent") {
                expect(history.sessionId).toBe(sessionIds.get(agentId));
                expect(providerInput).toContain(`${markers[agentId]}_chat.send_REPLY`);
              }
              sessionIds.set(agentId, history.sessionId);
              expect(new Set(sessionIds.values()).size).toBe(sessionIds.size);
              if (attachments) {
                const uploaded = history.messages
                  .flatMap((historyMessage) => {
                    const record = asOptionalRecord(historyMessage);
                    return record ? (readPersistedMediaFacts(record) ?? []) : [];
                  })
                  .filter((fact) => fact.fileName === `${agentId}-notes.txt`);
                expect(uploaded).toMatchObject([
                  { contentType: "text/plain", sizeBytes: Buffer.byteLength(attachmentText) },
                ]);
                const mediaRef = expectDefined(uploaded[0]?.url, "uploaded media reference");
                expect(mediaRef).toMatch(/^media:\/\/inbound\//);
                const resolved = expectDefined(
                  await resolveInboundMediaReference(mediaRef),
                  "managed inbound attachment",
                );
                await expect(fs.readFile(resolved.physicalPath, "utf8")).resolves.toBe(
                  attachmentText,
                );
                attachmentRefs.set(agentId, mediaRef);
              }
              const attachmentRef = attachmentRefs.get(agentId);
              const otherAttachmentRef = attachmentRefs.get(otherAgentId);
              // Captioned documents retain replay metadata in storage; the live upload gets
              // the model-facing attachment note through the current-turn prompt envelope.
              if (attachments) {
                expect(providerInput).toContain(attachmentRef);
              }
              if (otherAttachmentRef) {
                expect(providerInput).not.toContain(otherAttachmentRef);
              }
              const transcript = await loadTranscriptEvents({
                agentId,
                sessionKey: "global",
                sessionId: history.sessionId,
              });
              for (const persisted of [history.messages, transcript]) {
                const text = JSON.stringify(persisted);
                expect(text).toContain(message);
                expect(text).toContain(providerReply);
                expect(text).not.toContain(markers[otherAgentId]);
                if (attachmentRef) {
                  expect(text).toContain(attachmentRef);
                }
                if (otherAttachmentRef) {
                  expect(text).not.toContain(otherAttachmentRef);
                }
              }
              const otherHistory = await gateway.client.request<{ messages: unknown[] }>(
                "chat.history",
                { sessionKey: "global", agentId: otherAgentId, limit: 20 },
              );
              expect(JSON.stringify(otherHistory.messages)).not.toContain(markers[agentId]);
              if (attachmentRef) {
                expect(JSON.stringify(otherHistory.messages)).not.toContain(attachmentRef);
              }
              expect(providerErrors).toEqual([]);
            }
          }
        }
      }

      const profileScope = {
        agentId: "main",
        sessionKey: `agent:main:profile-authority-${randomUUID()}`,
        sessionId: `profile-authority-${randomUUID()}`,
      };
      await replaceSessionEntry(profileScope, {
        sessionId: profileScope.sessionId,
        updatedAt: Date.now(),
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: memberProfileId },
      });
      const replacement = ensureProfileForEmail("profile-replacement@example.test");
      const aliasEmail = "profile-custody-alias@example.test";
      const aliasSource = ensureProfileForEmail(aliasEmail);
      const beforeProfileReplacement = await loadTranscriptEvents(profileScope);
      const beforeProfileRequests = requests.length;
      const profileRead = holdSessionAuthorizationRead(profileScope.sessionKey);
      const replaced = gateway.client.request("chat.send", {
        sessionKey: profileScope.sessionKey,
        message: "This replaced caller must not reach the transcript or provider.",
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      try {
        await Promise.race([
          profileRead.entered,
          replaced.then(() => {
            throw new Error("Profile-bound chat completed before its worker read was held");
          }),
        ]);
        linkEmail(proxyUser, replacement.id);
        await expect(
          gateway.client.request<UsersSelfResult>("users.self", {}),
        ).resolves.toMatchObject({
          profile: { id: replacement.id },
        });
        profileRead.resume();
        await expect(replaced).rejects.toMatchObject({
          code: "FORBIDDEN",
          message: "Gateway requester authority changed",
        });
      } finally {
        profileRead.resume();
        await Promise.allSettled([replaced]);
        profileRead.restore();
      }
      expect(profileRead.wasHeld()).toBe(true);
      expect(requests).toHaveLength(beforeProfileRequests);
      expect(await loadTranscriptEvents(profileScope)).toEqual(beforeProfileReplacement);
      expect(await listSessionPendingInputs(profileScope)).toEqual({ items: [], total: 0 });

      // Keep both execution sources alive. Retiring either captured canonical
      // identity revokes authority; merging another profile into the sender does not.
      backingClient = await connectGatewayClient({
        url: `wss://127.0.0.1:${gateway.port}`,
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        edgeAuthHeaders: {
          "x-forwarded-for": "203.0.113.52",
          "x-forwarded-proto": "https",
          "x-forwarded-user": proxyBacking,
        },
        origin: "https://control.example.com",
        tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
        scopes: ["operator.read", "operator.write"],
        deviceIdentity: loadOrCreateDeviceIdentity({
          path: state.statePath("test-device-identities", "backing.sqlite"),
        }),
      });
      const backingSelf = await backingClient.request<UsersSelfResult>("users.self", {});
      expect(backingSelf.profile.id).not.toBe(replacement.id);
      await addSessionMember(profileScope, {
        identityId: backingSelf.profile.id,
        addedBy: replacement.id,
      });
      const backingMessage = `PROFILE_BACKING_${randomUUID()}`;
      const steeringMessage = `PROFILE_ACCEPTED_${randomUUID()}`;
      const backingHold = holdProviderResponse(backingMessage);
      const steeringHold = holdProviderResponse(steeringMessage);
      const requestOffset = requests.length;
      providerReply = "Accepted profile input completed.";
      const backing = await backingClient.request<{ runId: string; status: string }>("chat.send", {
        sessionKey: profileScope.sessionKey,
        message: backingMessage,
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      expect(backing.status).toBe("started");
      const backingTerminal = administrator.request<{ status: string }>(
        "agent.wait",
        { runId: backing.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      );
      await Promise.race([
        backingHold.entered.promise,
        backingTerminal.then((result) => {
          throw new Error(
            `Backing run settled before its provider hold: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      const steering = await gateway.client.request<{ runId: string; status: string }>(
        "chat.send",
        {
          sessionKey: profileScope.sessionKey,
          message: steeringMessage,
          queueMode: "steer",
          deliver: false,
          idempotencyKey: randomUUID(),
        },
      );
      expect(steering.status).toBe("started");
      expect(requests).toHaveLength(requestOffset + 1);
      expect(await listSessionPendingInputs(profileScope)).toMatchObject({
        total: 1,
        items: [{ runId: steering.runId, state: "queued", message: { content: steeringMessage } }],
      });
      expect(JSON.stringify(await loadTranscriptEvents(profileScope))).not.toContain(
        steeringMessage,
      );
      linkEmail(aliasEmail, replacement.id);
      const mergedProfile = readUserProfileIdentity(aliasSource.id);
      expect(mergedProfile).toMatchObject({
        profileId: replacement.id,
      });
      expect(mergedProfile?.aliases).toContain(aliasSource.id);
      await expect(
        gateway.client.request<UsersSelfResult>("users.self", {}),
      ).resolves.toMatchObject({
        profile: { id: replacement.id },
      });
      const steeringTerminal = administrator.request<{ status: string }>(
        "agent.wait",
        { runId: steering.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      );
      backingHold.resume.resolve();
      await Promise.race([
        steeringHold.entered.promise,
        Promise.all([backingTerminal, steeringTerminal]).then((results) => {
          throw new Error(`Accepted steering lost its backing run: ${JSON.stringify(results)}`);
        }),
      ]);
      await expect(
        administrator.request("agent.wait", { runId: backing.runId, timeoutMs: 100 }),
      ).resolves.toMatchObject({ status: "timeout" });
      expect(requests).toHaveLength(requestOffset + 2);
      expect(requests[requestOffset + 1]).toContain(steeringMessage);
      steeringHold.resume.resolve();
      await expect(backingTerminal).resolves.toMatchObject({ status: "ok" });
      await expect(steeringTerminal).resolves.toMatchObject({ status: "ok" });
      const settledMessages = (await loadTranscriptEvents(profileScope)).flatMap((event) => {
        const message = asOptionalRecord(asOptionalRecord(event)?.message);
        return message ? [message] : [];
      });
      for (const input of [backingMessage, steeringMessage]) {
        expect(
          settledMessages.filter(
            (message) => message.role === "user" && JSON.stringify(message.content).includes(input),
          ),
        ).toHaveLength(1);
      }
      expect(
        settledMessages.filter(
          (message) =>
            message.role === "assistant" && JSON.stringify(message.content).includes(providerReply),
        ),
      ).toHaveLength(2);
      expect(await listSessionPendingInputs(profileScope)).toEqual({ items: [], total: 0 });
      expect(providerErrors).toEqual([]);
    } finally {
      for (const hold of providerHolds) {
        hold.resume.resolve();
      }
      try {
        try {
          try {
            if (backingClient) {
              await disconnectGatewayClient(backingClient);
            }
          } finally {
            if (administrator) {
              await disconnectGatewayClient(administrator);
            }
          }
        } finally {
          if (gateway) {
            try {
              await disconnectGatewayClient(gateway.client);
            } finally {
              try {
                await Promise.all(agentExecutions.map((execution) => execution.release()));
              } finally {
                await gateway.server.close({ reason: "membership authority proof complete" });
              }
            }
          }
        }
      } finally {
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => {
          providerServer.close(() => resolve());
        });
        await state.cleanup();
      }
    }
  },
);
