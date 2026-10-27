// Load the deferred Gateway and model runtime during collection, outside the authority deadline.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { randomUUID, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { UsersSelfResult } from "../../packages/gateway-protocol/src/schema/users.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import * as workspaceReadiness from "../agents/workspace-readiness.js";
import { requireGit } from "../agents/worktrees/git.js";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
import type { CreateManagedWorktreeParams } from "../agents/worktrees/types.js";
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
import { waitForSessionRunEnd } from "../sessions/session-controller.native-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { Deferred } from "../shared/deferred.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { readResidentUserProfileIdentity } from "../state/user-profile-list.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import {
  createProductState,
  productModelConfig,
  productProvider,
} from "./server.chat-product.test-support.js";
import * as sessionSharingAuthorization from "./session-sharing-authorization-async.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
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

const expectHeld = (entered: Promise<unknown>, completed: Promise<unknown>, stage: string) =>
  awaitGateBeforeSettlement(entered, completed, `${stage}: operation settled before its hold`);

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
    await expectHeld(entered.promise, denied, "chat authorization");
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
    const state = await createProductState("chat-membership-authority");
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
      const providerServer = productProvider(providerErrors, async (body, response) => {
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
      });
      cleanups.push(() => closeProvider(providerServer));
      const agentExecutions: Array<{ release(): Promise<void> }> = [];
      const provider = buildMockOpenAiResponsesProvider(
        await listenProvider(providerServer),
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
      const model = productModelConfig(state.workspaceDir, provider);
      const identityScopes = { [proxyAdministrator]: adminScopes };
      const roles = {
        administrator: { sessions: { others: "write" }, agents: "*", scopes: adminScopes },
        view: { sessions: { others: "view" }, agents: "*", scopes: operatorScopes },
      } as const;
      const cfg = {
        agents: {
          ownership: "explicit",
          entries: { main: {}, work: {} },
          defaults: model.defaults,
        },
        session: { scope: "global" },
        messages: { queue: { allowCollaborativeSteering: true } },
        models: model.models,
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
            path: state.statePath("test-device-identities", name, "client", "credentials.sqlite"),
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
      await expectHeld(backingHold.entered.promise, backingTerminal, "backing provider");
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
        "accepted steering provider",
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

type ProviderCall = { body: Record<string, unknown>; response: ServerResponse };
type PromptFacts = Parameters<NonNullable<CreateManagedWorktreeParams["onPromptReady"]>>[0];
type CheckoutGate = {
  key: string;
  entered: Deferred<PromptFacts>;
  release: Deferred;
  toolWaiting: Deferred;
  settled: Deferred;
  failure?: Error;
};

const instruction = "WORKTREE_PROMPT_MARKER: preserve this committed project instruction.";
const fileContents = "WORKTREE_TOOL_MARKER: the complete checkout is ready.\n";
const userMessage = "Read src/remaining.txt and report its marker.";
const partial = "I can start while the workspace finishes.";
const assistantMessage = {
  type: "message",
  id: "msg_readiness",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: partial, annotations: [] }],
};

function writeEvent(response: ServerResponse, type: string, fields: Record<string, unknown>) {
  response.write(`data: ${JSON.stringify({ type: `response.${type}`, ...fields })}\n\n`);
}

function finishText(response: ServerResponse, text: string, id: string) {
  writeOpenAiResponsesText(response, { text, messageId: `msg_${id}`, responseId: `resp_${id}` });
}

