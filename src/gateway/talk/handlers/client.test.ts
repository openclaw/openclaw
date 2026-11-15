import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import { createEnteredGate } from "../../../agents/entered-gate.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { enqueueCommandInLane } from "../../../process/command-queue.js";
import {
  GatewayDrainingError,
  beginGatewayRestartSignalAdmission,
  markGatewayRestartDraining,
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
import {
  getCurrentSessionControllerClaim,
  getSessionControllerWorkCount,
} from "../../../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../../../sessions/session-lifecycle-admission.test-support.js";
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
  readTalkVoiceSelection,
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
const { completeOffer, disposeResources } = createTalkClientOfferFixture();

function browserFixture(publicOnly = false, dynamicVoice = false) {
  const createBrowserSession = vi.fn(async (request: BrowserRequest) => ({
    ...browserSession,
    ...(dynamicVoice ? { voice: request.voice ?? "marin", model: request.model } : {}),
  }));
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
  const respond = vi.fn();
  return {
    ...fixture,
    provider,
    createBrowserSession,
    respond,
    create: (params: Record<string, unknown> = {}) =>
      invokeCreate({
        params: { sessionKey, provider: "openai", ...params },
        respond,
        context: fixture.context,
        client: fixture.client,
      } as never),
  };
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

async function invokeClient(method: "transcript" | "close", params: Record<string, unknown>) {
  const respond = vi.fn();
  await talkClientHandlers[`talk.client.${method}`]?.({
    params,
    respond,
    context: { getRuntimeConfig: () => ({}) },
    ...(method === "close" ? { client: { connId: "conn-close" } } : {}),
  } as never);
  return respond;
}

async function createBrowserConsult(publicOnly = false) {
  const actual = await vi.importActual<typeof import("../../../talk/agent-consult-runtime.js")>(
    "../../../talk/agent-consult-runtime.js",
  );
  voiceMocks.consultRealtimeVoiceAgent.mockImplementation(actual.consultRealtimeVoiceAgent);
  voiceMocks.runEmbeddedAgent.mockImplementation(async (params) => {
    params.abortSignal?.throwIfAborted();
    return await enqueueCommandInLane(
      "talk-admission-test",
      async () => ({
        payloads: [{ text: "fixture status" }],
        meta: { durationMs: 0 },
      }),
      { abortSignal: params.abortSignal },
    );
  });
  const fixture = browserFixture(publicOnly);
  await fixture.create({ model: "gpt-live-test" });
  expectBrowserResponse(fixture.respond);
  ownedVoiceSessionId = fixture.respond.mock.calls[0]?.[1].voiceSessionId as string;
  const consult = expectDefined(
    fixture.createBrowserSession.mock.calls[0]?.[0].runAgentConsult,
    "Expected a Gateway-owned browser consult callback",
  );
  return { ...fixture, consult };
}

function expectErrorResponse(respond: ReturnType<typeof vi.fn>, message: unknown) {
  expect(respond).toHaveBeenLastCalledWith(false, undefined, expect.objectContaining({ message }));
}

function expectBrowserResponse(
  respond: ReturnType<typeof vi.fn>,
  extra: Record<string, unknown> = {},
) {
  expect(respond).toHaveBeenLastCalledWith(
    true,
    expect.objectContaining({ ...browserSession, ...extra }),
    undefined,
  );
}

function expectOk(respond: ReturnType<typeof vi.fn>) {
  expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
}

function requestVoice(
  fixture: ReturnType<typeof toolBrowser>,
  send: Parameters<typeof requestTalkVoiceChange>[0]["send"] = vi.fn(),
) {
  return requestTalkVoiceChange({
    session: resolveVoice(fixture.client.connId),
    voice: "cedar",
    requesterConnId: fixture.client.connId,
    assertCurrent: () => {},
    send,
  });
}

function callTool(control: ReturnType<ReturnType<typeof toolBrowser>["control"]>) {
  control.onToolCall?.({
    itemId: "item-selection",
    callId: "call-selection",
    name: "openclaw_agent_consult",
    args: { question: "Change voice and keep working" },
  });
}

function resolveVoice(connId: string, voiceSessionId = ownedVoiceSessionId!) {
  return resolveTalkVoiceSession({ kind: "client", connId, voiceSessionId });
}

function closeVoice(connId: string, voiceSessionId = ownedVoiceSessionId!) {
  return closeTalkClientGatewayControlSession({ voiceSessionId, sessionKey, connId });
}

function disconnect(fixture: ReturnType<typeof browserFixture>) {
  fixture.clients.delete(fixture.client);
  cleanupTalkConnection(fixture.client.connId, fixture.context.logGateway);
}

function createVoice(origin: "client" | "relay" = "client") {
  return createOrResumeClientVoiceSession({ agentId: "main", sessionKey, origin });
}

function toolBrowser(dynamicVoice = false) {
  const fixture = browserFixture(false, dynamicVoice);
  const { createBrowserSession, respond } = fixture;
  Object.assign(fixture.provider, { voices: ["marin", "cedar"] });
  Object.assign(fixture.provider.capabilities, {
    handlesAgentConsult: false,
    supportsGatewayControl: true,
    supportsToolCalls: true,
  });
  const attempt = (voiceChangeId?: string, overrides: Record<string, unknown> = {}) =>
    fixture.create({
      model: "gpt-realtime-2.1",
      capabilities: ["gateway-control-v1", "voice-selection"],
      voiceChangeId,
      ...overrides,
    });
  const create = async (
    voiceChangeId?: string,
    overrides: Record<string, unknown> = {},
    ready = true,
  ) => {
    respond.mockClear();
    await attempt(voiceChangeId, overrides);
    expectBrowserResponse(respond);
    ownedVoiceSessionId = respond.mock.calls[0]?.[1].voiceSessionId as string;
    if (ready) {
      control(createBrowserSession.mock.calls.length - 1).onReady?.();
    }
    return ownedVoiceSessionId;
  };
  const control = (index = 0) =>
    expectDefined(
      createBrowserSession.mock.calls[index]?.[0].gatewayControl,
      "Expected Gateway-owned function-tool control",
    );
  return { ...fixture, createBrowserSession, create, attempt, control };
}

beforeEach(async () => {
  vi.clearAllMocks();
  voiceMocks.executionReady.mockReset().mockResolvedValue(undefined);
  resetGatewayWorkAdmission();
  ownedVoiceSessionId = undefined;
  tempDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-talk-transcript-")),
  );
  setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  setRuntimeConfigSnapshot({});
  await replaceSessionEntry({ agentId: "main", sessionKey }, { sessionId, updatedAt: Date.now() });
});

afterEach(async () => {
  const remainingRootWork = getActiveGatewayRootWorkCount();
  resetGatewayWorkAdmission();
  disposeResources();
  if (ownedVoiceSessionId) {
    await closeVoice("conn-close");
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
  const fixture = toolBrowser(true);
  const { create, createBrowserSession } = fixture;
  const originalId = await create();
  expectBrowserResponse(fixture.respond, { model: "gpt-realtime-2.1", voice: "marin" });
  expect(readTalkVoiceSelection(resolveVoice(fixture.client.connId))).toMatchObject({
    sessionKey,
    voice: "marin",
    voices: ["marin", "cedar"],
    canChange: true,
  });
  const control = fixture.control();
  const submitToolResult = vi.fn(async () => {});
  control.bindControl?.({ submitToolResult });
  const requested = createDeferred<string>();
  const applied = createDeferred<Awaited<ReturnType<typeof requestVoice>>>();
  let selectionApplied = false;
  const finishWork = createDeferred();
  voiceMocks.consultRealtimeVoiceAgent.mockImplementationOnce(async () => {
    applied.resolve(await requestVoice(fixture, (event) => requested.resolve(event.changeId)));
    selectionApplied = true;
    await finishWork.promise;
    return { text: "Voice changed and accepted work finished" };
  });
  callTool(control);
  const changeId = await requested.promise;
  await fixture.attempt(changeId, { voiceSessionId: originalId });
  expectErrorResponse(fixture.respond, "A voice replacement requires a fresh voice session id");
  expect(createBrowserSession).toHaveBeenCalledOnce();
  let closeAcknowledged = false;
  const closing = invokeClient("close", { sessionKey, voiceSessionId: originalId }).then(
    (respond) => {
      closeAcknowledged = true;
      return respond;
    },
  );
  try {
    await vi.waitFor(() => expect(closeAcknowledged).toBe(true));
    expectOk(await closing);
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(voiceMocks.consultRealtimeVoiceAgent.mock.calls[0]?.[0]).toMatchObject({
      abortSignal: { aborted: false },
    });
    expect(() => control.bindControl?.({ submitToolResult })).toThrow("closed");
    const replacementId = await create(
      changeId,
      { model: "different-model", voice: "marin" },
      false,
    );
    expect(replacementId).not.toBe(originalId);
    expectBrowserResponse(fixture.respond, { model: "gpt-realtime-2.1", voice: "cedar" });
    expect(createBrowserSession.mock.lastCall?.[0]).toMatchObject({
      model: "gpt-realtime-2.1",
      voice: "cedar",
    });
    const completed = completeTalkVoiceChange({
      changeId,
      connId: fixture.client.connId,
      voiceSessionId: replacementId,
      outcome: "ready",
    });
    void completed.catch(() => {});
    await Promise.resolve();
    expect(selectionApplied).toBe(false);
    fixture.control(1).onReady?.();
    await completed;
    await expect(applied.promise).resolves.toMatchObject({
      status: "applied",
      voiceSessionId: replacementId,
      sessionKey,
      voice: "cedar",
    });
    expect(
      [originalId, replacementId].map(
        (id) => clientVoiceSessionTesting.readRecord("main", id)?.status,
      ),
    ).toEqual(["closed", "open"]);
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

it("releases accepted work when agent runtime loading fails", async () => {
  const { consult } = await createBrowserConsult();
  const resource = await completeOffer();
  voiceMocks.executionReady.mockRejectedValueOnce(new Error("Synthetic runtime load failure"));

  await expect(
    resource.runInAsyncScope(() => consult({ prompt: "Return the fixture status" })),
  ).rejects.toThrow("Synthetic runtime load failure");

  expect(voiceMocks.runEmbeddedAgent).not.toHaveBeenCalled();
  expect(rpcSourceTesting.size).toBe(0);
  expect(getSessionControllerWorkCount()).toBe(0);
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it("keeps an accepted consult admitted through offer completion and suspension", async ({
  signal,
}) => {
  const { consult } = await createBrowserConsult();
  const gate = createEnteredGate();
  const enqueue = voiceMocks.runEmbeddedAgent.getMockImplementation()!;
  voiceMocks.runEmbeddedAgent.mockImplementationOnce(async (params) => {
    expect(getSessionControllerWorkCount()).toBe(1);
    expect(resolveClientVoiceRunBinding(params.runId)).toMatchObject({
      agentId: "main",
      sessionKey,
      voiceSessionId: ownedVoiceSessionId,
    });
    await gate.wait();
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
          gate.entered,
          work,
          "Talk consult settled before entering the embedded run",
        ),
        signal,
      );
      expect(voiceMocks.runEmbeddedAgent).toHaveBeenCalledOnce();
    });
    expect(getSessionControllerWorkCount()).toBe(1);
    suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    gate.release();
    await expect(work).resolves.toEqual({ text: "fixture status" });
    expect(getSessionControllerWorkCount()).toBe(0);
    const [run] = voiceMocks.runEmbeddedAgent.mock.calls[0]!;
    expect(resolveClientVoiceRunBinding(run.runId)).toBeUndefined();
  } finally {
    gate.release();
    await work?.catch(() => undefined);
    suspension?.rollback();
  }
});

it.each(["suspend", "restart-signal", "restart-drain"] as const)(
  "does not admit a new sideband consult during %s",
  async (fence) => {
    const { consult } = await createBrowserConsult();
    const resource = await completeOffer();
    if (fence === "suspend") {
      expect(tryBeginGatewaySuspendAdmission(() => {})).not.toBeNull();
    } else if (fence === "restart-signal") {
      expect(beginGatewayRestartSignalAdmission()).not.toBeNull();
    } else {
      markGatewayRestartDraining();
    }
    await expect(
      resource.runInAsyncScope(() => consult({ prompt: "Must not start" })),
    ).rejects.toThrow(GatewayDrainingError);
    expect(voiceMocks.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(getSessionControllerWorkCount()).toBe(0);
  },
);

it("appends finalized messages once by event id", async () => {
  const voiceSessionId = await createVoice();
  const params = {
    sessionKey,
    voiceSessionId,
    entryId: "1",
    role: "user",
    text: "hello from voice",
    timestamp: 123,
  };

  expectOk(await invokeClient("transcript", params));
  expectOk(await invokeClient("transcript", params));
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
  const voiceSessionId = await createVoice();
  const params = { sessionKey, voiceSessionId };

  expectOk(await invokeClient("close", params));
  expectOk(await invokeClient("close", params));
});

it.each([
  { publicOnly: false, ending: "disconnect" },
  { publicOnly: true, ending: "close" },
])(
  "keeps accepted work while runtime loading spans $ending (public: $publicOnly)",
  async ({ ending, publicOnly }) => {
    const gate = createEnteredGate();
    voiceMocks.executionReady.mockImplementationOnce(gate.wait);
    const { consult, clients, client, context, cancelBrowserSession } =
      await createBrowserConsult(publicOnly);
    const execute = voiceMocks.runEmbeddedAgent.getMockImplementation()!;
    let claimedInput: unknown;
    let registeredInput: unknown;
    voiceMocks.runEmbeddedAgent.mockImplementationOnce(async (params) => {
      claimedInput = getCurrentSessionControllerClaim()?.inputs[0];
      return await execute(params);
    });
    const accepted = consult({ prompt: "Read the project status" });
    const settled = accepted.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      await awaitGateBeforeSettlement(gate.entered, accepted, "Consult settled before loading");
      expect(rpcSourceTesting.size).toBe(1);
      registeredInput = [...rpcSourceTesting.values()][0]?.input;
      expect(registeredInput).toBeDefined();
      expect(voiceMocks.runEmbeddedAgent).not.toHaveBeenCalled();
      if (ending === "close") {
        expectOk(await invokeClient("close", { sessionKey, voiceSessionId: ownedVoiceSessionId }));
      } else {
        clients.delete(client);
        cleanupTalkConnection(client.connId, context.logGateway);
      }
      await expect(consult({ prompt: "Start another task" })).rejects.toThrow(/closed|stopped/i);
    } finally {
      gate.release();
    }
    expect(await settled).toEqual({ result: { text: "fixture status" } });
    expect(claimedInput).toBe(registeredInput);
    expect(voiceMocks.runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(rpcSourceTesting.size).toBe(0);
    expect(cancelBrowserSession).toHaveBeenCalledTimes(publicOnly ? 0 : 1);
    await closeVoice(client.connId);
    expect(readLegacyVoiceBinding(client.connId, sessionKey)).toBeUndefined();
  },
);

it("retires browser voice metadata on provider close while accepted function-tool work drains", async () => {
  const fixture = toolBrowser();
  const finish = createDeferred<{ text: string }>();
  voiceMocks.consultRealtimeVoiceAgent.mockReturnValueOnce(finish.promise);
  const voiceSessionId = await fixture.create();
  const control = fixture.control();
  let changing: ReturnType<typeof requestTalkVoiceChange> | undefined;
  try {
    callTool(control);
    await vi.waitFor(() => expect(voiceMocks.consultRealtimeVoiceAgent).toHaveBeenCalledOnce());
    changing = requestVoice(fixture);
    void changing.catch(() => {});
    control.onClose?.("completed");
    await nextEventLoopTurn();
    expect(() => control.bindControl?.({ sendUserMessage: vi.fn() })).toThrow("closed");
    expect(() => resolveVoice(fixture.client.connId, voiceSessionId)).toThrow(
      "No active voice call",
    );
    expect(voiceMocks.consultRealtimeVoiceAgent.mock.calls[0]?.[0]).toMatchObject({
      abortSignal: { aborted: false },
    });
  } finally {
    finish.resolve({ text: "Accepted work finished" });
    await closeVoice(fixture.client.connId, voiceSessionId);
    await vi.waitFor(() =>
      expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("closed"),
    );
    cleanupTalkConnection(fixture.client.connId, fixture.context.logGateway);
    await changing?.catch(() => {});
  }
});

it("keeps the active selection when a pending same-id browser candidate fails", async () => {
  const { createBrowserSession, respond, create, client } = browserFixture();
  createBrowserSession
    .mockResolvedValueOnce(browserSession)
    .mockRejectedValueOnce(new Error("Candidate rejected"));
  await create();
  expectBrowserResponse(respond);
  const voiceSessionId = respond.mock.calls[0]?.[1].voiceSessionId as string;
  ownedVoiceSessionId = voiceSessionId;
  const original = resolveVoice(client.connId, voiceSessionId);
  const control = createBrowserSession.mock.calls[0]?.[0].gatewayControl;
  expect(Boolean(control)).toBe(true);
  await create({ voiceSessionId });
  expectErrorResponse(respond, expect.stringContaining("Candidate rejected"));
  expect(resolveVoice(client.connId, voiceSessionId)).toBe(original);
  expect(() => control?.bindControl?.({ sendUserMessage: vi.fn() })).not.toThrow();
});

it("cancels a public provider that resolves after its browser disconnects without creating a chat", async () => {
  const created = createDeferred<typeof browserSession>();
  const fixture = browserFixture(true);
  const { cancelBrowserSession, createBrowserSession, respond, create } = fixture;
  createBrowserSession.mockReturnValueOnce(created.promise);
  const pendingSessionKey = "agent:main:pending-voice";
  const starting = create({ sessionKey: pendingSessionKey, model: "gpt-live-test" });
  await vi.waitFor(() => expect(createBrowserSession).toHaveBeenCalledOnce());
  const runAgentConsult = createBrowserSession.mock.calls[0]?.[0].runAgentConsult;
  try {
    await expect(runAgentConsult!({ prompt: "Too early" })).rejects.toThrow(/not active/);
    disconnect(fixture);
  } finally {
    created.resolve(browserSession);
    await starting;
  }
  expectErrorResponse(respond, expect.stringMatching(/closed|disconnected/));
  expect(cancelBrowserSession).not.toHaveBeenCalled();
  expect(loadSessionEntry({ agentId: "main", sessionKey: pendingSessionKey })).toBeUndefined();
  expect(voiceMocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
});

it("does not create a provider after the browser disconnects during context preparation", async () => {
  const fixture = browserFixture();
  const { respond, createBrowserSession } = fixture;
  const starting = fixture.create({ model: "gpt-live-test" });
  disconnect(fixture);
  await starting;
  expectErrorResponse(respond, expect.stringContaining("disconnected"));
  expect(createBrowserSession).not.toHaveBeenCalled();
});

it("closes the committed voice session when its browser disconnects before startup resumes", async () => {
  const { cancelBrowserSession, client, clients, respond, create } = browserFixture();
  const voiceSessionId = "voice-disconnected-after-commit";
  ownedVoiceSessionId = voiceSessionId;
  const createVoiceSession = createOrResumeClientVoiceSession;
  using _ = vi
    .spyOn(
      await import("../../../talk/client-voice-session.js"),
      "createOrResumeClientVoiceSession",
    )
    .mockImplementationOnce(async (...args) => {
      const committed = await createVoiceSession(...args);
      clients.delete(client);
      return committed;
    });
  await create({ voiceSessionId });
  expectErrorResponse(respond, expect.stringContaining("disconnected"));
  expect(cancelBrowserSession).toHaveBeenCalledOnce();
  expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("closed");
});

it("rejects relay voice records", async () => {
  const voiceSessionId = await createVoice("relay");

  const respond = await invokeClient("transcript", {
    sessionKey,
    voiceSessionId,
    entryId: "1",
    role: "user",
    text: "hello",
  });
  expectErrorResponse(respond, expect.stringContaining("does not allow this transcript source"));
});
