import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { extractText } from "../../ui/src/lib/chat/message-extract.ts";
import { buildChatMarkdown } from "../../ui/src/pages/chat/export.ts";
import { createHostWorkspaceWriteTool } from "../agents/agent-tools.read.js";
import { createExecTool } from "../agents/bash-tools.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import { createAgentHarnessHostCapabilities } from "../agents/harness/host-capability.js";
import { projectEffectiveExecPolicy } from "../agents/session-permission-exec-mode.js";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { clearConfigCache, getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listSessionEntriesReadOnly,
  listSessionParticipantsReadOnly,
  loadTranscriptEventsSync,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../talk/agent-consult-tool.js";
import { createOrResumeClientVoiceSession } from "../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../talk/client-voice-session.test-support.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { createTranscriptUpdateBroadcastHandler } from "./server-session-events.js";
import {
  bindSessionRowProjection,
  getSessionRowProjection,
} from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { createTalkClientAgentConsultRunner } from "./talk/client-agent-consult.js";
import { resolveTalkAgentConsultAuthority } from "./talk/client-gateway-control.js";
import { retainTalkClientRunAuthority } from "./talk/client-run-authority.js";
import { talkClientHandlers } from "./talk/handlers/client.js";
import {
  createGatewaySuiteHarness,
  dispatchInboundMessageMock,
  gatewayReplyMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

const runEmbeddedAgent = vi.spyOn(embeddedAgent, "runEmbeddedAgent");
installGatewayTestHooks({ scope: "suite" });
let agentId = "main";
let sessionKey = "agent:main:main";
let canonicalKey = sessionKey;
let sessionId: string;
const connectionId = "talk-consult-history-ui";
const spoken = "SPOKEN_133855: Keep the literal labels Context: and Spoken style: in my note.";
const answer = "ANSWER_133855: Both labels are preserved.";
const consultAnswer = "INTERNAL_FINAL_133855: The note contains both requested labels.";
const consultCommentary = "COMMENTARY_133855: Checking the saved note.";
const consultToolResult = "TOOL_RESULT_133855: Context: and Spoken style: are present.";
const args = {
  question: "GENERATED_QUESTION_133855: Check the note requested by the speaker.",
  context: "GENERATED_CONTEXT_133855: The call already has a finalized human transcript.",
  responseStyle: "GENERATED_STYLE_133855: Speak one short sentence.",
};
const syntheticMarkers = Object.values(args);
const broadcast = vi.fn<GatewayBroadcastToConnIdsFn>();
let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let context: GatewayRequestContext;
let client: GatewayClient;
let storePath: string;
let voiceSessionId: string | undefined;
let modelStarted = createDeferred();
let releaseModel = createDeferred();
let unsubscribe: (() => void) | undefined;
let publications: Promise<void>[] = [];
let publicationErrors: unknown[] = [];

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  agentId = "main";
  sessionKey = canonicalKey = "agent:main:main";
  sessionId = randomUUID();
  // Voice transcripts use the canonical agent store, not a custom chat-store locator.
  storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  testState.sessionStorePath = storePath;
  await writeSessionStore({
    entries: { main: { sessionId, updatedAt: Date.now(), status: "done" } },
  });
  await prepareGatewayReplyRuntimeForTest({ force: true });
  context = createDirectChatContext({ getRuntimeConfig });
  const rowProjection = await createSessionRowProjection({
    cfg: getRuntimeConfig(),
    getConfig: getRuntimeConfig,
    context,
  });
  bindSessionRowProjection(context, () => rowProjection);
  const profile = ensureProfileForEmail("talk-history@example.test");
  client = {
    connId: connectionId,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
    },
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
  // Admission, the recorder, and publication stay real; only model execution is held.
  gatewayReplyMock.mockImplementation(getReplyFromConfig);
  dispatchInboundMessageMock.mockReset();
  runEmbeddedAgent.mockReset();
  modelStarted = createDeferred();
  releaseModel = createDeferred();
  runEmbeddedAgent.mockImplementation(async (params) => {
    modelStarted.resolve();
    await releaseModel.promise;
    return {
      payloads: [{ text: answer }],
      meta: {
        durationMs: 0,
        agentMeta: {
          sessionId: params.sessionId,
          provider: "test",
          model: "test",
          usage: { input: 1, output: 1 },
        },
      },
    };
  });
  broadcast.mockReset();
  publications = [];
  publicationErrors = [];
  const publish = createTranscriptUpdateBroadcastHandler({
    getSessionRowProjection: () => getSessionRowProjection(context),
    broadcastToConnIds: broadcast,
    sessionEventSubscribers: { getAll: () => new Set([connectionId]) },
    sessionMessageSubscribers: { get: () => new Set([connectionId]) },
    chatAbortControllers: context.chatAbortControllers,
  });
  unsubscribe = onInternalSessionTranscriptUpdate((update) => {
    if ((update.target?.sessionId ?? update.sessionId) !== sessionId) {
      return;
    }
    publications.push(
      publish(update).catch((error: unknown) => {
        publicationErrors.push(error);
      }),
    );
  });
  voiceSessionId = createOrResumeClientVoiceSession({
    agentId: "main",
    sessionKey,
    origin: "client",
    transcriptCapable: true,
  });
});
afterEach(async () => {
  releaseModel.resolve();
  try {
    await waitForDispatchEnd();
    if (voiceSessionId) {
      await rpc("talk.client.close", { sessionKey, voiceSessionId });
    }
    await drainPublications();
  } finally {
    unsubscribe?.();
    getSessionRowProjection(context)?.dispose();
    unsubscribe = undefined;
    voiceSessionId = undefined;
    clientVoiceSessionTesting.reset();
    testState.sessionStorePath = undefined;
    gatewayReplyMock.mockReset();
    runEmbeddedAgent.mockReset();
    clearConfigCache();
  }
});

