// Load the deferred Gateway and model runtime during collection, outside the authority deadline.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
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
import { redactSensitiveText } from "../logging/redact.js";
import { readPersistedMediaFacts } from "../media/media-facts.js";
import { resolveInboundMediaReference } from "../media/media-reference.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
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
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type Client = Awaited<ReturnType<typeof connectGatewayClient>>;
const operatorScopes = ["operator.read", "operator.write"];
const adminScopes = ["operator.admin"];
const profileId = async (client: Client) =>
  (await client.request<UsersSelfResult>("users.self", {})).profile.id;

function send(
  client: Client,
  method: "chat.send" | "agent",
  sessionKey: string,
  message: string,
  params: Record<string, unknown> = {},
) {
  return client.request<{ runId: string; status: string }>(method, {
    sessionKey,
    message,
    deliver: false,
    idempotencyKey: randomUUID(),
    ...params,
  });
}

function waitForRun(client: Client, runId: string) {
  return client.request<{ status: string }>(
    "agent.wait",
    { runId, timeoutMs: 30_000 },
    { timeoutMs: 35_000 },
  );
}

async function expectRun(client: Client, runId: string) {
  const terminal = await waitForRun(client, runId);
  expect(
    terminal,
    redactSensitiveText(JSON.stringify(terminal), { mode: "tools" }).slice(0, 4_000),
  ).toMatchObject({ status: "ok" });
}

async function expectHeld(entered: Promise<unknown>, completed: Promise<unknown>) {
  await Promise.race([
    entered,
    completed.then((result) => {
      throw new Error(`Operation settled before its hold: ${JSON.stringify(result)}`);
    }),
  ]);
}

function expectText(value: unknown, present: string[], absent: string[] = []) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const item of present) {
    expect(text).toContain(item);
  }
  for (const item of absent) {
    expect(text).not.toContain(item);
  }
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

function holdSessionAuthorization(sessionKey: string) {
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const resolveAuthorization = sessionSharingAuthorization.resolveSessionMutationAuthorizationAsync;
  let held = false;
  const resolveWithHold: typeof resolveAuthorization = async (params) => {
    const reply = await resolveAuthorization(params);
    if (
      !held &&
      params.method === "chat.send" &&
      asOptionalRecord(params.requestParams)?.sessionKey === sessionKey &&
      reply.authorization
    ) {
      held = true;
      entered.resolve();
      // Revoke captured authority before the handler can persist or dispatch input.
      await resume.promise;
    }
    return reply;
  };
  const authorization = vi
    .spyOn(sessionSharingAuthorization, "resolveSessionMutationAuthorizationAsync")
    .mockImplementation(resolveWithHold);
  return {
    entered: entered.promise,
    resume: () => resume.resolve(),
    restore: () => authorization.mockRestore(),
  };
}

