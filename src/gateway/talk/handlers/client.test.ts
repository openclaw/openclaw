import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { enqueueCommandInLane, resetCommandLane } from "../../../process/command-queue.js";
import {
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
import { getActiveSessionWorkAdmissionCount } from "../../../sessions/session-lifecycle-admission.js";
import {
  createOrResumeClientVoiceSession,
  resolveClientVoiceRunBinding,
} from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import type { GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "../../session-sharing-authorization-async.js";
import { closeTalkClientGatewayControlSession } from "../client-gateway-control.js";
import { cleanupTalkConnection } from "../session-registry.js";
import {
  completeTalkVoiceChange,
  requestTalkVoiceChange,
  resolveTalkVoiceSession,
} from "../voice-selection.js";
import { createTalkClient } from "./client-create.js";
import {
  browserSession,
  createDelegatedBrowserProviderFixture,
  type BrowserRequest,
} from "./client-fixtures.test-support.js";
import { readLegacyVoiceBinding } from "./client-legacy-voice-bindings.js";
import { createTalkClientOfferFixture } from "./client-offer.test-support.js";
import { talkClientHandlers } from "./client.js";

const voiceMocks = vi.hoisted(() => ({
  resolveConfiguredRealtimeVoiceProviderAsync: vi.fn(),
  consultRealtimeVoiceAgent: vi.fn(),
  executionReady: vi.fn<() => Promise<void>>(),
  runEmbeddedAgent: vi.fn<typeof import("../../../agents/embedded-agent.js").runEmbeddedAgent>(),
}));

// mock-isolation: Keep provider registration and credential state outside handler tests.
vi.mock("../../../talk/provider-resolver.js", () => ({
  resolveConfiguredRealtimeVoiceProviderAsync:
    voiceMocks.resolveConfiguredRealtimeVoiceProviderAsync,
}));
vi.mock("../../../talk/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/provider-registry.js")>()),
  listRealtimeVoiceProviders: () => [],
}));
vi.mock("../../../talk/agent-consult-runtime.js", () => ({
  consultRealtimeVoiceAgent: voiceMocks.consultRealtimeVoiceAgent,
}));
vi.mock("../../../plugins/runtime/index.js", async () => {
  const { createRuntimeAgent } = await import("../../../plugins/runtime/runtime-agent.js");
  return { createPluginRuntime: () => ({ agent: createRuntimeAgent() }) };
});
vi.mock("../../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: voiceMocks.runEmbeddedAgent,
}));
vi.mock("../../../shared/lazy-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/lazy-runtime.js")>();
  return {
    ...actual,
    createLazyRuntimeModule: <T>(importer: () => Promise<T>) => {
      const load = actual.createLazyRuntimeModule(importer);
      return Object.assign(
        async () => {
          const runtime = await load();
          if (
            runtime &&
            typeof runtime === "object" &&
            "runEmbeddedAgent" in runtime &&
            runtime.runEmbeddedAgent === voiceMocks.runEmbeddedAgent
          ) {
            await voiceMocks.executionReady();
          }
          return runtime;
        },
        { peek: load.peek, clear: load.clear },
      );
    },
  };
});
vi.mock("../../../agents/bootstrap-files.js", () => ({
  resolveBootstrapFilesForRun: async () => [],
}));

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const sessionKey = "agent:main:main";
const sessionId = "voice-transcript-session";
let tempDir: string;
let ownedVoiceSessionId: string | undefined;
let ownedVoiceSessionKey = sessionKey;
const { completeOffer, disposeResources } = createTalkClientOfferFixture();

function configureDelegatedBrowserProvider(
  createBrowserSession: (request: BrowserRequest) => Promise<typeof browserSession>,
  publicOnly = false,
) {
  const fixture = createDelegatedBrowserProviderFixture(createBrowserSession, tempDir);
  // Public plugins have neither native delegation nor the private cancellation hook.
  const provider = publicOnly
    ? {
        ...fixture.provider,
        capabilities: { ...fixture.provider.capabilities, handlesAgentConsult: false },
      }
    : fixture.provider;
  voiceMocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
    provider,
    providerConfig: {},
    capabilities: provider.capabilities,
  });
  return { ...fixture, provider };
}