function scope() {
  return { agentId, sessionKey: canonicalKey, sessionId, storePath };
}
async function rpc(method: string, params: Record<string, unknown>) {
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({
    req: { type: "req", id: randomUUID(), method, params },
    context,
    client,
    respond,
    isWebchatConnect: () => true,
  });
  expect(respond).toHaveBeenCalledOnce();
  const [ok, result, error] = expectDefined(respond.mock.calls[0], "Gateway RPC response");
  expect({ ok, error }).toEqual({ ok: true, error: undefined });
  return expectDefined(asOptionalRecord(result), "Gateway RPC result");
}
async function waitForDispatchEnd() {
  await getSessionWorkAdmissionRelease({ scope: storePath, identities: [canonicalKey, sessionId] });
  expect(context.chatAbortControllers.size).toBe(0);
}
async function drainPublications() {
  await Promise.all(publications);
  expect(publicationErrors).toEqual([]);
}
function liveMessages() {
  return broadcast.mock.calls.flatMap(([event, payload]) => {
    const message = asOptionalRecord(payload)?.message;
    return event === "session.message" && message ? [message] : [];
  });
}
function expectNoGeneratedInput(messages: unknown[], surface: string) {
  const markdown = buildChatMarkdown(messages, "Voice test assistant");
  const serialized = JSON.stringify(messages);
  expect
    .soft(
      syntheticMarkers.filter((marker) => serialized.includes(marker)),
      surface,
    )
    .toEqual([]);
  expect
    .soft(
      syntheticMarkers.filter((marker) => markdown?.includes(marker)),
      `${surface} Markdown`,
    )
    .toEqual([]);
}
function expectVisibleSpeechOnly(messages: unknown[], surface: string, hasAnswer: boolean) {
  const users = messages.filter((message) => asOptionalRecord(message)?.role === "user");
  expect.soft(users.map(extractText), surface).toEqual([spoken]);
  const markdown = buildChatMarkdown(messages, "Voice test assistant");
  expect.soft(markdown, `${surface} Markdown`).toContain(spoken);
  expect
    .soft(markdown?.match(/^## Message(?: \(|$)/gm), `${surface} input headings`)
    .toHaveLength(1);
  expectNoGeneratedInput(messages, surface);
  expect
    .soft(
      messages.map(extractText).filter((text) => text === answer),
      `${surface} spoken answer`,
    )
    .toHaveLength(hasAnswer ? 1 : 0);
  expect
    .soft(markdown?.split(answer).length, `${surface} spoken answer in Markdown`)
    .toBe(hasAnswer ? 2 : 1);
  expect.soft(JSON.stringify(messages), `${surface} internal final`).not.toContain(consultAnswer);
  expect.soft(markdown, `${surface} internal final in Markdown`).not.toContain(consultAnswer);
}
async function historyMessages() {
  const result = await rpc("chat.history", { sessionKey: canonicalKey, agentId });
  expect(Array.isArray(result.messages)).toBe(true);
  return result.messages as unknown[];
}

async function consult(question: string, callId: string) {
  return await rpc("talk.client.toolCall", {
    sessionKey,
    voiceSessionId,
    callId,
    name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
    args: { question },
  });
}

async function startHeldConsult() {
  const ack = await consult("Keep this task running until released.", "held-task");
  await Promise.race([
    modelStarted.promise,
    getSessionWorkAdmissionRelease({ scope: storePath, identities: [canonicalKey, sessionId] }),
  ]);
  const run = expectDefined(runEmbeddedAgent.mock.calls[0]?.[0], "held model invocation");
  const abortSignal = expectDefined(run.abortSignal, "admitted model cancellation signal");
  expect(abortSignal.aborted).toBe(false);
  return { ack, run, abortSignal };
}

describe("Browser Talk consult target handoff", () => {
  it.each([
    { name: "new session", key: "main", fresh: true, expected: "agent:voice:main" },
    { name: "scoped global", key: "agent:voice:main", global: true, expected: "global" },
    { name: "explicit other agent", key: "agent:primary:chosen", expected: "agent:primary:chosen" },
  ])(
    "executes and cancels the exact $name target without changing voice identity",
    async (entry) => {
      await rpc("talk.client.close", { sessionKey, voiceSessionId });
      voiceSessionId = undefined;
      const previousConfig = getRuntimeConfig();
      testState.sessionStorePath = undefined;
      agentId = entry.key.startsWith("agent:primary:") ? "primary" : "voice";
      sessionKey = entry.key;
      canonicalKey = entry.expected;
      storePath = resolveSessionStorePathCore(undefined, { agentId });
      await writeSessionStore({
        storePath,
        agentId,
        entries: entry.fresh
          ? {}
          : { [canonicalKey]: { sessionId, updatedAt: Date.now(), status: "done" } },
      });
      await prepareGatewayReplyRuntimeForTest({
        force: true,
        config: {
          ...previousConfig,
          agents: {
            ownership: "explicit",
            entries: { primary: {}, voice: {} },
            defaults: {
              ...previousConfig.agents?.defaults,
            },
          },
          talk: { agentId: "voice" },
          session: entry.global ? { scope: "global" } : {},
        },
      });
      voiceSessionId = createOrResumeClientVoiceSession({ agentId, sessionKey, origin: "client" });
      if (!entry.fresh) {
        await rpc("talk.client.transcript", {
          sessionKey,
          voiceSessionId,
          entryId: "spoken-user",
          role: "user",
          text: spoken,
        });
      }
      const { ack, run, abortSignal } = await startHeldConsult();
      expect(run).toMatchObject({
        agentId,
        sessionKey: canonicalKey,
        ...(!entry.fresh ? { sessionId } : {}),
      });
      if (entry.fresh) {
        sessionId = run.sessionId;
      }
      expect(ack).toMatchObject({ agentId, agentSessionKey: canonicalKey });
      expect(clientVoiceSessionTesting.readRecord(agentId, voiceSessionId)).toMatchObject({
        sessionKey,
        status: "open",
        consultRunIds: [ack.runId],
      });
      expect(
        listSessionEntriesReadOnly({ agentId, storePath }).map((row) => row.sessionKey),
      ).toEqual([canonicalKey]);
      expect(
        await rpc("chat.abort", {
          sessionKey: ack.agentSessionKey,
          agentId: ack.agentId,
          runId: ack.runId,
        }),
      ).toMatchObject({ aborted: true, runIds: [ack.runId] });
      expect(abortSignal.aborted).toBe(true);
      const history = await historyMessages();
      if (entry.fresh) {
        expectNoGeneratedInput(history, "new target history");
      } else {
        expectVisibleSpeechOnly(history, "canonical target history", false);
      }
    },
  );
});

describe("Browser Talk literal consult commands", () => {
  it("does not turn a generated stop question into cancellation of the active consult", async () => {
    const first = await startHeldConsult();
    const ack = await consult("/stop", "literal-stop-during-task");
    expect(ack.runId).not.toBe(first.ack.runId);
    expect
      .soft(first.abortSignal.aborted, "generated input cancelled the existing task")
      .toBe(false);
    releaseModel.resolve();
    await waitForDispatchEnd();
    expect(runEmbeddedAgent.mock.calls.map(([run]) => run.prompt)).toEqual(
      expect.arrayContaining([expect.stringContaining("/stop")]),
    );
  });

  it("preserves an actual human stop command", async () => {
    const first = await startHeldConsult();
    const stopped = await rpc("chat.send", {
      sessionKey,
      message: "/stop",
      idempotencyKey: "human-stop",
    });
    expect(stopped).toMatchObject({ aborted: true, runIds: [first.ack.runId] });
    expect(first.abortSignal.aborted).toBe(true);
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  });
});

describe("Browser Talk consult input custody", () => {
  it.each([
    {
      name: "read-only Talk operator",
      scopes: ["operator.read", "operator.talk"],
      tools: ["read", "web_search", "web_fetch", "x_search", "memory_search", "memory_get"],
    },
  ])(
    "keeps $name consult scaffolding out of chat and later context but in the raw archive",
    async ({ scopes, tools }) => {
      client.connect.scopes = scopes;
      const completeModel = expectDefined(
        runEmbeddedAgent.getMockImplementation(),
        "held model implementation",
      );
      let modelReply = consultAnswer;
      let modelMessages: Parameters<SessionManager["appendMessage"]>[0][] = [
        Object.assign(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: consultCommentary }],
          }),
          {
            openclawStreamFallback: {
              replacementText: consultCommentary,
              source: "segment",
              itemId: "consult-commentary",
            },
          },
        ),
        makeAgentAssistantMessage({
          content: [
            { type: "toolCall", id: "consult-read", name: "read", arguments: { path: "note.txt" } },
          ],
          stopReason: "toolUse",
        }),
        {
          role: "toolResult",
          toolCallId: "consult-read",
          toolName: "read",
          content: [{ type: "text", text: consultToolResult }],
          isError: false,
          timestamp: 0,
        },
        makeAgentAssistantMessage({ content: [{ type: "text", text: modelReply }] }),
      ];
      runEmbeddedAgent.mockImplementation(async (params) => {
        params.onExecutionPhase?.({ phase: "model_call_started" });
        const result = await completeModel(params);
        params.abortSignal?.throwIfAborted();
        const manager = guardSessionManager(SessionManager.open(scope()), {
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          runId: params.runId,
          prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
        });
        for (const message of modelMessages) {
          manager.appendMessage(message);
        }
        return { ...result, payloads: [{ text: modelReply }] };
      });
      const userTranscript = {
        sessionKey,
        voiceSessionId,
        entryId: "spoken-user",
        role: "user",
        text: spoken,
      };
      await rpc("talk.client.transcript", userTranscript);
      await rpc("talk.client.transcript", userTranscript);
      await drainPublications();
      const participantsBeforeConsult =
        listSessionParticipantsReadOnly(scope()).get(sessionKey) ?? [];
      const ack = await rpc("talk.client.toolCall", {
        sessionKey,
        voiceSessionId,
        callId: "native-consult",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args,
      });
      expect(ack.runId).toEqual(expect.any(String));
      expect(ack.idempotencyKey).toBe(ack.runId);
      await Promise.race([
        modelStarted.promise,
        getSessionWorkAdmissionRelease({ scope: storePath, identities: [sessionKey, sessionId] }),
      ]);
      expect(context.logGateway.error).not.toHaveBeenCalled();
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      const run = expectDefined(runEmbeddedAgent.mock.calls[0]?.[0], "consult model invocation");
      expect(run.toolsAllow).toEqual(tools);
      for (const marker of syntheticMarkers) {
        expect(run.prompt).toContain(marker);
      }
      await drainPublications();
      expectVisibleSpeechOnly(liveMessages(), "before model completion", false);
      expectVisibleSpeechOnly(await historyMessages(), "model-held chat.history", false);

      releaseModel.resolve();
      await waitForDispatchEnd();
      // The browser persists the provider's final spoken answer through this same RPC.
      await rpc("talk.client.transcript", {
        sessionKey,
        voiceSessionId,
        entryId: "spoken-assistant",
        role: "assistant",
        text: answer,
      });
      await drainPublications();
      expectVisibleSpeechOnly(liveMessages(), "live session.message", true);
      expectVisibleSpeechOnly(await historyMessages(), "chat.history", true);

      const storedMessages = loadTranscriptEventsSync(scope()).flatMap((event) => {
        const message = asOptionalRecord(asOptionalRecord(event)?.message);
        return message ? [message] : [];
      });
      const generated = storedMessages.filter((message) =>
        extractText(message)?.includes(args.question),
      );
      expect(
        storedMessages.filter((message) => extractText(message) === consultAnswer),
      ).toHaveLength(1);
      expect(
        storedMessages.find((message) => extractText(message) === consultCommentary),
      ).not.toHaveProperty("display", false);
      expect(
        storedMessages.find((message) => extractText(message) === consultToolResult),
      ).toMatchObject({
        role: "toolResult",
        toolCallId: "consult-read",
      });
      expect(
        storedMessages.find((message) => extractText(message) === consultToolResult),
      ).not.toHaveProperty("display", false);
      expect((await historyMessages()).map(extractText)).toContain(consultCommentary);
      expect(generated).toHaveLength(1);
      expect.soft(generated[0]).toMatchObject({
        role: "user",
        display: false,
        excludeFromContext: true,
        provenance: { kind: "internal_system" },
      });
      const metadata = asOptionalRecord(generated[0]?.["__openclaw"]);
      expect.soft(metadata?.senderIdentity).toBeUndefined();
      expect.soft(metadata?.senderIsOwner).not.toBe(true);
      expect
        .soft(listSessionParticipantsReadOnly(scope()).get(sessionKey) ?? [])
        .toEqual(participantsBeforeConsult);

      // Reopen only this fixture's transcript database after dispatch/publication have drained.
      const databasePath = resolveOpenClawAgentSqlitePath(
        toDatabaseOptions(resolveSqliteTranscriptReadScope(scope())),
      );
      expect(await closeOpenClawAgentDatabaseByPathAsync(databasePath)).toBe(true);
      clearSessionStoreCacheForTest();
      expectVisibleSpeechOnly(await historyMessages(), "reopened chat.history", true);
      for (const manager of [
        SessionManager.open(scope()),
        SessionManager.openModelContext(scope()),
      ]) {
        const messages = manager.buildSessionContext().messages;
        expectNoGeneratedInput(messages, "reopened model context");
        expect(messages.map(extractText)).toEqual(
          expect.arrayContaining([
            spoken,
            answer,
            consultCommentary,
            consultToolResult,
            consultAnswer,
          ]),
        );
        expect(messages).toContainEqual(
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "toolCall", id: "consult-read" }),
            ]),
          }),
        );
      }
      expect(loadTranscriptEventsSync(scope())).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: generated[0] })]),
      );

      client.connect.scopes = ["operator.read", "operator.write", "operator.admin"];
      const normalPrompt = "NORMAL_PROMPT_133855: What did you find?";
      modelReply = "NORMAL_REPLY_133855: The saved note contains both labels.";
      modelMessages = [
        makeAgentAssistantMessage({ content: [{ type: "text", text: modelReply }] }),
      ];
      await rpc("chat.send", {
        sessionKey,
        message: normalPrompt,
        idempotencyKey: `normal-after-consult-${sessionId}`,
      });
      await waitForDispatchEnd();
      await drainPublications();
      expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
      for (const messages of [liveMessages(), await historyMessages()]) {
        expect(messages.map(extractText).filter((text) => text === modelReply)).toEqual([
          modelReply,
        ]);
        expect(messages.map(extractText)).toContain(normalPrompt);
        expect(JSON.stringify(messages)).not.toContain(consultAnswer);
      }
    },
  );
});

