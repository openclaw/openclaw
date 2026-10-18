// Load the deferred Gateway and model runtime during collection, outside the authority deadline.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import assert from "node:assert/strict";
import { randomUUID, X509Certificate } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { text as readStreamText } from "node:stream/consumers";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { UsersSelfResult } from "../../packages/gateway-protocol/src/schema/users.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
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
import { createDeferredCore } from "../shared/deferred.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { readResidentUserProfileIdentity } from "../state/user-profile-list.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import * as sessionSharingAuthorization from "./session-sharing-authorization-async.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type Client = Awaited<ReturnType<typeof connectGatewayClient>>;
const operatorScopes: Array<"operator.read" | "operator.write"> = [
  "operator.read",
  "operator.write",
];
const adminScopes: Array<"operator.admin"> = ["operator.admin"];
const resetHistory = {
  sessionKey: "global",
  messages: [
    { role: "system", content: [{ type: "text", text: "Reset" }], __openclaw: { kind: "reset" } },
  ],
};
const profileId = async (client: Client) =>
  (await client.request<UsersSelfResult>("users.self", {})).profile.id;

function send(
  client: Client,
  sessionKey: string,
  message: string,
  params: Record<string, unknown> = {},
  method: "chat.send" | "agent" = "chat.send",
) {
  return client.request<{ runId: string; status: string }>(method, {
    sessionKey,
    message,
    deliver: false,
    idempotencyKey: randomUUID(),
    ...params,
  });
}

async function waitForRun(client: Client, runId: string) {
  const terminal = await client.request<{ status: string }>(
    "agent.wait",
    { runId, timeoutMs: 30_000 },
    { timeoutMs: 35_000 },
  );
  expect(terminal).toMatchObject({ status: "ok" });
}

const expectHeld = (entered: Promise<unknown>, completed: Promise<unknown>) =>
  awaitGateBeforeSettlement(entered, completed, "Operation settled before its hold");

function expectText(value: unknown, present: string[], absent: string[] = []) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  present.forEach((item) => expect(text).toContain(item));
  absent.forEach((item) => expect(text).not.toContain(item));
}

function seedSession(
  scope: { agentId: string; sessionKey: string; sessionId: string },
  ownerId: string,
  visibility: "shared" | "read-only" = "read-only",
  sessionId = scope.sessionId,
) {
  return replaceSessionEntry(scope, {
    sessionId,
    updatedAt: Date.now(),
    visibility,
    createdActor: { type: "human", source: "profile", id: ownerId },
  });
}

// Attempt every cleanup even if an earlier owner fails to close.
async function cleanupAll(...actions: Array<() => Promise<unknown>>) {
  const [first, ...rest] = actions;
  if (first) {
    try {
      await first();
    } finally {
      await cleanupAll(...rest);
    }
  }
}

async function rejectAfterChange(
  client: Client,
  sessionKey: string,
  change: () => Promise<void>,
  error: { code: string; message?: string } = { code: "INVALID_REQUEST" },
) {
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const resolveAuthorization = sessionSharingAuthorization.resolveSessionMutationAuthorizationAsync;
  let held = false;
  const authorization = vi
    .spyOn(sessionSharingAuthorization, "resolveSessionMutationAuthorizationAsync")
    .mockImplementation(async (params) => {
      const reply = await resolveAuthorization(params);
      if (
        !held &&
        params.method === "chat.send" &&
        asOptionalRecord(params.requestParams)?.sessionKey === sessionKey &&
        reply.authorization
      ) {
        held = true;
        entered.resolve();
        await resume.promise;
      }
      return reply;
    });
  const denied = send(client, sessionKey, "Authority changed during this turn.");
  try {
    await expectHeld(entered.promise, denied);
    await change();
    resume.resolve();
    await expect(denied).rejects.toMatchObject(error);
  } finally {
    resume.resolve();
    await Promise.allSettled([denied]);
    authorization.mockRestore();
  }
}