function finishWithTool(response: ServerResponse, name: string, args: Record<string, unknown>) {
  const item = {
    type: "function_call",
    id: "fc_read_remaining",
    call_id: "call_read_remaining",
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
  writeTextEvent(response, "done", { text: partial });
  writeEvent(response, "output_item.done", { output_index: 0, item: assistantMessage });
  writeEvent(response, "output_item.added", { output_index: 1, item: { ...item, arguments: "" } });
  writeEvent(response, "function_call_arguments.done", {
    item_id: item.id,
    output_index: 1,
    arguments: item.arguments,
  });
  writeEvent(response, "output_item.done", { output_index: 1, item });
  writeEvent(response, "completed", {
    response: {
      id: "resp_read_remaining",
      status: "completed",
      output: [assistantMessage, item],
      usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
    },
  });
  response.end("data: [DONE]\n\n");
}

function writeTextEvent(response: ServerResponse, phase: string, fields: Record<string, unknown>) {
  writeEvent(response, `output_text.${phase}`, {
    item_id: assistantMessage.id,
    output_index: 0,
    content_index: 0,
    ...fields,
  });
}

async function writeRecordingChannel(root: string, captureUrl: string) {
  const id = "readiness-chat";
  const schema = { type: "object", additionalProperties: false };
  await fs.mkdir(root, { recursive: true });
  const writeJson = (file: string, value: unknown) =>
    fs.writeFile(path.join(root, file), JSON.stringify(value));
  await writeJson("package.json", {
    name: id,
    version: "1.0.0",
    openclaw: { extensions: ["./index.cjs"] },
  });
  await writeJson("openclaw.plugin.json", {
    id,
    channels: [id],
    activation: { onStartup: true },
    channelConfigs: {
      [id]: { schema: { ...schema, properties: { enabled: { type: "boolean" } } } },
    },
    configSchema: schema,
  });
  await fs.writeFile(
    path.join(root, "index.cjs"),
    `
const id = "readiness-chat";
async function send(ctx) {
  const bytes = ctx.mediaUrl ? await ctx.mediaReadFile(ctx.mediaUrl) : Buffer.alloc(0);
  ctx.signal?.throwIfAborted();
  await ctx.onPlatformSendDispatch?.();
  ctx.assertDirectAdapterHandoff?.();
  const response = await fetch(${JSON.stringify(captureUrl)}, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: ctx.to, text: ctx.text, contents: bytes.toString("utf8") }),
    signal: ctx.signal,
  });
  if (!response.ok) throw new Error("Synthetic capture refused delivery");
  await response.text();
  return { channel: id, messageId: ctx.to };
}
module.exports = { id, register(api) {
  api.registerChannel({ plugin: {
    id, meta: { id, label: id, selectionLabel: id, docsPath: "/channels", blurb: "Synthetic recording channel" },
    capabilities: { chatTypes: ["direct"], media: true },
    config: { listAccountIds: () => ["default"], resolveAccount: () => ({ accountId: "default", enabled: true }), isConfigured: () => true },
    messaging: { normalizeTarget: (raw) => raw.trim(), targetResolver: { looksLikeId: (raw) => raw.trim().length > 0 } },
    outbound: { deliveryMode: "direct", resolveTarget: ({to}) => ({ ok: true, to }), sendText: send, sendMedia: send },
  } });
} };
`,
  );
  return root;
}

function promptPrefix(
  body: Record<string, unknown>,
  workspace: string,
  branch: string,
  sessionKey: string,
) {
  const input = Array.isArray(body.input) ? body.input : [];
  return JSON.stringify(
    {
      instructions: body.instructions,
      systemMessages: input.filter(
        (item) => isRecord(item) && (item.role === "system" || item.role === "developer"),
      ),
      tools: body.tools,
    },
    (_key, value: unknown) =>
      typeof value === "string"
        ? value
            .replaceAll(workspace, "<worktree>")
            .replaceAll(branch, "<branch>")
            .replaceAll(sessionKey, "<session>")
            .replaceAll(encodeURIComponent(sessionKey), "<session>")
        : value,
  );
}

it(
  "starts inference before checkout, preserves the prompt, and fences revoked workspace effects",
  { timeout: 90_000 },
  async ({ signal }) => {
    const state = await createProductState("chat-worktree-readiness");
    const repo = state.workspaceDir;
    let providerCalls = 0;
    const deliveries: Array<Record<string, unknown>> = [];
    const failures: unknown[] = [];
    const terminalErrors: Array<string | undefined> = [];
    let nextCall = createDeferred<ProviderCall>();
    let activeGate: CheckoutGate | undefined;
    const firstDelta = createDeferred();
    const failedTurn = createDeferred();
    // The spy calls this captured method with its original service instance below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const create = ManagedWorktreeService.prototype.createWithOutcome;
    const creationObserver = vi.spyOn(ManagedWorktreeService.prototype, "createWithOutcome");
    creationObserver.mockImplementation(function (this: ManagedWorktreeService, params) {
      const gate = activeGate;
      if (!gate || params.ownerId !== gate.key) {
        return create.call(this, params);
      }
      const onPromptReady = expectDefined(params.onPromptReady, "early prompt callback");
      const operation = create.call(this, {
        ...params,
        onPromptReady: async (facts) => {
          console.error("worktree readiness: publishing early prompt", gate.key);
          await onPromptReady(facts);
          console.error("worktree readiness: early prompt published", gate.key);
          gate.entered.resolve(facts);
          await gate.release.promise;
          if (gate.failure) {
            throw gate.failure;
          }
        },
      });
      void operation
        .then(
          () => gate.entered.reject(new Error("Checkout completed without an early prompt")),
          (error: unknown) => gate.entered.reject(error),
        )
        .finally(() => gate.settled.resolve());
      return operation;
    });
    const captureReadiness = workspaceReadiness.captureAgentWorkspaceReadiness;
    const readinessObserver = vi
      .spyOn(workspaceReadiness, "captureAgentWorkspaceReadiness")
      .mockImplementation((key) => {
        const captured = captureReadiness(key);
        const gate = activeGate;
        return captured && gate && gate.key === key
          ? {
              ...captured,
              waitUntilReady: () => {
                gate.toolWaiting.resolve();
                return captured.waitUntilReady();
              },
            }
          : captured;
      });
    const providerServer = productProvider(failures, (json, response, url) => {
      const body: unknown = JSON.parse(json);
      if (!isRecord(body)) {
        throw new Error("Synthetic provider received an invalid request");
      }
      if (url === "/capture") {
        deliveries.push(body);
        response.writeHead(200).end("captured");
        return;
      }
      const call = { body, response };
      providerCalls++;
      nextCall.resolve(call);
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      await requireGit(repo, ["init", "-b", "main"]);
      await requireGit(repo, ["config", "user.name", "OpenClaw Test"]);
      await requireGit(repo, ["config", "user.email", "test@example.invalid"]);
      await fs.writeFile(path.join(repo, "AGENTS.md"), `${instruction}\n`);
      await fs.mkdir(path.join(repo, "src"));
      await fs.writeFile(path.join(repo, "src/remaining.txt"), fileContents);
      await requireGit(repo, ["add", "."]);
      await requireGit(repo, ["commit", "-qm", "synthetic project"]);
      const providerUrl = await listenProvider(providerServer);
      const provider = buildMockOpenAiResponsesProvider(providerUrl, "worktree-proof");
      const model = productModelConfig(repo, provider);
      const channelPath = await writeRecordingChannel(
        state.path("recording-channel"),
        new URL("/capture", providerUrl).href,
      );
      const cfg = {
        agents: {
          defaults: { ...model.defaults, utilityModel: "" },
        },
        models: model.models,
        plugins: {
          allow: ["readiness-chat"],
          load: { paths: [channelPath] },
          slots: { memory: "none" },
        },
        channels: { "readiness-chat": { enabled: true } },
        tools: {
          profile: "full",
          allow: ["read", "write", "message"],
          codeMode: false,
          toolSearch: false,
        },
        worktreeAcceleration: false,
        gateway: { auth: { mode: "token", token: "worktree-proof" } },
      } satisfies OpenClawConfig;
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token: "worktree-proof",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        onEvent: (event) => {
          const payload = event.payload;
          if (
            event.event !== "chat" ||
            !isRecord(payload) ||
            typeof payload.sessionKey !== "string" ||
            typeof payload.state !== "string"
          ) {
            return;
          }
          if (payload.sessionKey === "agent:main:readiness-early" && payload.state === "delta") {
            firstDelta.resolve();
          }
          if (
            payload.sessionKey === "agent:main:readiness-failure" &&
            ["final", "error", "aborted"].includes(payload.state)
          ) {
            terminalErrors.push(
              typeof payload.errorMessage === "string" ? payload.errorMessage : undefined,
            );
            failedTurn.resolve();
          }
        },
      });
      const client = gateway.client;
      const createWorktree = <T>(name: string, params: Record<string, unknown> = {}) =>
        client.request<T>("sessions.create", {
          key: `agent:main:${name}`,
          agentId: "main",
          displayName: name,
          worktree: true,
          worktreeName: name,
          worktreeBaseRef: "HEAD",
          ...params,
        });
      const expectRun = async (runId: string, status = "ok") =>
        expect(await client.request("agent.wait", { runId, timeoutMs: 60_000 })).toMatchObject({
          status,
        });
      const expectNoEffects = async (name: string, canary: string) => {
        expect(deliveries.filter((delivery) => delivery.to === name)).toEqual([]);
        await expect(fs.access(canary)).rejects.toMatchObject({ code: "ENOENT" });
      };
      const wait = <T>(work: PromiseLike<T>) => withinTest(work, signal);
      const startCheckout = async (
        name: string,
        message: string,
        failure?: Error,
        displayName = name,
      ) => {
        const gate: CheckoutGate = {
          key: `agent:main:${name}`,
          failure,
          entered: createDeferred<PromptFacts>(),
          release: createDeferred(),
          toolWaiting: createDeferred(),
          settled: createDeferred(),
        };
        activeGate = gate;
        nextCall = createDeferred<ProviderCall>();
        console.error("worktree readiness: creating session", gate.key);
        const started = await createWorktree<{
          key: string;
          runId: string;
          sessionId: string;
          runStarted: boolean;
        }>(name, { message, displayName });
        console.error("worktree readiness: session accepted", gate.key);
        const facts = await wait(gate.entered.promise);
        return { gate, started, facts, call: await wait(nextCall.promise) };
      };
      const {
        gate: earlyGate,
        started: early,
        facts,
        call: initial,
      } = await startCheckout("readiness-early", userMessage, undefined, "Readiness proof");
      expect(early.runStarted).toBe(true);
      expect(JSON.stringify(initial.body)).toContain(instruction);
      await expect(fs.access(path.join(facts.path, "src/remaining.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      initial.response.writeHead(200, { "content-type": "text/event-stream" });
      writeEvent(initial.response, "output_item.added", {
        output_index: 0,
        item: { ...assistantMessage, content: [], status: "in_progress" },
      });
      writeTextEvent(initial.response, "delta", { delta: partial });
      await wait(firstDelta.promise);
      nextCall = createDeferred<ProviderCall>();
      finishWithTool(initial.response, "read", { path: "src/remaining.txt" });
      await wait(earlyGate.toolWaiting.promise);
      expect(providerCalls).toBe(1);
      await expect(fs.access(path.join(facts.path, "src/remaining.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      earlyGate.release.resolve();
      const result = await wait(nextCall.promise);
      expect(JSON.stringify(result.body.input)).toContain(fileContents.trim());
      finishText(result.response, fileContents, "done");
      await expectRun(early.runId);

      activeGate = undefined;
      const normal = await createWorktree<{
        key: string;
        worktree: { path: string; branch: string };
      }>("readiness-normal", { displayName: "Readiness proof" });
      nextCall = createDeferred<ProviderCall>();
      const normalRun = await gateway.client.request<{ runId: string }>("chat.send", {
        sessionKey: normal.key,
        message: userMessage,
        idempotencyKey: "readiness-normal-run",
      });
      const prepared = await wait(nextCall.promise);
      const initialPrefix = promptPrefix(initial.body, facts.path, facts.branch, early.key);
      const preparedPrefix = promptPrefix(
        prepared.body,
        normal.worktree.path,
        normal.worktree.branch,
        normal.key,
      );
      expect(initialPrefix).toBe(preparedPrefix);
      finishText(prepared.response, "Prepared prompt matches.", "normal");
      await expectRun(normalRun.runId);

      for (const toolName of ["write", "message"] as const) {
        for (const revoked of [false, true]) {
          const name = `readiness-${toolName}-${revoked ? "aborted" : "allowed"}`;
          const {
            gate,
            started,
            call: request,
          } = await startCheckout(
            name,
            toolName === "write"
              ? "Write a workspace canary."
              : "Send the workspace marker attachment.",
          );
          // Checkout rollback must not erase evidence of an unauthorized effect.
          const canary = state.path(`effects/${name}.txt`);
          nextCall = createDeferred<ProviderCall>();
          request.response.writeHead(200, { "content-type": "text/event-stream" });
          finishWithTool(
            request.response,
            toolName,
            toolName === "write"
              ? { path: canary, content: "workspace write canary" }
              : {
                  action: "send",
                  channel: "readiness-chat",
                  target: name,
                  message: name,
                  media: path.join(repo, "src/remaining.txt"),
                },
          );
          await wait(
            awaitGateBeforeSettlement(
              gate.toolWaiting.promise,
              nextCall.promise,
              `${name}: tool finished without waiting for checkout`,
            ),
          );
          await expectNoEffects(name, canary);
          const runEnded = waitForSessionRunEnd(started.sessionId, null);
          if (revoked) {
            expect(
              await gateway.client.request("chat.abort", {
                sessionKey: gate.key,
                runId: started.runId,
              }),
            ).toMatchObject({ aborted: true, runIds: [started.runId] });
          }
          gate.release.resolve();
          await wait(gate.settled.promise);
          if (!revoked) {
            const completedTool = await wait(nextCall.promise);
            if (toolName === "write") {
              expect(await fs.readFile(canary, "utf8")).toBe("workspace write canary");
            } else {
              expect(deliveries.filter((delivery) => delivery.to === name)).toEqual([
                { to: name, text: name, contents: fileContents },
              ]);
            }
            finishText(completedTool.response, "Effect completed.", name);
          }
          expect(await wait(runEnded)).toBe(true);
          await expectRun(started.runId, revoked ? "error" : "ok");
          if (revoked) {
            await expectNoEffects(name, canary);
          }
        }
      }

      const preparationError = new Error("Synthetic checkout failed; retry the session.");
      const { gate: failedGate, started: failed } = await startCheckout(
        "readiness-failure",
        userMessage,
        preparationError,
        "Readiness failure",
      );
      failedGate.release.resolve();
      await wait(failedTurn.promise);
      await gateway.client.request("agent.wait", { runId: failed.runId, timeoutMs: 60_000 });
      expect(terminalErrors).toHaveLength(1);
      expect(JSON.stringify(terminalErrors)).toContain(preparationError.message);
      expect(failures).toEqual([]);
    } finally {
      activeGate?.release.resolve();
      await closeProvider(providerServer);
      try {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "worktree readiness proof complete" });
        }
      } finally {
        creationObserver.mockRestore();
        readinessObserver.mockRestore();
        await state.cleanup();
      }
    }
  },
);