describe("Direct Talk consult history after call closure", () => {
  it.each(["before-final", "after-final"] as const)(
    "retains the direct answer when the call closes %s without a spoken replacement",
    async (ordering) => {
      const callId = expectDefined(voiceSessionId, "direct voice session");
      const directAnswer = "DIRECT_FINAL_134003: The requested note contains both labels.";
      const finalCommitted = createDeferred();
      const releaseResult = createDeferred();
      const completeModel = expectDefined(
        runEmbeddedAgent.getMockImplementation(),
        "held model implementation",
      );
      runEmbeddedAgent.mockImplementation(async (params) => {
        const recorder = expectDefined(params.userTurnTranscriptRecorder, "direct input recorder");
        await recorder.persistApproved();
        expect(recorder.hasPersisted()).toBe(true);
        const result = await completeModel(params);
        params.abortSignal?.throwIfAborted();
        const manager = guardSessionManager(SessionManager.open(scope()), {
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          runId: params.runId,
          prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
        });
        manager.appendMessage(
          makeAgentAssistantMessage({ content: [{ type: "text", text: directAnswer }] }),
        );
        finalCommitted.resolve();
        await releaseResult.promise;
        return { ...result, payloads: [{ text: directAnswer }] };
      });
      const runner = createTalkClientAgentConsultRunner({
        config: getRuntimeConfig(),
        context,
        sessionTarget: { agentId, sessionKey, canonicalKey, storePath },
        ownerConnId: connectionId,
        getVoiceSessionId: () => callId,
        initialItems: [],
      });
      const providerTask = new AbortController();
      const directRun = runner.runArgs(args, providerTask.signal);
      void directRun.catch(() => undefined);
      try {
        await Promise.race([modelStarted.promise, directRun]);
        const run = expectDefined(runEmbeddedAgent.mock.calls[0]?.[0], "direct core invocation");
        const backingSignal = expectDefined(run.abortSignal, "direct backing signal");
        expect(run).toMatchObject({ agentId, sessionId, sessionKey: canonicalKey });
        expect(backingSignal.aborted).toBe(false);
        if (ordering === "after-final") {
          releaseModel.resolve();
          await Promise.race([finalCommitted.promise, directRun]);
        }
        await rpc("talk.client.close", { sessionKey, voiceSessionId: callId });
        expect(clientVoiceSessionTesting.readRecord(agentId, callId)).toMatchObject({
          status: "closed",
          consultRunIds: [run.runId],
        });
        expect(providerTask.signal.aborted).toBe(false);
        expect(backingSignal.aborted).toBe(false);
        await expect(runner.runArgs(args)).rejects.toThrow("voice session is closed");
        releaseModel.resolve();
        releaseResult.resolve();
        await expect(directRun).resolves.toEqual({ text: directAnswer });
        expect(runEmbeddedAgent).toHaveBeenCalledOnce();
        await drainPublications();
        expectNoGeneratedInput(liveMessages(), "direct live publication");

        const storedMessages = loadTranscriptEventsSync(scope()).flatMap((event) => {
          const message = asOptionalRecord(asOptionalRecord(event)?.message);
          return message ? [message] : [];
        });
        const generated = storedMessages.filter((message) =>
          extractText(message)?.includes(args.question),
        );
        expect(generated).toHaveLength(1);
        expect(generated[0]).toMatchObject({
          role: "user",
          display: false,
          excludeFromContext: true,
        });
        expect(
          storedMessages.filter((message) => message.role === "assistant").map(extractText),
        ).toEqual([directAnswer]);
        const history = await historyMessages();
        const databasePath = resolveOpenClawAgentSqlitePath(
          toDatabaseOptions(resolveSqliteTranscriptReadScope(scope())),
        );
        expect(await closeOpenClawAgentDatabaseByPathAsync(databasePath)).toBe(true);
        clearSessionStoreCacheForTest();
        for (const [view, messages] of [
          ["chat.history", history],
          ["reopened chat.history", await historyMessages()],
        ] as const) {
          expect
            .soft(
              messages.map(extractText).filter((text) => text === directAnswer),
              view,
            )
            .toEqual([directAnswer]);
          expectNoGeneratedInput(messages, `closed direct call ${view}`);
        }
        const modelContext =
          SessionManager.openModelContext(scope()).buildSessionContext().messages;
        expectNoGeneratedInput(modelContext, "closed direct call model context");
        expect(modelContext.map(extractText)).toContain(directAnswer);
      } finally {
        releaseModel.resolve();
        releaseResult.resolve();
        await directRun.catch(() => undefined);
      }
    },
  );
});