async function invokeCreate(options: GatewayRequestHandlerOptions) {
  const admission = await resolveSessionMutationAuthorizationAsync({
    method: "talk.client.create",
    requestParams: options.params,
    context: options.context,
    client: options.client,
  });
  if (admission.error) {
    options.respond(false, undefined, admission.error);
    return;
  }
  try {
    await createTalkClient({ ...options, sessionMutationAuthorization: admission.authorization });
  } finally {
    admission.authorization?.release?.();
  }
}

async function invokeTranscript(params: Record<string, unknown>) {
  const respond = vi.fn();
  await talkClientHandlers["talk.client.transcript"]?.({
    params,
    respond,
    context: { getRuntimeConfig: () => ({}) },
  } as never);
  return respond;
}

async function invokeClose(params: Record<string, unknown>) {
  const respond = vi.fn();
  await talkClientHandlers["talk.client.close"]?.({
    params,
    respond,
    context: { getRuntimeConfig: () => ({}) },
    client: { connId: "conn-close" },
  } as never);
  return respond;
}

async function createBrowserConsult(publicOnly = false) {
  const createBrowserSession = vi.fn(async (_request: BrowserRequest) => browserSession);
  const fixture = configureDelegatedBrowserProvider(createBrowserSession, publicOnly);
  const respond = vi.fn();
  await invokeCreate({
    params: { sessionKey, provider: "openai", model: "gpt-live-test" },
    respond,
    context: fixture.context,
    client: fixture.client,
  } as never);
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(browserSession), undefined);
  const createdSession = respond.mock.calls[0]?.[1];
  if (!createdSession) {
    throw new Error("Expected a browser session response");
  }
  ownedVoiceSessionId = createdSession.voiceSessionId;
  const consult = createBrowserSession.mock.calls[0]?.[0].runAgentConsult;
  if (!consult) {
    throw new Error("Expected a Gateway-owned browser consult callback");
  }
  return { ...fixture, consult };
}

async function useRealConsultRuntime() {
  const actual = await vi.importActual<typeof import("../../../talk/agent-consult-runtime.js")>(
    "../../../talk/agent-consult-runtime.js",
  );
  voiceMocks.consultRealtimeVoiceAgent.mockImplementation(actual.consultRealtimeVoiceAgent);
  voiceMocks.runEmbeddedAgent.mockImplementation(async (params) => {
    params.abortSignal?.throwIfAborted();
    return await enqueueCommandInLane("talk-admission-test", async () => ({
      payloads: [{ text: "fixture status" }],
      meta: { durationMs: 0 },
    }));
  });
}