async function rejectAfterChange(
  client: Client,
  sessionKey: string,
  change: () => Promise<void>,
  error: { code: string; message?: string } = { code: "INVALID_REQUEST" },
) {
  const hold = holdSessionAuthorization(sessionKey);
  const denied = send(client, "chat.send", sessionKey, "Authority changed during this turn.");
  try {
    await expectHeld(hold.entered, denied);
    await change();
    hold.resume();
    await expect(denied).rejects.toMatchObject(error);
  } finally {
    hold.resume();
    await Promise.allSettled([denied]);
    hold.restore();
  }
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
    let administrator: Client | undefined;
    let backingClient: Client | undefined;
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
            identityScopes: { [proxyAdministrator]: adminScopes },
          },
          trustedProxies: ["127.0.0.1"],
          controlUi: { allowedOrigins: ["https://control.example.com"] },
          tls: { enabled: true, autoGenerate: false, certPath, keyPath },
          roles: {
            default: "view",
            definitions: {
              administrator: { sessions: { others: "write" }, agents: "*", scopes: adminScopes },
              view: { sessions: { others: "view" }, agents: "*", scopes: operatorScopes },
            },
          },
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
      gateway = await startGatewayWithClient({
        ...connection,
        cfg,
        configPath: state.configPath,
        portClaim: await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] }),
        auth: cfg.gateway.auth,
        edgeAuthHeaders: edgeHeaders(proxyUser, "203.0.113.50"),
        secure: true,
      });
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
      administrator = await connectAs(proxyAdministrator, "administrator", "203.0.113.51");
      const memberProfileId = await profileId(client);
      const sessionKey = `agent:main:member-authority-${randomUUID()}`;
      const sessionId = `member-authority-${randomUUID()}`;
      const scope = { agentId: "main", sessionKey, sessionId };
      const owner = ensureProfileForEmail("membership-authority-owner@example.test");
      await seedSession(scope, owner.id);
      await addSessionMember(scope, { identityId: memberProfileId, addedBy: owner.id });

      const allowedMessage = "Persist and dispatch this authorized member turn.";
      const accepted = await send(client, "chat.send", sessionKey, allowedMessage);
      expect(accepted.status).toBe("started");
      await expectRun(client, accepted.runId);
      expectText(await loadTranscriptEvents(scope), [allowedMessage, "Authorized member reply."]);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain(allowedMessage);
      expect(providerErrors).toEqual([]);

      const transcriptBeforeDeniedTurn = structuredClone(await loadTranscriptEvents(scope));
      const expectUnchanged = async () => {
        expect(await loadTranscriptEvents(scope)).toEqual(transcriptBeforeDeniedTurn);
        expect(requests).toHaveLength(1);
        expect(providerErrors).toEqual([]);
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
      await expect(
        send(client, "chat.send", sessionKey, "Later revoked member turn."),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expectUnchanged();

      // Reset through a separate administrator; member turns must retain their narrow scopes.
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
                client.request("chat.history", { sessionKey: "global", agentId }),
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
              const message = `${markers[agentId]}_${method}_INPUT`;
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
              const started = await send(client, method, "global", message, {
                agentId,
                attachments,
              });
              expect(started.status).toBe(method === "chat.send" ? "started" : "accepted");
              await expectRun(client, started.runId);
              const providerInput = requests.slice(requestOffset).join("\n");
              expectText(providerInput, [message], [markers[otherAgentId]]);
              const history = await historyFor(agentId);
              expect(history).toMatchObject({
                sessionKey: "global",
                sessionId: expect.any(String),
              });
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
                expectText(
                  persisted,
                  [message, providerReply, ...(attachmentRef ? [attachmentRef] : [])],
                  [markers[otherAgentId], ...(otherAttachmentRef ? [otherAttachmentRef] : [])],
                );
              }
              expectText(
                (await historyFor(otherAgentId)).messages,
                [],
                [markers[agentId], ...(attachmentRef ? [attachmentRef] : [])],
              );
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
      await seedSession(profileScope, memberProfileId, "shared");
      const replacement = ensureProfileForEmail("profile-replacement@example.test");
      const aliasEmail = "profile-custody-alias@example.test";
      const aliasSource = ensureProfileForEmail(aliasEmail);
      const beforeProfileReplacement = await loadTranscriptEvents(profileScope);
      const beforeProfileRequests = requests.length;
      const replaceCaller = async () => {
        linkEmail(proxyUser, replacement.id);
        expect(await profileId(client)).toBe(replacement.id);
      };
      await rejectAfterChange(client, profileScope.sessionKey, replaceCaller, {
        code: "FORBIDDEN",
        message: "Gateway requester authority changed",
      });
      expect(requests).toHaveLength(beforeProfileRequests);
      expect(await loadTranscriptEvents(profileScope)).toEqual(beforeProfileReplacement);
      expect(await listSessionPendingInputs(profileScope)).toEqual({ items: [], total: 0 });

      // Keep both execution sources alive. Retiring either captured canonical
      // identity revokes authority; merging another profile into the sender does not.
      backingClient = await connectAs(proxyBacking, "backing", "203.0.113.52");
      const backingProfileId = await profileId(backingClient);
      expect(backingProfileId).not.toBe(replacement.id);
      await addSessionMember(profileScope, {
        identityId: backingProfileId,
        addedBy: replacement.id,
      });
      const backingMessage = `PROFILE_BACKING_${randomUUID()}`;
      const steeringMessage = `PROFILE_ACCEPTED_${randomUUID()}`;
      const backingHold = holdProviderResponse(backingMessage);
      const steeringHold = holdProviderResponse(steeringMessage);
      const requestOffset = requests.length;
      providerReply = "Accepted profile input completed.";
      const backing = await send(
        backingClient,
        "chat.send",
        profileScope.sessionKey,
        backingMessage,
      );
      expect(backing.status).toBe("started");
      const backingTerminal = waitForRun(administrator, backing.runId);
      await expectHeld(backingHold.entered.promise, backingTerminal);
      const steering = await send(client, "chat.send", profileScope.sessionKey, steeringMessage, {
        queueMode: "steer",
      });
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
      expect(readResidentUserProfileIdentity(aliasSource.id)).toMatchObject({
        profileId: replacement.id,
        aliases: expect.arrayContaining([aliasSource.id]),
      });
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
      await expect(backingTerminal).resolves.toMatchObject({ status: "ok" });
      await expect(steeringTerminal).resolves.toMatchObject({ status: "ok" });
      const settledMessages = (await loadTranscriptEvents(profileScope)).flatMap((event) => {
        const message = asOptionalRecord(asOptionalRecord(event)?.message);
        return message ? [message] : [];
      });
      const countMessage = (role: string, text: string) =>
        settledMessages.filter(
          (message) => message.role === role && JSON.stringify(message.content).includes(text),
        ).length;
      for (const input of [backingMessage, steeringMessage]) {
        expect(countMessage("user", input)).toBe(1);
      }
      expect(countMessage("assistant", providerReply)).toBe(2);
      expect(await listSessionPendingInputs(profileScope)).toEqual({ items: [], total: 0 });
      expect(providerErrors).toEqual([]);
    } finally {
      for (const hold of providerHolds) {
        hold.resume.resolve();
      }
      await cleanupAll(
        async () => backingClient && disconnectGatewayClient(backingClient),
        async () => administrator && disconnectGatewayClient(administrator),
        async () => {
          const activeGateway = gateway;
          if (activeGateway) {
            await cleanupAll(
              () => disconnectGatewayClient(activeGateway.client),
              () => Promise.all(agentExecutions.map((execution) => execution.release())),
              () => activeGateway.server.close({ reason: "membership authority proof complete" }),
            );
          }
        },
        async () => {
          providerServer.closeAllConnections();
          await new Promise<void>((resolve) => {
            providerServer.close(() => resolve());
          });
          await state.cleanup();
        },
      );
    }
  },
);