// Fixed model action through the real text and both Talk admission paths.
it("dispatches permitted native actions once per logical request across text and Talk", async () => {
  const config = getRuntimeConfig();
  await prepareGatewayReplyRuntimeForTest({
    force: true,
    config: { ...config, tools: { ...config.tools, exec: { host: "gateway", mode: "full" } } },
  });
  await replaceSessionEntry(scope(), {
    sessionId,
    updatedAt: Date.now(),
    permissionMode: "full",
    execHost: "gateway",
  });
  const results: unknown[] = [];
  const prepared: unknown[] = [];
  let marker: string | undefined;
  const resetWriteMarker = () =>
    fs.rm(
      path.join(path.dirname(expectDefined(marker, "native effect file")), "voice-parity-note.txt"),
      { force: true },
    );
  runEmbeddedAgent.mockImplementation(async (params) => {
    const admission = expectDefined(params.preparedRunAdmission, "real ingress admission");
    const admittedRunContext = await admission.admit("plugin-harness", "parity-test-model");
    prepared.push({
      principal: admission.readOperatorAuthority?.()?.profileId,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      cwd: params.cwd,
      permissionMode: params.permissionMode,
      sessionRoot: params.sessionRoot,
      execOverrides: params.execOverrides,
      bashElevated: params.bashElevated,
      senderId: params.senderId,
      senderIsOwner: params.senderIsOwner,
      messageProvider: params.messageProvider,
      messageChannel: params.messageChannel,
      carriesControlAuthority: Object.hasOwn(params, "operatorAuthority"),
      approvalReviewerDeviceId: params.approvalReviewerDeviceId,
    });
    const host = createAgentHarnessHostCapabilities({
      pluginId: "parity-test-model",
      attempt: {
        agentId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        workspaceDir: params.workspaceDir,
        cwd: params.cwd,
        config: params.config,
        admittedRunContext,
      },
    });
    const policy = projectEffectiveExecPolicy({
      base: { host: "gateway", mode: "full" },
      overrides: params.execOverrides,
      permissionPolicy: { mode: params.permissionMode ?? "read-only" },
    });
    marker = path.join(params.workspaceDir, "voice-parity-effects");
    const [tool, writeTool] = host.capabilities.bindToolSurface([
      createExecTool({
        ...policy,
        config: params.config,
        cwd: params.workspaceDir,
        agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        runId: params.runId,
        allowBackground: false,
      }),
      createHostWorkspaceWriteTool(params.workspaceDir),
    ]);
    try {
      const result = await expectDefined(tool, "bound native exec").execute("same-model-action", {
        command: "printf 'effect\n' >> voice-parity-effects",
        workdir: params.workspaceDir,
        yieldMs: 10000,
      });
      const written = await expectDefined(writeTool, "bound filesystem action").execute(
        "same-write-action",
        { path: "voice-parity-note.txt", content: "same permitted note" },
      );
      expect(written.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("Successfully wrote"),
          }),
        ]),
      );
      expect(
        await fs.readFile(path.join(params.workspaceDir, "voice-parity-note.txt"), "utf8"),
      ).toBe("same permitted note");
      results.push(result.details);
      expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
      return { payloads: [{ text: "Done." }], meta: { durationMs: 1 } };
    } finally {
      host.close();
    }
  });
  await rpc("chat.send", {
    sessionKey,
    message: "Carry out the action",
    idempotencyKey: "parity-text",
  });
  await waitForDispatchEnd();
  expect(results).toHaveLength(1);
  const retained = await retainTalkClientRunAuthority({ client, context });
  try {
    const runner = createTalkClientAgentConsultRunner({
      config: getRuntimeConfig(),
      context,
      sessionTarget: { agentId, sessionKey, canonicalKey, storePath },
      ownerConnId: connectionId,
      runAuthority: retained,
      authority: resolveTalkAgentConsultAuthority(client.connect.scopes, client),
      getVoiceSessionId: () => voiceSessionId,
      initialItems: [],
    });
    await resetWriteMarker();
    expect(await runner.runArgs({ question: "Carry out the action" })).toEqual({ text: "Done." });
    expect(results).toHaveLength(2);
    await resetWriteMarker();
    await consult("Carry out the action", "parity-provider-call");
    await waitForDispatchEnd();
    expect(results).toHaveLength(3);
    expect(prepared[0]).toMatchObject({
      principal: expectDefined(client.authenticatedUserProfile, "authenticated caller profile")
        .profileId,
    });
    expect(prepared[1]).toEqual(prepared[0]);
    expect(prepared[2]).toEqual(prepared[0]);
    const replay = vi.fn<RespondFn>();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: randomUUID(),
        method: "talk.client.toolCall",
        params: {
          sessionKey,
          voiceSessionId,
          callId: "parity-provider-call",
          name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
          args: { question: "Carry out the action" },
        },
      },
      context,
      client,
      respond: replay,
      isWebchatConnect: () => true,
    });
    // Completed work cannot be advertised as a new active subscription. Keep
    // that terminal refusal, without treating a retransmit as new work.
    expect(replay.mock.calls[0]).toMatchObject([
      false,
      undefined,
      {
        code: "UNAVAILABLE",
        message: "Realtime agent consult completed before the tool result subscription started.",
      },
    ]);
    await waitForDispatchEnd();
    expect(results).toHaveLength(3);
    await resetWriteMarker();
    await consult("Carry out the action", "parity-provider-fresh-call");
    await waitForDispatchEnd();
    expect(results).toHaveLength(4);
    expect(await fs.readFile(expectDefined(marker, "native effect file"), "utf8")).toBe(
      "effect\neffect\neffect\neffect\n",
    );
  } finally {
    retained.release();
  }
});