describe("talk.client.transcript", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    voiceMocks.executionReady.mockReset().mockResolvedValue(undefined);
    resetGatewayWorkAdmission();
    ownedVoiceSessionId = undefined;
    ownedVoiceSessionKey = sessionKey;
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-talk-transcript-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    setRuntimeConfigSnapshot({});
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { sessionId, updatedAt: Date.now() },
    );
  });

  afterEach(async () => {
    const remainingRootWork = getActiveGatewayRootWorkCount();
    resetGatewayWorkAdmission();
    disposeResources();
    resetCommandLane("talk-admission-test");
    if (ownedVoiceSessionId) {
      await closeTalkClientGatewayControlSession({
        voiceSessionId: ownedVoiceSessionId,
        sessionKey: ownedVoiceSessionKey,
        connId: "conn-close",
      });
    }
    cleanupTalkConnection("conn-close", { warn: vi.fn() });
    clientVoiceSessionTesting.reset();
    vi.useRealTimers();
    await cleanupSessionStateForTest({ stateDir: tempDir });
    clearRuntimeConfigSnapshot();
    envSnapshot.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
    expect(remainingRootWork).toBe(0);
  });

  it("acknowledges close before creating the voice replacement requested by an active tool consult", async () => {
    const createBrowserSession = vi.fn(async (request: BrowserRequest) => ({
      ...browserSession,
      voice: request.voice ?? "marin",
    }));
    const fixture = configureDelegatedBrowserProvider(createBrowserSession);
    Object.assign(fixture.provider, { voices: ["marin", "cedar"] });
    Object.assign(fixture.provider.capabilities, {
      handlesAgentConsult: false,
      supportsGatewayControl: true,
      supportsToolCalls: true,
    });
    const create = async (voiceChangeId?: string) => {
      const respond = vi.fn();
      await invokeCreate({
        params: {
          sessionKey,
          provider: "openai",
          model: "gpt-realtime-2.1",
          capabilities: ["gateway-control-v1", "voice-selection"],
          voiceChangeId,
        },
        respond,
        context: fixture.context,
        client: fixture.client,
      } as never);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining(browserSession),
        undefined,
      );
      ownedVoiceSessionId = respond.mock.calls[0]?.[1].voiceSessionId as string;
      createBrowserSession.mock.calls.at(-1)?.[0].gatewayControl?.onReady?.();
      return ownedVoiceSessionId;
    };
    const originalId = await create();
    const control = createBrowserSession.mock.calls[0]?.[0].gatewayControl;
    if (!control) {
      throw new Error("Expected Gateway-owned function-tool control");
    }
    const submitToolResult = vi.fn(async () => {});
    control.bindControl?.({ submitToolResult });
    const requested = createDeferred<string>();
    const applied = createDeferred();
    const finishWork = createDeferred();
    voiceMocks.consultRealtimeVoiceAgent.mockImplementationOnce(async () => {
      await requestTalkVoiceChange({
        session: resolveTalkVoiceSession({
          kind: "client",
          connId: fixture.client.connId,
          voiceSessionId: originalId,
        }),
        voice: "cedar",
        requesterConnId: fixture.client.connId,
        assertCurrent: () => {},
        send: (event) => requested.resolve(event.changeId),
      });
      applied.resolve();
      await finishWork.promise;
      return { text: "Voice changed and accepted work finished" };
    });
    control.onToolCall?.({
      itemId: "item-change-own-voice",
      callId: "call-change-own-voice",
      name: "openclaw_agent_consult",
      args: { question: "Change your voice and keep working" },
    });
    const changeId = await requested.promise;
    let closeAcknowledged = false;
    const closing = invokeClose({ sessionKey, voiceSessionId: originalId }).then((respond) => {
      closeAcknowledged = true;
      return respond;
    });
    try {
      await vi.waitFor(() => expect(closeAcknowledged).toBe(true));
      expect(await closing).toHaveBeenCalledWith(true, { ok: true }, undefined);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      const accepted = voiceMocks.consultRealtimeVoiceAgent.mock.calls[0]?.[0] as {
        abortSignal: AbortSignal;
      };
      expect(accepted.abortSignal.aborted).toBe(false);
      expect(() => control.bindControl?.({ submitToolResult })).toThrow("closed");
      const replacementId = await create(changeId);
      await completeTalkVoiceChange({
        changeId,
        connId: fixture.client.connId,
        voiceSessionId: replacementId,
        outcome: "ready",
      });
      await applied.promise;
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(createBrowserSession.mock.calls.at(-1)?.[0].voice).toBe("cedar");
      finishWork.resolve();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(submitToolResult).not.toHaveBeenCalled();
    } finally {
      await completeTalkVoiceChange({
        changeId,
        connId: fixture.client.connId,
        outcome: "failed",
        error: "Test cleanup",
      }).catch(() => {});
      finishWork.resolve();
      await closing;
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    }
  });

  it("admits a later sideband consult after its HTTP offer has released admission", async () => {
    await useRealConsultRuntime();
    const { consult } = await createBrowserConsult();
    const resource = await completeOffer();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
    const enqueue = voiceMocks.runEmbeddedAgent.getMockImplementation()!;
    voiceMocks.runEmbeddedAgent.mockImplementationOnce(async (params) => {
      expect(resolveClientVoiceRunBinding(params.runId)).toMatchObject({
        agentId: "main",
        sessionKey,
        voiceSessionId: ownedVoiceSessionId,
      });
      return await enqueue(params);
    });

    await expect(
      resource.runInAsyncScope(() => consult({ prompt: "Return the fixture status" })),
    ).resolves.toEqual({ text: "fixture status" });
    const [run] = voiceMocks.runEmbeddedAgent.mock.calls[0]!;
    expect(resolveClientVoiceRunBinding(run.runId)).toBeUndefined();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(getActiveSessionWorkAdmissionCount()).toBe(0);
  });

  it("keeps an accepted consult admitted through offer completion and suspension", async ({
    signal,
  }) => {
    await useRealConsultRuntime();
    const { consult } = await createBrowserConsult();
    const embeddedEntered = createDeferred();
    const beforeEnqueue = createDeferred();
    const enqueue = voiceMocks.runEmbeddedAgent.getMockImplementation()!;
    voiceMocks.runEmbeddedAgent.mockImplementationOnce(async (params) => {
      expect(getActiveSessionWorkAdmissionCount()).toBe(1);
      embeddedEntered.resolve();
      await beforeEnqueue.promise;
      return await enqueue(params);
    });
    let work: Promise<{ text: string }> | undefined;
    let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission> = null;
    try {
      await completeOffer(async (resource) => {
        work = resource.runInAsyncScope(() =>
          consult({ prompt: "Return the fixture status", signal }),
        );
        await withinTest(
          awaitGateBeforeSettlement(
            embeddedEntered.promise,
            work,
            "Talk consult settled before entering the embedded run",
          ),
          signal,
        );
        expect(voiceMocks.runEmbeddedAgent).toHaveBeenCalledOnce();
      });
      expect(getActiveSessionWorkAdmissionCount()).toBe(1);
      suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension).not.toBeNull();
      beforeEnqueue.resolve();
      await expect(work).resolves.toEqual({ text: "fixture status" });
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
    } finally {
      beforeEnqueue.resolve();
      await work?.catch(() => undefined);
      suspension?.rollback();
    }
  });

  it.each(["suspend"] as const)("does not admit a new sideband consult during %s", async () => {
    await useRealConsultRuntime();
    const { consult } = await createBrowserConsult();
    const resource = await completeOffer();
    expect(tryBeginGatewaySuspendAdmission(() => {})).not.toBeNull();
    await expect(
      resource.runInAsyncScope(() => consult({ prompt: "Must not start" })),
    ).rejects.toThrow(GatewayDrainingError);
    expect(voiceMocks.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(getActiveSessionWorkAdmissionCount()).toBe(0);
  });

  it("appends finalized messages once by event id", async () => {
    const voiceSessionId = await createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });
    const params = {
      sessionKey,
      voiceSessionId,
      entryId: "1",
      role: "user",
      text: "hello from voice",
      timestamp: 123,
    };

    expect(await invokeTranscript(params)).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(await invokeTranscript(params)).toHaveBeenCalledWith(true, { ok: true }, undefined);
    const events = readSessionTranscriptMessageEvents({ agentId: "main", sessionId });
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({
      id: `voice:${voiceSessionId}:1`,
      message: {
        role: "user",
        content: [{ type: "text", text: "hello from voice" }],
        timestamp: 123,
        provenance: { kind: "realtime_voice", sourceChannel: "talk" },
      },
    });
  });

  it("accepts an idempotent close retry after the first response is lost", async () => {
    const voiceSessionId = await createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });
    const params = { sessionKey, voiceSessionId };

    expect(await invokeClose(params)).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(await invokeClose(params)).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it.each([
    { publicOnly: false, ending: "disconnect" },
    { publicOnly: true, ending: "close" },
  ])(
    "keeps accepted work while runtime loading spans $ending (public: $publicOnly)",
    async ({ ending, publicOnly }) => {
      await useRealConsultRuntime();
      const loading = createDeferred();
      const resume = createDeferred();
      voiceMocks.executionReady.mockImplementationOnce(async () => {
        loading.resolve();
        await resume.promise;
      });
      const { consult, clients, client, context, cancelBrowserSession } =
        await createBrowserConsult(publicOnly);
      const accepted = consult({ prompt: "Read the project status" });
      const settled = accepted.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        await awaitGateBeforeSettlement(
          loading.promise,
          accepted,
          "Consult settled before loading",
        );
        expect(context.chatAbortControllers.size).toBe(1);
        expect(voiceMocks.runEmbeddedAgent).not.toHaveBeenCalled();
        if (ending === "close") {
          expect(
            await invokeClose({ sessionKey, voiceSessionId: ownedVoiceSessionId }),
          ).toHaveBeenCalledWith(true, { ok: true }, undefined);
        } else {
          clients.delete(client);
          cleanupTalkConnection(client.connId, context.logGateway);
        }
        await expect(consult({ prompt: "Start another task" })).rejects.toThrow(/closed|stopped/i);
      } finally {
        resume.resolve();
      }
      expect(await settled).toEqual({ result: { text: "fixture status" } });
      expect(voiceMocks.runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(context.chatAbortControllers.size).toBe(0);
      expect(cancelBrowserSession).toHaveBeenCalledTimes(publicOnly ? 0 : 1);
      await closeTalkClientGatewayControlSession({
        voiceSessionId: ownedVoiceSessionId!,
        sessionKey,
        connId: client.connId,
      });
      expect(readLegacyVoiceBinding(client.connId, sessionKey)).toBeUndefined();
    },
  );

  it.each(["provider"] as const)(
    "retires browser voice metadata on %s close while accepted function-tool work drains",
    async () => {
      const createBrowserSession = vi.fn(async (_request: BrowserRequest) => browserSession);
      const fixture = configureDelegatedBrowserProvider(createBrowserSession);
      Object.assign(fixture.provider, { voices: ["marin", "cedar"] });
      Object.assign(fixture.provider.capabilities, {
        handlesAgentConsult: false,
        supportsGatewayControl: true,
        supportsToolCalls: true,
      });
      const finish = createDeferred<{ text: string }>();
      voiceMocks.consultRealtimeVoiceAgent.mockReturnValueOnce(finish.promise);
      const respond = vi.fn();
      await invokeCreate({
        params: {
          sessionKey,
          provider: "openai",
          model: "gpt-realtime-2.1",
          capabilities: ["gateway-control-v1", "voice-selection"],
        },
        respond,
        context: fixture.context,
        client: fixture.client,
      } as never);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining(browserSession),
        undefined,
      );
      const voiceSessionId = respond.mock.calls[0]?.[1].voiceSessionId as string;
      ownedVoiceSessionId = voiceSessionId;
      const control = createBrowserSession.mock.calls[0]?.[0].gatewayControl;
      if (!control) {
        throw new Error("Expected Gateway-owned function-tool control");
      }
      control.onReady?.();
      let changing: ReturnType<typeof requestTalkVoiceChange> | undefined;
      try {
        control.onToolCall?.({
          itemId: "item-selection",
          callId: "call-selection",
          name: "openclaw_agent_consult",
          args: { question: "Change voice and keep working" },
        });
        await vi.waitFor(() => expect(voiceMocks.consultRealtimeVoiceAgent).toHaveBeenCalledOnce());
        changing = requestTalkVoiceChange({
          session: resolveTalkVoiceSession({
            kind: "client",
            connId: fixture.client.connId,
            voiceSessionId,
          }),
          voice: "cedar",
          requesterConnId: fixture.client.connId,
          assertCurrent: () => {},
          send: vi.fn(),
        });
        void changing.catch(() => {});
        control.onClose?.("completed");
        await nextEventLoopTurn();
        expect(() => control.bindControl?.({ sendUserMessage: vi.fn() })).toThrow("closed");
        expect(() =>
          resolveTalkVoiceSession({
            kind: "client",
            connId: fixture.client.connId,
            voiceSessionId,
          }),
        ).toThrow("No active voice call");
        const accepted = voiceMocks.consultRealtimeVoiceAgent.mock.calls[0]?.[0] as {
          abortSignal: AbortSignal;
        };
        expect(accepted.abortSignal.aborted).toBe(false);
      } finally {
        finish.resolve({ text: "Accepted work finished" });
        await closeTalkClientGatewayControlSession({
          voiceSessionId,
          sessionKey,
          connId: fixture.client.connId,
        });
        await vi.waitFor(() =>
          expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe(
            "closed",
          ),
        );
        cleanupTalkConnection(fixture.client.connId, fixture.context.logGateway);
        await changing?.catch(() => {});
      }
    },
  );

  it.each([false])(
    "keeps the active selection when a pending same-id browser candidate fails (public: %s)",
    async (publicOnly) => {
      const createBrowserSession = vi
        .fn(async (_request: BrowserRequest) => browserSession)
        .mockResolvedValueOnce(browserSession)
        .mockRejectedValueOnce(new Error("Candidate rejected"));
      const fixture = configureDelegatedBrowserProvider(createBrowserSession, publicOnly);
      const respond = vi.fn();
      const create = (voiceSessionId?: string) =>
        invokeCreate({
          params: { sessionKey, provider: "openai", voiceSessionId },
          respond,
          context: fixture.context,
          client: fixture.client,
        } as never);
      await create();
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining(browserSession),
        undefined,
      );
      const voiceSessionId = respond.mock.calls[0]?.[1].voiceSessionId as string;
      ownedVoiceSessionId = voiceSessionId;
      const original = resolveTalkVoiceSession({
        kind: "client",
        connId: fixture.client.connId,
        voiceSessionId,
      });
      const control = createBrowserSession.mock.calls[0]?.[0].gatewayControl;
      expect(Boolean(control)).toBe(!publicOnly);
      await create(voiceSessionId);
      expect(respond).toHaveBeenLastCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("Candidate rejected") }),
      );
      expect(
        resolveTalkVoiceSession({ kind: "client", connId: fixture.client.connId, voiceSessionId }),
      ).toBe(original);
      expect(() => control?.bindControl?.({ sendUserMessage: vi.fn() })).not.toThrow();
    },
  );

  it.each([true])(
    "cancels a provider that resolves after its browser disconnects without creating a chat (public: %s)",
    async (publicOnly) => {
      let finishCreation!: (value: typeof browserSession) => void;
      const created = new Promise<typeof browserSession>((resolve) => {
        finishCreation = resolve;
      });
      const createBrowserSession = vi.fn(async (_request: BrowserRequest) => await created);
      const { cancelBrowserSession, client, clients, context } = configureDelegatedBrowserProvider(
        createBrowserSession,
        publicOnly,
      );
      const pendingSessionKey = "agent:main:pending-voice";
      const respond = vi.fn();
      const starting = invokeCreate({
        params: { sessionKey: pendingSessionKey, provider: "openai", model: "gpt-live-test" },
        respond,
        context,
        client,
      } as never);
      await vi.waitFor(() => expect(createBrowserSession).toHaveBeenCalledOnce());
      const runAgentConsult = createBrowserSession.mock.calls[0]?.[0].runAgentConsult;
      try {
        await expect(runAgentConsult!({ prompt: "Too early" })).rejects.toThrow(/not active/);
        clients.delete(client);
        cleanupTalkConnection(client.connId, context.logGateway);
      } finally {
        finishCreation(browserSession);
        await starting;
      }
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringMatching(/closed|disconnected/) }),
      );
      expect(cancelBrowserSession).toHaveBeenCalledTimes(publicOnly ? 0 : 1);
      expect(loadSessionEntry({ agentId: "main", sessionKey: pendingSessionKey })).toBeUndefined();
      expect(voiceMocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
    },
  );

  it.each([false])(
    "does not create a provider after the browser disconnects during context preparation (public: %s)",
    async (publicOnly) => {
      const createBrowserSession = vi.fn(async (_request: BrowserRequest) => browserSession);
      const { client, clients, context } = configureDelegatedBrowserProvider(
        createBrowserSession,
        publicOnly,
      );
      const respond = vi.fn();
      const starting = invokeCreate({
        params: { sessionKey, provider: "openai", model: "gpt-live-test" },
        respond,
        context,
        client,
      } as never);
      clients.delete(client);
      cleanupTalkConnection(client.connId, context.logGateway);
      await starting;
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("disconnected") }),
      );
      expect(createBrowserSession).not.toHaveBeenCalled();
    },
  );

  it("closes the committed voice session when its browser disconnects before startup resumes", async () => {
    const { cancelBrowserSession, client, clients, context } = configureDelegatedBrowserProvider(
      async () => browserSession,
    );
    const voiceSessionId = "voice-disconnected-after-commit";
    ownedVoiceSessionId = voiceSessionId;
    const createVoiceSession = createOrResumeClientVoiceSession;
    const creation = vi
      .spyOn(
        await import("../../../talk/client-voice-session.js"),
        "createOrResumeClientVoiceSession",
      )
      .mockImplementationOnce(async (...args) => {
        const committed = await createVoiceSession(...args);
        clients.delete(client);
        return committed;
      });
    const respond = vi.fn();
    try {
      await invokeCreate({
        params: { sessionKey, provider: "openai", voiceSessionId },
        respond,
        context,
        client,
      } as never);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("disconnected") }),
      );
      expect(cancelBrowserSession).toHaveBeenCalledOnce();
      expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("closed");
    } finally {
      creation.mockRestore();
    }
  });

  it("rejects relay voice records", async () => {
    const voiceSessionId = await createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "relay",
      voiceSessionId: "voice-relay",
    });

    const respond = await invokeTranscript({
      sessionKey,
      voiceSessionId,
      entryId: "1",
      role: "user",
      text: "hello",
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("does not allow this transcript source"),
      }),
    );
  });
});