it(
  "carries current caller, membership and global ownership through transcript persistence and agent dispatch",
  { timeout: 90_000 },
  async () => {
    const state = await createOpenClawTestState({
      label: "chat-membership-authority",
      env: {
        ...KERNEL_TEST_ENV,
        VITEST: process.env.VITEST,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    const requests: string[] = [];
    const providerErrors: unknown[] = [];
    const expectRequests = (count: number) =>
      expect({ count: requests.length, errors: providerErrors }).toEqual({ count, errors: [] });
    let providerReply = "Authorized member reply.";
    const providerHolds: ReturnType<typeof holdProviderResponse>[] = [];
    function holdProviderResponse(message: string) {
      const hold = {
        message,
        entered: createDeferredCore(),
        resume: createDeferredCore(),
        claimed: false,
      };
      providerHolds.push(hold);
      return hold;
    }
    const cleanups: Array<() => Promise<unknown>> = [() => state.cleanup()];
    try {
      const providerServer = createServer((request, response) => {
        void (async () => {
          const body = await readStreamText(request);
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
      cleanups.push(async () => {
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => {
          providerServer.close(() => resolve());
        });
      });
      await once(providerServer.listen(0, "127.0.0.1"), "listening");
      const address = providerServer.address();
      assert(address && typeof address !== "string", "fixture provider did not bind");
      const agentExecutions: Array<{ release(): Promise<void> }> = [];
      const provider = buildMockOpenAiResponsesProvider(
        `http://127.0.0.1:${address.port}/v1`,
        "membership-authority",
      );
      const proxyUser = "member@example.test";
      const proxyAdministrator = "administrator@example.test";
      const proxyBacking = "backing@example.test";
      setUserProfileRole(ensureProfileForEmail(proxyAdministrator).id, "administrator");
      const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
      const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
      const trustedProxy = {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowUsers: [proxyUser, proxyAdministrator, proxyBacking],
        allowLoopback: true,
        deviceAutoApprove: { enabled: true, scopes: operatorScopes },
      };
      const providerConfig = { ...provider.config, request: { allowPrivateNetwork: true } };
      const modelParams = { transport: "sse", openaiWsWarmup: false };
      const identityScopes = { [proxyAdministrator]: adminScopes };
      const roles = {
        administrator: { sessions: { others: "write" }, agents: "*", scopes: adminScopes },
        view: { sessions: { others: "view" }, agents: "*", scopes: operatorScopes },
      } as const;
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
              [provider.modelRef]: { agentRuntime: { id: "openclaw" }, params: modelParams },
            },
          },
        },
        session: { scope: "global" },
        models: { mode: "replace", providers: { [provider.providerId]: providerConfig } },
        plugins: { enabled: false, slots: { memory: "none" } },
        tools: { profile: "minimal" },
        gateway: {
          auth: { mode: "trusted-proxy", trustedProxy, identityScopes },
          trustedProxies: ["127.0.0.1"],
          controlUi: { allowedOrigins: ["https://control.example.com"] },
          tls: { enabled: true, autoGenerate: false, certPath, keyPath },
          roles: { default: "view", definitions: roles },
        },
      } satisfies OpenClawConfig;
      const connection = {
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        origin: "https://control.example.com",
        tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
        scopes: operatorScopes,
      };
      const edgeHeaders = (user: string, forwardedFor: string) => ({
        "x-forwarded-for": forwardedFor,
        "x-forwarded-proto": "https",
        "x-forwarded-user": user,
      });
      const gateway = await startGatewayWithClient({
        ...connection,
        cfg,
        configPath: state.configPath,
        portClaim: await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] }),
        auth: cfg.gateway.auth,
        edgeAuthHeaders: edgeHeaders(proxyUser, "203.0.113.50"),
        secure: true,
      });
      cleanups.push(
        () => gateway.server.close({ reason: "membership authority proof complete" }),
        () => Promise.all(agentExecutions.map((execution) => execution.release())),
        () => disconnectGatewayClient(gateway.client),
      );
      await gateway.server.startupSettled;
      const client = gateway.client;
      const gatewayUrl = `wss://127.0.0.1:${gateway.port}`;
      const connectAs = (user: string, name: string, ip: string) =>
        connectGatewayClient({
          ...connection,
          url: gatewayUrl,
          edgeAuthHeaders: edgeHeaders(user, ip),
          deviceIdentity: loadOrCreateDeviceIdentity({
            path: state.statePath("test-device-identities", `${name}.sqlite`),
          }),
        });
      const historyFor = (agentId: string) =>
        client.request<{ sessionKey: string; sessionId: string; messages: unknown[] }>(
          "chat.history",
          { sessionKey: "global", agentId, limit: 20 },
        );
      // Keep both fixture agents resident while alternating owners; the runtime retains one idle executor.
      for (const agentId of ["main", "work"]) {
        agentExecutions.push(captureOpenClawAgentDatabaseExecution({ agentId, env: state.env }));
      }
      const administrator = await connectAs(proxyAdministrator, "administrator", "203.0.113.51");
      cleanups.push(() => disconnectGatewayClient(administrator));
      const memberProfileId = await profileId(client);
      const sessionKey = `agent:main:member-authority-${randomUUID()}`;
      const sessionId = `member-authority-${randomUUID()}`;
      const scope = { agentId: "main", sessionKey, sessionId };
      const owner = ensureProfileForEmail("membership-authority-owner@example.test");
      await seedSession(scope, owner.id);
      await addSessionMember(scope, { identityId: memberProfileId, addedBy: owner.id });
      const allowedMessage = "Persist and dispatch this authorized member turn.";
      const accepted = await send(client, sessionKey, allowedMessage);
      expect(accepted.status).toBe("started");
      await waitForRun(client, accepted.runId);
      expectText(await loadTranscriptEvents(scope), [allowedMessage, "Authorized member reply."]);
      expectRequests(1);
      expect(requests[0]).toContain(allowedMessage);
      const transcriptBeforeDeniedTurn = structuredClone(await loadTranscriptEvents(scope));
      const expectUnchanged = async () => {
        expect(await loadTranscriptEvents(scope)).toEqual(transcriptBeforeDeniedTurn);
        expectRequests(1);
      };
      for (const change of ["membership revoked", "session replaced"] as const) {
        await addSessionMember(scope, { identityId: memberProfileId, addedBy: owner.id });
        const revoke = async () => {
          await expectUnchanged();
          if (change === "membership revoked") {
            await removeSessionMember(scope, memberProfileId);
          } else {
            await seedSession(scope, owner.id, "read-only", `${sessionId}-successor`);
          }
        };
        await rejectAfterChange(client, sessionKey, revoke);
        await expectUnchanged();
        if (change === "session replaced") {
          expect(
            await loadTranscriptEvents({ ...scope, sessionId: `${sessionId}-successor` }),
          ).toEqual([]);
        }
      }
      await removeSessionMember(scope, memberProfileId);
      await expect(send(client, sessionKey, "Later revoked member turn.")).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
      await expectUnchanged();
      // Reset through a separate administrator; member turns must retain their narrow scopes.
      let resetGlobalSessions = false;
      for (const [first, second, withAttachment] of [
        ["main", "work", false],
        ["main", "work", true],
        ["work", "main", false],
        ["work", "main", true],
      ] as const) {
        if (resetGlobalSessions) {
          for (const agentId of [first, second]) {
            await expect(
              administrator.request("sessions.reset", { key: "global", agentId }),
            ).resolves.toMatchObject({ ok: true });
            await expect(
              client.request("chat.history", { sessionKey: "global", agentId }),
            ).resolves.toMatchObject(resetHistory);
          }
        }
        resetGlobalSessions = true;
        const markers = {
          main: `GLOBAL_MAIN_${randomUUID()}`,
          work: `GLOBAL_WORK_${randomUUID()}`,
        };
        const sessionIds = new Map<string, string>();
        const attachmentRefs = new Map<string, string>();
        for (const [method, agentId] of [
          ["chat.send", first],
          ["chat.send", second],
          ["agent", first],
          ["agent", second],
        ] as const) {
          const otherAgentId = agentId === "main" ? "work" : "main";
          const message = `${markers[agentId]}_${method}_INPUT`;
          providerReply = `${markers[agentId]}_${method}_REPLY`;
          const attachmentText = `${markers[agentId]} attachment`;
          const attachment = {
            fileName: `${agentId}-notes.txt`,
            mimeType: "text/plain",
            content: Buffer.from(attachmentText).toString("base64"),
          };
          const attachments = withAttachment && method === "chat.send" ? [attachment] : undefined;
          const requestOffset = requests.length;
          const started = await send(client, "global", message, { agentId, attachments }, method);
          expect(started.status).toBe(method === "chat.send" ? "started" : "accepted");
          await waitForRun(client, started.runId);
          const providerInput = requests.slice(requestOffset).join("\n");
          expectText(providerInput, [message], [markers[otherAgentId]]);
          const history = await historyFor(agentId);
          expect(history).toMatchObject({ sessionKey: "global", sessionId: expect.any(String) });
          if (method === "agent") {
            expect(history.sessionId).toBe(sessionIds.get(agentId));
            expect(providerInput).toContain(`${markers[agentId]}_chat.send_REPLY`);
          }
          sessionIds.set(agentId, history.sessionId);
          expect(new Set(sessionIds.values()).size).toBe(sessionIds.size);
          if (attachments) {
            const uploaded = history.messages
              .flatMap((item) => readPersistedMediaFacts(asOptionalRecord(item) ?? {}) ?? [])
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
            await expect(fs.readFile(resolved.physicalPath, "utf8")).resolves.toBe(attachmentText);
            attachmentRefs.set(agentId, mediaRef);
          }
          const attachmentRef = attachmentRefs.get(agentId);
          const otherAttachmentRef = attachmentRefs.get(otherAgentId);
          const ownMedia = attachmentRef ? [attachmentRef] : [];
          const otherMedia = otherAttachmentRef ? [otherAttachmentRef] : [];
          // Captioned documents retain replay metadata in storage; the live upload gets
          // the model-facing attachment note through the current-turn prompt envelope.
          expectText(providerInput, attachments ? ownMedia : [], otherMedia);
          const transcript = await loadTranscriptEvents({
            agentId,
            sessionKey: "global",
            sessionId: history.sessionId,
          });
          for (const persisted of [history.messages, transcript]) {
            expectText(
              persisted,
              [message, providerReply, ...ownMedia],
              [markers[otherAgentId], ...otherMedia],
            );
          }
          expectText(
            (await historyFor(otherAgentId)).messages,
            [],
            [markers[agentId], ...ownMedia],
          );
          expect(providerErrors).toEqual([]);
        }
      }
      const profile = {
        agentId: "main",
        sessionKey: `agent:main:profile-authority-${randomUUID()}`,
        sessionId: `profile-authority-${randomUUID()}`,
      };
      await seedSession(profile, memberProfileId, "shared");
      const replacement = ensureProfileForEmail("profile-replacement@example.test");
      const aliasEmail = "profile-custody-alias@example.test";
      const aliasSource = ensureProfileForEmail(aliasEmail);
      const beforeProfileReplacement = await loadTranscriptEvents(profile);
      const beforeProfileRequests = requests.length;
      const replaceCaller = async () => {
        linkEmail(proxyUser, replacement.id);
        expect(await profileId(client)).toBe(replacement.id);
      };
      await rejectAfterChange(client, profile.sessionKey, replaceCaller, {
        code: "FORBIDDEN",
        message: "Gateway requester authority changed",
      });
      expect(requests).toHaveLength(beforeProfileRequests);
      expect(await loadTranscriptEvents(profile)).toEqual(beforeProfileReplacement);
      expect(await listSessionPendingInputs(profile)).toEqual({ items: [], total: 0 });
      // Keep both execution sources alive. Retiring either captured canonical
      // identity revokes authority; merging another profile into the sender does not.
      const backer = await connectAs(proxyBacking, "backing", "203.0.113.52");
      cleanups.push(() => disconnectGatewayClient(backer));
      const backingProfileId = await profileId(backer);
      expect(backingProfileId).not.toBe(replacement.id);
      await addSessionMember(profile, { identityId: backingProfileId, addedBy: replacement.id });
      const backingMessage = `PROFILE_BACKING_${randomUUID()}`;
      const steeringMessage = `PROFILE_ACCEPTED_${randomUUID()}`;
      const backingHold = holdProviderResponse(backingMessage);
      const steeringHold = holdProviderResponse(steeringMessage);
      const requestOffset = requests.length;
      providerReply = "Accepted profile input completed.";
      const backing = await send(backer, profile.sessionKey, backingMessage);
      expect(backing.status).toBe("started");
      const backingTerminal = waitForRun(administrator, backing.runId);
      await expectHeld(backingHold.entered.promise, backingTerminal);
      const steering = await send(client, profile.sessionKey, steeringMessage, {
        queueMode: "steer",
      });
      expect(steering.status).toBe("started");
      expect(requests).toHaveLength(requestOffset + 1);
      expect(await listSessionPendingInputs(profile)).toMatchObject({
        total: 1,
        items: [{ runId: steering.runId, state: "queued", message: { content: steeringMessage } }],
      });
      expect(JSON.stringify(await loadTranscriptEvents(profile))).not.toContain(steeringMessage);
      linkEmail(aliasEmail, replacement.id);
      const mergedIdentity = readResidentUserProfileIdentity(aliasSource.id);
      expect(mergedIdentity).toMatchObject({
        profileId: replacement.id,
      });
      expect(mergedIdentity?.aliases.has(aliasSource.id)).toBe(true);
      expect(await profileId(client)).toBe(replacement.id);
      const steeringTerminal = waitForRun(administrator, steering.runId);
      backingHold.resume.resolve();
      await expectHeld(
        steeringHold.entered.promise,
        Promise.all([backingTerminal, steeringTerminal]),
      );
      await expect(
        administrator.request("agent.wait", { runId: backing.runId, timeoutMs: 100 }),
      ).resolves.toMatchObject({ status: "timeout" });
      expect(requests).toHaveLength(requestOffset + 2);
      expect(requests[requestOffset + 1]).toContain(steeringMessage);
      steeringHold.resume.resolve();
      await Promise.all([backingTerminal, steeringTerminal]);
      const settledMessages = (await loadTranscriptEvents(profile)).flatMap((event) => {
        const message = asOptionalRecord(asOptionalRecord(event)?.message);
        return message ? [message] : [];
      });
      const countMessage = (role: string, text: string) =>
        settledMessages.filter(
          (message) => message.role === role && JSON.stringify(message.content).includes(text),
        ).length;
      [backingMessage, steeringMessage].forEach((input) =>
        expect(countMessage("user", input)).toBe(1),
      );
      expect(countMessage("assistant", providerReply)).toBe(2);
      expect(await listSessionPendingInputs(profile)).toEqual({ items: [], total: 0 });
      expect(providerErrors).toEqual([]);
    } finally {
      providerHolds.forEach((hold) => hold.resume.resolve());
      await cleanupAll(...cleanups.toReversed());
    }
  },
);