it("preserves the original operator source through chat-backed capability adaptation", async () => {
  let originalSource: object | undefined;
  let admittedSource: object | undefined;
  runEmbeddedAgent.mockImplementationOnce(async (params) => {
    admittedSource = params.preparedRunAdmission?.readOperatorAuthority?.()?.source;
    return { payloads: [{ text: "Done." }], meta: { durationMs: 1 } };
  });
  const handler = expectDefined(talkClientHandlers["talk.client.toolCall"], "Talk RPC handler");
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: randomUUID(),
      method: "talk.client.toolCall",
      params: {
        sessionKey,
        voiceSessionId,
        callId: "source-identity-call",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "Check the requested status" },
      },
    },
    context,
    client,
    respond,
    isWebchatConnect: () => true,
    extraHandlers: {
      "talk.client.toolCall": async (options) => {
        const original = await captureGatewayOperatorRunAuthority({
          client: options.client ?? null,
          context: options.context,
          hasCurrentClientAuthority: options.hasCurrentClientAuthority,
        });
        originalSource = original?.authority.source;
        try {
          await handler(options);
        } finally {
          original?.release();
        }
      },
    },
  });
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  await waitForDispatchEnd();
  expect(originalSource).toBeDefined();
  expect(admittedSource).toBe(originalSource);
});

// The isolated native cell uses Linux executables; protocol/policy siblings remain portable.
it.runIf(process.platform === "linux").each([false, true])(
  "keeps host-authenticated node approval cancellation (public callback: %s)",
  async (publicOnly) => {
    const { runTalkNodePermissionParity } =
      await import("./server.talk-permission-parity.test-support.js");
    await runTalkNodePermissionParity({
      publicOnly,
      harness,
      client,
      context,
      agentId,
      sessionKey,
      canonicalKey,
      sessionId,
      storePath,
      voiceSessionId,
      connectionId,
      runEmbeddedAgent,
      rpc,
      waitForDispatchEnd,
    });
  },
);

it.runIf(process.platform === "linux")(
  "isolates registered Talk replay across authenticated callers",
  async () => {
    const { runTalkCallerReplay } = await import("./server.talk-caller-replay.test-support.js");
    await runTalkCallerReplay({
      harness,
      runEmbeddedAgent,
      sessionId,
      sessionKey,
      storePath,
      voiceSessionId: expectDefined(voiceSessionId, "shared voice identity"),
    });
  },
);
